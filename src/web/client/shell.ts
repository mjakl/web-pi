// The application shell's browser half: the theme, the two panel columns and
// their drag handles, the top-bar panels, the keyboard shortcuts, and the
// document title. Everything here belongs to the shell area; the sidebar's
// own behaviour is in sidebar.ts.

import { setUpRegion } from "./lifecycle.ts";
import { abortTurn } from "./composer.ts";
import { dialogOpen, setUpDialogs } from "./dialogs.ts";
import { setUpExtensions } from "./extensions.ts";
import { setUpNotifications } from "./notify.ts";
import { setUpPreferences } from "./preferences.ts";
import { setUpPush } from "./push.ts";
import { setUpResize } from "./resize.ts";
import { setUpTheme } from "./theme.ts";
import { setUpToasts } from "./toasts.ts";
import { setUpViewport } from "./viewport.ts";

const SIDEBAR_WIDTH_KEY = "web-pi-sidebar-width";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 260;

function sidebar(): HTMLElement | null {
  return document.getElementById("session-sidebar");
}

/**
 * pi-web's title: the folder on screen, then the product. Only a folder this
 * page load actually opened counts — a session, or a folder named in the URL
 * — because pi-web builds the title from `activeCwd`, which stays null on the
 * restored index and new-session views (AppShell.tsx L1096).
 */
function setUpTitle(): void {
  const main = document.querySelector("main");
  const cwd = main?.dataset["cwd"] ?? "";
  const opened =
    (main?.dataset["sessionId"] ?? "") !== "" ||
    new URLSearchParams(location.search).has("cwd");
  const name = cwd.split(/[\\/]/).filter(Boolean).pop();
  document.title =
    name === undefined || !opened ? "web-pi" : `${name} - web-pi`;
}

export function closeMobileSidebar(): void {
  if (matchMedia("(max-width: 640px)").matches) setSidebarOpen(false);
}

function setSidebarOpen(open: boolean): void {
  const element = sidebar();
  if (!element) return;
  element.classList.toggle("sidebar-open", open);
  element.classList.toggle("sidebar-closed", !open);
  const toggle = document.getElementById("sidebar-toggle");
  toggle?.setAttribute("aria-expanded", String(open));
  const openIcon = toggle?.querySelector<HTMLElement>(
    "[data-sidebar-open-icon]",
  );
  const closedIcon = toggle?.querySelector<HTMLElement>(
    "[data-sidebar-closed-icon]",
  );
  if (openIcon) openIcon.hidden = !open;
  if (closedIcon) closedIcon.hidden = open;
  const backdrop = document.querySelector<HTMLElement>(
    ".sidebar-overlay-backdrop",
  );
  backdrop?.classList.toggle("is-open", open);
  const handle = document.querySelector<HTMLElement>(".sidebar-resize-handle");
  if (handle) handle.hidden = !open;
}

/**
 * The drawer starts closed on a phone. `.sidebar-mobile-pending` holds it off
 * screen until this runs, so the first paint never slides it away.
 */
function mountSidebar(element: HTMLElement): void {
  const mobile = matchMedia("(max-width: 640px)").matches;
  setSidebarOpen(!mobile);
  element.classList.remove("sidebar-mobile-pending");
  document
    .querySelector(".sidebar-overlay-backdrop")
    ?.classList.remove("sidebar-mobile-pending");
}

function mountSidebarResize(handle: HTMLElement, signal: AbortSignal): void {
  setUpResize(
    {
      handle,
      storageKey: SIDEBAR_WIDTH_KEY,
      property: "--sidebar-width",
      min: SIDEBAR_MIN,
      max: () => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, innerWidth - 320)),
      fallback: () => SIDEBAR_DEFAULT,
      // Anchored to the left edge: the width is the pointer's own x.
      widthAt: (clientX) => clientX,
    },
    signal,
  );
}

/**
 * System, Tools and Session info share one host under the top bar, and only
 * one is open at a time. A second click on the open button closes it, which
 * has to happen before htmx sees the click and fetches the panel again.
 */
/**
 * The narrow-phone toolbar: the three tabs live behind the "more" button and
 * slide in over the bar, as pi-web's `mobileToolbarMoreOpen` does.
 */
function mountMobileToolbar(button: HTMLElement, signal: AbortSignal): void {
  const tabs = document.getElementById("top-bar-tabs");
  if (!tabs) return;
  const closed = button.querySelector<HTMLElement>("[data-more-closed-icon]");
  const open = button.querySelector<HTMLElement>("[data-more-open-icon]");
  const paint = (showing: boolean): void => {
    tabs.toggleAttribute("data-open", showing);
    button.setAttribute("aria-expanded", String(showing));
    button.title = showing ? "Close" : "More controls";
    button.setAttribute("aria-label", showing ? "Close" : "More controls");
    if (closed) closed.hidden = showing;
    if (open) open.hidden = !showing;
  };
  paint(false);
  button.addEventListener(
    "click",
    () => {
      paint(!tabs.hasAttribute("data-open"));
    },
    { signal },
  );
}

function mountTopPanels(host: HTMLElement, signal: AbortSignal): void {
  const bar = document.getElementById("top-bar");
  if (!bar) return;
  const buttons = [
    ...document.querySelectorAll<HTMLElement>("[data-top-panel]"),
  ];
  // The host is fixed, so it has to be told where the bar is: it spans the
  // bar exactly, which is the centre column, never the sidebar.
  const place = (): void => {
    // Every scroll in the page lands here; a hidden host has nothing to place.
    if (host.hidden) return;
    const box = bar.getBoundingClientRect();
    host.style.top = `${String(box.bottom)}px`;
    host.style.left = `${String(box.left)}px`;
    host.style.width = `${String(box.width)}px`;
    host.style.maxHeight = `calc(100dvh - ${String(box.bottom)}px)`;
  };
  const observer = new ResizeObserver(place);
  observer.observe(bar);
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  addEventListener("scroll", place, { capture: true, signal });
  const paint = (open: string): void => {
    host.hidden = open === "";
    if (open !== "") place();
    for (const button of buttons) {
      const active = button.dataset["topPanel"] === open;
      button.setAttribute("aria-pressed", String(active));
    }
  };
  const close = (): void => {
    host.replaceChildren();
    paint("");
  };
  close();
  // What a panel answered decides its icon's colour, as the session state
  // does in pi-web: a prompt or an active tool tints the tab's icon.
  host.addEventListener(
    "htmx:after:settle",
    () => {
      const open = buttons.find(
        (button) => button.getAttribute("aria-pressed") === "true",
      );
      if (!open) return;
      const loaded =
        host.querySelector(".system-prompt-text, .tool-definitions-item") !==
        null;
      open.toggleAttribute("data-panel-loaded", loaded);
    },
    { signal },
  );
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLElement>("[data-top-panel]");
      if (!button) {
        // A click anywhere else dismisses the panel, as a popover would.
        if (!host.hidden && !host.contains(target)) close();
        return;
      }
      if (button.getAttribute("aria-pressed") === "true") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      paint(button.dataset["topPanel"] ?? "");
    },
    { capture: true, signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && !host.hidden) close();
    },
    { signal },
  );
}

function inTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement
  );
}

function setUpShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    // Escape inside a field is the composer's: it closes a menu first, and
    // an open dialog owns it outright, or closing the picker would abort the
    // turn behind it.
    if (event.key === "Escape") {
      if (dialogOpen()) return;
      if (!event.defaultPrevented && !inTextEntry(event.target)) abortTurn();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
      return;
    }
    if (event.key === "k") {
      event.preventDefault();
      location.assign("/new");
      return;
    }
    // Digits pick the nth session, but they are ordinary typing in a field.
    if (inTextEntry(event.target)) return;
    // 1..9, and 0 for the tenth, as in a browser's own tab shortcuts.
    const position = event.key === "0" ? 10 : Number(event.key);
    if (!Number.isInteger(position) || position < 1 || position > 10) return;
    const links = document.querySelectorAll<HTMLAnchorElement>(
      "#session-list a[href^='/sessions/']",
    );
    const link = links[position - 1];
    if (!link) return;
    event.preventDefault();
    location.assign(link.href);
  });
}

/** How long pi-web leaves a copy button showing its check mark. */
const COPIED_MS = 1400;

/**
 * The copy buttons of the session info panel. They hold both icons, so the
 * swap is a `hidden` flip rather than a text replacement.
 */
function setUpSessionCopy(): void {
  setUpRegion("[data-session-copy]", (button, signal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
    button.addEventListener(
      "click",
      () => {
        const value = button.dataset["sessionCopy"];
        if (value === undefined) return;
        const idle = button.querySelector<HTMLElement>("[data-copy-idle]");
        const done = button.querySelector<HTMLElement>("[data-copy-done]");
        void navigator.clipboard.writeText(value).then(() => {
          if (signal.aborted) return;
          if (idle) idle.hidden = true;
          if (done) done.hidden = false;
          button.classList.add("is-copied");
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (idle) idle.hidden = false;
            if (done) done.hidden = true;
            button.classList.remove("is-copied");
          }, COPIED_MS);
        }, noop);
      },
      { signal },
    );
  });
}

function noop(): void {
  // A browser that refuses the clipboard leaves the value on screen to select.
}

/**
 * pi-web's global/project segmented control. The pressed button writes the
 * hidden field its form posts, and the install path beside it follows.
 */
function setUpScopePickers(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const option = target.closest<HTMLElement>("[data-scope]");
    const picker = option?.closest<HTMLElement>("[data-scope-picker]");
    const scope = option?.dataset["scope"];
    if (!picker || scope === undefined) return;
    for (const button of picker.querySelectorAll<HTMLElement>("[data-scope]")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset["scope"] === scope),
      );
    }
    const field =
      picker.parentElement?.querySelector<HTMLInputElement>(
        "[data-scope-value]",
      );
    if (field) field.value = scope;
    const path = picker
      .closest("form, .config-detail-stack")
      ?.querySelector<HTMLElement>("[data-scope-path]");
    const shown =
      path?.dataset[
        scope === "project" ? "scopePathProject" : "scopePathGlobal"
      ];
    if (path && shown !== undefined) path.textContent = shown;
  });
}

/** The three example sources under the Add plugin form fill the field. */
function setUpPluginExamples(): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const example = target.closest<HTMLElement>("[data-plugin-example]")
      ?.dataset["pluginExample"];
    if (example === undefined) return;
    const field = document.querySelector<HTMLInputElement>("#plugin-source");
    if (field) field.value = example;
  });
}

function mountModelSettings(form: HTMLElement, signal: AbortSignal): void {
  const filter = form.querySelector<HTMLInputElement>("#settings-model-filter");
  filter?.addEventListener(
    "input",
    () => {
      const query = filter.value.trim().toLocaleLowerCase();
      let count = 0;
      for (const row of form.querySelectorAll<HTMLElement>(
        "[data-model-search]",
      )) {
        row.hidden = !(row.dataset["modelSearch"] ?? "")
          .toLocaleLowerCase()
          .includes(query);
        if (!row.hidden) count++;
      }
      const empty = form.querySelector<HTMLElement>("[data-model-empty]");
      if (empty) empty.hidden = count > 0;
    },
    { signal },
  );
}

export function setUpShell(): void {
  setUpRegion(".settings-models", mountModelSettings);
  setUpTheme();
  setUpRegion("main", setUpTitle);
  setUpPreferences();
  setUpDialogs();
  setUpRegion("#session-sidebar", mountSidebar);
  setUpRegion("#sidebar-toggle", () => {
    setSidebarOpen(sidebar()?.classList.contains("sidebar-open") ?? false);
  });
  setUpRegion(".sidebar-resize-handle", mountSidebarResize);
  setUpRegion("#mobile-toolbar-more", mountMobileToolbar);
  setUpRegion("#top-panel", mountTopPanels);
  setUpShortcuts();
  setUpToasts();
  setUpViewport();
  setUpSessionCopy();
  setUpScopePickers();
  setUpPluginExamples();
  setUpExtensions();
  setUpNotifications();
  setUpPush();
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#page-refresh")) location.reload();
    else if (target.closest("#sidebar-toggle")) {
      setSidebarOpen(!(sidebar()?.classList.contains("sidebar-open") ?? false));
    } else if (target.closest(".sidebar-overlay-backdrop"))
      setSidebarOpen(false);
  });
}
