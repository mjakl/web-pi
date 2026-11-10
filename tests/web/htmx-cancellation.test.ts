import { expect, it } from "vitest";
import { htmxBrowser, page } from "#/web/htmx4-browser";

const markup = page(
  '<div id="sync"><button id="request" hx-get="/slow" hx-target="#result" hx-sync="#sync:replace">Request</button></div><div id="result"></div>',
);

it("keeps the latest replacement in charge after an aborted request finalizes", async () => {
  const pending: {
    signal: AbortSignal;
    resolve: (response: Response) => void;
  }[] = [];
  const logged: unknown[][] = [];
  const browser = await htmxBrowser(
    markup,
    (request) =>
      new Promise((resolve, reject) => {
        pending.push({ signal: request.signal, resolve });
        request.signal.addEventListener(
          "abort",
          () => {
            reject(request.signal.reason as Error);
          },
          { once: true },
        );
      }),
    {
      afterMarkup(window) {
        window.console = {
          ...window.console,
          error: (...args: unknown[]) => {
            logged.push(args);
          },
        };
      },
    },
  );
  let finalized = 0;
  let errors = 0;
  browser.document.addEventListener("htmx:finally:request", () => {
    finalized += 1;
  });
  browser.document.addEventListener("htmx:error", () => {
    errors += 1;
  });
  const click = () => {
    browser.window.eval("document.querySelector('#request').click()");
  };
  click();
  await expect.poll(() => pending.length).toBe(1);
  click();
  await expect.poll(() => finalized).toBe(1);
  click();
  await expect.poll(() => pending.length).toBe(3);
  expect(pending[1]?.signal.aborted).toBe(true);
  pending[2]?.resolve(new Response("Latest result"));
  await expect
    .poll(() => browser.document.querySelector("#result")?.textContent)
    .toBe("Latest result");
  expect(errors).toBe(0);
  expect(logged).toEqual([]);
});

it("treats aborted response-body reading as cancellation, not a request failure", async () => {
  let requests = 0;
  let firstSignal: AbortSignal | undefined;
  const logged: unknown[][] = [];
  const browser = await htmxBrowser(
    markup,
    (request) => {
      if (++requests > 1) return new Response("Replacement");
      firstSignal = request.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              "abort",
              () => {
                controller.error(request.signal.reason);
              },
              { once: true },
            );
          },
        }),
        { headers: { "HX-Trigger": "cancelled-body-event" } },
      );
    },
    {
      afterMarkup(window) {
        window.console = {
          ...window.console,
          error: (...args: unknown[]) => {
            logged.push(args);
          },
        };
      },
    },
  );
  let responses = 0;
  let errors = 0;
  let cancelledBodyEvents = 0;
  browser.document.addEventListener("cancelled-body-event", () => {
    cancelledBodyEvents += 1;
  });
  browser.document.addEventListener("htmx:before:response", () => {
    responses += 1;
  });
  browser.document.addEventListener("htmx:error", () => {
    errors += 1;
  });
  browser.window.eval("document.querySelector('#request').click()");
  await expect.poll(() => responses).toBe(1);
  browser.window.eval("document.querySelector('#request').click()");
  await expect
    .poll(() => browser.document.querySelector("#result")?.textContent)
    .toBe("Replacement");
  expect(firstSignal?.aborted).toBe(true);
  expect(cancelledBodyEvents).toBe(0);
  expect(errors).toBe(0);
  expect(logged).toEqual([]);
});

it.each(["network", "unrelated AbortError", "HTTP", "timeout"])(
  "still reports a real %s failure",
  async (failure) => {
    const logged: unknown[][] = [];
    const browser = await htmxBrowser(
      markup,
      (request) => {
        if (failure === "HTTP")
          return new Response("Unavailable", { status: 503 });
        if (failure === "timeout")
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                reject(request.signal.reason as Error);
              },
              { once: true },
            );
          });
        throw failure === "network"
          ? new TypeError("Network failed")
          : new DOMException("Not a cancellation", "AbortError");
      },
      {
        afterMarkup(window) {
          window.console = {
            ...window.console,
            error: (...args: unknown[]) => {
              logged.push(args);
            },
          };
        },
      },
    );
    let httpErrors = 0;
    browser.document.addEventListener("htmx:response:error", () => {
      httpErrors += 1;
    });
    browser.window.eval(
      "htmx.config.defaultTimeout = 10; document.querySelector('#request').click()",
    );
    if (failure === "HTTP") await expect.poll(() => httpErrors).toBe(1);
    else await expect.poll(() => logged.length).toBeGreaterThan(0);
  },
);

it("cleans up a connected SSE fetch whose body errors when aborted", async () => {
  let signal: AbortSignal | undefined;
  const browser = await htmxBrowser(
    page(
      '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div><button id="remove" hx-get="/remove" hx-target="#live" hx-swap="outerHTML">Remove</button>',
    ),
    (request) => {
      if (new URL(request.url).pathname === "/remove")
        return new Response('<div id="removed"></div>');
      signal = request.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            request.signal.addEventListener(
              "abort",
              () => {
                controller.error(request.signal.reason);
              },
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  await expect
    .poll(
      () =>
        browser.window.eval(
          "document.querySelector('#live')._htmx?.sse?.status",
        ) as number | undefined,
    )
    .toBe(200);
  browser.window.eval("document.querySelector('#remove').click()");
  await expect
    .poll(() => browser.document.querySelector("#removed") !== null)
    .toBe(true);
  expect(signal?.aborted).toBe(true);
  // Vitest also fails this test file on an unhandled cancellation rejection.
});
