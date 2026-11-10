import { assistantEntry, userEntry } from "@adapters/fake/index";
import { expect, it } from "vitest";
import { storedSession, testApp } from "#/web/fixtures/test-app";
import { htmxBrowser } from "#/web/htmx4-browser";

const headers = { "X-Web-Pi-Starred": "true" };

it("keeps the toggle, navigation, refresh and lifecycle stream in the same mode", async () => {
  const { app, world, workspace } = testApp();
  world.store.set("plain", storedSession({ id: "plain" }));
  await world.sessions.setStar("s1", "a1", true);
  const browser = await htmxBrowser(
    await (await app.request("/sessions/s1")).text(),
    (request) => app.request(request),
  );
  const button = () => browser.document.querySelector("#starred-filter");
  const row = (id: string) => browser.document.querySelector(`#row-${id}`);
  const main = browser.document.querySelector("main");
  expect(button()?.nextElementSibling?.getAttribute("aria-label")).toBe(
    "New session",
  );
  browser.window.eval("document.querySelector('#starred-filter').click()");
  await expect.poll(() => button()?.getAttribute("aria-pressed")).toBe("true");
  await expect.poll(() => row("plain")).toBeNull();
  expect(row("s1")).not.toBeNull();
  expect(browser.document.querySelector("main")).toBe(main);
  await expect
    .poll(() =>
      browser.requests.some(
        (request) =>
          new URL(request.url).search === "?starred=1" &&
          new URL(request.url).pathname === "/events",
      ),
    )
    .toBe(true);
  // The current tab's state wins even if another tab changed the cookie.
  browser.window.document.cookie = "web-pi-starred=false; path=/";
  browser.window.eval("document.querySelector('#sidebar-refresh').click()");
  await expect
    .poll(() =>
      browser.requests.some(
        (request) =>
          new URL(request.url).pathname === "/sidebar" &&
          request.headers.get("X-Web-Pi-Starred") === "true",
      ),
    )
    .toBe(true);
  expect(button()?.getAttribute("aria-pressed")).toBe("true");
  await workspace.activate("plain");
  await workspace.activate("s1");
  await expect.poll(() => row("s1")?.classList.contains("is-live")).toBe(true);
  expect(row("plain")).toBeNull();
  browser.window.eval(
    "document.querySelector('[aria-label=\"Unstar answer\"]').click()",
  );
  await expect.poll(() => row("s1")).toBeNull();
  browser.window.eval(
    "document.querySelector('[aria-label=\"New session\"]').click()",
  );
  await expect
    .poll(() => browser.document.querySelector(".chat-window.is-empty"))
    .not.toBeNull();
  expect(
    browser.document.querySelector("main")?.getAttribute("data-session-id"),
  ).toBeNull();
  expect(button()?.getAttribute("aria-pressed")).toBe("true");
  browser.window.eval("document.querySelector('#starred-filter').click()");
  await expect.poll(() => button()?.getAttribute("aria-pressed")).toBe("false");
  await expect.poll(() => row("plain")).not.toBeNull();
  expect(row("s1")).not.toBeNull();
});

it("filters before paging, ignores non-answer and legacy stars, and restores the ordinary list", async () => {
  const { app, world } = testApp();
  for (let index = 0; index < 55; index += 1) {
    const id = `plain-${String(index)}`;
    world.store.set(id, storedSession({ id, modifiedAt: "2026-10-01" }));
  }
  const stored = world.store.get("s1");
  if (!stored) throw new Error("Missing fixture");
  stored.entries.push(
    {
      type: "custom",
      id: "legacy",
      parentId: "a1",
      timestamp: "2026-09-02",
      customType: "pi-web:star",
      data: { targetId: "a1", starred: true },
    },
    {
      type: "custom",
      id: "invalid",
      parentId: "legacy",
      timestamp: "2026-09-02",
      customType: "web-pi:star",
      data: { targetId: "u1", starred: true },
    },
  );
  expect(
    await (await app.request("/sidebar/rows", { headers })).text(),
  ).toContain("No sessions with starred answers");
  await world.sessions.setStar("s1", "a1", true);
  const enabled = await app.request("/sidebar?starred=1");
  expect(enabled.headers.get("set-cookie")).toContain("web-pi-starred=true");
  const reloaded = await (
    await app.request("/sessions/s1", {
      headers: { Cookie: "web-pi-starred=true" },
    })
  ).text();
  expect(reloaded).toContain('aria-pressed="true"');
  expect(reloaded).not.toContain('id="row-plain-');
  const filtered = await enabled.text();
  expect(filtered).toContain('id="row-s1"');
  expect(filtered).not.toContain('id="row-plain-');
  expect(filtered).not.toContain("Loading more sessions");
  expect(filtered).toContain('aria-pressed="true"');
  expect(filtered).toContain("/events?starred=1");
  const ordinary = await (await app.request("/sidebar?starred=0")).text();
  expect(ordinary).toContain('id="row-plain-');
  expect(ordinary).toContain('aria-pressed="false"');
});

it("pages matching sessions rather than taking matches from ordinary pages", async () => {
  const { app, world } = testApp();
  for (let i = 0; i < 53; i += 1) {
    const id = `starred-${String(i)}`;
    world.store.set(id, storedSession({ id }));
    await world.sessions.setStar(id, "a1", true);
  }
  const first = await (await app.request("/sidebar/rows", { headers })).text();
  expect(first.match(/class="session-row"/g)).toHaveLength(50);
  expect(first).toContain("after=50");
  expect(first).not.toContain('id="row-s1"');
  const last = await (
    await app.request("/sidebar/rows?after=50", { headers })
  ).text();
  expect(last.match(/class="session-row"/g)).toHaveLength(3);
  expect(last).not.toContain("Loading more sessions");
});

it("keeps only matching delegation nodes and does not pin an unstarred selection", async () => {
  const { app, world } = testApp();
  world.store.set(
    "child",
    storedSession({
      id: "child",
      inspectionOnly: true,
      delegation: { parentSessionId: "s1", agent: "coder", handle: "child" },
    }),
  );
  await world.sessions.setStar("child", "a1", true);
  const first = await (
    await app.request("/sidebar/rows", {
      headers: { ...headers, "X-Web-Pi-Session": "s1" },
    })
  ).text();
  expect(first).toContain('id="row-child"');
  expect(first).not.toContain('id="row-s1"');
  await world.sessions.setStar("s1", "a1", true);
  const grouped = await (
    await app.request("/sidebar/rows", { headers })
  ).text();
  expect(grouped).toContain('data-parent-session-id="s1"');
  const children = await (
    await app.request("/sidebar/rows?parent=s1", { headers })
  ).text();
  expect(children).toContain('id="row-child"');
});

it("refreshes the filtered list immediately when an answer is starred, unstarred or cleared", async () => {
  const { app } = testApp();
  for (const starred of [true, false, true]) {
    const response = await app.request("/sessions/s1/star", {
      method: "POST",
      headers,
      body: new URLSearchParams({ entryId: "a1", starred: String(starred) }),
    });
    const html = await response.text();
    expect(html).toContain('hx-target="#session-list"');
    expect(html.includes('id="row-s1"')).toBe(starred);
  }
  const cleared = await (
    await app.request("/sessions/s1/stars/clear", { method: "POST", headers })
  ).text();
  expect(cleared).toContain("No sessions with starred answers");
  expect(cleared).not.toContain('id="row-s1"');
});

it("counts stars across branches and honors the latest unstar", async () => {
  const { app, world } = testApp();
  const stored = world.store.get("s1");
  if (!stored) throw new Error("Missing fixture");
  stored.entries.push(
    userEntry("fork-u", "u1", "Another branch"),
    assistantEntry("fork-a", "fork-u", "Other answer", 100),
  );
  await world.sessions.setStar("s1", "a1", true);
  expect(
    await (await app.request("/sidebar/rows", { headers })).text(),
  ).toContain('id="row-s1"');
  await world.sessions.setStar("s1", "a1", false);
  expect(
    await (await app.request("/sidebar/rows", { headers })).text(),
  ).not.toContain('id="row-s1"');
});
