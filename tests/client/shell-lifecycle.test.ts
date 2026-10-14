import { describe, expect, it, vi } from "vitest";
import { byId, click, htmxEvent, keydown, mount, query } from "./helpers.ts";

const shell =
  '<main data-session-id="s1" data-cwd="/repo/one">' +
  '<aside id="session-sidebar" class="sidebar-mobile-pending"><div class="sidebar-resize-handle" tabindex="0"></div></aside>' +
  '<button id="sidebar-toggle"></button><div class="sidebar-overlay-backdrop"></div>' +
  '<button id="mobile-toolbar-more"><span data-more-closed-icon></span><span data-more-open-icon hidden></span></button>' +
  '<div id="top-bar-tabs"></div></main>';

async function load(): Promise<void> {
  mount(shell);
  const { setUpShell } = await import("@web/client/shell");
  setUpShell();
}

function replaceBody(): void {
  const replacement = document.createElement("body");
  replacement.innerHTML = shell.replace("/repo/one", "/repo/two");
  document.body.replaceWith(replacement);
  htmxEvent(document.body, "htmx:after:process");
  htmxEvent(document.body, "htmx:after:process");
}

describe("shell region replacement", () => {
  it("mounts a fresh drawer, resize handle, toolbar and title without rerunning setup", async () => {
    await load();
    const oldHandle = query(".sidebar-resize-handle");
    const oldMore = byId("mobile-toolbar-more");
    const oldTabs = byId("top-bar-tabs");
    click(byId("sidebar-toggle"));
    click(oldMore);
    replaceBody();
    expect(document.title).toBe("two - web-pi");
    expect(byId("session-sidebar").classList.contains("sidebar-open")).toBe(
      true,
    );
    click(byId("sidebar-toggle"));
    expect(byId("session-sidebar").classList.contains("sidebar-closed")).toBe(
      true,
    );
    click(byId("sidebar-toggle"));
    click(query(".sidebar-overlay-backdrop"));
    expect(byId("session-sidebar").classList.contains("sidebar-closed")).toBe(
      true,
    );
    keydown(oldHandle, "ArrowRight");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBeNull();
    keydown(query(".sidebar-resize-handle"), "ArrowRight");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBe("272");
    click(oldMore);
    expect(oldTabs.hasAttribute("data-open")).toBe(true);
    click(byId("mobile-toolbar-more"));
    expect(byId("top-bar-tabs").hasAttribute("data-open")).toBe(true);
  });

  it("releases an in-progress drag when its handle is cleaned up", async () => {
    await load();
    const handle = query(".sidebar-resize-handle");
    const release = vi.spyOn(handle, "releasePointerCapture");
    handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 7 }));
    htmxEvent(handle, "htmx:before:cleanup");
    expect(release).toHaveBeenCalledWith(7);
    handle.dispatchEvent(
      new PointerEvent("pointermove", { pointerId: 7, clientX: 400 }),
    );
    expect(
      document.documentElement.style.getPropertyValue("--sidebar-width"),
    ).toBe("260px");
    expect(localStorage.getItem("web-pi-sidebar-width")).toBeNull();
  });

  it("keeps replacement drawers closed on phones", async () => {
    window.innerWidth = 500;
    await load();
    click(byId("sidebar-toggle"));
    replaceBody();
    expect(byId("session-sidebar").classList.contains("sidebar-closed")).toBe(
      true,
    );
    expect(
      byId("session-sidebar").classList.contains("sidebar-mobile-pending"),
    ).toBe(false);
  });
});
