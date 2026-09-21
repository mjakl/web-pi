import type { HTMLButtonElement } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";
import { disconnectable } from "#/web/fixtures/disconnect";
import { rewritableSession } from "#/web/fixtures/rewritable-session";
import { streamingFixture } from "#/web/fixtures/streaming";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

it.each([false, true])(
  "replaces a rewritten canonical branch (disconnected: %s) and then resumes append recovery",
  async (disconnected) => {
    const f = await rewritableSession();
    const transport = disconnectable((request) => f.app.request(request));
    const browser = await htmxBrowser(
      await (await f.app.request(`/sessions/${f.id}`)).text(),
      (request) =>
        new URL(request.url).pathname === "/events"
          ? new Response("")
          : transport.request(request),
    );
    browsers.push(browser);
    const { document, window } = browser;
    await expect.poll(() => transport.connections.length).toBe(1);
    const owner = required(document.querySelector("main"));
    const oldLog = required(document.querySelector("#log"));
    const oldRail = required(document.querySelector("#rail-column"));
    oldRail.classList.add("has-branches", "is-expanded");
    oldRail.setAttribute("style", "width:100px");
    // A real previous-page request, so a reset must replace its pagination too.
    const earlier = required(
      document.querySelector(".load-earlier")?.getAttribute("hx-get"),
    );
    await window.eval(
      `htmx.ajax('GET', ${JSON.stringify(earlier)}, {target:'.load-earlier',swap:'outerHTML'})`,
    );
    expect(document.querySelector("#entry-u11")).not.toBeNull();
    if (disconnected) required(transport.connections[0]).disconnect();
    // The response goes to the other tab; only this tab's SSE can update its DOM.
    const changed = await f.app.request(`/sessions/${f.id}/navigate`, {
      method: "POST",
      body: new URLSearchParams({ entryId: "a30" }),
    });
    expect(changed.status).toBe(200);
    await expect
      .poll(() => document.querySelector("#log") !== oldLog)
      .toBe(true);
    expect(document.querySelector("main")).toBe(owner);
    const rail = required(document.querySelector("#rail-column"));
    expect(rail).not.toBe(oldRail);
    await expect.poll(() => rail.classList.contains("is-expanded")).toBe(false);
    expect(rail.classList.contains("chat-minimap")).toBe(true);
    expect(document.querySelector("#entry-a60")).toBeNull();
    expect(document.querySelector("#entry-a30")).not.toBeNull();
    expect(
      document.querySelector(".load-earlier")?.getAttribute("hx-get"),
    ).toContain("before=u6");
    expect(
      document.querySelectorAll('.minimap-row[data-minimap-entry-id="u60"]'),
    ).toHaveLength(0);
    const log = required(document.querySelector("#log"));
    if (disconnected)
      expect(
        required(transport.connections[1]).request.headers.get("Last-Event-ID"),
      ).toBe("settled=a60");
    await f.workspace.send(f.id, "continue after rewrite");
    await expect
      .poll(() => document.querySelector("#messages")?.textContent)
      .toContain("Reply after rewrite");
    await expect
      .poll(() => document.querySelector("#status [data-running]"))
      .toBeNull();
    const answer = required(
      document.querySelector(
        "#messages .turn:last-child [data-role=assistant]",
      ),
    );
    const count = transport.connections.length;
    required(transport.connections.at(-1)).disconnect();
    await expect.poll(() => transport.connections.length).toBe(count + 1);
    expect(document.querySelector("#log")).toBe(log);
    expect(document.querySelector("#rail-column")).toBe(rail);
    expect(document.querySelectorAll(`#${answer.id}`)).toHaveLength(1);
    expect(document.querySelector("#entry-a60")).toBeNull();
  },
);

it.each(["u31", "u1"])(
  "replaces history after another tab rewinds to %s, including the empty branch",
  async (entryId) => {
    const f = await rewritableSession();
    const subscribed = vi.spyOn(
      required(f.world.runtime.get(f.id)),
      "subscribe",
    );
    const transport = disconnectable((request) => f.app.request(request));
    const browser = await htmxBrowser(
      await (await f.app.request(`/sessions/${f.id}`)).text(),
      (request) =>
        new URL(request.url).pathname === "/events"
          ? new Response("")
          : transport.request(request),
    );
    browsers.push(browser);
    const { document } = browser;
    await expect.poll(() => transport.connections.length).toBe(1);
    // A response body exists before async inspection checks finish. This case
    // must stop an already-subscribed runtime to exercise reconnection.
    await expect.poll(() => subscribed.mock.calls.length).toBe(1);
    subscribed.mockRestore();
    const owner = document.querySelector("main");
    const oldLog = document.querySelector("#log");
    expect(
      (
        await f.app.request(`/sessions/${f.id}/rewind`, {
          method: "POST",
          body: new URLSearchParams({ entryId }),
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(() => document.querySelector("#log") !== oldLog)
      .toBe(true);
    expect(document.querySelector("main")).toBe(owner);
    expect(document.querySelector("#entry-a60")).toBeNull();
    expect(document.querySelector("#turn")?.textContent).toBe("");
    expect(document.querySelector("#status [data-running]")).toBeNull();
    if (entryId === "u1") {
      expect(document.querySelector("#messages")?.textContent).toBe("");
      expect(document.querySelector(".load-earlier")).toBeNull();
    } else {
      expect(document.querySelector("#entry-a30")).not.toBeNull();
      expect(
        document.querySelector(".load-earlier")?.getAttribute("hx-get"),
      ).toContain("before=u6");
    }
    // DOM replacement can precede stream EOF and the jittered reconnect delay.
    await expect
      .poll(() => transport.connections.length, { timeout: 5000 })
      .toBe(2);
    expect(
      required(transport.connections[1]).request.headers.get("Last-Event-ID"),
    ).not.toBeNull();
    await f.workspace.send(f.id, "continue from the rewritten branch");
    await expect
      .poll(() => document.querySelector("#messages")?.textContent)
      .toContain("Reply after rewrite");
    const log = document.querySelector("#log");
    const answer = required(
      document.querySelector(
        "#messages .turn:last-child [data-role=assistant]",
      ),
    );
    required(transport.connections.at(-1)).disconnect();
    await expect.poll(() => transport.connections.length).toBe(3);
    expect(document.querySelector("#log")).toBe(log);
    expect(document.querySelectorAll(`#${answer.id}`)).toHaveLength(1);
  },
);

it("restores the rewound prompt when SSE replaces history before the action response arrives", async () => {
  const f = await rewritableSession();
  const release = Promise.withResolvers<undefined>();
  let pending: Request | undefined;
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    async (request) => {
      if (new URL(request.url).pathname === "/events") return new Response("");
      const response = await f.app.request(request);
      if (new URL(request.url).pathname.endsWith("/rewind")) {
        pending = request;
        await release.promise;
      }
      return response;
    },
  );
  browsers.push(browser);
  const { document, window } = browser;
  window.eval("window.confirm = () => true");
  const oldLog = required(document.querySelector("#log"));
  const oldComposer = required(document.querySelector("#composer"));
  const button = required(
    document.querySelector<HTMLButtonElement>(
      '#entry-u51 [hx-post$="/rewind"]',
    ),
  );
  try {
    button.click();
    await expect.poll(() => pending !== undefined).toBe(true);
    await expect
      .poll(() => document.querySelector("#log") !== oldLog)
      .toBe(true);
    expect(document.querySelector("#entry-u51")).toBeNull();
    expect(document.querySelector("#entry-a60")).toBeNull();
    expect(document.querySelector("#entry-a50")).not.toBeNull();
    expect(required(pending).signal.aborted).toBe(false);
  } finally {
    release.resolve(undefined);
  }
  await expect
    .poll(() => document.querySelector("#composer") !== oldComposer)
    .toBe(true);
  expect(document.querySelector("textarea")?.value).toBe("Question 51");
  expect(f.world.runtime.get(f.id)?.snapshot().status.running).toBe(false);
  expect(
    document.querySelector(`[hx-post="/sessions/${f.id}/stop"]`),
  ).not.toBeNull();
  expect(document.querySelector("#status [data-running]")).toBeNull();
  expect(document.querySelector("#turn")?.textContent).toBe("");
  expect(window.localStorage.getItem(`web-pi:draft:${f.id}`)).toBe(
    "Question 51",
  );
});

it("aborts the old owner's pending history request and rejects its late content after replacement", async () => {
  const f = await rewritableSession();
  const release = Promise.withResolvers<undefined>();
  let pending: Request | undefined;
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    async (request) => {
      if (new URL(request.url).pathname === "/events") return new Response("");
      const response = await f.app.request(request);
      if (new URL(request.url).pathname.endsWith("/earlier")) {
        pending = request;
        await release.promise;
      }
      return response;
    },
  );
  browsers.push(browser);
  const { document, window } = browser;
  const oldLog = required(document.querySelector("#log"));
  const earlier = required(
    document.querySelector(".load-earlier")?.getAttribute("hx-get"),
  );
  await window.eval(
    `void htmx.ajax('GET', ${JSON.stringify(earlier)}, {source:document.querySelector('.load-earlier'),target:'.load-earlier',swap:'outerHTML'}).finally(()=>window.earlierFinished=true)`,
  );
  await expect.poll(() => pending !== undefined).toBe(true);
  try {
    await f.workspace.navigateTree(f.id, "a30");
    await expect
      .poll(() => document.querySelector("#log") !== oldLog)
      .toBe(true);
    expect(required(pending).signal.aborted).toBe(true);
  } finally {
    release.resolve(undefined);
  }
  await expect
    .poll(() => window.eval("window.earlierFinished") === true)
    .toBe(true);
  expect(oldLog.isConnected).toBe(false);
  expect(document.querySelector("#entry-u11")).not.toBeNull();
  expect(document.querySelector("#entry-u1")).toBeNull();
  expect(document.querySelectorAll(".message-preview-popover")).toHaveLength(1);
});

it("reports an unrelated projection failure instead of resetting history or announcing completion", async () => {
  const f = await streamingFixture();
  f.finish("already delivered", false);
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    (request) =>
      new URL(request.url).pathname === "/events"
        ? new Response("")
        : f.app.request(request),
  );
  browsers.push(browser);
  const { document } = browser;
  await expect.poll(() => f.subscribers).toBe(1);
  const log = document.querySelector("#log");
  let completions = 0;
  document.body.addEventListener("done", () => {
    completions += 1;
  });
  f.workspace.viewSession = () =>
    Promise.reject(new RangeError("Broken fixture projection"));
  f.emit("turn_done");
  f.emit("completed");
  await expect
    .poll(() => document.querySelector("#toasts")?.textContent)
    .toContain("Broken fixture projection");
  expect(document.querySelector("#log")).toBe(log);
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(completions).toBe(0);
  await expect.poll(() => f.subscribers).toBe(0);
});
