import { createFakeWorld, type FakeStoredSession } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { controlledStream, htmxBrowser } from "#/web/htmx4-browser";
import { afterEach, expect, it } from "vitest";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
});

function session(id: string): FakeStoredSession {
  return {
    summary: {
      id,
      cwd: "/repo",
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 0,
    },
    entries: [],
  };
}

function fixture() {
  const world = createFakeWorld({ sessions: [session("existing")] });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: "/repo",
    staticRoot: "static",
  });
  return { world, workspace, app };
}

it("discovers stored external sessions on initial connection and real SSE reconnection without replacing the owner", async () => {
  const { world, app } = fixture();
  const markup = await (await app.request("/new")).text();
  world.store.set("external-1", session("external-1"));
  const first = controlledStream();
  const second = controlledStream();
  let connections = 0;
  const b = await htmxBrowser(
    markup.replace(
      'hx-sse:connect="/events"',
      'hx-sse:connect="/events" hx-config="sse.reconnectDelay:1 sse.reconnectJitter:0"',
    ),
    (request) => {
      if (new URL(request.url).pathname === "/events")
        return ++connections === 1 ? first.response : second.response;
      return app.request(request);
    },
  );
  browsers.push(b);
  const owner = b.document.querySelector("#sidebar-events");
  const nav = b.document.querySelector("#session-nav");
  const main = b.document.querySelector("main");
  await expect
    .poll(() => b.document.querySelector("#row-external-1"))
    .not.toBeNull();
  world.store.set("external-2", session("external-2"));
  first.end();
  await expect
    .poll(() => b.document.querySelector("#row-external-2"))
    .not.toBeNull();
  expect(connections).toBe(2);
  expect(b.document.querySelector("#sidebar-events")).toBe(owner);
  expect(b.document.querySelector("#session-nav")).toBe(nav);
  expect(b.document.querySelector("main")).toBe(main);
  expect(
    b.requests.filter((r) => new URL(r.url).pathname === "/sidebar/rows"),
  ).toHaveLength(2);
});

it("serializes manual refresh with an in-flight automatic request and retains lifecycle SSE after navigation", async () => {
  const { world, workspace, app } = fixture();
  const held = Promise.withResolvers<Response>();
  let scans = 0;
  let active = 0;
  let peak = 0;
  const b = await htmxBrowser(
    await (await app.request("/new")).text(),
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path !== "/sidebar" && path !== "/sidebar/rows")
        return app.request(request);
      scans += 1;
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (scans === 1) return await held.promise;
        return await app.request(request);
      } finally {
        active -= 1;
      }
    },
    { clock: true },
  );
  browsers.push(b);
  await b.advanceTime(100);
  expect(scans).toBe(1);
  b.window.eval(
    "document.querySelector('#sidebar-refresh').click(); window.dispatchEvent(new Event('focus'))",
  );
  await b.advanceTime(100);
  expect(scans).toBe(1);
  world.store.set("external", session("external"));
  held.resolve(await app.request("/sidebar/rows?selected="));
  await b.advanceTime(100);
  await expect
    .poll(() => b.document.querySelector("#row-external"))
    .not.toBeNull();
  await expect.poll(() => scans).toBeGreaterThanOrEqual(2);
  expect(peak).toBe(1);
  const owner = b.document.querySelector("#sidebar-events");
  b.window.eval(
    "void htmx.ajax('GET', '/sessions/existing', {source:'#session-region', target:'#session-region', swap:'outerHTML'})",
  );
  await b.advanceTime(100);
  expect(
    b.document.querySelector("main")?.getAttribute("data-session-id"),
  ).toBe("existing");
  expect(b.document.querySelector("#sidebar-events")).toBe(owner);
  await workspace.activate("external");
  await b.advanceTime(100);
  await expect
    .poll(() =>
      b.document
        .querySelector("#row-external .session-indicator")
        ?.getAttribute("data-status"),
    )
    .toBe("Session active");
  expect(b.document.querySelector("#sidebar-events")).toBe(owner);
});

it("coalesces automatic triggers into a running manual refresh instead of queueing scans", async () => {
  const { app } = fixture();
  const held = Promise.withResolvers<Response>();
  const b = await htmxBrowser(
    await (await app.request("/new")).text(),
    (request) => {
      if (new URL(request.url).pathname === "/sidebar") return held.promise;
      return app.request(request);
    },
    { clock: true },
  );
  browsers.push(b);
  await b.advanceTime(200);
  const rowsRequests = () =>
    b.requests.filter((r) => new URL(r.url).pathname === "/sidebar/rows")
      .length;
  expect(rowsRequests()).toBe(1);
  b.window.eval("document.querySelector('#sidebar-refresh').click()");
  await b.advanceTime(1);
  expect(
    b.requests.filter((r) => new URL(r.url).pathname === "/sidebar"),
  ).toHaveLength(1);
  for (let i = 0; i < 3; i += 1) {
    b.window.eval("window.dispatchEvent(new Event('focus'))");
    await b.advanceTime(100);
  }
  expect(rowsRequests()).toBe(1);
  held.resolve(await app.request("/sidebar"));
  await b.advanceTime(200);
  expect(rowsRequests()).toBe(2);
  expect(
    b.document.querySelector("#sidebar-refresh")?.hasAttribute("data-done"),
  ).toBe(true);
  await b.advanceTime(200);
  expect(rowsRequests()).toBe(2);
});
