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
import { displayedCwd, displayedSessionId } from "./navigation.ts";
import { setUpTheme } from "./theme.ts";
import { setUpToasts } from "./toasts.ts";
import { isTextEntry, setUpViewport } from "./viewport.ts";

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
  const opened =
    displayedSessionId() !== "" ||
    new URLSearchParams(location.search).has("cwd");
  const name = displayedCwd().split(/[\\/]/).filter(Boolean).pop();
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

/**
 * System, Tools and Session info are popovers that fetch their content as
 * they open. Closing one empties it, so the next opening never shows the last
 * answer, and what a panel answered tints its tab's icon, as the session
 * state does in pi-web: a prompt or an active tool.
 */
function setUpTopPanels(): void {
  // Popover toggle events do not bubble.
  document.addEventListener(
    "toggle",
    (event) => {
      const panel = event.target;
      if (
        panel instanceof HTMLElement &&
        panel.matches(".shell-top-panel") &&
        event.newState === "closed"
      )
        panel.replaceChildren();
    },
    true,
  );
  document.addEventListener("htmx:after:settle", (event) => {
    const panel =
      event.target instanceof Element
        ? event.target.closest(".shell-top-panel")
        : null;
    if (!panel) return;
    const loaded =
      panel.querySelector(".system-prompt-text, .tool-definitions-item") !==
      null;
    document
      .querySelector(`[popovertarget="${panel.id}"]`)
      ?.toggleAttribute("data-panel-loaded", loaded);
  });
}

/**
 * What Escape closes before it may stop the turn: the browser closes a dialog
 * or popover only after the key's listeners have run, so it is still open.
 */
function somethingOpen(): boolean {
  return dialogOpen() || document.querySelector(":popover-open") !== null;
}

function setUpShortcuts(): void {
  document.addEventListener("keydown", (event) => {
    // Escape inside a field is the composer's: it closes a menu first.
    if (event.key === "Escape") {
      if (
        !event.defaultPrevented &&
        !isTextEntry(event.target) &&
        !somethingOpen()
      )
        abortTurn();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
      return;
    }
    if (event.key === "k") {
      event.preventDefault();
      if (dialogOpen()) return;
      // The link swaps the session region, keeping attachments and streams
      // that a page load would drop.
      const link = document.querySelector<HTMLAnchorElement>(
        "a[data-session-link]",
      );
      if (link) link.click();
      else location.assign("/new");
    }
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
  form.addEventListener(
    "change",
    (event) => {
      const checkbox = event.target;
      if (!(checkbox instanceof HTMLInputElement) || checkbox.name !== "model")
        return;
      const selected = form.querySelectorAll(
        'input[name="model"]:checked',
      ).length;
      if (!selected) {
        checkbox.checked = true;
        const status = form.querySelector<HTMLElement>("[data-model-status]");
        if (status)
          status.textContent =
            "Keep at least one model selected, or choose Use all models.";
      }
      const save = form.querySelector<HTMLButtonElement>("[data-model-save]");
      if (save) save.disabled = false;
    },
    { signal },
  );
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
  setUpTopPanels();
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
