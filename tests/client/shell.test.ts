import { describe, expect, it, vi } from "vitest";
import {
  byId,
  click,
  field,
  flush,
  htmxEvent,
  keydown,
  mockFetch,
  mount,
  query,
  text,
} from "./helpers.ts";

// The application shell: the title, the sidebar drawer and its drag handle,
// the top-bar panels, the keyboard shortcuts, and the small delegated
// behaviours of the settings pages.

async function load(html: string): Promise<void> {
  mount(html);
  const { setUpShell } = await import("@web/client/shell");
  setUpShell();
}

const SIDEBAR =
  '<aside id="session-sidebar" class="sidebar-mobile-pending">' +
  '<div class="sidebar-resize-handle" tabindex="0"></div></aside>' +
  '<button type="button" id="sidebar-toggle" aria-expanded="false">' +
  "<span data-sidebar-open-icon hidden></span><span data-sidebar-closed-icon></span></button>" +
  '<div class="sidebar-overlay-backdrop"></div>';

describe("the title", () => {
  it("names the opened folder, then the product", async () => {
    await load('<main data-cwd="/home/me/proj" data-session-id="s1"></main>');
    expect(document.title).toBe("proj - web-pi");
  });

  it("stays plain on the index, unless the URL names a folder", async () => {
    await load('<main data-cwd="/home/me/proj" data-session-id=""></main>');
    expect(document.title).toBe("web-pi");
    location.assign("/?cwd=%2Fhome%2Fme%2Fproj");
    await load('<main data-cwd="/home/me/proj" data-session-id=""></main>');
    expect(document.title).toBe("proj - web-pi");
  });
});

describe("the sidebar drawer", () => {
  it("opens on a desktop and toggles from the button and the backdrop", async () => {
    await load(SIDEBAR);
    const sidebar = byId("session-sidebar");
    expect(sidebar.classList.contains("sidebar-open")).toBe(true);
    expect(sidebar.classList.contains("sidebar-mobile-pending")).toBe(false);
    expect(byId("sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(query("[data-sidebar-open-icon]").hidden).toBe(false);
    expect(
      query(".sidebar-overlay-backdrop").classList.contains("is-open"),
    ).toBe(true);
    click(byId("sidebar-toggle"));
    expect(sidebar.classList.contains("sidebar-closed")).toBe(true);
    expect(query("[data-sidebar-closed-icon]").hidden).toBe(false);
    expect(query(".sidebar-resize-handle").hidden).toBe(true);
    expect(
      query(".sidebar-overlay-backdrop").classList.contains("is-open"),
    ).toBe(false);
    click(byId("sidebar-toggle"));
    expect(sidebar.classList.contains("sidebar-open")).toBe(true);
    click(query(".sidebar-overlay-backdrop"));
    expect(sidebar.classList.contains("sidebar-open")).toBe(false);
  });

  it("starts closed on a phone", async () => {
    window.innerWidth = 500;
    await load(SIDEBAR);
    expect(byId("session-sidebar").classList.contains("sidebar-closed")).toBe(
      true,
    );
  });
});

describe("the sidebar width", () => {
  const width = () =>
    document.documentElement.style.getPropertyValue("--sidebar-width");

  it("steps with the arrows, jumps with Home, End and Enter, and remembers", async () => {
    localStorage.setItem("pi-sidebar-width", "400");
    await load(SIDEBAR);
    const handle = query(".sidebar-resize-handle");
    expect(width()).toBe("260px");
    expect(keydown(handle, "ArrowRight").defaultPrevented).toBe(true);
    expect(width()).toBe("272px");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBe("272");
    keydown(handle, "ArrowRight", { shiftKey: true });
    expect(width()).toBe("304px");
    keydown(handle, "ArrowLeft");
    expect(width()).toBe("292px");
    keydown(handle, "Home");
    expect(width()).toBe("180px");
    keydown(handle, "End");
    expect(width()).toBe("480px");
    keydown(handle, "Enter");
    expect(width()).toBe("260px");
    expect(keydown(handle, "a").defaultPrevented).toBe(false);
  });

  it("restores a stored width, clamped to what fits", async () => {
    localStorage.setItem("web-pi-sidebar-width", "9999");
    await load(SIDEBAR);
    expect(width()).toBe("480px");
    window.innerWidth = 600;
    keydown(query(".sidebar-resize-handle"), "End");
    expect(width()).toBe("280px");
  });

  it("follows the pointer and stores the width on release", async () => {
    await load(SIDEBAR);
    const handle = query(".sidebar-resize-handle");
    const press = new PointerEvent("pointerdown", {
      cancelable: true,
      pointerId: 1,
    });
    handle.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 333, pointerId: 1 }),
    );
    expect(width()).toBe("333px");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBeNull();
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(localStorage.getItem("web-pi-sidebar-width")).toBe("333");
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 400, pointerId: 1 }),
    );
    expect(width()).toBe("333px");
    handle.dispatchEvent(new MouseEvent("dblclick"));
    expect(width()).toBe("260px");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBe("260");
  });
});

describe("the top bar", () => {
  // Opening one panel at a time, the outside click and Escape are the
  // browser's: the panels are popovers. What is left is what they answered.
  const PANELS =
    '<div id="top-bar"><button type="button" popovertarget="system-panel"></button>' +
    '<button type="button" popovertarget="tools-panel" data-panel-loaded></button></div>' +
    '<div id="system-panel" class="shell-top-panel" popover="auto"></div>' +
    '<div id="tools-panel" class="shell-top-panel" popover="auto"></div>';

  it("tints a tab from what its panel answered and empties a panel as it closes", async () => {
    await load(PANELS);
    const system = byId("system-panel");
    system.showPopover();
    system.innerHTML =
      '<section class="system-prompt-panel"><div class="system-prompt-text">Be concise.</div></section>';
    htmxEvent(system, "htmx:after:settle");
    expect(
      query('[popovertarget="system-panel"]').hasAttribute("data-panel-loaded"),
    ).toBe(true);
    const tools = byId("tools-panel");
    tools.showPopover();
    tools.innerHTML =
      '<div class="tool-definitions-panel"><div class="tool-definitions-empty">No active tools</div></div>';
    htmxEvent(tools, "htmx:after:settle");
    expect(
      query('[popovertarget="tools-panel"]').hasAttribute("data-panel-loaded"),
    ).toBe(false);
    system.hidePopover();
    expect(system.childElementCount).toBe(0);
    expect(tools.childElementCount).toBe(1);
  });

  it("slides the phone toolbar's tabs in from the more button", async () => {
    await load(
      '<button type="button" id="mobile-toolbar-more" aria-expanded="false">' +
        "<span data-more-closed-icon></span><span data-more-open-icon hidden></span></button>" +
        '<div id="top-bar-tabs"></div>',
    );
    click(byId("mobile-toolbar-more"));
    expect(byId("top-bar-tabs").hasAttribute("data-open")).toBe(true);
    expect(byId("mobile-toolbar-more").title).toBe("Close");
    expect(query("[data-more-open-icon]").hidden).toBe(false);
    click(byId("mobile-toolbar-more"));
    expect(byId("top-bar-tabs").hasAttribute("data-open")).toBe(false);
    expect(byId("mobile-toolbar-more").getAttribute("aria-label")).toBe(
      "More controls",
    );
  });
});

describe("shortcuts", () => {
  const LIST =
    '<main data-session-id="s1"></main><div id="session-list">' +
    '<a href="/sessions/s1">1</a><a href="/sessions/s2">2</a></div>' +
    '<form id="composer" data-session-id="s1"><textarea id="composer-text"></textarea></form>';
  const PANELS =
    '<div id="stats-panel" class="shell-top-panel" popover="auto"></div>' +
    '<div id="row-menu" popover="auto"></div>';

  it("opens a new session on Ctrl+K through the sidebar's link", async () => {
    await load(`${LIST}<a href="/new" data-session-link></a>`);
    const clicked = vi.fn((event: Event) => {
      event.preventDefault();
    });
    query("a[data-session-link]").addEventListener("click", clicked);
    expect(
      keydown(document.body, "k", { ctrlKey: true }).defaultPrevented,
    ).toBe(true);
    expect(clicked).toHaveBeenCalledOnce();
    expect(location.pathname).toBe("/");
    // A dialog over the page keeps the shortcut from reaching under it.
    document.body.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
    keydown(document.body, "k", { metaKey: true });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("loads the new-session page on Ctrl+K when there is no link", async () => {
    await load(LIST);
    keydown(document.body, "k", { ctrlKey: true });
    expect(location.pathname).toBe("/new");
  });

  it("aborts the turn on Escape outside a field, unless a dialog owns it", async () => {
    const fetch = mockFetch(() => text(""));
    await load(LIST);
    keydown(byId("composer-text"), "Escape");
    expect(fetch).not.toHaveBeenCalled();
    keydown(document.body, "Escape");
    expect(fetch).toHaveBeenCalledWith("/sessions/s1/abort", {
      method: "POST",
    });
    document.body.insertAdjacentHTML("beforeend", "<dialog open></dialog>");
    keydown(document.body, "Escape");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("leaves Escape in an editable region to that region", async () => {
    const fetch = mockFetch(() => text(""));
    await load(`${LIST}<div id="editable" contenteditable="true"></div>`);
    keydown(byId("editable"), "Escape");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("closes an open top panel or popover first, and only then aborts", async () => {
    const fetch = mockFetch(() => text(""));
    await load(LIST + PANELS);
    // The browser closes a popover after the key's listeners have run.
    for (const id of ["stats-panel", "row-menu"]) {
      byId(id).showPopover();
      keydown(document.body, "Escape");
      expect(fetch).not.toHaveBeenCalled();
      byId(id).hidePopover();
    }
    keydown(document.body, "Escape");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/sessions/s1/abort", {
      method: "POST",
    });
  });

  it("sends nothing from a page without a composer", async () => {
    const fetch = mockFetch(() => text(""));
    await load('<main data-session-id="s1"></main>');
    keydown(document.body, "Escape");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("settings helpers", () => {
  it("copies a session value and swaps the icon for a moment", async () => {
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await load(
      '<button type="button" data-session-copy="/tmp/s1.jsonl">' +
        "<span data-copy-idle></span><span data-copy-done hidden></span></button>",
    );
    click(query("[data-session-copy]"));
    await flush();
    expect(write).toHaveBeenCalledWith("/tmp/s1.jsonl");
    expect(query("[data-copy-done]").hidden).toBe(false);
    expect(query("[data-copy-idle]").hidden).toBe(true);
    expect(query("[data-session-copy]").classList.contains("is-copied")).toBe(
      true,
    );
    vi.advanceTimersByTime(1400);
    expect(query("[data-copy-done]").hidden).toBe(true);
    expect(query("[data-session-copy]").classList.contains("is-copied")).toBe(
      false,
    );
  });

  it("fills the plugin source from an example", async () => {
    await load(
      '<input id="plugin-source"><button type="button" data-plugin-example="npm:pi-x">x</button>',
    );
    click(query("[data-plugin-example]"));
    expect(field("#plugin-source").value).toBe("npm:pi-x");
  });

  it("reloads the page from the refresh button", async () => {
    const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
    await load('<button type="button" id="page-refresh"></button>');
    click(byId("page-refresh"));
    expect(reload).toHaveBeenCalledOnce();
  });
});
