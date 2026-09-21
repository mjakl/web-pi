import { createFakeWorld, type FakeStoredSession } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { afterEach, describe, expect, it } from "vitest";
import { Window, type HTMLDetailsElement, type HTMLElement } from "happy-dom";
import { htmxBrowser } from "#/web/htmx4-browser";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
});

function session(id: string, parent?: string, age = 0): FakeStoredSession {
  return {
    summary: {
      id,
      cwd: `/repo/${id}`,
      name: id,
      fileSize: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: new Date(Date.UTC(2026, 8, 20) - age * 1000).toISOString(),
      ...(parent === undefined
        ? {}
        : {
            inspectionOnly: true,
            delegation: { parentSessionId: parent, agent: "coder", handle: id },
          }),
    },
    entries: [],
  };
}

function fixture(
  sessions = [
    session("parent"),
    session("child", "parent"),
    session("grandchild", "child"),
    session("sibling", "parent"),
    session("other"),
  ],
) {
  const world = createFakeWorld({ sessions });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: "/repo",
    staticRoot: "static",
  });
  return { world, workspace, app };
}

async function browse(active = "other", sessions?: FakeStoredSession[]) {
  const f = fixture(sessions);
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${active}`)).text(),
    (request) => f.app.request(request),
  );
  browsers.push(browser);
  await expect
    .poll(() =>
      browser.requests.some((r) => new URL(r.url).pathname === "/events"),
    )
    .toBe(true);
  return { ...f, ...browser };
}

function ids(markup: string): string[] {
  const window = new Window();
  window.document.body.innerHTML = markup;
  return [...window.document.querySelectorAll(".session-row")].map(
    (row) => row.getAttribute("data-session-id") ?? "",
  );
}

function disclosure(
  b: Awaited<ReturnType<typeof browse>>,
  id: string,
): HTMLDetailsElement {
  const element = b.document.querySelector<HTMLDetailsElement>(
    `#node-${id} > details`,
  );
  if (!element) throw new Error(`Missing ${id}'s disclosure`);
  return element;
}

function toggle(
  b: Awaited<ReturnType<typeof browse>>,
  id: string,
  open: boolean,
): void {
  const details = disclosure(b, id);
  details.open = open;
}

function click(b: Awaited<ReturnType<typeof browse>>, selector: string): void {
  const element = b.document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  element.click();
}

describe("sidebar tree HTTP fragments", () => {
  it("renders roots only until a parent is requested, with direct rather than descendant counts", async () => {
    const { app } = fixture();
    const roots = await (await app.request("/sidebar/rows")).text();
    expect(ids(roots)).toEqual(["other", "parent"]);
    expect(roots).toContain("2 sub-sessions");
    expect(roots).not.toContain('id="row-child"');
    const children = await (
      await app.request("/sidebar/rows?parent=parent")
    ).text();
    expect(ids(children)).toEqual(["child", "sibling"]);
    expect(children).toContain("1 sub-session");
    expect(children).not.toContain("session-indicator");
    expect(children).not.toContain("session-menu-trigger");
  });

  it("pins the selected ancestry beyond each first sibling page and excludes pins on later pages", async () => {
    const { app } = fixture([
      ...Array.from({ length: 55 }, (_, i) =>
        session(`root-${String(i)}`, undefined, i),
      ),
      session("parent", undefined, 100),
      ...Array.from({ length: 55 }, (_, i) =>
        session(`child-${String(i)}`, "parent", 100 + i),
      ),
      session("selected", "parent", 200),
    ]);
    const first = await (
      await app.request("/sidebar/rows?selected=selected")
    ).text();
    expect(ids(first)).toContain("parent");
    expect(ids(first)).toContain("selected");
    expect(ids(first)).not.toContain("root-50");
    expect(first).toContain("after=50&amp;parent=parent&amp;selected=selected");
    const laterRoots = await (
      await app.request("/sidebar/rows?after=50&selected=selected")
    ).text();
    expect(ids(laterRoots)).toEqual([
      "root-50",
      "root-51",
      "root-52",
      "root-53",
      "root-54",
    ]);
    const laterChildren = await (
      await app.request(
        "/sidebar/rows?after=50&parent=parent&selected=selected",
      )
    ).text();
    expect(ids(laterChildren)).toEqual([
      "child-50",
      "child-51",
      "child-52",
      "child-53",
      "child-54",
    ]);
    const displayedWins = await (
      await app.request("/sidebar/rows?selected=selected", {
        headers: { "X-Web-Pi-Session": "root-1" },
      })
    ).text();
    expect(ids(displayedWins)).not.toContain("parent");
    const blankSelection = await (
      await app.request("/sidebar/rows?selected=", {
        headers: { Cookie: "web-pi-session=selected" },
      })
    ).text();
    expect(ids(blankSelection)).not.toContain("parent");
  });

  it.each(["child", "subagent.abc123"])(
    "rejects the rename editor for inspection-only %s",
    async (id) => {
      const { app } = fixture([
        session("parent"),
        session("child", "parent"),
        session("subagent.abc123"),
      ]);
      const response = await app.request(`/sessions/${id}/rename`);
      expect(await response.text()).not.toContain("session-rename-input");
      expect(response.status).toBe(403);
    },
  );
});

describe("sidebar tree with native HTMX", () => {
  it("loads children on opening, keeps them through rename, and restores browser choices after stream/list replacement", async () => {
    const b = await browse();
    expect(b.document.querySelector("#row-child")).toBeNull();
    expect(
      b.requests.filter((r) => new URL(r.url).pathname === "/sidebar/rows"),
    ).toHaveLength(0);
    toggle(b, "parent", true);
    await expect
      .poll(() => b.document.querySelector("#row-child"))
      .not.toBeNull();
    expect(b.document.querySelector("#row-grandchild")).toBeNull();
    const savedChild = b.document.querySelector("#node-child");
    const savedDisclosure = disclosure(b, "parent");
    click(b, '#row-parent [hx-get="/sessions/parent/rename"]');
    await expect
      .poll(() => b.document.querySelector("#row-parent input"))
      .not.toBeNull();
    await b.window.eval(
      `htmx.ajax('POST', '/sessions/parent/rename', {source:'#row-parent', target:'#row-parent', swap:'outerHTML', values:{name:'Renamed parent'}})`,
    );
    expect(b.document.querySelector("#row-parent")?.textContent).toContain(
      "Renamed parent",
    );
    expect(b.document.querySelector("#node-child")).toBe(savedChild);
    expect(disclosure(b, "parent")).toBe(savedDisclosure);
    expect(disclosure(b, "parent").open).toBe(true);
    b.world.store.set("new-child", session("new-child", "parent"));
    await b.workspace.activate("parent");
    await expect
      .poll(() => disclosure(b, "parent") !== savedDisclosure)
      .toBe(true);
    await expect
      .poll(() => b.document.querySelector("#row-new-child"))
      .not.toBeNull();
    expect(disclosure(b, "parent").open).toBe(true);
    expect(
      disclosure(b, "parent").querySelector("summary")?.textContent,
    ).toContain("3 sub-sessions");
    toggle(b, "parent", false);
    const previous = disclosure(b, "parent");
    await b.workspace.stop("parent");
    await expect.poll(() => disclosure(b, "parent") !== previous).toBe(true);
    expect(disclosure(b, "parent").open).toBe(false);
    expect(b.document.querySelector("#row-child")).toBeNull();
  });

  it("recovers selected ancestry after navigation and repeated global stream replacements without persisting the reveal", async () => {
    const b = await browse();
    await b.window.eval(
      `htmx.ajax('GET', '/sessions/grandchild', {source:'#session-region', target:'#session-region', swap:'outerHTML'})`,
    );
    await expect
      .poll(() => b.document.querySelector("#row-grandchild.is-selected"))
      .not.toBeNull();
    expect(disclosure(b, "parent").open).toBe(true);
    expect(disclosure(b, "child").open).toBe(true);
    expect(
      b.window.localStorage.getItem("web-pi:session-tree:open"),
    ).toBeNull();
    for (const act of [
      () => b.workspace.activate("parent"),
      () => b.workspace.stop("parent"),
    ]) {
      const previous = disclosure(b, "parent");
      await act();
      await expect.poll(() => disclosure(b, "parent") !== previous).toBe(true);
      await expect
        .poll(() => b.document.querySelector("#row-grandchild.is-selected"))
        .not.toBeNull();
      expect(disclosure(b, "child").open).toBe(true);
      expect(b.document.querySelectorAll("#row-grandchild")).toHaveLength(1);
    }
    click(b, "#row-other a");
    await expect
      .poll(() =>
        b.document.querySelector("main")?.getAttribute("data-session-id"),
      )
      .toBe("other");
    expect(disclosure(b, "parent").open).toBe(false);
    expect(disclosure(b, "child").open).toBe(false);
    expect(
      b.window.localStorage.getItem("web-pi:session-tree:open"),
    ).toBeNull();
  });

  it("does not duplicate a formerly pinned row when later sibling pages arrive after navigation", async () => {
    const b = await browse("pinned", [
      ...Array.from({ length: 55 }, (_, i) =>
        session(`root-${String(i)}`, undefined, i),
      ),
      session("pinned", undefined, 100),
    ]);
    await expect
      .poll(() => b.document.querySelector("#row-pinned"))
      .not.toBeNull();
    click(b, "#row-root-1 a");
    await expect
      .poll(() =>
        b.document.querySelector("main")?.getAttribute("data-session-id"),
      )
      .toBe("root-1");
    await b.window.eval(
      `htmx.ajax('GET', '/sidebar/rows?after=50&selected=pinned', {source:'.session-rows-loading',target:'.session-rows-loading',swap:'outerHTML'})`,
    );
    expect(b.document.querySelectorAll("#row-pinned")).toHaveLength(1);
    expect(b.document.querySelector("#row-root-54")).not.toBeNull();
    const last = b.requests
      .filter((r) => new URL(r.url).pathname === "/sidebar/rows")
      .at(-1);
    expect(
      new URL(last?.url ?? "http://missing").searchParams.get("selected"),
    ).toBe("root-1");
  });

  it("keeps a pending sibling page usable when selection changes before it arrives", async () => {
    const f = fixture([
      ...Array.from({ length: 55 }, (_, i) =>
        session(`root-${String(i)}`, undefined, i),
      ),
      session("pinned", undefined, 100),
    ]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const browser = await htmxBrowser(
      await (await f.app.request("/sessions/pinned")).text(),
      async (request) => {
        if (new URL(request.url).searchParams.get("after") === "50") await gate;
        return f.app.request(request);
      },
    );
    browsers.push(browser);
    const b = { ...f, ...browser };
    try {
      await expect
        .poll(() => b.document.querySelector("#row-pinned"))
        .not.toBeNull();
      b.window.eval(
        `window.pendingPage = htmx.ajax('GET', '/sidebar/rows?after=50', {source:'.session-rows-loading',target:'.session-rows-loading',swap:'outerHTML'}); undefined`,
      );
      await expect
        .poll(() =>
          b.requests.some(
            (r) => new URL(r.url).searchParams.get("after") === "50",
          ),
        )
        .toBe(true);
      click(b, "#row-root-1 a");
      await expect
        .poll(() =>
          b.document.querySelector("main")?.getAttribute("data-session-id"),
        )
        .toBe("root-1");
      release();
      await b.window.eval("window.pendingPage");
      expect(b.document.querySelector("#row-root-54")).not.toBeNull();
      expect(b.document.querySelectorAll("#row-pinned")).toHaveLength(1);
      expect(
        b.document.querySelector("#row-root-1.is-selected"),
      ).not.toBeNull();
    } finally {
      release();
    }
  });

  it.each(["other", "parent"])(
    "promotes children immediately when deleting a parent while viewing %s",
    async (active) => {
      const b = await browse(active);
      const main = b.document.querySelector("main");
      await b.window.eval(
        `htmx.ajax('POST', '/sessions/parent/delete', {source:'#row-parent',target:'#row-parent',swap:'outerHTML'})`,
      );
      await expect
        .poll(() => b.document.querySelector("#row-parent"))
        .toBeNull();
      await expect
        .poll(() => b.document.querySelector("#session-list > #node-child"))
        .not.toBeNull();
      expect(
        b.document.querySelector("#session-list > #node-sibling"),
      ).not.toBeNull();
      expect(b.world.store.has("child")).toBe(true);
      expect(b.world.store.has("grandchild")).toBe(true);
      if (active === "parent") {
        await expect
          .poll(() =>
            b.document.querySelector("main")?.getAttribute("data-session-id"),
          )
          .toBeNull();
        expect(b.window.location.pathname).toBe("/new");
      } else expect(b.document.querySelector("main")).toBe(main);
    },
  );
});
