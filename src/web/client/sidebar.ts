// The sidebar's browser half: the state pi-web keeps in React and web-pi
// cannot render from the server — which sessions finished while the reader
// was elsewhere, where a row's fixed-position menu lands, whether a modifier
// is held, and which project group is open.

import { relativeTime } from "@core/sessions";
import type { Htmx } from "htmx.org";
import { requestContext, swapTasks } from "./htmx.ts";
import { setUpRegion } from "./lifecycle.ts";
import { setUpFolderMemory } from "./preferences.ts";

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

function currentSessionId(): string {
  return document.querySelector("main")?.getAttribute("data-session-id") ?? "";
}

function paintSelection(): void {
  const active = currentSessionId();
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
    if (ids.delete(currentSessionId())) storeUnread(ids);
    paintUnread();
  });
  // The global stream announces every finished session, including unloaded rows.
  document.addEventListener("finished", (event) => {
    const text = (event as CustomEvent<{ data?: unknown }>).detail?.data;
    if (typeof text !== "string") return;
    let finished: { id?: string } = {};
    try {
      finished = JSON.parse(text) as typeof finished;
    } catch {
      return;
    }
    if (!finished || typeof finished.id !== "string") return;
    const id = finished.id;
    if (!id || id === currentSessionId()) return;
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
  let displayedSelection = currentSessionId();
  const collapsedSelection = new Set<string>();
  let pending = false;
  let refreshNeeded = false;

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
    const active = currentSessionId();
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
    if (
      pending ||
      (!refreshNeeded && (!active || selected || attemptedSelection === active))
    )
      return;
    const explicitRefresh = refreshNeeded;
    refreshNeeded = false;
    attemptedSelection = active;
    pending = true;
    const query = new URLSearchParams({ selected: active });
    const htmx = (globalThis as unknown as { htmx: Htmx }).htmx;
    // The stream cannot know about later navigation. Replace just its first
    // page to reveal an off-page path; a missing ID gets one attempt, not a loop.
    void htmx
      .ajax("GET", `/sidebar/rows?${query.toString()}`, {
        source: list,
        target: list,
        swap: "innerHTML",
      })
      .catch(() => {
        // Normal HTMX error feedback owns a failed request; no automatic retry.
      })
      .finally(() => {
        pending = false;
        if (explicitRefresh && active !== currentSessionId())
          refreshNeeded = true;
        reconcile();
      });
  };

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
  document.addEventListener("htmx:config:request", (event) => {
    const ctx = requestContext(event);
    const url = new URL(ctx.request.action, location.href);
    if (url.pathname !== "/sidebar/rows") return;
    url.searchParams.set("selected", currentSessionId());
    ctx.request.action = url.pathname + url.search;
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

/**
 * A project with more than one working folder opens and closes in place
 * (§3.3). The folders are already in the page, so this only flips the
 * disclosure; `areas/sidebar.css` turns aria-expanded into the chevron.
 */
function setUpFolderGroups(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(
      ".project-folder-row[aria-expanded]",
    );
    if (!row) return;
    const open = row.getAttribute("aria-expanded") !== "true";
    row.setAttribute("aria-expanded", open ? "true" : "false");
    const folders = document.getElementById(
      row.getAttribute("aria-controls") ?? "",
    );
    if (folders) folders.hidden = !open;
  });
}

const EXPLORER_OPEN_KEY = "web-pi:file-explorer:open";

/**
 * The explorer folds to its header row (§3.5). pi-web keeps `explorerOpen`
 * in React and reads the stored value after hydration, so a collapsed
 * explorer opens for a frame there too; here aria-expanded on the toggle is
 * the state and areas/sidebar.css paints both states from it. Storage is
 * best-effort, as in pi-web: without it the choice lasts for this page.
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

/** The refresh button says it worked: a check for two seconds (§3.1). */
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

/**
 * pi-web puts a ⌘1…⌘0 badge where a row's menu trigger is while a modifier
 * is held, and jumps to that session on the matching digit (§3.4). The
 * modifier decides the label, so it is written here rather than server-side.
 */
function setUpShortcuts(): void {
  let modifier: "ctrl" | "meta" | null = null;

  const swap = (
    badge: HTMLElement,
    other: HTMLElement | null,
    text: string,
  ) => {
    const shown = modifier !== null && text !== "";
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
        index >= 0 && index < 10
          ? `${label}${index === 9 ? "0" : String(index + 1)}`
          : "",
      );
    });
  };

  const update = (event: KeyboardEvent) => {
    const next = event.metaKey ? "meta" : event.ctrlKey ? "ctrl" : null;
    if (next === modifier) return;
    modifier = next;
    paint();
  };

  window.addEventListener("keydown", (event) => {
    update(event);
    if (
      event.repeat ||
      event.altKey ||
      event.shiftKey ||
      (!event.ctrlKey && !event.metaKey) ||
      !/^[0-9]$/.test(event.key) ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }
    const index = event.key === "0" ? 9 : Number(event.key) - 1;
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

/** pi-web's whole row is the click target, not just its title (§3.4). */
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
  setUpFolderGroups();
  setUpRegion("#explorer-toggle", mountExplorerFold);
  setUpRegion("#sidebar-refresh", mountSidebarRefresh);
  setUpRowMenus();
  setUpShortcuts();
  setUpRowSelection();
}
