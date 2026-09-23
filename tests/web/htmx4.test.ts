import { createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { HTMX_SRC, HTMX_SSE_SRC } from "@web/HtmlLayout";
import type { HTMLButtonElement, HTMLInputElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controlledStream, htmxBrowser, page } from "#/web/htmx4-browser";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected test value");
  return value;
}

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  vi.restoreAllMocks();
});
async function open(...args: Parameters<typeof htmxBrowser>) {
  const browser = await htmxBrowser(...args);
  browsers.push(browser);
  return browser;
}
const eventually = async (assertion: () => void) => {
  await expect
    .poll(() => {
      assertion();
      return true;
    })
    .toBe(true);
};
const composer = `<form id="composer" data-session-id="s1" hx-post="/send" hx-target="#toasts" hx-swap="beforeend" hx-encoding="multipart/form-data"><textarea id="composer-text" name="text">draft</textarea><button type="submit" name="mode" value="followUp">Send</button><div id="slash-menu"></div><div id="at-menu"></div><input id="image-input" type="file" multiple><div id="image-previews"></div></form><div id="toasts"></div>`;

describe("shipped HTMX 4 with the real browser client", () => {
  it("loads the scripts and startup configuration selected by HtmlLayout", async () => {
    const app = createWebApp({
      workspace: createWorkspace(createFakeWorld()),
      staticRoot: "static",
      defaultCwd: "/repo",
    });
    const shell = await (await app.request("/new")).text();
    // Guards the rendered loading contract. Only a real browser can prove
    // parser/DCL ordering when the deferred scripts arrive late.
    expect(shell).toContain(`<script src="${HTMX_SRC}"></script>`);
    expect(shell).toContain(`<script src="${HTMX_SSE_SRC}" defer=""></script>`);
    // Keep the real head configuration and body inheritance. The test loads
    // scripts itself and does not need the page's long-lived sidebar stream.
    const markup = shell
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/(<body\b[^>]*>)[\s\S]*<\/body>/, "$1</body>");
    const { window, document } = await open(markup, () => new Response(""));
    expect(window.eval("htmx.config.extensions")).toBe("sse");
    expect(window.eval("htmx.config.sse.pauseOnBackground")).toBe(false);
    expect(window.eval("htmx.config.defaultTimeout")).toBe(0);
    expect(document.body.getAttribute("hx-status:4xx:inherited")).toBe(
      "swap:none",
    );
    expect(document.body.getAttribute("hx-status:5xx:inherited")).toBe(
      "swap:none",
    );
  });

  it("uses the production request-field filter on toolbar controls without consuming the draft", async () => {
    let received: FormData | undefined;
    const { document } = await open(
      page(
        composer.replace(
          "</form>",
          `<input name="thinking" value="high"><input name="tag" value="one"><input name="tag" value="two"><button id="toolbar" type="button" hx-post="/thinking" hx-swap="none" data-request-fields="thinking" hx-vals='{"tag":"one"}'>Think</button></form>`,
        ),
      ),
      async (request) => {
        received = await request.formData();
        return new Response("");
      },
    );
    required(document.querySelector<HTMLButtonElement>("#toolbar")).click();
    await eventually(() => {
      expect(received?.get("thinking")).toBe("high");
    });
    expect(required(received).has("text")).toBe(false);
    expect(required(received).getAll("tag")).toEqual(["one", "two"]);
    expect(required(document.querySelector("textarea")).value).toBe("draft");
  });

  it.each(["accepted", "HTTP 200 rejection"])(
    "requires explicit composer acceptance for %s",
    async (kind) => {
      const { document } = await open(
        page(composer),
        () =>
          new Response(
            kind === "accepted"
              ? ""
              : `<div class="notice-shelf-item">Rejected</div>`,
            {
              headers:
                kind === "accepted"
                  ? { "X-Web-Pi-Submission": "accepted" }
                  : {},
            },
          ),
      );
      required(document.querySelector("button")).click();
      await eventually(() => {
        if (kind === "accepted") {
          expect(required(document.querySelector("textarea")).value).toBe("");
        } else {
          expect(
            required(document.getElementById("toasts")).textContent,
          ).toContain("Rejected");
          expect(required(document.querySelector("textarea")).value).toBe(
            "draft",
          );
        }
      });
    },
  );

  it.each([422, 500])(
    "does not swap or clear drafts on HTTP %i, but delivers header toasts",
    async (status) => {
      const { document } = await open(
        page(composer),
        () =>
          new Response("<b>must not swap</b>", {
            status,
            headers: {
              "HX-Trigger": JSON.stringify({
                "web-pi:toast": {
                  message: `Failed ${String(status)}`,
                  type: "error",
                },
              }),
            },
          }),
      );
      required(document.querySelector("button")).click();
      await eventually(() => {
        expect(
          required(document.getElementById("toasts")).textContent,
        ).toContain(`Failed ${String(status)}`);
      });
      expect(document.body.textContent).not.toContain("must not swap");
      expect(required(document.querySelector("textarea")).value).toBe("draft");
    },
  );

  it("passes a real toolbar request through app.request and swaps the fake workspace's response", async () => {
    const app = createWebApp({
      workspace: createWorkspace(createFakeWorld()),
      staticRoot: "/nonexistent",
      defaultCwd: "/repo",
    });
    const { document, requests } = await open(
      page(
        `<button id="load" hx-get="/new" hx-target="#result">New</button><div id="result"></div>`,
      ),
      (request) => app.request(request),
    );
    required(document.querySelector<HTMLButtonElement>("#load")).click();
    await eventually(() => {
      expect(document.querySelector("#result #composer")).not.toBeNull();
    });
    expect(document.querySelector("#result html")).toBeNull();
    expect(required(requests[0]).headers.get("HX-Request")).toBe("true");
  });

  it("submits and recalls a queued prompt through the real routes, including the OOB image holder", async () => {
    const workspace = createWorkspace(
      createFakeWorld({
        delayMs: 200,
        sessions: [
          {
            summary: {
              id: "s1",
              cwd: "/repo",
              name: "Test",
              createdAt: "2026-09-01T00:00:00.000Z",
              modifiedAt: "2026-09-01T00:00:00.000Z",
              fileSize: 1,
            },
            entries: [],
          },
        ],
      }),
    );
    const app = createWebApp({
      workspace,
      staticRoot: "/nonexistent",
      defaultCwd: "/repo",
    });
    await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: new URLSearchParams({ text: "start" }),
    });
    const markup = composer
      .replace('id="image-input"', 'id="image-input" name="images[]"')
      .replace('hx-post="/send"', 'hx-post="/sessions/s1/prompt"')
      .replace(
        "</form>",
        `<input name="behavior" value="followUp"><button type="button" id="recall" hx-post="/sessions/s1/queue/recall" data-request-fields="none" hx-target="#composer-text" hx-swap="outerHTML">Recall</button><div id="recalled-images"></div></form>`,
      );
    const { document, window, requests } = await open(
      page(`${markup}<div id="status"></div>`),
      (request) => app.request(request),
    );
    try {
      const bytes = new Uint8Array([0, 128, 255, 42]);
      const input = required(
        document.querySelector<HTMLInputElement>("#image-input"),
      );
      const files = new window.FileList();
      files.push(new window.File([bytes], "queued.png", { type: "image/png" }));
      input.files = files;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
      await eventually(() => {
        expect(document.querySelectorAll("#image-previews img")).toHaveLength(
          1,
        );
      });
      required(document.querySelector("button")).click();
      await eventually(() => {
        expect(required(document.querySelector("textarea")).value).toBe("");
        expect(document.querySelectorAll("#image-previews img")).toHaveLength(
          0,
        );
      });
      required(document.querySelector<HTMLButtonElement>("#recall")).click();
      await eventually(() => {
        expect(required(document.querySelector("textarea")).value).toBe(
          "draft",
        );
      });
      expect(
        required(document.getElementById("recalled-images")).innerHTML,
      ).toBe("");
      expect(document.querySelectorAll("#composer-text")).toHaveLength(1);
      await eventually(() => {
        expect(document.querySelectorAll("#image-previews img")).toHaveLength(
          1,
        );
        expect(input.files).toHaveLength(1);
      });
      expect(
        new Uint8Array(await required(input.files[0]).arrayBuffer()),
      ).toEqual(bytes);
      // Recall emits settle events for both the textarea and OOB holder.
      // Sending again proves they restored one attachment, not one per event.
      required(document.querySelector("button")).click();
      await eventually(() => {
        expect(required(document.querySelector("textarea")).value).toBe("");
        expect(document.querySelectorAll("#image-previews img")).toHaveLength(
          0,
        );
      });
      const sent = requests.filter((request) =>
        new URL(request.url).pathname.endsWith("/prompt"),
      );
      expect(sent).toHaveLength(2);
      for (const request of sent) {
        const images = (await request.formData()).getAll("images[]") as File[];
        expect(images).toHaveLength(1);
        expect(required(images[0]).type).toBe("image/png");
        expect(new Uint8Array(await required(images[0]).arrayBuffer())).toEqual(
          bytes,
        );
      }
    } finally {
      await app.request("/sessions/s1/abort", { method: "POST" });
    }
  });

  it("swaps and clears every HTML SSE region, then dispatches named events after insertion", async () => {
    const ids = [
      "turn",
      "status",
      "shelf",
      "extension-dialog",
      "custom-ui",
      "custom-frame",
      "editor-insert",
      "toasts",
      "messages",
      "session-list",
      "file-panel",
      "composer-text",
      "project-picker",
    ];
    const stream = controlledStream();
    const { document, window } = await open(
      page(
        `<main data-session-id="s1"><div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div>${ids.map((id) => `<div id="${id}">old</div>`).join("")}</main><div class="session-row" data-session-id="s2"><span class="session-indicator"></span></div>`,
      ),
      () => stream.response,
    );
    const settled: string[] = [];
    // Observe insertion before the full client consumes editor-insert payloads.
    document.body.addEventListener(
      "htmx:after:settle",
      (event) => {
        const detail = (
          event as unknown as CustomEvent<{ newContent: Element[] }>
        ).detail;
        for (const node of detail.newContent) {
          if (node.nodeType === 1 && node.hasAttribute("data-inserted")) {
            expect(node.isConnected).toBe(true);
            settled.push(required(node.getAttribute("data-inserted")));
          }
        }
      },
      { capture: true },
    );
    let done = "";
    let turnSettled = false;
    document.body.addEventListener("settled", () => {
      expect(required(document.getElementById("messages")).textContent).toBe(
        "new messages",
      );
      expect(required(document.getElementById("turn")).innerHTML).toBe("");
      turnSettled = true;
    });
    document.body.addEventListener("done", (event) => {
      done = (event as unknown as CustomEvent<{ data: string }>).detail.data;
      expect(required(document.getElementById("messages")).textContent).toBe(
        "new messages",
      );
    });
    await eventually(() => {
      expect(
        window.eval("document.getElementById('live')._htmx?.sse?.status"),
      ).toBe(200);
    });
    stream.send(
      ids
        .map(
          (id) =>
            `<hx-partial hx-target="#${id}"><span data-inserted="${id}">new ${id}</span></hx-partial>`,
        )
        .join(""),
    );
    stream.send('<hx-partial hx-target="#turn"></hx-partial>');
    stream.send("s1", "settled");
    stream.send("s1", "done");
    stream.send(JSON.stringify({ id: "s2", project: "/repo" }), "finished");
    await eventually(() => {
      expect(done).toBe("s1");
    });
    expect(turnSettled).toBe(true);
    expect(new Set(settled)).toEqual(new Set(ids));
    await eventually(() => {
      expect(
        required(
          document.querySelector(".session-indicator"),
        ).classList.contains("session-indicator-unread"),
      ).toBe(true);
    });
    stream.send(
      ids.map((id) => `<hx-partial hx-target="#${id}"></hx-partial>`).join(""),
    );
    await eventually(() => {
      for (const id of ids)
        expect(required(document.getElementById(id)).innerHTML).toBe("");
    });
  });

  it("runs production settle handlers for OOB status and every newly inserted sibling", async () => {
    const stream = controlledStream();
    const { document, window } = await open(
      page(
        `${
          composer
        }<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div><div id="status"></div><div id="extension-dialog"></div>`,
      ),
      () => stream.response,
    );
    await eventually(() => {
      expect(
        window.eval("document.getElementById('live')._htmx?.sse?.status"),
      ).toBe(200);
    });
    const showModal = vi.spyOn(window.HTMLDialogElement.prototype, "showModal");
    stream.send(
      `<div id="status" hx-swap-oob="outerHTML"><span id="session-state" data-running></span></div><hx-partial hx-target="#extension-dialog" hx-swap="outerHTML"><div id="extension-dialog"></div><dialog id="second-sibling" data-modal open>Question</dialog></hx-partial>`,
    );
    await eventually(() => {
      expect(showModal).toHaveBeenCalledOnce();
    });
    expect(required(document.querySelector("dialog")).open).toBe(true);
    expect(
      required(document.getElementById("composer")).hasAttribute(
        "data-running",
      ),
    ).toBe(true);
    stream.send(
      `<div id="status" hx-swap-oob="outerHTML"><span id="session-state"></span></div>`,
    );
    await eventually(() => {
      expect(
        required(document.getElementById("composer")).hasAttribute(
          "data-running",
        ),
      ).toBe(false);
    });
  });

  it.each([
    ["/sessions/s1/events", "network"],
    ["/sessions/s1/events", "503"],
    ["/events", "network"],
    ["/events", "503"],
  ])("establishes %s after an initial %s failure", async (url, failure) => {
    const stream = controlledStream();
    let connections = 0;
    const { document, window, advanceTime } = await open(
      page(
        `<div id="live" hx-sse:connect="${url}" hx-trigger="web-pi:sse-start" hx-swap="none"></div><div id="messages"></div><div id="toasts"></div>`,
      ),
      () => {
        connections += 1;
        if (connections === 1) {
          if (failure === "network")
            throw new TypeError("Network connection reset");
          return new Response("Unavailable", { status: 503 });
        }
        return stream.response;
      },
      { clock: true },
    );
    // Reprocessing while the initial connection is pending must not queue a
    // second connection when the extension installs its trigger again.
    window.eval("htmx.process(document.body)");
    await advanceTime(500);
    expect(connections).toBe(2);
    stream.send(
      '<hx-partial hx-target="#messages" hx-swap="beforeend"><p>Future update</p></hx-partial>',
    );
    await eventually(() => {
      expect(document.querySelectorAll("#messages p")).toHaveLength(1);
    });
    await advanceTime(600);
    expect(connections).toBe(2);
    expect(document.querySelectorAll("#messages p")).toHaveLength(1);
  });

  it("starts once when the client bundle loads after HTMX processing", async () => {
    const stream = controlledStream();
    let connections = 0;
    const { window, advanceTime, htmxProcessedBeforeClient } = await open(
      page(
        '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div>',
      ),
      () => {
        connections += 1;
        return stream.response;
      },
      { clientAfterHtmx: true, clock: true },
    );
    expect(htmxProcessedBeforeClient).toBe(true);
    await eventually(() => {
      expect(connections).toBe(1);
    });
    window.eval("htmx.process(document.body)");
    await advanceTime(600);
    expect(connections).toBe(1);
  });

  it.each([false, true])(
    "cancels startup backoff on owner removal (replacement: %s)",
    async (replace) => {
      const stream = controlledStream();
      const owner =
        '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div>';
      let connections = 0;
      const { document, advanceTime } = await open(
        page(
          `${owner}<div id="messages"></div><div id="toasts"></div><button id="remove" hx-get="/remove" hx-target="#live" hx-swap="outerHTML">Remove</button>`,
        ),
        (request) => {
          if (new URL(request.url).pathname === "/remove")
            return new Response(replace ? owner : '<div id="removed"></div>');
          connections += 1;
          return connections === 1
            ? new Response("Unavailable", { status: 503 })
            : stream.response;
        },
        { clock: true },
      );
      const oldOwner = required(document.getElementById("live"));
      required(document.querySelector<HTMLButtonElement>("#remove")).click();
      await eventually(() => {
        expect(oldOwner.isConnected).toBe(false);
      });
      if (replace) {
        await eventually(() => {
          expect(connections).toBe(2);
        });
        stream.send(
          '<hx-partial hx-target="#messages" hx-swap="beforeend"><p>Replacement</p></hx-partial>',
        );
        await eventually(() => {
          expect(document.querySelectorAll("#messages p")).toHaveLength(1);
        });
      }
      await advanceTime(700);
      expect(connections).toBe(replace ? 2 : 1);
      expect(required(document.getElementById("toasts")).textContent).toBe("");
    },
  );

  it("aborts an initial fetch when its owner is removed", async () => {
    let signal: AbortSignal | undefined;
    let connections = 0;
    const { document, advanceTime } = await open(
      page(
        '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div><div id="toasts"></div><button id="remove" hx-get="/remove" hx-target="#live" hx-swap="outerHTML">Remove</button>',
      ),
      (request) => {
        if (new URL(request.url).pathname === "/remove")
          return new Response('<div id="removed"></div>');
        connections += 1;
        signal = request.signal;
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Removed", "AbortError"));
            },
            { once: true },
          );
        });
      },
      { clock: true },
    );
    required(document.querySelector<HTMLButtonElement>("#remove")).click();
    await eventually(() => {
      expect(signal?.aborted).toBe(true);
    });
    await advanceTime(600);
    expect(connections).toBe(1);
    expect(required(document.getElementById("toasts")).textContent).toBe("");
  });

  it.each([200, 401, 403, 404])(
    "reports a non-SSE HTTP %s response without retrying",
    async (status) => {
      let connections = 0;
      const { document, window, advanceTime } = await open(
        page(
          '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div><div id="toasts"></div>',
        ),
        () => {
          connections += 1;
          return new Response("Not an event stream", { status });
        },
        { clock: true },
      );
      await eventually(() => {
        expect(
          required(document.getElementById("toasts")).textContent,
        ).toContain("Reload this page to reconnect.");
      });
      window.eval("htmx.process(document.body)");
      await advanceTime(700);
      expect(connections).toBe(1);
    },
  );

  it("stops after six startup attempts and reports how to reconnect", async () => {
    let connections = 0;
    const { document, window, advanceTime } = await open(
      page(
        '<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-swap="none"></div><div id="toasts"></div>',
      ),
      () => {
        connections += 1;
        return new Response("Unavailable", { status: 503 });
      },
      { clock: true },
    );
    expect(connections).toBe(1);
    for (const delay of [500, 1000, 2000, 4000, 8000]) {
      const previous = connections;
      await advanceTime(delay - 1);
      expect(connections).toBe(previous);
      await advanceTime(1);
      expect(connections).toBe(previous + 1);
    }
    expect(required(document.getElementById("toasts")).textContent).toContain(
      "Reload this page to reconnect.",
    );
    expect(connections).toBe(6);
    window.eval("htmx.process(document.body)");
    await advanceTime(600);
    expect(connections).toBe(6);
  });

  it("reconnects with Last-Event-ID, stays connected while hidden, and cleans up a removed owner", async () => {
    const first = controlledStream();
    const second = controlledStream();
    let connections = 0;
    const { window, document, requests } = await open(
      page(
        `<div id="live" hx-sse:connect="/events" hx-trigger="web-pi:sse-start" hx-config="sse.reconnectDelay:1 sse.reconnectJitter:0" hx-swap="none"></div><button id="remove" hx-get="/remove" hx-target="#live" hx-swap="outerHTML">Remove</button>`,
      ),
      (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/remove")
          return new Response("<div id='replacement'></div>");
        if (path === "/settings/web")
          return Response.json({
            warnTokens: 100000,
            theme: "auto",
            sound: true,
          });
        expect(path).toBe("/events");
        return ++connections === 1 ? first.response : second.response;
      },
    );
    await eventually(() => {
      expect(
        window.eval("document.getElementById('live')._htmx?.sse?.status"),
      ).toBe(200);
    });
    first.send("payload", "checkpoint", "42");
    first.end();
    await eventually(() => {
      expect(connections).toBe(2);
    });
    expect(required(requests[1]).headers.get("Last-Event-ID")).toBe("42");
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
    let message = "";
    document.body.addEventListener("checkpoint", (event) => {
      message = (event as unknown as CustomEvent<{ data: string }>).detail.data;
    });
    second.send("still connected", "checkpoint");
    await eventually(() => {
      expect(message).toBe("still connected");
    });
    expect(second.cancelled).toBe(false);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
    second.send("visible again", "checkpoint");
    await eventually(() => {
      expect(message).toBe("visible again");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connections).toBe(2);
    expect(second.cancelled).toBe(false);
    required(document.querySelector<HTMLButtonElement>("#remove")).click();
    await eventually(() => {
      expect(document.getElementById("replacement")).not.toBeNull();
    });
    await eventually(() => {
      expect(second.cancelled).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connections).toBe(2);
  });
});
