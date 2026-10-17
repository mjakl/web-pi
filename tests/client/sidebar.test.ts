import type { SessionSummary } from "@core/sessions";
import { SessionRow } from "@web/views/Sidebar";
import { describe, expect, it, vi } from "vitest";
import {
  blockStorage,
  byId,
  click,
  field,
  htmxEvent,
  keydown,
  keyup,
  mount,
  query,
  render,
  setRect,
  type,
} from "./helpers.ts";

// The sidebar's browser half against the rows views/Sidebar.tsx renders:
// unread dots in localStorage, the project filter, the modifier badges and
// digit shortcuts, and where a row's menu lands.

function load() {
  return import("@web/client/sidebar");
}

function summary(
  id: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: "/repo/one",
    createdAt: "2026-09-01T00:00:00.000Z",
    modifiedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 10,
    ...extra,
  };
}

function row(id: string, extra: Partial<SessionSummary> = {}): string {
  return render(
    SessionRow({
      summary: summary(id, extra),
      metadata: {
        firstMessage: `Prompt ${id}`,
        messageCount: 2,
        starCount: 0,
        modifiedAt: "2026-09-02T00:00:00.000Z",
        fileSize: 10,
      },
    }),
  );
}

function page(options: { current?: string; rows?: string[] } = {}): void {
  const rows = (options.rows ?? ["s1", "s2"]).map((id) => row(id)).join("");
  mount(
    `<main data-session-id="${options.current ?? ""}"></main>` +
      `<aside id="sidebar">` +
      `<button type="button" class="new-session-shortcut" hidden></button>` +
      `<span class="new-session-plus">+</span>` +
      `<div id="sidebar-project-menu"></div>` +
      `<div id="session-list">${rows}</div>` +
      `<div id="sidebar-stream"></div>` +
      `</aside>`,
  );
}

function indicator(id: string): HTMLElement {
  return query(`#row-${id} .session-indicator`);
}

function finished(id: string, project: string): void {
  htmxEvent(byId("sidebar-stream"), "finished", {
    data: JSON.stringify({ id, project }),
  });
}

describe("session card locations", () => {
  it.each([false, true])(
    "shows the branch for a checkout with isWorktree=%s",
    (isWorktree) => {
      mount(
        row("s1", {
          branch: "feature/session-cards",
          isWorktree,
          cwdAvailable: true,
        }),
      );
      const location = query(".session-row-location");
      expect(location.textContent).toContain("one");
      expect(location.textContent).toContain("feature/session-cards");
      expect(location.classList.contains("is-unavailable")).toBe(false);
      expect(query(".session-row-folder").title).toBe("/repo/one");
      expect(query(".session-row-meta").textContent).toContain("2 msgs");
      expect(location.querySelector("[data-session-modified-at]")).toBeNull();
    },
  );

  it("marks a missing directory as unavailable while keeping its session link", () => {
    mount(
      row("s1", {
        cwd: "/repo/deleted-worktree",
        cwdAvailable: false,
        branch: "old-branch",
        isWorktree: true,
      }),
    );
    expect(
      query(".session-row-location").classList.contains("is-unavailable"),
    ).toBe(true);
    expect(query(".session-row-folder").title).toBe(
      "/repo/deleted-worktree (Working directory unavailable)",
    );
    expect(query(".session-row-link").getAttribute("href")).toBe(
      "/sessions/s1",
    );
    expect(query(".session-branch-name").textContent).toBe("old-branch");
  });
});

describe("relative timestamps", () => {
  it("keeps the existing unit thresholds as time passes", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:59.000Z"));
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    const age = query("#row-s1 [data-session-modified-at]");
    expect(age.textContent).toBe("59 seconds ago");
    vi.advanceTimersByTime(1000);
    expect(age.textContent).toBe("1 minute ago");
    vi.setSystemTime(new Date("2026-09-02T00:59:59.000Z"));
    vi.advanceTimersByTime(1000);
    expect(age.textContent).toBe("1 hour ago");
    vi.setSystemTime(new Date("2026-09-02T23:59:59.000Z"));
    vi.advanceTimersByTime(1000);
    expect(age.textContent).toBe("1 day ago");
  });

  it("updates replaced and appended rows using their current modification times", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:30.000Z"));
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    byId("row-s1").outerHTML = row("s1", {
      modifiedAt: "2026-09-02T00:00:25.000Z",
    });
    byId("session-list").insertAdjacentHTML("beforeend", row("s3"));
    htmxEvent(byId("row-s1"), "htmx:after:process");
    htmxEvent(byId("row-s3"), "htmx:after:process");
    vi.advanceTimersByTime(1000);
    expect(query("#row-s1 [data-session-modified-at]").textContent).toBe(
      "6 seconds ago",
    );
    expect(query("#row-s3 [data-session-modified-at]").textContent).toBe(
      "31 seconds ago",
    );
  });

  it("releases the old sidebar clock and updates a replacement body", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:30.000Z"));
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    const oldAge = query("#row-s1 [data-session-modified-at]");
    const replacement = document.createElement("body");
    replacement.innerHTML = document.body.innerHTML;
    document.body.replaceWith(replacement);
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    vi.advanceTimersByTime(1000);
    expect(oldAge.textContent).toBe("30 seconds ago");
    expect(query("#row-s1 [data-session-modified-at]").textContent).toBe(
      "31 seconds ago",
    );
    expect(vi.getTimerCount()).toBe(2);
    htmxEvent(byId("sidebar"), "htmx:before:cleanup");
    byId("sidebar").remove();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up immediately on foreground return and page restoration", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:30.000Z"));
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    const age = query("#row-s1 [data-session-modified-at]");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10_000);
    expect(age.textContent).toBe("30 seconds ago");
    vi.setSystemTime(new Date("2026-09-02T00:05:00.000Z"));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(age.textContent).toBe("5 minutes ago");
    vi.setSystemTime(new Date("2026-09-02T00:06:00.000Z"));
    window.dispatchEvent(new Event("pageshow"));
    expect(age.textContent).toBe("6 minutes ago");
  });

  it("ages an idle row every second without changing its timestamp or order", async () => {
    vi.setSystemTime(new Date("2026-09-02T00:00:30.000Z"));
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    const age = query('#row-s1 [title="2026-09-02T00:00:00.000Z"]');
    expect(age.textContent).toBe("30 seconds ago");
    vi.advanceTimersByTime(1000);
    expect(age.textContent).toBe("31 seconds ago");
    expect(age.title).toBe("2026-09-02T00:00:00.000Z");
    expect(
      [...document.querySelectorAll(".session-row")].map((el) => el.id),
    ).toEqual(["row-s1", "row-s2"]);
  });
});

describe("sidebar replacement", () => {
  it("clears the destination unread badge and keeps delegated completion and row selection working", async () => {
    page({ current: "s1" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    finished("s2", "/repo/one");
    const replacement = document.createElement("body");
    replacement.innerHTML = document.body.innerHTML.replace(
      'data-session-id="s1"',
      'data-session-id="s2"',
    );
    document.body.replaceWith(replacement);
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      false,
    );
    finished("s1", "/repo/one");
    expect(indicator("s1").classList.contains("session-indicator-unread")).toBe(
      true,
    );
    const select = vi.spyOn(query("#row-s1 a"), "click");
    click(byId("row-s1"));
    expect(select).toHaveBeenCalledOnce();
  });

  it("releases refresh feedback timers and restores the explorer fold on replacement", async () => {
    mount(
      '<aside id="sidebar"><button id="sidebar-refresh"></button><button id="explorer-toggle" aria-expanded="true"></button></aside>',
    );
    const { setUpSidebar } = await load();
    setUpSidebar();
    const oldButton = byId("sidebar-refresh");
    click(byId("explorer-toggle"));
    htmxEvent(oldButton, "htmx:after:request");
    const replacement = document.createElement("body");
    replacement.innerHTML = document.body.innerHTML;
    document.body.replaceWith(replacement);
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    expect(byId("explorer-toggle").getAttribute("aria-expanded")).toBe("false");
    click(byId("explorer-toggle"));
    expect(byId("explorer-toggle").getAttribute("aria-expanded")).toBe("true");
    htmxEvent(byId("sidebar-refresh"), "htmx:after:request");
    vi.advanceTimersByTime(2000);
    expect(oldButton.hasAttribute("data-done")).toBe(true);
    expect(byId("sidebar-refresh").hasAttribute("data-done")).toBe(false);
  });
});

describe("unread sessions", () => {
  it("marks a session that finished elsewhere and stores it", async () => {
    page({ current: "s1" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    finished("s2", "/repo/one");
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      true,
    );
    expect(indicator("s2").title).toBe("Session stopped · New activity");
    expect(indicator("s1").classList.contains("session-indicator-unread")).toBe(
      false,
    );
    expect(JSON.parse(localStorage.getItem("web-pi:unread") ?? "{}")).toEqual({
      s2: "",
    });
  });

  it("dismisses the previous completion on restart and marks the next completion", async () => {
    page({ current: "s1", rows: ["s1", "s2", "s3"] });
    const { setUpSidebar } = await load();
    setUpSidebar();
    finished("s2", "/repo/one");
    finished("s3", "/repo/one");

    byId("row-s2").outerHTML = row("s2", { running: true, live: true });
    htmxEvent(byId("row-s2"), "htmx:after:settle");
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      false,
    );
    expect(indicator("s2").classList.contains("is-running")).toBe(true);
    expect(indicator("s2").title).toBe("Agent running…");
    expect(indicator("s2").getAttribute("aria-label")).toBe("Agent running…");
    expect(JSON.parse(localStorage.getItem("web-pi:unread") ?? "{}")).toEqual({
      s3: "",
    });
    expect(indicator("s3").classList.contains("session-indicator-unread")).toBe(
      true,
    );

    byId("row-s2").outerHTML = row("s2", { live: true });
    htmxEvent(byId("row-s2"), "htmx:after:settle");
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      false,
    );
    finished("s2", "/repo/one");
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      true,
    );
    expect(indicator("s2").classList.contains("is-active")).toBe(true);
    expect(indicator("s2").title).toBe("Session active · New activity");
    expect(JSON.parse(localStorage.getItem("web-pi:unread") ?? "{}")).toEqual({
      s3: "",
      s2: "",
    });
  });

  it.each(["initial", "later", "restored"])(
    "clears stored unread state for a running row on %s load",
    async (arrival) => {
      localStorage.setItem("web-pi:unread", JSON.stringify(["s2", "s3"]));
      page({ current: "s1", rows: ["s1", "s3"] });
      if (arrival === "initial")
        byId("session-list").insertAdjacentHTML(
          "beforeend",
          row("s2", { running: true }),
        );
      const { setUpSidebar } = await load();
      setUpSidebar();
      if (arrival === "later") {
        byId("session-list").insertAdjacentHTML(
          "beforeend",
          row("s2", { running: true }),
        );
        htmxEvent(byId("row-s2"), "htmx:after:settle");
      } else if (arrival === "restored") {
        const replacement = document.createElement("body");
        replacement.innerHTML = document.body.innerHTML;
        replacement
          .querySelector("#session-list")
          ?.insertAdjacentHTML("beforeend", row("s2", { running: true }));
        document.body.replaceWith(replacement);
        htmxEvent(document.body, "htmx:after:process");
      }
      expect(
        indicator("s2").classList.contains("session-indicator-unread"),
      ).toBe(false);
      expect(JSON.parse(localStorage.getItem("web-pi:unread") ?? "{}")).toEqual(
        { s3: "" },
      );
      expect(
        indicator("s3").classList.contains("session-indicator-unread"),
      ).toBe(true);
    },
  );

  it("never marks the session on screen", async () => {
    page({ current: "s1" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    finished("s1", "/repo/one");
    expect(localStorage.getItem("web-pi:unread")).toBeNull();
  });

  it("clears the mark when the session is opened", async () => {
    localStorage.setItem("web-pi:unread", JSON.stringify({ s1: "/repo/one" }));
    page({ current: "s1" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    expect(JSON.parse(localStorage.getItem("web-pi:unread") ?? "")).toEqual({});
    expect(indicator("s1").classList.contains("session-indicator-unread")).toBe(
      false,
    );
    expect(indicator("s1").classList.contains("is-stopped")).toBe(true);
  });

  it("reads the old array shape and paints rows that arrive later", async () => {
    localStorage.setItem("web-pi:unread", JSON.stringify(["s2"]));
    page({ current: "" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    expect(indicator("s2").classList.contains("session-indicator-unread")).toBe(
      true,
    );
    byId("session-list").insertAdjacentHTML("beforeend", row("s3"));
    localStorage.setItem("web-pi:unread", JSON.stringify({ s2: "", s3: "" }));
    htmxEvent(byId("row-s3"), "htmx:after:settle");
    expect(indicator("s3").classList.contains("session-indicator-unread")).toBe(
      true,
    );
  });

  it("marks a completion from an unloaded directory when its row arrives", async () => {
    page({ current: "s1" });
    const { setUpSidebar } = await load();
    setUpSidebar();
    finished("elsewhere", "/repo/two");
    byId("session-list").insertAdjacentHTML(
      "beforeend",
      row("elsewhere", { cwd: "/repo/two" }),
    );
    htmxEvent(byId("row-elsewhere"), "htmx:after:settle");
    expect(
      indicator("elsewhere").classList.contains("session-indicator-unread"),
    ).toBe(true);
    expect(query("#row-elsewhere .session-row-folder").title).toBe("/repo/two");
  });
});

describe("the project menu", () => {
  const MENU =
    '<input id="project-filter">' +
    '<div class="project-folder-group" data-project-key="/home/me/alpha"></div>' +
    '<div class="project-folder-group" data-project-key="/home/me/beta"></div>' +
    '<div id="project-empty" hidden>No matching projects</div>';

  it("filters project rows and says when nothing matches", async () => {
    page();
    byId("sidebar-project-menu").innerHTML = MENU;
    const { setUpSidebar } = await load();
    setUpSidebar();
    type(field("#project-filter"), "ALPHA");
    expect(query('[data-project-key="/home/me/alpha"]').hidden).toBe(false);
    expect(query('[data-project-key="/home/me/beta"]').hidden).toBe(true);
    expect(byId("project-empty").hidden).toBe(true);
    type(field("#project-filter"), "zzz");
    expect(byId("project-empty").hidden).toBe(false);
    type(field("#project-filter"), "");
    expect(query('[data-project-key="/home/me/beta"]').hidden).toBe(false);
    expect(byId("project-empty").hidden).toBe(true);
  });

  it("clears the filter and closes the menu on Escape", async () => {
    page();
    byId("sidebar-project-menu").innerHTML = MENU;
    const { setUpSidebar } = await load();
    setUpSidebar();
    const menu = byId("sidebar-project-menu");
    menu.showPopover();
    let closed = false;
    menu.addEventListener("toggle", (event) => {
      closed = (event as unknown as { newState: string }).newState === "closed";
    });
    type(field("#project-filter"), "beta");
    keydown(field("#project-filter"), "Escape");
    expect(field("#project-filter").value).toBe("");
    expect(query('[data-project-key="/home/me/alpha"]').hidden).toBe(false);
    expect(closed).toBe(true);
  });
});

describe("the explorer fold", () => {
  const section =
    '<div id="explorer-section">' +
    '<button type="button" id="explorer-toggle" aria-expanded="true" aria-controls="explorer-body">Explorer</button>' +
    '<div id="explorer-body"></div></div>';

  async function mounted(): Promise<HTMLElement> {
    page();
    byId("sidebar").insertAdjacentHTML("beforeend", section);
    const { setUpSidebar } = await load();
    setUpSidebar();
    return byId("explorer-toggle");
  }

  it("ignores the old key, remembers folding, and stays folded after a reload", async () => {
    localStorage.setItem("pi-web:file-explorer:open", "false");
    let toggle = await mounted();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("web-pi:file-explorer:open")).toBe("false");
    // The next page load: the server renders it open, the module folds it.
    toggle = await mounted();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("web-pi:file-explorer:open")).toBe("true");
  });

  it("re-folds a section that a whole-page swap rendered open", async () => {
    localStorage.setItem("web-pi:file-explorer:open", "false");
    await mounted();
    byId("sidebar").innerHTML = section;
    htmxEvent(byId("sidebar"), "htmx:after:process");
    htmxEvent(byId("sidebar"), "htmx:after:settle");
    expect(byId("explorer-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("still folds in a private window, for this page", async () => {
    blockStorage();
    const toggle = await mounted();
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("shortcuts", () => {
  it.each([
    ["!", "Digit1", "s1"],
    ["+", "Digit1", "s1"],
    ["@", "Digit2", "s2"],
    ["#", "Digit3", "s3"],
    ["$", "Digit4", "s4"],
    ["%", "Digit5", "s5"],
    ["^", "Digit6", "s6"],
    ["&", "Digit7", "s7"],
    ["*", "Digit8", "s8"],
    ["(", "Digit9", "s9"],
  ])("opens %s / %s from the composer", async (key, code, id) => {
    page({ rows: Array.from({ length: 10 }, (_, i) => `s${String(i + 1)}`) });
    document
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        '<textarea id="composer-text">Unsent draft</textarea>',
      );
    const composer = query("#composer-text");
    composer.focus();
    const opened = vi.fn((event: Event) => {
      event.preventDefault();
    });
    query(`#row-${id} a[href]`).addEventListener("click", opened);
    const { setUpSidebar } = await load();
    setUpSidebar();
    const event = keydown(composer, key, {
      code,
      ctrlKey: true,
      shiftKey: true,
    });
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);
    expect((composer as HTMLTextAreaElement).value).toBe("Unsent draft");
  });

  it("shows session badges only for Control+Shift, keeping new-session hints", async () => {
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    keydown(document.body, "Meta", { metaKey: true });
    expect(query("#row-s1 .session-shortcut").hidden).toBe(true);
    expect(query("#row-s1 .session-menu-trigger").hidden).toBe(false);
    expect(query(".new-session-shortcut").textContent).toBe("⌘K");
    expect(query(".new-session-plus").hidden).toBe(true);
    keyup(document.body, "Meta");
    expect(query("#row-s1 .session-shortcut").hidden).toBe(true);
    expect(query("#row-s1 .session-menu-trigger").hidden).toBe(false);
    keydown(document.body, "Control", { ctrlKey: true });
    expect(query("#row-s1 .session-shortcut").hidden).toBe(true);
    expect(query(".new-session-shortcut").textContent).toBe("Ctrl+K");
    keydown(document.body, "Shift", { ctrlKey: true, shiftKey: true });
    expect(query("#row-s1 .session-shortcut").textContent).toBe("Ctrl+Shift+1");
    expect(query("#row-s2 .session-shortcut").textContent).toBe("Ctrl+Shift+2");
    expect(query("#row-s1 .session-shortcut").hidden).toBe(false);
    expect(query("#row-s1 .session-menu-trigger").hidden).toBe(true);
    keyup(document.body, "Shift", { ctrlKey: true });
    expect(query("#row-s1 .session-shortcut").hidden).toBe(true);
    expect(query("#row-s1 .session-menu-trigger").hidden).toBe(false);
    keydown(document.body, "Shift", { ctrlKey: true, shiftKey: true });
    window.dispatchEvent(new Event("blur"));
    expect(query("#row-s1 .session-shortcut").hidden).toBe(true);
  });

  it("numbers a row swapped in while the modifier is held", async () => {
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    keydown(document.body, "Shift", { ctrlKey: true, shiftKey: true });
    byId("row-s1").outerHTML = row("s1");
    htmxEvent(byId("session-list"), "htmx:after:settle");
    expect(query("#row-s1 .session-shortcut").textContent).toBe("Ctrl+Shift+1");
    expect(query("#row-s1 .session-shortcut").hidden).toBe(false);
  });

  it("leaves the tenth row without a shortcut badge", async () => {
    page({ rows: Array.from({ length: 10 }, (_, i) => `s${String(i + 1)}`) });
    const { setUpSidebar } = await load();
    setUpSidebar();
    keydown(document.body, "Shift", { ctrlKey: true, shiftKey: true });
    expect(query("#row-s9 .session-shortcut").textContent).toBe("Ctrl+Shift+9");
    expect(query("#row-s9 .session-shortcut").hidden).toBe(false);
    expect(query("#row-s10 .session-shortcut").hidden).toBe(true);
    expect(query("#row-s10 .session-menu-trigger").hidden).toBe(false);
    keydown(document.body, "Alt", {
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    });
    expect(query("#row-s9 .session-shortcut").hidden).toBe(true);
  });

  it.each([
    ["old Control", "1", { code: "Digit1", ctrlKey: true }],
    ["old Command", "1", { code: "Digit1", metaKey: true }],
    ["Command+Shift", "!", { code: "Digit1", metaKey: true, shiftKey: true }],
    ["Shift alone", "!", { code: "Digit1", shiftKey: true }],
    [
      "extra Alt",
      "!",
      { code: "Digit1", ctrlKey: true, shiftKey: true, altKey: true },
    ],
    [
      "extra Meta",
      "!",
      { code: "Digit1", ctrlKey: true, shiftKey: true, metaKey: true },
    ],
    ["zero", ")", { code: "Digit0", ctrlKey: true, shiftKey: true }],
    ["old zero", "0", { code: "Digit0", ctrlKey: true }],
    ["numpad", "1", { code: "Numpad1", ctrlKey: true, shiftKey: true }],
    ["key without code", "1", { ctrlKey: true, shiftKey: true }],
    [
      "repeat",
      "!",
      { code: "Digit1", ctrlKey: true, shiftKey: true, repeat: true },
    ],
    [
      "IME",
      "!",
      { code: "Digit1", ctrlKey: true, shiftKey: true, isComposing: true },
    ],
    [
      "legacy IME",
      "!",
      // oxlint-disable-next-line typescript/no-deprecated -- Exercise the legacy IME guard.
      { code: "Digit1", ctrlKey: true, shiftKey: true, keyCode: 229 },
    ],
    ["ordinary editing", "ArrowUp", {}],
  ] satisfies [string, string, KeyboardEventInit][])(
    "does not intercept %s",
    async (_, key, init) => {
      page({ rows: Array.from({ length: 10 }, (_, i) => `s${String(i + 1)}`) });
      const opened = vi.fn((event: Event) => {
        event.preventDefault();
      });
      byId("session-list").addEventListener("click", opened);
      const { setUpSidebar } = await load();
      setUpSidebar();
      expect(keydown(document.body, key, init).defaultPrevented).toBe(false);
      expect(opened).not.toHaveBeenCalled();
    },
  );

  it("waits for active IME composition to end before switching from the composer", async () => {
    page();
    document
      .querySelector("main")
      ?.insertAdjacentHTML(
        "beforeend",
        '<textarea id="composer-text"></textarea>',
      );
    const composer = query("#composer-text");
    const opened = vi.fn((event: Event) => {
      event.preventDefault();
    });
    query("#row-s1 a[href]").addEventListener("click", opened);
    const { setUpSidebar } = await load();
    setUpSidebar();
    composer.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(
      keydown(composer, "!", { code: "Digit1", ctrlKey: true, shiftKey: true })
        .defaultPrevented,
    ).toBe(false);
    expect(opened).not.toHaveBeenCalled();
    composer.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    keydown(composer, "!", { code: "Digit1", ctrlKey: true, shiftKey: true });
    expect(opened).toHaveBeenCalledOnce();
  });

  it("does not intercept a shortcut already handled by another control", async () => {
    page();
    const opened = vi.spyOn(query("#row-s1 a[href]"), "click");
    document.body.addEventListener("keydown", (event) => {
      event.preventDefault();
    });
    const { setUpSidebar } = await load();
    setUpSidebar();
    keydown(document.body, "!", {
      code: "Digit1",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(opened).not.toHaveBeenCalled();
  });

  it("keeps other form fields and open dialogs out of session navigation", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<input id="other-field"><dialog open><button id="dialog-action">Action</button></dialog>',
    );
    const opened = vi.spyOn(query("#row-s1 a[href]"), "click");
    const { setUpSidebar } = await load();
    setUpSidebar();
    for (const target of [document.body, byId("dialog-action")]) {
      expect(
        keydown(target, "!", { code: "Digit1", ctrlKey: true, shiftKey: true })
          .defaultPrevented,
      ).toBe(false);
    }
    document.querySelector("dialog")?.remove();
    expect(
      keydown(byId("other-field"), "!", {
        code: "Digit1",
        ctrlKey: true,
        shiftKey: true,
      }).defaultPrevented,
    ).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it("leaves an unavailable session position unhandled", async () => {
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    expect(
      keydown(document.body, "(", {
        code: "Digit9",
        ctrlKey: true,
        shiftKey: true,
      }).defaultPrevented,
    ).toBe(false);
  });

  it("opens a row from a click anywhere on it but its controls", async () => {
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    let opened = 0;
    query("#row-s1 a[href]").addEventListener("click", (event) => {
      event.preventDefault();
      opened += 1;
    });
    click(query("#row-s1 .session-counts"));
    expect(opened).toBe(1);
    click(query("#row-s1 .session-menu-trigger"));
    expect(opened).toBe(1);
  });
});

describe("row menus and the refresh button", () => {
  it("places the menu under its trigger, flipped up when it would not fit", async () => {
    page();
    const { setUpSidebar } = await load();
    setUpSidebar();
    const trigger = query("#row-s1 .session-menu-trigger");
    const menu = byId("row-menu-s1");
    setRect(trigger, { top: 100, bottom: 130, right: 300 });
    menu.showPopover();
    expect(menu.style.left).toBe("156px");
    expect(menu.style.top).toBe("134px");
    menu.hidePopover();
    // Two items, 34px each plus padding, do not fit under a trigger near the
    // bottom of a 768px window.
    setRect(trigger, { top: 700, bottom: 730, right: 300 });
    menu.showPopover();
    const height = menu.querySelectorAll(".menu-item").length * 34 + 10;
    expect(menu.style.top).toBe(`${String(700 - height - 4)}px`);
  });

  it("shows a check on the refresh button for two seconds", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button type="button" id="sidebar-refresh"></button>',
    );
    const { setUpSidebar } = await load();
    setUpSidebar();
    htmxEvent(byId("sidebar-refresh"), "htmx:after:request");
    expect(byId("sidebar-refresh").hasAttribute("data-done")).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(byId("sidebar-refresh").hasAttribute("data-done")).toBe(false);
  });
});

describe("folder memory", () => {
  it("pre-fills the picker with the last validated folder", async () => {
    page();
    document.body.insertAdjacentHTML("beforeend", '<div id="dialogs"></div>');
    const { setUpSidebar } = await load();
    setUpSidebar();
    const body = new FormData();
    body.set("cwd", "/home/me/deep/folder");
    htmxEvent(document.body, "htmx:config:request", {
      ctx: { request: { action: "/workspaces/validate", body } },
    });
    expect(localStorage.getItem("web-pi:last-cwd")).toBe(
      "/home/me/deep/folder",
    );
    byId("dialogs").innerHTML = '<input id="directory-path" value="/home/me">';
    htmxEvent(byId("dialogs"), "htmx:after:settle");
    expect(field("#directory-path").value).toBe("/home/me/deep/folder");
  });
});
