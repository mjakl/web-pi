// The sidebar's browser half: the state pi-web keeps in React and web-pi
// cannot render from the server — which sessions finished while the reader
// was elsewhere, where a row's fixed-position menu lands, whether a modifier
// is held, and which session trees are open.

import { relativeTime } from "@core/sessions";
import type { Htmx } from "htmx.org";
import { dialogOpen } from "./dialogs.ts";
import { requestContext, swapTasks } from "./htmx.ts";
import { setUpRegion } from "./lifecycle.ts";
import { displayedSessionId } from "./navigation.ts";
import { setUpFolderMemory } from "./preferences.ts";
import { isTextEntry } from "./viewport.ts";

// Keep the existing stored map readable; project values no longer affect dots.
const UNREAD_KEY = "web-pi:unread";

function unreadIds(): Map<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? "{}");
    // Phase 3a stored a plain array of ids; those keep working, unattributed.
    if (Array.isArray(raw)) {
      return new Map((raw as string[]).map((id) => [id, ""]));
    }
    if (typeof raw !== "object" || raw === null) return new Map();
    return new Map(Object.entries(raw as Record<string, string>));
  } catch {
    return new Map();
  }
}

function storeUnread(ids: Map<string, string>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(Object.fromEntries(ids)));
  } catch {
    // Without storage the dots last for this page only.
  }
}

/**
 * The session a sidebar stream `finished` or `completed` event names, or
 * undefined for anything unreadable.
 */
export function finishedId(event: Event): string | undefined {
  const text = (event as CustomEvent<{ data?: unknown }>).detail?.data;
  if (typeof text !== "string") return undefined;
  try {
    const { id } = JSON.parse(text) as { id?: unknown };
    return typeof id === "string" && id !== "" ? id : undefined;
  } catch {
    return undefined;
  }
}

function paintSelection(): void {
  const active = displayedSessionId();
  for (const row of document.querySelectorAll<HTMLElement>(
    ".session-row[data-session-id]",
  )) {
    const selected = row.dataset["sessionId"] === active;
    row.classList.toggle("is-selected", selected);
  }
}

/** The unread halo uses --info and adds “New activity” to the status title. */
function paintUnread(): void {
  paintSelection();
  const ids = unreadIds();
  let changed = false;
  for (const row of document.querySelectorAll<HTMLElement>(
    ".session-row[data-session-id]",
  )) {
    const id = row.dataset["sessionId"] ?? "";
    const indicator = row.querySelector<HTMLElement>(".session-indicator");
    if (!indicator) continue;
    // Restarting dismisses the previous completion, including stored marks on loaded rows.
    if (indicator.classList.contains("is-running") && ids.delete(id))
      changed = true;
    const unread = ids.has(id);
    indicator.classList.toggle("session-indicator-unread", unread);
    const status = indicator.dataset["status"] ?? "";
    const label = unread ? `${status} · New activity` : status;
    indicator.title = label;
    indicator.setAttribute("aria-label", label);
  }
  if (changed) storeUnread(ids);
}

function setUpUnread(): void {
  setUpRegion("main", () => {
    const ids = unreadIds();
    if (ids.delete(displayedSessionId())) storeUnread(ids);
    paintUnread();
  });
  // The global stream announces every finished session, including unloaded rows.
  document.addEventListener("finished", (event) => {
    const id = finishedId(event);
    if (id === undefined || id === displayedSessionId()) return;
    const pending = unreadIds();
    pending.set(id, "");
    storeUnread(pending);
    paintUnread();
  });
  // Rows arrive lazily and out of band; a streaming turn swaps ten times a
  // second and must not drag the whole sidebar through this.
  document.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("#sidebar")) paintUnread();
  });
}

const TREE_OPEN_KEY = "web-pi:session-tree:open";

function treePreferences(): Map<string, boolean> {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(TREE_OPEN_KEY) ?? "{}",
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return new Map();
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return new Map();
  }
}

function visibleSessionRows(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>("#session-list .session-row"),
  ].filter((row) => !row.closest("details:not([open])"));
}

/** Preferences belong to the browser; ancestry and sibling pages stay server-rendered. */
function setUpSessionTree(): void {
  const preferences = treePreferences();
  const states = new WeakMap<
    HTMLDetailsElement,
    { open: boolean; active: string; ancestor: boolean }
  >();
  let attemptedSelection: string | undefined;
  let displayedSelection = displayedSessionId();
  const collapsedSelection = new Set<string>();
  let pending = false;
  let refreshNeeded = false;
  let automaticRefreshNeeded = false;

  const loadChildren = (root: Element) => {
    for (const placeholder of root.querySelectorAll(
      ".session-children-loading",
    )) {
      if (!placeholder.closest("details:not([open])"))
        placeholder.dispatchEvent(new Event("web-pi:children"));
    }
  };

  const reconcile = () => {
    const list = document.getElementById("session-list");
    if (!list) return;
    const active = displayedSessionId();
    if (active !== displayedSelection) {
      displayedSelection = active;
      collapsedSelection.clear();
    }
    paintSelection();
    for (const details of list.querySelectorAll<HTMLDetailsElement>(
      ".session-children",
    )) {
      const ancestor =
        details.querySelector(".session-row.is-selected") !== null;
      const id = details.dataset["parentSessionId"] ?? "";
      let state = states.get(details);
      if (!state || state.active !== active || state.ancestor !== ancestor) {
        state = {
          open:
            (ancestor && !collapsedSelection.has(id)) ||
            preferences.get(id) === true,
          active,
          ancestor,
        };
        states.set(details, state);
        // Record before changing open: its queued toggle must not save a preference.
        details.open = state.open;
      }
    }
    const selected = list.querySelector(".session-row.is-selected");
    if (!active || selected) attemptedSelection = undefined;
    const automaticRefresh = automaticRefreshNeeded && !document.hidden;
    if (
      pending ||
      (!refreshNeeded &&
        !automaticRefresh &&
        (!active || selected || attemptedSelection === active))
    )
      return;
    const explicitRefresh = refreshNeeded;
    refreshNeeded = false;
    automaticRefreshNeeded = false;
    attemptedSelection = active;
    pending = true;
    const htmx = (globalThis as unknown as { htmx: Htmx }).htmx;
    // The stream cannot know about later navigation. Replace just its first
    // page to reveal an off-page path; a missing ID gets one attempt, not a loop.
    void htmx
      .ajax("GET", "/sidebar/rows", {
        source: list,
        target: list,
        swap: "innerHTML",
      })
      .catch(() => {
        // Normal HTMX error feedback owns a failed request; no automatic retry.
      })
      .finally(() => {
        pending = false;
        if (explicitRefresh && active !== displayedSessionId())
          refreshNeeded = true;
        reconcile();
      });
  };

  setUpRegion("#sidebar", (sidebar, signal) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(scheduled);
      scheduled = undefined;
      if (document.hidden || !sidebar.isConnected) return;
      automaticRefreshNeeded = true;
      reconcile();
    };
    // Focus, visibility and reconnect commonly arrive together. One short
    // window avoids repeating a full-store scan for the same return to the page.
    const schedule = () => {
      if (document.hidden || scheduled !== undefined) return;
      scheduled = setTimeout(() => {
        scheduled = undefined;
        refresh();
      }, 100);
    };
    const stop = () => {
      clearInterval(poll);
      clearTimeout(scheduled);
      poll = undefined;
      scheduled = undefined;
      automaticRefreshNeeded = false;
    };
    const observeVisibility = () => {
      if (document.hidden) {
        stop();
        return;
      }
      poll ??= setInterval(refresh, 30_000);
    };
    observeVisibility();
    document.addEventListener(
      "visibilitychange",
      () => {
        observeVisibility();
        schedule();
      },
      { signal },
    );
    window.addEventListener("focus", schedule, { signal });
    sidebar.addEventListener(
      "htmx:sse:after:connection",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.id === "sidebar-events"
        )
          schedule();
      },
      { signal },
    );
    signal.addEventListener("abort", stop, { once: true });
  });
  setUpRegion("#session-list, main", reconcile);
  // Capture the inserted selection before the settle delay: another stream
  // frame may replace it before after:settle is delivered.
  for (const name of [
    "htmx:before:settle",
    "htmx:after:process",
    "htmx:after:settle",
  ]) {
    document.addEventListener(name, (event) => {
      const root = event.target;
      if (!(root instanceof Element)) return;
      if (
        root.closest("#session-list") ||
        root.matches("main") ||
        root.querySelector("#session-list, main")
      )
        reconcile();
    });
  }
  document.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (
        !(details instanceof HTMLDetailsElement) ||
        !details.matches(".session-children")
      )
        return;
      const state = states.get(details);
      if (!state) return;
      if (state.open !== details.open) {
        state.open = details.open;
        const id = details.dataset["parentSessionId"] ?? "";
        preferences.set(id, details.open);
        if (details.open) collapsedSelection.delete(id);
        else if (state.ancestor) collapsedSelection.add(id);
        try {
          localStorage.setItem(
            TREE_OPEN_KEY,
            JSON.stringify(Object.fromEntries(preferences)),
          );
        } catch {
          // Private windows retain choices for this page, including list swaps.
        }
      }
      if (details.open) loadChildren(details);
    },
    true,
  );
  document.addEventListener("web-pi:sidebar-refresh", () => {
    refreshNeeded = true;
    reconcile();
  });
  document.addEventListener("htmx:before:request", (event) => {
    const ctx = requestContext(event);
    if (new URL(ctx.request.action, location.href).pathname !== "/sidebar/rows")
      return;
    if (
      !ctx.sourceElement.isConnected ||
      (ctx.sourceElement.matches(".session-children-loading") &&
        ctx.sourceElement.closest("details:not([open])"))
    )
      event.preventDefault();
  });
  const rejectObsolete = (event: Event) => {
    const ctx = requestContext(event);
    if (!ctx?.request) return false;
    const url = new URL(ctx.request.action, location.href);
    if (url.pathname !== "/sidebar/rows") return false;
    // Selection may change during a sibling request. Its page is still useful;
    // reconcile paints the current selection and repairs any missing path.
    if (!ctx.sourceElement.isConnected) {
      event.preventDefault();
      return true;
    }
    return false;
  };
  document.addEventListener("htmx:before:response", rejectObsolete);
  document.addEventListener("htmx:before:swap", (event) => {
    if (rejectObsolete(event)) return;
    const ctx = requestContext(event);
    if (!ctx?.request) return;
    const url = new URL(ctx.request.action, location.href);
    if (
      url.pathname !== "/sidebar/rows" ||
      Number(url.searchParams.get("after")) <= 0
    )
      return;
    // A previously pinned row can reappear in a later sibling page after
    // selection changes. Keep its existing wrapper and any loaded descendants.
    for (const task of swapTasks(event) as { fragment: DocumentFragment }[]) {
      for (const node of task.fragment.querySelectorAll(".session-node")) {
        if (document.getElementById(node.id)) node.remove();
      }
    }
  });
}

/** The project menu's own filter, shown once there are many projects. */
function applyProjectFilter(): void {
  const input = document.querySelector<HTMLInputElement>("#project-filter");
  if (!input) return;
  const needle = input.value.trim().toLowerCase();
  let matches = 0;
  for (const group of document.querySelectorAll<HTMLElement>(
    "#sidebar-project-menu .project-folder-group[data-project-key]",
  )) {
    const key = (group.dataset["projectKey"] ?? "").toLowerCase();
    group.hidden = needle !== "" && !key.includes(needle);
    if (!group.hidden) matches += 1;
  }
  const empty = document.getElementById("project-empty");
  if (empty) empty.hidden = matches > 0 || needle === "";
}

function setUpProjectFilter(): void {
  document.addEventListener("input", (event) => {
    if ((event.target as HTMLElement).id === "project-filter") {
      applyProjectFilter();
    }
  });
  document.addEventListener("keydown", (event) => {
    const input = event.target;
    if (
      event.key !== "Escape" ||
      !(input instanceof HTMLInputElement) ||
      input.id !== "project-filter"
    ) {
      return;
    }
    input.value = "";
    applyProjectFilter();
    document.getElementById("sidebar-project-menu")?.hidePopover();
  });
}

const EXPLORER_OPEN_KEY = "web-pi:file-explorer:open";

/**
 * The explorer folds to its header row. pi-web keeps `explorerOpen` in React
 * and reads the stored value after hydration, so a collapsed explorer opens
 * for a frame there too; here aria-expanded on the toggle is the state and
 * areas/sidebar.css paints both states from it. Storage is best-effort, as in
 * pi-web: without it the choice lasts for this page.
 */
function mountExplorerFold(button: HTMLElement, signal: AbortSignal): void {
  let open = true;
  try {
    open = localStorage.getItem(EXPLORER_OPEN_KEY) !== "false";
  } catch {
    // A private window: the explorer starts open.
  }
  const paint = () => {
    button.setAttribute("aria-expanded", String(open));
  };
  paint();
  button.addEventListener(
    "click",
    () => {
      open = !open;
      try {
        localStorage.setItem(EXPLORER_OPEN_KEY, String(open));
      } catch {
        // Without storage the choice lasts for this page only.
      }
      paint();
    },
    { signal },
  );
}

/** The refresh button says it worked: a check for two seconds. */
function mountSidebarRefresh(button: HTMLElement, signal: AbortSignal): void {
  button.removeAttribute("data-done");
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  button.addEventListener(
    "htmx:after:request",
    () => {
      button.setAttribute("data-done", "");
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.removeAttribute("data-done");
      }, 2000);
    },
    { signal },
  );
}

/**
 * Where a row's action menu lands (SessionItem.tsx `menuPositionFor`): a
 * fixed box under the trigger, 144px wide, clamped to the viewport and
 * flipped above the row when it would not fit below. Popover toggle events
 * do not bubble, so this listens in the capture phase.
 */
function placeRowMenu(menu: HTMLElement): void {
  const trigger = menu
    .closest(".session-row")
    ?.querySelector<HTMLElement>(".session-menu-trigger");
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = 144;
  const rowHeight = matchMedia("(pointer: coarse)").matches ? 44 : 34;
  const height = menu.querySelectorAll(".menu-item").length * rowHeight + 10;
  menu.style.left = `${String(
    Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
  )}px`;
  menu.style.top = `${String(
    rect.bottom + 4 + height <= window.innerHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - height - 4),
  )}px`;
}

function setUpRowMenus(): void {
  document.addEventListener(
    "beforetoggle",
    (event) => {
      const menu = event.target;
      if (
        !(menu instanceof HTMLElement) ||
        !menu.matches(".session-row > .menu-surface") ||
        event.newState !== "open"
      ) {
        return;
      }
      placeRowMenu(menu);
    },
    true,
  );
}

/** Visible row positions and held modifiers belong to the browser. */
function setUpShortcuts(): void {
  let modifier: "ctrl" | "meta" | null = null;
  let sessionModifier = false;
  let composing = false;

  const swap = (
    badge: HTMLElement,
    other: HTMLElement | null,
    text: string,
    enabled: boolean,
  ) => {
    const shown = enabled && text !== "";
    badge.textContent = text;
    badge.hidden = !shown;
    if (other) other.hidden = shown;
  };

  const paint = () => {
    const label = modifier === "meta" ? "⌘" : "Ctrl+";
    const newSession = document.querySelector<HTMLElement>(
      ".new-session-shortcut",
    );
    if (newSession) {
      swap(
        newSession,
        document.querySelector<HTMLElement>(".new-session-plus"),
        `${label}K`,
        modifier !== null,
      );
    }
    const visible = visibleSessionRows();
    const rows = document.querySelectorAll<HTMLElement>(
      "#session-list .session-row",
    );
    rows.forEach((row) => {
      const index = visible.indexOf(row);
      const badge = row.querySelector<HTMLElement>(".session-shortcut");
      if (!badge) return;
      swap(
        badge,
        row.querySelector<HTMLElement>(".session-menu-trigger"),
        index >= 0 && index < 9 ? `Ctrl+Shift+${String(index + 1)}` : "",
        sessionModifier,
      );
    });
  };

  const update = (event: KeyboardEvent) => {
    const next = event.metaKey ? "meta" : event.ctrlKey ? "ctrl" : null;
    const nextSession =
      event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
    if (next === modifier && nextSession === sessionModifier) return;
    modifier = next;
    sessionModifier = nextSession;
    paint();
  };

  window.addEventListener("compositionstart", () => {
    composing = true;
  });
  window.addEventListener("compositionend", () => {
    composing = false;
  });
  window.addEventListener("keydown", (event) => {
    update(event);
    if (
      event.defaultPrevented ||
      event.repeat ||
      composing ||
      event.isComposing ||
      // oxlint-disable-next-line typescript/no-deprecated -- Some IMEs report 229 without isComposing.
      event.keyCode === 229 ||
      !sessionModifier ||
      !/^Digit[1-9]$/.test(event.code) ||
      dialogOpen() ||
      (isTextEntry(event.target) &&
        event.target !== document.getElementById("composer-text"))
    ) {
      return;
    }
    // Shift changes key to a symbol on many layouts; code names the physical row.
    const index = Number(event.code.slice(-1)) - 1;
    const row = visibleSessionRows()[index];
    const link = row?.querySelector<HTMLAnchorElement>("a[href]");
    if (!link) return;
    event.preventDefault();
    link.click();
  });
  window.addEventListener("keyup", update);
  window.addEventListener("blur", () => {
    if (modifier === null) return;
    modifier = null;
    sessionModifier = false;
    paint();
  });
  // A row swapped in while the modifier is held arrives with its badge
  // hidden and unnumbered, and the rows after it have all moved down one.
  setUpRegion("#sidebar", paint);
  document.addEventListener(
    "toggle",
    (event) => {
      if (
        event.target instanceof Element &&
        event.target.matches(".session-children")
      )
        paint();
    },
    true,
  );
  document.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (modifier === null || !(target instanceof Element)) return;
    if (target.closest("#sidebar")) paint();
  });
}

function mountRelativeTimes(sidebar: HTMLElement, signal: AbortSignal): void {
  const paint = () => {
    if (document.hidden) return;
    const now = Date.now();
    for (const age of sidebar.querySelectorAll<HTMLElement>(
      "[data-session-modified-at]",
    )) {
      const text = relativeTime(age.dataset["sessionModifiedAt"] ?? "", now);
      if (age.textContent !== text) age.textContent = text;
    }
  };
  paint();
  // Query current rows, not a snapshot: pagination and SSE replace them.
  const timer = setInterval(paint, 1000);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(timer);
    },
    { once: true },
  );
  sidebar.addEventListener("htmx:after:process", paint, { signal });
  document.addEventListener("visibilitychange", paint, { signal });
  window.addEventListener("pageshow", paint, { signal });
}

/** pi-web's whole row is the click target, not just its title. */
function setUpRowSelection(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(".session-row");
    if (!row || target.closest("a, button, input, .menu-surface")) return;
    row.querySelector<HTMLAnchorElement>("a[href]")?.click();
  });
}

export function setUpSidebar(): void {
  setUpRegion("#sidebar", mountRelativeTimes);
  setUpFolderMemory();
  setUpUnread();
  setUpSessionTree();
  setUpProjectFilter();
  setUpRegion("#explorer-toggle", mountExplorerFold);
  setUpRegion("#sidebar-refresh", mountSidebarRefresh);
  setUpRowMenus();
  setUpShortcuts();
  setUpRowSelection();
}
