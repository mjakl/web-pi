import type { Htmx, HtmxRequestCtx } from "htmx.org";
import { requestContext } from "./htmx.ts";
import { buildAtInsertText } from "@core/composer";
import { catppuccinIcon } from "@core/file-types";
import { replaceRange, textarea } from "./editor.ts";
import { setUpRegion } from "./lifecycle.ts";
import { setUpResize } from "./resize.ts";
import { TAB_CLOSE_ICON } from "@web/views/icons";

// The files area's browser half: how wide it is, which tabs are open, where
// each was scrolled, and the stream that tells the viewer its file moved.
// Everything the panel shows is rendered by the server; this decides what to
// ask for and keeps the reading position while it arrives.

const WIDTH_KEY = "web-pi-right-panel-width";
const MIN_WIDTH = 300;
const MAX_WIDTH = 1200;

const CATPPUCCIN_ROOT = "/static/icons/catppuccin";

function htmx(): Htmx | undefined {
  return (globalThis as { htmx?: Htmx }).htmx;
}

function panel(): HTMLElement | null {
  return document.getElementById("file-panel");
}

function sessionId(): string {
  return panel()?.dataset["session"] ?? "";
}

/** Which folder the explorer is about: the open session's, or the picked one. */
function scopeQuery(): string {
  const id = sessionId();
  if (id !== "") return `session=${encodeURIComponent(id)}`;
  return `cwd=${encodeURIComponent(panel()?.dataset["cwd"] ?? "")}`;
}

/** Per-tab, in memory only: reopening web-pi starts with no tabs, as pi-web. */
type TabState = { mode: string; wrap: boolean; scrollTop: number };

const tabs = new Map<string, TabState>();
let active: string | null = null;
let viewerRequest: HtmxRequestCtx | null = null;

function cancelViewerRequest(): void {
  const previous = viewerRequest;
  viewerRequest = null;
  previous?.request.abort();
}

function viewerStatus(path: string, error = false): void {
  const host = document.getElementById("file-view");
  if (!host) return;
  const status = document.createElement("div");
  status.className = `file-viewer-empty file-viewer-status${error ? " is-error" : ""}`;
  status.role = "status";
  status.textContent = error
    ? `Could not load ${baseName(path)}. Open the file again to retry.`
    : `Loading ${baseName(path)}…`;
  status.title = path;
  if (error) host.removeAttribute("aria-busy");
  else host.setAttribute("aria-busy", "true");
  host.replaceChildren(status);
}

function isViewerRequest(ctx: HtmxRequestCtx): boolean {
  return (
    ctx.target.id === "file-view" &&
    new URL(ctx.request.action, document.baseURI).pathname === "/files/view"
  );
}

function currentViewerRequest(ctx: HtmxRequestCtx): boolean {
  return (
    ctx === viewerRequest &&
    ctx.target.isConnected &&
    !ctx.request.signal.aborted
  );
}

function defaultWidth(): number {
  return Math.min(640, Math.max(360, Math.round(innerWidth * 0.42)));
}

/**
 * The panel is a column beside the conversation at 960px and up, so it may
 * not grow past what leaves the transcript room to read; below that it
 * overlays and only the absolute cap applies.
 */
function maxWidth(): number {
  // The row the panel shares with the transcript, not the window: the
  // sidebar is a column of its own.
  const row =
    panel()?.parentElement?.getBoundingClientRect().width ?? innerWidth;
  const room = innerWidth >= 960 ? row - 420 : row;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, room));
}

function isOpen(): boolean {
  return panel()?.classList.contains("right-panel-open") ?? false;
}

function setOpen(open: boolean): void {
  const element = panel();
  if (!element) return;
  element.classList.toggle("right-panel-open", open);
  element.classList.toggle("right-panel-closed", !open);
  document.body.dataset["filePanel"] = open ? "open" : "closed";
  const toggle = document.getElementById("file-panel-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    // pi-web names the button for what the click does next (files.showPanel /
    // files.hidePanel), so the label flips with the panel.
    const label = open ? "Hide file panel" : "Show file panel";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  }
  if (open) connectWatch();
  else disconnectWatch();
}

// --- Tabs ----------------------------------------------------------------

function tabBar(): HTMLElement | null {
  return document.getElementById("file-tabs");
}

function baseName(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/** The masked Catppuccin span the views render, built without JSX. */
function fileIcon(name: string): HTMLSpanElement {
  const icon = document.createElement("span");
  const file = catppuccinIcon(name);
  icon.className = "catppuccin-file-icon";
  icon.ariaHidden = "true";
  icon.style.setProperty(
    "--catppuccin-icon-light",
    `url(${CATPPUCCIN_ROOT}/latte/${file}.svg)`,
  );
  icon.style.setProperty(
    "--catppuccin-icon-dark",
    `url(${CATPPUCCIN_ROOT}/mocha/${file}.svg)`,
  );
  return icon;
}

/** pi-web's TabBar (components/TabBar.tsx), built in the browser. */
function renderTabs(): void {
  const bar = tabBar();
  if (!bar) return;
  bar.replaceChildren();
  bar.hidden = tabs.size === 0;
  for (const path of tabs.keys()) {
    const selected = path === active;
    const label = baseName(path);
    const tab = document.createElement("div");
    tab.className = "file-tab";
    tab.role = "tab";
    tab.dataset["path"] = path;
    tab.setAttribute("aria-selected", selected ? "true" : "false");

    const icon = document.createElement("span");
    icon.className = "file-tab-icon";
    icon.append(fileIcon(label));

    const name = document.createElement("span");
    name.className = "file-tab-name";
    name.title = path;
    name.textContent = label;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.dataset["close"] = "1";
    close.title = "Close";
    close.setAttribute("aria-label", `Close ${label}`);
    close.innerHTML = TAB_CLOSE_ICON;

    tab.append(icon, name, close);
    bar.append(tab);
  }
}

function viewer(): HTMLElement | null {
  return document.querySelector("#file-view .file-viewer-shell");
}

function viewerBody(): HTMLElement | null {
  return document.querySelector("#file-view .file-viewer-content");
}

function saveActiveState(): void {
  if (active === null) return;
  const element = viewer();
  const state = tabs.get(active);
  if (!element || !state || element.dataset["path"] !== active) return;
  state.mode = element.dataset["mode"] ?? state.mode;
  const body = viewerBody();
  if (body) state.scrollTop = body.scrollTop;
}

function loadViewer(path: string, mode?: string): void {
  const state = tabs.get(path);
  // The same scope the tree is listed from: without a session the viewer
  // still needs the folder, for the relative path and the diff against HEAD.
  const query = new URLSearchParams(scopeQuery());
  query.set("path", path);
  const wanted = mode ?? state?.mode;
  if (wanted !== undefined && wanted !== "") query.set("mode", wanted);
  const target = document.getElementById("file-view");
  if (!target) return;
  cancelViewerRequest();
  viewerStatus(path);
  void htmx()?.ajax("GET", `/files/view?${query.toString()}`, {
    target,
    swap: "innerHTML",
  });
}

function restoreViewer(): void {
  const element = viewer();
  if (!element) return;
  describeMedia(element);
  if (active === null) return;
  const state = tabs.get(active);
  if (!state) return;
  state.mode = element.dataset["mode"] ?? state.mode;
  applyWrap(state.wrap);
  const body = viewerBody();
  if (body && state.scrollTop > 0) body.scrollTop = state.scrollTop;
  // Every mode switch and every change replaces the toolbar, so the live
  // indicator has to be re-lit from the stream that is already open.
  showWatching(stream !== null && watching === active);
}

/** pi-web re-renders the source with different inline styles; a class does. */
function applyWrap(wrap: boolean): void {
  const source = viewer()?.querySelector<HTMLElement>(".file-source-view");
  source?.classList.toggle("is-wrapped", wrap);
  const toggle = viewer()?.querySelector("[data-wrap-toggle]");
  toggle?.setAttribute("aria-pressed", wrap ? "true" : "false");
  const label = wrap ? "Disable word wrap" : "Enable word wrap";
  toggle?.setAttribute("title", label);
  toggle?.setAttribute("aria-label", label);
}

export function openFile(path: string, mode?: string): void {
  saveActiveState();
  const existing = tabs.get(path);
  if (!existing) {
    tabs.set(path, { mode: mode ?? "", wrap: false, scrollTop: 0 });
  } else if (mode !== undefined && mode !== existing.mode) {
    // A hint ("open this at its diff") resets the position but keeps wrap.
    existing.mode = mode;
    existing.scrollTop = 0;
  }
  active = path;
  setOpen(true);
  renderTabs();
  loadViewer(path, mode);
}

function emptyViewer(): void {
  const host = document.getElementById("file-view");
  if (!host) return;
  host.removeAttribute("aria-busy");
  const empty = document.createElement("div");
  empty.className = "file-viewer-empty";
  empty.textContent = "No file open";
  host.replaceChildren(empty);
}

function closeTab(path: string): void {
  const wasActive = active === path;
  tabs.delete(path);
  if (!wasActive) {
    renderTabs();
    return;
  }
  const last = [...tabs.keys()].at(-1);
  active = last ?? null;
  renderTabs();
  if (last === undefined) {
    cancelViewerRequest();
    emptyViewer();
    disconnectWatch();
    setOpen(false);
    return;
  }
  connectWatch();
  loadViewer(last);
}

// --- Live watch ----------------------------------------------------------

let stream: EventSource | null = null;
let watchController: AbortController | null = null;
let watching: string | null = null;

function disconnectWatch(): void {
  watchController?.abort();
  watchController = null;
  stream?.close();
  stream = null;
  watching = null;
}

/** The dot, and the "live"/"static" word the media toolbars carry beside it. */
function showWatching(live: boolean): void {
  const element = viewer();
  if (!element) return;
  const dot = element.querySelector<HTMLElement>(".file-viewer-live-indicator");
  if (dot) {
    dot.classList.toggle("is-live", live);
    const title = live ? "Live sync active" : "Not watching";
    dot.title = title;
    dot.setAttribute("aria-label", title);
  }
  const pill = element.querySelector<HTMLElement>(".file-viewer-live");
  if (pill) {
    pill.classList.toggle("is-live", live);
    pill.title = live ? "Live sync active" : "Not watching";
  }
  const word = element.querySelector(".file-viewer-live-label");
  if (word) word.textContent = live ? "live" : "static";
}

function connectWatch(): void {
  if (!isOpen() || active === null) {
    disconnectWatch();
    return;
  }
  if (watching === active && stream !== null) return;
  disconnectWatch();
  watching = active;
  const query = new URLSearchParams({ path: active, session: sessionId() });
  const source = new EventSource(`/files/watch?${query.toString()}`);
  stream = source;
  watchController = new AbortController();
  const { signal } = watchController;
  source.addEventListener(
    "connected",
    () => {
      showWatching(true);
    },
    { signal },
  );
  source.addEventListener(
    "change",
    () => {
      if (active !== null) {
        saveActiveState();
        loadViewer(active);
      }
    },
    { signal },
  );
  source.addEventListener(
    "error",
    () => {
      showWatching(false);
    },
    { signal },
  );
}

// --- Line ranges ---------------------------------------------------------

function lineOf(node: Node | null): number | null {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const row = element?.closest<HTMLElement>(".file-source-line");
  const value = Number(row?.dataset["lineNumber"]);
  return Number.isInteger(value) ? value : null;
}

/** The lines the reader actually selected, trimmed to what is highlighted. */
function selectedRange(): { start: number; end: number } | null {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const source = viewer()?.querySelector(".file-source-view");
  if (!source || !source.contains(range.commonAncestorContainer)) return null;
  const first = lineOf(range.startContainer);
  const last = lineOf(range.endContainer);
  if (first === null || last === null) return null;
  // A selection that ends at offset 0 of a row never covered that row.
  const end = range.endOffset === 0 && last > first ? last - 1 : last;
  return { start: Math.min(first, end), end: Math.max(first, end) };
}

function mentionActiveFile(): void {
  const element = viewer();
  const area = textarea();
  if (!element || !area) return;
  const relative = element.dataset["relative"] ?? element.dataset["path"] ?? "";
  if (relative === "") return;
  const range = selectedRange();
  const insert = buildAtInsertText(
    { path: relative, isDir: false },
    false,
    range ?? undefined,
  );
  replaceRange(
    area,
    area.selectionStart,
    area.selectionEnd,
    insert.text,
    insert.caret,
  );
}

// --- The explorer tree ---------------------------------------------------

function treeItems(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>("#file-tree [role='treeitem']"),
  ].filter((item) => item.offsetParent !== null);
}

function focusItem(item: HTMLElement | undefined): void {
  if (!item) return;
  for (const other of treeItems()) other.tabIndex = -1;
  item.tabIndex = 0;
  item.focus();
}

function expand(item: HTMLElement, open: boolean): void {
  if (item.dataset["dir"] !== "1") return;
  item.setAttribute("aria-expanded", open ? "true" : "false");
  const children = item.querySelector<HTMLElement>(":scope > [data-children]");
  if (children) children.hidden = !open;
  const folder = item.querySelector<HTMLElement>(
    ":scope > .file-tree-row .catppuccin-file-icon",
  );
  // The folder icon has an open variant; the chevron is turned by CSS.
  if (folder) {
    const name = open ? "_folder_open" : "_folder";
    folder.style.setProperty(
      "--catppuccin-icon-light",
      `url(${CATPPUCCIN_ROOT}/latte/${name}.svg)`,
    );
    folder.style.setProperty(
      "--catppuccin-icon-dark",
      `url(${CATPPUCCIN_ROOT}/mocha/${name}.svg)`,
    );
  }
  if (open) item.dispatchEvent(new CustomEvent("expand"));
}

function activate(item: HTMLElement): void {
  const path = item.dataset["path"];
  if (path === undefined) return;
  if (item.dataset["dir"] === "1") {
    expand(item, item.getAttribute("aria-expanded") !== "true");
    return;
  }
  openFile(path);
}

function onTreeKey(event: KeyboardEvent): void {
  const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    "[role='treeitem']",
  );
  if (!item) return;
  const items = treeItems();
  const index = items.indexOf(item);
  switch (event.key) {
    case "ArrowDown":
      focusItem(items[index + 1]);
      break;
    case "ArrowUp":
      focusItem(items[index - 1]);
      break;
    case "ArrowRight":
      if (item.dataset["dir"] !== "1") return;
      if (item.getAttribute("aria-expanded") === "true") {
        focusItem(items[index + 1]);
      } else expand(item, true);
      break;
    case "ArrowLeft":
      if (item.getAttribute("aria-expanded") === "true") expand(item, false);
      else {
        focusItem(
          item.parentElement?.closest<HTMLElement>("[role='treeitem']") ??
            undefined,
        );
      }
      break;
    case "Home":
      focusItem(items[0]);
      break;
    case "End":
      focusItem(items.at(-1));
      break;
    case "Enter":
    case " ":
      activate(item);
      break;
    default:
      return;
  }
  event.preventDefault();
}

// --- Changed files -------------------------------------------------------

function changesToggle(): HTMLElement | null {
  return document.getElementById("explorer-changes-toggle");
}

function showingChanges(): boolean {
  return changesToggle()?.getAttribute("aria-pressed") === "true";
}

function explorerUrl(): string {
  const base = `/files/explorer?${scopeQuery()}`;
  return showingChanges() ? `${base}&changes=1` : base;
}

/**
 * The magnifier in the explorer header opens the field and closes it again,
 * as pi-web's `fileSearchOpen` does; closing it puts the tree back.
 */
function toggleFileSearch(button: Element): void {
  const field = document.getElementById("file-search-field");
  const input = document.getElementById("file-search");
  if (!field || !(input instanceof HTMLInputElement)) return;
  const open = field.hidden;
  field.hidden = !open;
  button.setAttribute("aria-pressed", open ? "true" : "false");
  if (open) {
    input.focus();
    return;
  }
  if (input.value === "") return;
  input.value = "";
  // htmx listens for `search`, which is what clearing the field fires.
  input.dispatchEvent(new Event("search", { bubbles: true }));
}

/** pi-web only offers the toggle while something is actually changed. */
function syncChangesToggle(): void {
  const toggle = changesToggle();
  const tree = document.getElementById("file-tree");
  if (!toggle || !tree) return;
  // Search results carry no count; they are a view of the same tree, so the
  // button keeps whatever the last explorer fragment said.
  const reported = tree.dataset["changes"];
  if (reported === undefined) return;
  const count = Number(reported);
  toggle.hidden = count === 0;
  const label = `${String(count)} changed files`;
  toggle.title = label;
  toggle.setAttribute("aria-label", label);
  if (count === 0) toggle.setAttribute("aria-pressed", "false");
}

// --- Resizing ------------------------------------------------------------

function mountPanelResize(handle: HTMLElement, signal: AbortSignal): void {
  setUpResize(
    {
      handle,
      storageKey: WIDTH_KEY,
      property: "--right-panel-width",
      min: MIN_WIDTH,
      max: maxWidth,
      fallback: defaultWidth,
      // Anchored to the right edge: the width is the distance to it.
      widthAt: (clientX) => innerWidth - clientX,
    },
    signal,
  );
}

/**
 * What only the browser can measure: an image's pixels and an audio file's
 * length. Both land in the slot the media toolbar keeps for them, ahead of
 * the size the server already rendered.
 */
function describeMedia(root: ParentNode): void {
  const slot = root.querySelector<HTMLElement>(".file-viewer-measured");
  if (!slot) return;
  const image = root.querySelector("img");
  if (image) {
    const size = () => {
      if (image.naturalWidth > 0) {
        slot.textContent = `${String(image.naturalWidth)} × ${String(image.naturalHeight)}`;
      }
    };
    if (image.complete) size();
  }
  const audio = root.querySelector("audio");
  if (audio) {
    const length = () => {
      if (!Number.isFinite(audio.duration)) return;
      const seconds = Math.round(audio.duration);
      const minutes = Math.floor(seconds / 60);
      slot.textContent = `${String(minutes)}:${String(seconds % 60).padStart(2, "0")}`;
    };
    if (audio.readyState > 0) length();
  }
}

export function setUpFiles(): void {
  setUpRegion("#file-panel", (_owner, signal) => {
    tabs.clear();
    active = null;
    renderTabs();
    emptyViewer();
    setOpen(false);
    signal.addEventListener(
      "abort",
      () => {
        cancelViewerRequest();
        disconnectWatch();
        tabs.clear();
        active = null;
      },
      { once: true },
    );
  });
  setUpRegion(".right-panel-resize-handle", mountPanelResize);
  setUpRegion("#file-panel-toggle", () => {
    setOpen(isOpen());
  });
  for (const type of ["load", "loadedmetadata"]) {
    document.addEventListener(
      type,
      (event) => {
        const target = event.target;
        if (
          !(
            target instanceof HTMLImageElement ||
            target instanceof HTMLAudioElement
          )
        )
          return;
        const root = target.closest("#file-view .file-viewer-shell");
        if (root) describeMedia(root);
      },
      true,
    );
  }

  // Mode buttons and watch refreshes share the same viewer request lifecycle.
  document.addEventListener("htmx:config:request", (event) => {
    const ctx = requestContext(event);
    if (!isViewerRequest(ctx)) return;
    const path = new URL(ctx.request.action, document.baseURI).searchParams.get(
      "path",
    );
    if (!ctx.target.isConnected || path === null || path !== active) {
      event.preventDefault();
      return;
    }
    saveActiveState();
    cancelViewerRequest();
    viewerRequest = ctx;
    viewerStatus(path);
  });
  for (const type of ["htmx:before:response", "htmx:before:swap"]) {
    document.addEventListener(type, (event) => {
      const ctx = requestContext(event);
      if (isViewerRequest(ctx) && !currentViewerRequest(ctx))
        event.preventDefault();
    });
  }
  for (const type of ["htmx:after:request", "htmx:error"]) {
    document.addEventListener(type, (event) => {
      const ctx = requestContext(event) as HtmxRequestCtx | undefined;
      if (
        ctx &&
        isViewerRequest(ctx) &&
        (type === "htmx:error" || (ctx.response?.status ?? 0) >= 400)
      ) {
        // A mode request's source was removed by the pending state, so its
        // inherited HTTP-error swap rule is no longer available to HTMX.
        event.preventDefault();
        if (currentViewerRequest(ctx) && active !== null) {
          viewerStatus(active, true);
        }
      }
    });
  }

  // Anything carrying a path opens the viewer: a transcript link, a
  // written-file chip, a tool call's path, a changes row, a tree row.
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#file-panel-toggle")) {
      setOpen(!isOpen());
      return;
    }
    if (target.closest("#file-panel-close")) {
      setOpen(false);
      return;
    }
    const tab = target.closest<HTMLElement>(".file-tab");
    if (tab) {
      const path = tab.dataset["path"] ?? "";
      if (target.closest("[data-close]")) closeTab(path);
      else if (path !== active) openFile(path);
      return;
    }
    if (target.closest("[data-wrap-toggle]")) {
      const state = active === null ? undefined : tabs.get(active);
      if (!state) return;
      state.wrap = !state.wrap;
      applyWrap(state.wrap);
      return;
    }
    if (target.closest("[data-mention-file]")) {
      mentionActiveFile();
      return;
    }
    const search = target.closest("#explorer-search-toggle");
    if (search) {
      toggleFileSearch(search);
      return;
    }
    const toggle = target.closest("#explorer-changes-toggle");
    if (toggle) {
      const showing = showingChanges();
      toggle.setAttribute("aria-pressed", showing ? "false" : "true");
      void htmx()?.ajax("GET", explorerUrl(), {
        target: "#file-tree",
        swap: "outerHTML",
      });
      return;
    }
    const holder = target.closest<HTMLElement>("[data-file-path]");
    if (holder) {
      event.preventDefault();
      openFile(
        holder.dataset["filePath"] ?? "",
        holder.dataset["fileMode"] ?? undefined,
      );
      return;
    }
    const row = target.closest<HTMLElement>(".file-tree-row");
    const item = row?.parentElement;
    if (item && !target.closest(".file-tree-action")) {
      focusItem(item);
      activate(item);
    }
  });

  // The mention button must not steal the selection it is about to quote.
  document.addEventListener("pointerdown", (event) => {
    if ((event.target as Element | null)?.closest("[data-mention-file]")) {
      event.preventDefault();
    }
  });

  // Middle click closes a tab, as it does in a browser.
  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const tab = (event.target as Element | null)?.closest<HTMLElement>(
      ".file-tab",
    );
    if (!tab) return;
    event.preventDefault();
    closeTab(tab.dataset["path"] ?? "");
  });

  document.addEventListener("keydown", (event) => {
    const search = document.getElementById("file-search");
    if (event.key === "Escape" && event.target === search) {
      if (search instanceof HTMLInputElement) {
        search.value = "";
        // htmx listens for `search`, which is what clearing the field fires.
        search.dispatchEvent(new Event("search", { bubbles: true }));
      }
      event.preventDefault();
      return;
    }
    onTreeKey(event);
  });

  // The explorer refreshes itself on every settled turn; keep the changed
  // files showing when that is what the reader asked for.
  document.addEventListener("htmx:config:request", (event) => {
    const { request } = requestContext(event);
    if (
      new URL(request.action, document.baseURI).pathname !== "/files/explorer"
    )
      return;
    if (showingChanges() && request.body instanceof FormData) {
      request.body.set("changes", "1");
    }
  });

  // A refreshed tree loses focus positions; the first row becomes the entry.
  document.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.id === "file-explorer" || target.id === "file-tree") {
      const first = treeItems()[0];
      if (first) first.tabIndex = 0;
      syncChangesToggle();
    }
    if (target.id === "file-view" && viewer()) {
      target.removeAttribute("aria-busy");
      restoreViewer();
    }
  });

  // A viewer that scrolls records where it is, so switching tabs comes back.
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.classList.contains("file-viewer-content")
      ) {
        saveActiveState();
      }
    },
    true,
  );

  addEventListener("pagehide", disconnectWatch);
}
