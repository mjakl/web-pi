import { expect, it } from "vitest";
import type {
  HTMLButtonElement,
  HTMLElement,
  HTMLFormElement,
} from "happy-dom";
import { createFakeWorld } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { htmxBrowser } from "#/web/htmx4-browser";

async function fixture() {
  const world = createFakeWorld({
    sessions: ["newer-stopped", "first", "middle", "last", "older-stopped"].map(
      (id, index) => ({
        summary: {
          id,
          cwd: `/${id}`,
          name: id,
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: `2026-09-0${String(6 - index)}T00:00:00.000Z`,
          fileSize: 0,
        },
        entries: [],
      }),
    ),
    script: () => [{ dialog: { method: "confirm", title: "Continue?" } }],
  });
  const workspace = createWorkspace(world);
  for (const id of ["first", "middle", "last"]) await workspace.activate(id);
  const app = createWebApp({
    workspace,
    defaultCwd: "/default",
    staticRoot: "static",
  });
  const browser = await htmxBrowser(
    await (await app.request("/sessions/first")).text(),
    (request) => app.request(request),
  );
  await expect
    .poll(() =>
      browser.requests.some(
        (request) => new URL(request.url).pathname === "/events",
      ),
    )
    .toBe(true);
  const order = () =>
    [...browser.document.querySelectorAll("#session-list .session-row")].map(
      (row) => row.getAttribute("data-session-id"),
    );
  expect(order()).toEqual([
    "first",
    "middle",
    "last",
    "newer-stopped",
    "older-stopped",
  ]);
  return { ...browser, workspace, world, app, order };
}

it("keeps the global list and stream across directories while explorer and new-session preference stay independent", async () => {
  const b = await fixture();
  b.document.cookie = "web-pi-cwd=%2Fchosen";
  const nav = b.document.querySelector("#session-nav");
  const stream = b.document.querySelector("#sidebar-events");
  b.document.querySelector<HTMLElement>("#row-middle a")?.click();
  await expect
    .poll(() =>
      b.document.querySelector("main")?.getAttribute("data-session-id"),
    )
    .toBe("middle");
  await expect
    .poll(() =>
      b.document.querySelector("#file-explorer")?.getAttribute("data-cwd"),
    )
    .toBe("/middle");
  expect(b.document.querySelector("#session-nav")).toBe(nav);
  expect(b.document.querySelector("#sidebar-events")).toBe(stream);
  expect(b.document.querySelector("#project-select")).toBeNull();
  expect(b.document.cookie).toContain("web-pi-cwd=%2Fchosen");
  expect(
    b.document.querySelector("#file-explorer")?.getAttribute("hx-get"),
  ).toBe("/files/explorer?session=middle");

  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await expect.poll(() => b.window.location.pathname).toBe("/new");
  expect(b.document.querySelector("main")?.getAttribute("data-cwd")).toBe(
    "/chosen",
  );
  expect(
    b.document.querySelector("#project-select")?.getAttribute("data-cwd"),
  ).toBe("/chosen");
  expect(b.document.querySelector("#session-nav")).toBe(nav);
  expect(b.document.querySelector("#sidebar-events")).toBe(stream);
  expect(b.world.runtime.live()).toHaveLength(3);
  await expect
    .poll(() =>
      b.document.querySelector("#composer")?.hasAttribute("data-htmx-powered"),
    )
    .toBe(true);
  b.window.eval(
    `document.querySelector('#composer-text').value='first message';document.querySelector('#composer-text').dispatchEvent(new Event('input',{bubbles:true}))`,
  );
  b.document.querySelector<HTMLFormElement>("#composer")?.requestSubmit();
  await expect
    .poll(() =>
      b.document.querySelector("main")?.getAttribute("data-session-id"),
    )
    .toBe("new-1");
  expect((await b.workspace.row("new-1"))?.summary.cwd).toBe("/chosen");
  expect(b.document.querySelector("#project-select")).toBeNull();
  // An existing session's form cannot move it, even if a caller supplies cwd.
  await b.app.request("/sessions/middle/prompt", {
    method: "POST",
    body: new URLSearchParams({ cwd: "/wrong", text: "stay here" }),
  });
  expect((await b.workspace.row("middle"))?.summary.cwd).toBe("/middle");
});

it("reorders already-live sessions on turn start in another directory and after abort", async () => {
  const b = await fixture();
  const main = b.document.querySelector("main");
  await b.workspace.send("last", "wait for confirmation");
  await expect.poll(() => b.order()[0]).toBe("last");
  expect(
    b.document
      .querySelector("#row-last .session-indicator")
      ?.getAttribute("data-status"),
  ).toBe("Agent running…");
  await b.workspace.abort("last");
  await expect
    .poll(() =>
      b.document
        .querySelector("#row-last .session-indicator")
        ?.getAttribute("data-status"),
    )
    .toBe("Session active");
  expect(b.document.querySelector("main")).toBe(main);
  expect(b.order().indexOf("last")).toBeLessThan(
    b.order().indexOf("newer-stopped"),
  );
});

it.each(["row action", "runtime stop"])(
  "moves a stopped session below all directories' live sessions after %s",
  async (source) => {
    const b = await fixture();
    if (source === "row action") {
      const stop = b.document.querySelector<HTMLButtonElement>(
        '#row-middle button[hx-post="/sessions/middle/stop"]',
      );
      if (!stop) throw new Error("missing stop action");
      stop.click();
    } else await b.workspace.stop("middle");
    await expect
      .poll(b.order)
      .toEqual(["first", "last", "newer-stopped", "middle", "older-stopped"]);
    expect(b.world.runtime.get("middle")).toBeUndefined();
    expect(
      b.document.querySelector("main")?.getAttribute("data-session-id"),
    ).toBe("first");
  },
);

it("refreshes the global list without changing the blank draft or selected directory", async () => {
  const b = await fixture();
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await expect.poll(() => b.window.location.pathname).toBe("/new");
  const main = b.document.querySelector("main");
  const picker = b.document.querySelector("#project-select");
  const nav = b.document.querySelector("#session-nav");
  b.window.eval(
    `document.querySelector('#composer-text').value='keep draft';document.querySelector('#composer-text').dispatchEvent(new Event('input',{bubbles:true}))`,
  );
  b.document.querySelector<HTMLButtonElement>("#sidebar-refresh")?.click();
  await expect
    .poll(() => b.document.querySelector("#session-nav") !== nav)
    .toBe(true);
  await expect
    .poll(
      () =>
        b.requests.filter((r) => new URL(r.url).pathname === "/events").length,
    )
    .toBeGreaterThan(1);
  await b.workspace.activate("older-stopped");
  await expect
    .poll(
      () =>
        b.order().indexOf("older-stopped") < b.order().indexOf("newer-stopped"),
    )
    .toBe(true);
  expect(b.document.querySelector("main")).toBe(main);
  expect(b.document.querySelector("#project-select")).toBe(picker);
  expect(b.window.eval(`document.querySelector('#composer-text').value`)).toBe(
    "keep draft",
  );
  expect(
    b.document.querySelector("#sidebar-events")?.getAttribute("hx-sse:connect"),
  ).toBe("/events");
});

it("sends finished for every turn and completed only for a completed run", async () => {
  const world = createFakeWorld({
    delayMs: 1,
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/s1",
          name: "s1",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          fileSize: 0,
        },
        entries: [],
      },
    ],
  });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: "/",
    staticRoot: "static",
  });
  const reader = (await app.request("/events")).body?.getReader();
  if (!reader) throw new Error("Missing event stream");
  const decoder = new TextDecoder();
  let received = "";
  const named = () =>
    [...received.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map(
      ([, name, data]) => `${String(name)} ${String(data)}`,
    );
  const until = async (count: number) => {
    while (named().length < count) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Event stream ended");
      received += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    await workspace.send("s1", "hello");
    await until(2);
    await workspace.runBash("s1", "ls", false);
    await until(3);
    await workspace.send("s1", "again");
    await until(5);
    expect(named()).toEqual([
      'finished {"id":"s1"}',
      'completed {"id":"s1"}',
      // The shell command finished the turn but completed no run.
      'finished {"id":"s1"}',
      'finished {"id":"s1"}',
      'completed {"id":"s1"}',
    ]);
  } finally {
    await reader.cancel();
  }
});
