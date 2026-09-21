import type { SidebarView } from "@core/workspace";
import { RenameRow, SessionList, SessionRow } from "@web/views/Sidebar";
import { describe, expect, it, vi } from "vitest";
import {
  blockStorage,
  byId,
  click,
  htmx,
  htmxEvent,
  keydown,
  mount,
  query,
  render,
} from "./helpers.ts";

const OPEN_KEY = "web-pi:session-tree:open";

function row(id: string, inspectionOnly = false): SidebarView["rows"][number] {
  return {
    summary: {
      id,
      cwd: `/repo/${id}`,
      name: id,
      branch: "feature/tree",
      inspectionOnly,
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 0,
    },
    metadata: {
      firstMessage: id,
      messageCount: 2,
      starCount: 0,
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 0,
    },
  };
}

function tree(loaded = true): SidebarView {
  return {
    rows: [
      {
        ...row("parent"),
        childCount: 2,
        ...(loaded
          ? {
              children: {
                parentId: "parent",
                rows: [
                  {
                    ...row("child", true),
                    childCount: 1,
                    children: {
                      parentId: "child",
                      rows: [row("grandchild", true)],
                    },
                  },
                  row("sibling", true),
                ],
              },
            }
          : {}),
      },
      row("other"),
    ],
  };
}

function markup(view = tree()): string {
  return render(SessionList({ view }));
}

async function setup(active = "", view = tree()): Promise<void> {
  mount(
    `<main data-session-id="${active}"></main><aside id="sidebar">${markup(view)}</aside>`,
  );
  const { setUpSidebar } = await import("@web/client/sidebar");
  setUpSidebar();
}

function details(id: string): HTMLDetailsElement {
  return query(`#node-${id} > details`) as HTMLDetailsElement;
}

function toggle(id: string, open: boolean): void {
  const disclosure = details(id);
  disclosure.open = open;
}

function navigate(id: string): void {
  query("main").dataset["sessionId"] = id;
  htmxEvent(query("main"), "htmx:after:process");
}

function replaceList(view = tree()): void {
  byId("session-list").outerHTML = markup(view);
  htmxEvent(byId("session-list"), "htmx:after:process");
  htmxEvent(byId("session-list"), "htmx:after:settle");
}

describe("sidebar tree cards", () => {
  it("puts the direct-child disclosure after the whole row, not inside its link, and omits it at zero", async () => {
    await setup();
    expect(details("parent").previousElementSibling).toBe(byId("row-parent"));
    expect(query("#node-parent > details > summary").textContent).toContain(
      "2 sub-sessions",
    );
    expect(query("#node-child > details > summary").textContent).toContain(
      "1 sub-session",
    );
    expect(byId("node-other").querySelector("details")).toBeNull();
    expect(byId("row-parent").querySelector("summary")).toBeNull();
    const openSession = vi.spyOn(query("#row-parent a"), "click");
    click(byId("row-parent"));
    expect(openSession).toHaveBeenCalledOnce();
    expect(details("parent").open).toBe(false);
    click(query("#node-parent > details > summary"));
    expect(openSession).toHaveBeenCalledOnce();
  });

  it.each(["child", "subagent.abc123"])(
    "keeps %s's identity but has no activity or menu icon even at the root",
    async (id) => {
      await setup(id, { rows: [row(id, id === "child")] });
      const card = byId(`row-${id}`);
      expect(card.classList.contains("is-selected")).toBe(true);
      expect(
        card.querySelector(
          ".session-indicator, .session-menu-trigger, .session-row-menu",
        ),
      ).toBeNull();
      expect(card.querySelector(".session-row-title")?.textContent).toBe(id);
      expect(
        card.querySelector(".session-row-folder")?.getAttribute("title"),
      ).toBe(`/repo/${id}`);
      expect(card.querySelector(".session-branch-name")?.textContent).toBe(
        "feature/tree",
      );
      expect(card.querySelector("[data-session-modified-at]")).not.toBeNull();
    },
  );

  it("retains the same disclosure and children through rename, star and stop row replacements", async () => {
    await setup("grandchild");
    const disclosure = details("parent");
    const child = byId("node-child");
    for (const replacement of [
      RenameRow(row("parent")),
      SessionRow({
        ...row("parent"),
        metadata: { ...row("parent").metadata, name: "Renamed", starCount: 3 },
      }),
      SessionRow({
        ...row("parent"),
        summary: { ...row("parent").summary, live: false },
      }),
    ]) {
      byId("row-parent").outerHTML = render(replacement);
      htmxEvent(byId("row-parent"), "htmx:after:process");
      htmxEvent(byId("row-parent"), "htmx:after:settle");
      expect(details("parent")).toBe(disclosure);
      expect(disclosure.open).toBe(true);
      expect(byId("node-child")).toBe(child);
      expect(query("#node-parent > details > summary").textContent).toContain(
        "2 sub-sessions",
      );
    }
  });
});

describe("sidebar expansion preferences", () => {
  it("starts collapsed and remembers each level across list replacements", async () => {
    await setup();
    expect(details("parent").open).toBe(false);
    expect(details("child").open).toBe(false);
    toggle("parent", true);
    toggle("child", true);
    toggle("parent", false);
    replaceList();
    expect(details("parent").open).toBe(false);
    expect(details("child").open).toBe(true);
    expect(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}")).toEqual({
      parent: false,
      child: true,
    });
    toggle("parent", true);
    expect(details("child").open).toBe(true);
  });

  it("reveals the selected path without saving it, then restores collapsed choices on departure", async () => {
    localStorage.setItem(
      OPEN_KEY,
      JSON.stringify({ parent: false, child: false }),
    );
    await setup("grandchild");
    expect(details("parent").open).toBe(true);
    expect(details("child").open).toBe(true);
    details("parent").dispatchEvent(new Event("toggle"));
    details("child").dispatchEvent(new Event("toggle"));
    expect(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}")).toEqual({
      parent: false,
      child: false,
    });
    navigate("other");
    expect(details("parent").open).toBe(false);
    expect(details("child").open).toBe(false);
    expect(query("#row-other").classList.contains("is-selected")).toBe(true);
  });

  it("preserves user collapse of the selected path until selection changes", async () => {
    await setup("grandchild");
    toggle("parent", false);
    htmxEvent(byId("row-parent"), "htmx:after:settle");
    expect(details("parent").open).toBe(false);
    replaceList();
    expect(details("parent").open).toBe(false);
    navigate("sibling");
    expect(details("parent").open).toBe(true);
    navigate("other");
    expect(details("parent").open).toBe(false);
  });

  it("keeps preferences for this page when localStorage is blocked", async () => {
    blockStorage();
    await setup();
    toggle("parent", true);
    replaceList();
    expect(details("parent").open).toBe(true);
  });

  it("asks HTMX for children only on expansion, including saved nested disclosures when their ancestor opens", async () => {
    await setup("", tree(false));
    const placeholder = query(".session-children-loading");
    const request = vi.fn();
    placeholder.addEventListener("web-pi:children", request);
    expect(request).not.toHaveBeenCalled();
    toggle("parent", true);
    expect(request).toHaveBeenCalledOnce();
    toggle("parent", false);
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("visible shortcuts and selection recovery", () => {
  it("numbers and jumps only visible rows, including children when expanded", async () => {
    await setup();
    const other = vi.spyOn(query("#row-other a"), "click");
    const child = vi.spyOn(query("#row-child a"), "click");
    keydown(document.body, "Meta", { metaKey: true });
    expect(query("#row-other .session-shortcut").textContent).toBe("⌘2");
    expect(query("#row-child .session-shortcut").hidden).toBe(true);
    keydown(document.body, "2", { metaKey: true });
    expect(other).toHaveBeenCalledOnce();
    toggle("parent", true);
    expect(query("#row-child .session-shortcut").textContent).toBe("⌘2");
    expect(query("#row-grandchild .session-shortcut").hidden).toBe(true);
    keydown(document.body, "2", { metaKey: true });
    expect(child).toHaveBeenCalledOnce();
    toggle("parent", false);
    expect(query("#row-other .session-shortcut").textContent).toBe("⌘2");
  });

  it("requests a missing selected path once and does not loop on a nonexistent ID", async () => {
    await setup("missing");
    await Promise.resolve();
    await Promise.resolve();
    expect(htmx().ajax).toHaveBeenCalledOnce();
    expect(htmx().ajax).toHaveBeenCalledWith(
      "GET",
      "/sidebar/rows?selected=missing",
      expect.objectContaining({
        target: byId("session-list"),
        swap: "innerHTML",
      }),
    );
    replaceList();
    navigate("missing");
    expect(htmx().ajax).toHaveBeenCalledOnce();
    navigate("other");
    navigate("another-missing");
    expect(htmx().ajax).toHaveBeenCalledTimes(2);
  });

  it("uses the displayed session rather than stale paging selection", async () => {
    await setup("other");
    const ctx = {
      request: { action: "/sidebar/rows?parent=parent&after=50&selected=old" },
    };
    htmxEvent(byId("session-list"), "htmx:config:request", { ctx });
    expect(ctx.request.action).toBe(
      "/sidebar/rows?parent=parent&after=50&selected=other",
    );
  });
});
