// The live stream reconciles what the page missed: answers settled before
// it subscribed, turns missed while disconnected, and a runtime that
// appears or goes away.

import { expect, it } from "vitest";
import {
  flushPromises,
  nextEvent,
  reconnected,
  requestFinished,
  required,
} from "#/web/helpers";
import { htmxBrowser } from "#/web/htmx4-browser";
import { open, streamingFixture } from "#/web/fixtures/streaming";
import { disconnectable } from "#/web/fixtures/disconnect";

it("recovers a canonical answer settled between page render and initial subscription", async () => {
  const f = await streamingFixture();
  f.runningTools();
  const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
  f.finish("missed canonical answer", false);
  const { document } = await open(f, markup);
  await expect
    .poll(() => document.querySelector("#messages")?.textContent)
    .toContain("missed canonical answer");
  await expect
    .poll(() => document.querySelector("#status [data-running]"))
    .toBeNull();
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelector("#turn")?.textContent).toBe("");
});

it.each([0, 1, 3, 30])(
  "reconciles %i missed turns without replaying delivered history or pulling a paginated reader down",
  async (missed) => {
    const f = await streamingFixture();
    for (let i = 0; i < 40; i += 1)
      f.finish(`older answer ${String(i)}`, false);
    const transport = disconnectable((request) => f.app.request(request));
    const { document, window } = await open(f, undefined, transport.request);
    await expect.poll(() => transport.connections.length).toBe(1);
    const sentinel = required(document.querySelector(".load-earlier"));
    const url = required(sentinel.getAttribute("hx-get"));
    await window.eval(
      `htmx.ajax('GET', ${JSON.stringify(url)}, {target:'.load-earlier', swap:'outerHTML'})`,
    );
    const oldest = required(document.querySelector("#entry-u1"));
    const log = required(document.querySelector("#log"));
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 10_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    log.scrollTop = 9500;
    log.dispatchEvent(new window.Event("scroll"));
    log.scrollTop = 500;
    log.dispatchEvent(new window.Event("scroll"));
    let done = 0;
    document.body.addEventListener("done", () => {
      done += 1;
    });
    f.finish("already delivered");
    await expect
      .poll(() => document.querySelector("#entry-a41")?.textContent)
      .toContain("already delivered");
    const reconnect = reconnected(required(document.querySelector("main")));
    required(transport.connections[0]).disconnect();
    for (let i = 0; i < missed; i += 1)
      f.finish(`missed answer ${String(i)}`, false);
    // Also cover reconnection to an active newer turn, not only an empty idle tail.
    if (missed > 1) f.runningTools();
    // One reconciliation frame carries the missed turns, the tail and status.
    await reconnect;
    expect(transport.connections).toHaveLength(2);
    expect(
      document.querySelector(`#entry-a${String(41 + missed)}`),
    ).not.toBeNull();
    expect(
      required(transport.connections[1]).request.headers.get("Last-Event-ID"),
    ).toBe("settled=a41");
    expect(document.querySelectorAll("#entry-a41")).toHaveLength(1);
    for (let i = 0; i < missed; i += 1)
      expect(
        document.querySelectorAll(`#entry-a${String(42 + i)}`),
      ).toHaveLength(1);
    expect(document.querySelector("#entry-u1")).toBe(oldest);
    expect(document.querySelector(".load-earlier")).toBeNull();
    expect(log.scrollTop).toBe(500);
    expect(document.querySelector("#status [data-running]") !== null).toBe(
      missed > 1,
    );
    expect(done).toBe(0);
  },
);

it("reconciles each live-end boundary from the current snapshot, including a newer active turn", async () => {
  const f = await streamingFixture();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.finish("first finished");
  f.finish("second finished");
  f.runningTools();
  f.emit("activity");
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent)
    .toContain("second finished");
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
  expect(document.querySelector("#turn")?.textContent).toContain(
    "streaming text",
  );
  await expect
    .poll(() => document.querySelector("#status [data-running]"))
    .not.toBeNull();
});

it("recovers settlement during the native initial 500ms subscription retry gap", async () => {
  const f = await streamingFixture();
  f.runningTools();
  let attempts = 0;
  let failed: Promise<unknown> | undefined;
  const { document, advanceTime } = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/events") return new Response("");
      if (path.endsWith("/events") && ++attempts === 1) {
        f.finish("finished during retry", false);
        return new Response("busy", { status: 503 });
      }
      return f.app.request(request);
    },
    {
      clock: true,
      afterMarkup: (window) => {
        failed = requestFinished(window.document, `/sessions/${f.id}/events`);
      },
    },
  );
  // The retry is scheduled when the failed attempt finishes.
  await failed;
  await advanceTime(499);
  expect(attempts).toBe(1);
  await advanceTime(1);
  await expect
    .poll(() => document.querySelector("#entry-a1")?.textContent)
    .toContain("finished during retry");
  expect(attempts).toBe(2);
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
});

it.each(["disconnect", "body replacement"])(
  "prevents a delayed old response from overwriting new activity after %s",
  async (action) => {
    const f = await streamingFixture();
    const transport = disconnectable((request) => f.app.request(request));
    const { document, window, firstFrame } = await open(
      f,
      undefined,
      transport.request,
    );
    await expect.poll(() => f.subscribers).toBe(1);
    // Only the next render may be held, not the initial one.
    await firstFrame;
    const original = f.workspace.viewSession;
    const blocked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const returned = Promise.withResolvers<undefined>();
    let delay = true;
    f.workspace.viewSession = async (...args) => {
      const view = await original(...args);
      if (delay) {
        delay = false;
        blocked.resolve(undefined);
        await release.promise;
        returned.resolve(undefined);
      }
      return view;
    };
    f.finish("delayed old answer");
    await blocked.promise;
    const answered = nextEvent(document, "htmx:sse:after:message", () =>
      Boolean(
        document
          .querySelector("#entry-a2")
          ?.textContent?.includes("new canonical answer"),
      ),
    );
    if (action === "disconnect")
      required(transport.connections[0]).disconnect();
    else
      await window.eval(
        "htmx.swap({target:document.body,sourceElement:document.body,text:'',swap:'innerHTML'})",
      );
    f.finish("new canonical answer", false);
    f.runningTools();
    if (action === "body replacement") {
      const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
      const body = required(/<body[^>]*>([\s\S]*)<\/body>/.exec(markup)?.[1]);
      await window.eval(
        `htmx.swap({target:document.body,sourceElement:document.body,text:${JSON.stringify(body)},swap:'innerHTML'})`,
      );
    }
    await answered;
    expect(transport.connections).toHaveLength(2);
    release.resolve(undefined);
    await returned.promise;
    // The old stream's render resumes with promise work only.
    await flushPromises();
    expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
    expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
    expect(document.querySelector("#turn")?.textContent).toContain(
      "streaming text",
    );
    expect(document.querySelector("#status [data-running]")).not.toBeNull();
    expect(f.subscribers).toBe(1);
  },
);

it("recovers a new runtime after a no-owner connection returns to saved observation", async () => {
  const f = await streamingFixture();
  f.finish("stored answer", false);
  f.world.store.set(f.id, {
    summary: f.snapshot.summary,
    entries: [...f.snapshot.entries],
  });
  const get = f.world.runtime.get.bind(f.world.runtime);
  let attached = false;
  f.world.runtime.get = (id) => (attached ? get(id) : undefined);
  const { document, requests, advanceTime } = await open(
    f,
    undefined,
    undefined,
    {
      clock: true,
    },
  );
  // The stream finds no runtime and hands the page back to saved observation.
  await expect
    .poll(() => document.querySelector("main")?.hasAttribute("hx-sse:connect"))
    .toBe(false);
  expect(f.subscribers).toBe(0);
  f.finish("finished before runtime subscription", false);
  attached = true;
  // The next two-second saved check finds the runtime and hands off.
  await advanceTime(2000);
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent)
    .toContain("finished before runtime subscription");
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
  expect(f.subscribers).toBe(1);
  const streams = requests.filter((request) =>
    new URL(request.url).pathname.endsWith(`/${f.id}/events`),
  );
  expect(new URL(required(streams.at(-1)).url).searchParams.get("saved")).toBe(
    "1",
  );
});

it("reconciles persisted entries at runtime removal before closing the stream", async () => {
  const f = await streamingFixture();
  f.finish("already rendered", false);
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.finish("persisted just before stop", false);
  f.world.store.set(f.id, {
    summary: f.snapshot.summary,
    entries: [...f.snapshot.entries],
  });
  f.world.runtime.get = () => undefined;
  f.emit("stopped");
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent)
    .toContain("persisted just before stop");
  await expect.poll(() => f.subscribers).toBe(0);
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
});

it("dispatches completion only after canonical messages, live tail and status have settled", async () => {
  const f = await streamingFixture();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  const completed: unknown[] = [];
  document.body.addEventListener("done", () => {
    completed.push({
      answer: document.querySelectorAll("#entry-a1").length,
      tail: document.querySelector("#turn")?.textContent,
      running: document.querySelector("#status [data-running]") !== null,
    });
  });
  f.finish("completed answer");
  f.emit("completed");
  await expect
    .poll(() => completed)
    .toEqual([{ answer: 1, tail: "", running: false }]);
});
