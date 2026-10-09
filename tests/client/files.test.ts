import type { HtmxRequestCtx } from "htmx.org";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  click,
  flush,
  htmx,
  htmxEvent,
  keydown,
  mount,
  query,
  setRect,
} from "./helpers.ts";

// The file panel's browser half: tabs and their per-tab state, what the
// viewer asks htmx for, the watch stream, the explorer tree's keyboard, and
// the selection that becomes an `@` mention.

function load() {
  return import("@web/client/files");
}

/** What a viewer fragment carries: the toolbar hooks and numbered lines. */
function viewer(path: string, mode = "source", lines = 3): string {
  const source = Array.from(
    { length: lines },
    (_, index) =>
      `<span class="file-source-line" data-line-number="${String(index + 1)}">` +
      `<span class="file-source-line-content">line ${String(index + 1)}</span></span>`,
  ).join("\n");
  return (
    `<div class="file-viewer-shell" data-path="/repo/one/${path}" data-relative="${path}" data-mode="${mode}">` +
    '<div class="file-viewer-toolbar">' +
    '<span class="file-viewer-live-indicator" title="Not watching"></span>' +
    '<span class="file-viewer-live"><span class="file-viewer-live-label">static</span></span>' +
    '<span class="file-viewer-measured"></span>' +
    '<button type="button" data-mention-file>@</button>' +
    '<button type="button" data-wrap-toggle aria-pressed="false">wrap</button>' +
    "</div>" +
    `<div class="file-viewer-content"><pre class="file-source-view">${source}</pre></div></div>`
  );
}

function treeItem(
  path: string,
  options: { dir?: boolean; open?: boolean; children?: string } = {},
): string {
  const name = path.split("/").pop() ?? path;
  const open = options.open === true;
  const row = `<div class="file-tree-row"><span class="catppuccin-file-icon"></span><span>${name}</span><button type="button" class="file-tree-action" data-mention="${path}">@</button></div>`;
  if (options.dir !== true) {
    return `<div class="file-tree-node" role="treeitem" tabindex="-1" data-path="${path}" data-name="${name}">${row}</div>`;
  }
  return `<div class="file-tree-node" role="treeitem" tabindex="-1" data-path="${path}" data-name="${name}" data-dir="1" aria-expanded="${String(open)}">${row}<div role="group" data-children${open ? "" : " hidden"}>${options.children ?? ""}</div></div>`;
}

function page(
  options: { session?: string; tree?: string; changes?: number } = {},
): void {
  const session = options.session ?? "s1";
  mount(
    `<main data-session-id="${session}">` +
      '<form id="composer"><textarea id="composer-text"></textarea></form>' +
      '<button type="button" id="file-panel-toggle" aria-expanded="false"></button>' +
      '<div class="panel-resize-handle right-panel-resize-handle" tabindex="0"></div>' +
      '<div id="file-explorer">' +
      '<button type="button" id="explorer-search-toggle" aria-pressed="false"></button>' +
      '<div id="file-search-field" hidden><input id="file-search"></div>' +
      '<button type="button" id="explorer-changes-toggle" aria-pressed="false"></button>' +
      `<div id="file-tree" role="tree"${options.changes === undefined ? "" : ` data-changes="${String(options.changes)}"`}>${options.tree ?? ""}</div>` +
      "</div>" +
      `<div id="file-panel" class="right-panel-container right-panel-closed" data-session="${session}" data-cwd="/repo/one">` +
      '<div id="file-tabs" role="tablist" hidden></div>' +
      '<button type="button" id="file-panel-close"></button>' +
      '<div id="file-view" hx-sync="#file-view:replace"><div>No file open</div></div>' +
      "</div></main>",
  );
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

function streams(): FakeEventSource[] {
  return FakeEventSource.instances;
}

/** Answers the last viewer request with a fragment, as htmx would swap it. */
async function deliver(html: string): Promise<void> {
  byId("file-view").innerHTML = html;
  htmxEvent(byId("file-view"), "htmx:after:settle");
  await flush();
}

// Hold the transport, not the client lifecycle. Even an aborted request can
// deliver here so the tests prove rejection before a swap, not just cancellation.
function delayedViewers() {
  const requests: {
    ctx: HtmxRequestCtx;
    respond: (html: string, status?: number) => Promise<void>;
    fail: () => Promise<void>;
  }[] = [];
  const emit = (ctx: HtmxRequestCtx, name: string) => {
    const event = new CustomEvent(name, {
      bubbles: true,
      cancelable: true,
      detail: { ctx },
    });
    (ctx.sourceElement.isConnected
      ? ctx.sourceElement
      : document
    ).dispatchEvent(event);
    return !event.defaultPrevented;
  };
  htmx().ajax.mockImplementation((_verb, url, options) => {
    const { target, source = target } = options as {
      target: HTMLElement;
      source?: HTMLElement;
    };
    const controller = new AbortController();
    const ctx: HtmxRequestCtx = {
      sourceElement: source,
      sourceEvent: null,
      target,
      swap: "innerHTML",
      select: "",
      selectOOB: "",
      push: false,
      replace: false,
      transition: false,
      request: {
        action: url,
        method: "GET",
        headers: {},
        validate: false,
        signal: controller.signal,
        abort: () => {
          controller.abort();
        },
        credentials: "same-origin",
        mode: "same-origin",
      },
    };
    if (!emit(ctx, "htmx:config:request")) return Promise.resolve();
    return new Promise<void>((resolve) => {
      requests.push({
        ctx,
        async respond(html, status = 200) {
          ctx.response = {
            raw: new Response(html, { status }),
            status,
            headers: new Headers(),
          };
          if (emit(ctx, "htmx:before:response")) {
            ctx.text = html;
            if (emit(ctx, "htmx:after:request")) {
              if (status >= 400) emit(ctx, "htmx:response:error");
              if (emit(ctx, "htmx:before:swap")) {
                target.innerHTML = html;
                htmxEvent(target, "htmx:after:settle");
              }
            }
          }
          resolve();
          await flush();
        },
        async fail() {
          emit(ctx, "htmx:error");
          resolve();
          await flush();
        },
      });
    });
  });
  return requests;
}

function tabs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#file-tabs .file-tab")];
}

function ajaxUrls(): string[] {
  return htmx().ajax.mock.calls.map((call) => call[1]);
}

describe("file panel width", () => {
  it.each([
    ["pi-right-panel-width", "420px"],
    ["web-pi-right-panel-width", "450px"],
  ])("restores only the current preference key: %s", async (key, expected) => {
    localStorage.setItem(key, "450");
    window.innerWidth = 1000;
    page();
    setRect(query("main"), { width: 1000 });
    const { setUpFiles } = await load();
    setUpFiles();
    expect(
      document.documentElement.style.getPropertyValue("--right-panel-width"),
    ).toBe(expected);
  });
});

describe("file panel replacement", () => {
  it("releases the old watcher and tabs, then binds the replacement without duplicate opens", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("old.ts");
    await deliver(viewer("old.ts"));
    const oldStream = streams()[0];
    const oldHandle = query(".right-panel-resize-handle");
    const oldBody = document.body;
    const replacement = document.createElement("body");
    replacement.innerHTML = oldBody.innerHTML.replaceAll(
      'data-session="s1"',
      'data-session="s2"',
    );
    oldBody.replaceWith(replacement);
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    expect(oldStream?.closed).toBe(true);
    expect(tabs()).toHaveLength(0);
    expect(byId("file-panel").classList.contains("right-panel-closed")).toBe(
      true,
    );
    expect(byId("file-view").textContent).toBe("No file open");
    keydown(oldHandle, "Home");
    expect(localStorage.getItem("web-pi-right-panel-width")).toBeNull();
    keydown(query(".right-panel-resize-handle"), "Home");
    expect(localStorage.getItem("web-pi-right-panel-width")).toBe("300");
    click(byId("file-panel-toggle"));
    expect(byId("file-panel").classList.contains("right-panel-open")).toBe(
      true,
    );
    click(byId("file-panel-close"));
    expect(byId("file-panel").classList.contains("right-panel-closed")).toBe(
      true,
    );
    const link = document.createElement("a");
    link.dataset["filePath"] = "new.ts";
    document.body.append(link);
    const beforeOpen = ajaxUrls().length;
    click(link);
    expect(ajaxUrls()).toHaveLength(beforeOpen + 1);
    await deliver(viewer("new.ts"));
    expect(tabs()).toHaveLength(1);
    expect(streams().at(-1)?.url).toContain("session=s2");
    const requests = ajaxUrls().length;
    oldStream?.dispatchEvent(new Event("change"));
    expect(ajaxUrls()).toHaveLength(requests);
  });

  it("ignores a pending old viewer completion after cleanup", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    let complete: (() => void) | undefined;
    htmx().ajax.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    openFile("old.ts");
    const oldStream = streams()[0];
    htmxEvent(byId("file-panel"), "htmx:before:cleanup");
    expect(oldStream?.closed).toBe(true);
    page({ session: "s2" });
    htmxEvent(document.body, "htmx:after:process");
    complete?.();
    await flush();
    expect(streams()).toHaveLength(1);
    expect(tabs()).toHaveLength(0);
  });
});

describe("opening files", () => {
  it("immediately replaces empty or previous content while a viewer request is delayed", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/brief.md");
    expect(byId("file-view").textContent).toContain("Loading brief.md…");
    expect(byId("file-view").textContent).not.toContain("No file open");
    expect(query('[role="status"]').textContent).toContain("brief.md");
    expect(byId("file-view").getAttribute("aria-busy")).toBe("true");
    await requests[0]?.respond(viewer("brief.md"));
    expect(query(".file-viewer-shell").dataset["path"]).toBe(
      "/repo/one/brief.md",
    );
    expect(byId("file-view").hasAttribute("aria-busy")).toBe(false);
    openFile("/repo/one/next.md");
    expect(byId("file-view").textContent).toContain("Loading next.md…");
    expect(byId("file-view").querySelector(".file-viewer-shell")).toBeNull();
    // A previous swap can finish settling after the next open starts.
    htmxEvent(byId("file-view"), "htmx:after:settle");
    expect(byId("file-view").getAttribute("aria-busy")).toBe("true");
  });

  it.each([403, 404, 500, "network"])(
    "ends loading truthfully after a %s failure and can reopen",
    async (failure) => {
      page();
      const { openFile, setUpFiles } = await load();
      setUpFiles();
      const requests = delayedViewers();
      openFile("/repo/one/<brief>.md");
      if (failure === "network") await requests[0]?.fail();
      else await requests[0]?.respond("Cannot read that file", Number(failure));
      expect(query('[role="status"]').textContent).toBe(
        "Could not load <brief>.md. Open the file again to retry.",
      );
      expect(byId("file-view").hasAttribute("aria-busy")).toBe(false);
      expect(byId("file-view").querySelector("brief")).toBeNull();
      openFile("/repo/one/<brief>.md");
      expect(query('[role="status"]').textContent).toBe("Loading <brief>.md…");
      await requests[1]?.respond(viewer("<brief>.md"));
      expect(byId("file-view").querySelector('[role="status"]')).toBeNull();
    },
  );

  it("keeps a named error status when a mode button has been removed during loading", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/brief.md");
    await requests[0]?.respond(viewer("brief.md"));
    const source = document.createElement("button");
    query(".file-viewer-toolbar").append(source);
    void htmx().ajax(
      "GET",
      "/files/view?session=s1&path=%2Frepo%2Fone%2Fbrief.md&mode=preview",
      { target: byId("file-view"), source },
    );
    expect(source.isConnected).toBe(false);
    await requests[1]?.respond("Not found", 404);
    expect(query('[role="status"]').textContent).toBe(
      "Could not load brief.md. Open the file again to retry.",
    );
    expect(byId("file-view").hasAttribute("aria-busy")).toBe(false);
  });

  it("keeps the latest of overlapping opens, even when older responses or errors arrive last", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/a.ts");
    openFile("/repo/one/b.ts");
    openFile("/repo/one/c.ts");
    expect(requests).toHaveLength(3);
    expect(requests[0]?.ctx.request.signal.aborted).toBe(true);
    await requests[0]?.respond(viewer("a.ts"));
    expect(query('[role="status"]').textContent).toBe("Loading c.ts…");
    await requests[2]?.respond(viewer("c.ts"));
    await requests[1]?.respond("Not found", 404);
    await requests[0]?.fail();
    expect(query(".file-viewer-shell").dataset["path"]).toBe("/repo/one/c.ts");
    expect(
      tabs().find((tab) => tab.getAttribute("aria-selected") === "true")
        ?.dataset["path"],
    ).toBe("/repo/one/c.ts");
  });

  it("rejects a superseded mode response, including one whose body was already read", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/a.md");
    await requests[0]?.respond(viewer("a.md"));
    void htmx().ajax(
      "GET",
      "/files/view?session=s1&path=%2Frepo%2Fone%2Fa.md&mode=preview",
      { target: byId("file-view") },
    );
    expect(query('[role="status"]').textContent).toBe("Loading a.md…");
    openFile("/repo/one/b.ts");
    const old = requests[1]?.ctx;
    const swap = new CustomEvent("htmx:before:swap", {
      bubbles: true,
      cancelable: true,
      detail: { ctx: old, tasks: [] },
    });
    byId("file-view").dispatchEvent(swap);
    expect(swap.defaultPrevented).toBe(true);
    await requests[1]?.respond(viewer("a.md", "preview"));
    expect(query('[role="status"]').textContent).toBe("Loading b.ts…");
    await requests[2]?.respond(viewer("b.ts"));
    expect(query(".file-viewer-shell").dataset["path"]).toBe("/repo/one/b.ts");
  });

  it("cannot repopulate a closed tab or a replacement panel with a late response", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/a.ts");
    openFile("/repo/one/b.ts");
    click(query('.file-tab[data-path="/repo/one/b.ts"] [data-close]'));
    expect(query('[role="status"]').textContent).toBe("Loading a.ts…");
    await requests[1]?.respond(viewer("b.ts"));
    expect(query('[role="status"]').textContent).toBe("Loading a.ts…");
    click(query(".file-tab [data-close]"));
    await requests[2]?.respond(viewer("a.ts"));
    expect(byId("file-view").textContent).toBe("No file open");
    expect(byId("file-panel").classList.contains("right-panel-closed")).toBe(
      true,
    );
    openFile("/repo/one/c.ts");
    htmxEvent(byId("file-panel"), "htmx:before:cleanup");
    page({ session: "s2" });
    htmxEvent(document.body, "htmx:after:process");
    await requests[3]?.respond(viewer("c.ts"));
    expect(byId("file-view").textContent).toBe("No file open");
    expect(tabs()).toHaveLength(0);
    expect(byId("file-panel").dataset["session"]).toBe("s2");
  });

  it("does not reopen a panel hidden while its file was loading", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    const requests = delayedViewers();
    openFile("/repo/one/a.ts");
    click(byId("file-panel-close"));
    await requests[0]?.respond(viewer("a.ts"));
    expect(byId("file-panel").classList.contains("right-panel-closed")).toBe(
      true,
    );
    expect(streams()[0]?.closed).toBe(true);
    click(byId("file-panel-toggle"));
    expect(query(".file-viewer-shell").dataset["path"]).toBe("/repo/one/a.ts");
  });

  it("opens a tab, the panel, and asks htmx for the viewer in the session's scope", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    expect(document.body.dataset["filePanel"]).toBe("closed");
    openFile("/repo/one/src/a.ts");
    const panel = byId("file-panel");
    expect(panel.classList.contains("right-panel-open")).toBe(true);
    expect(document.body.dataset["filePanel"]).toBe("open");
    expect(byId("file-panel-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(byId("file-panel-toggle").title).toBe("Hide file panel");
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[0]?.textContent).toContain("a.ts");
    expect(byId("file-tabs").hidden).toBe(false);
    expect(ajaxUrls()).toEqual([
      "/files/view?session=s1&path=%2Frepo%2Fone%2Fsrc%2Fa.ts",
    ]);
    await deliver(viewer("src/a.ts"));
    expect(streams()).toHaveLength(1);
    expect(streams()[0]?.url).toBe(
      "/files/watch?path=%2Frepo%2Fone%2Fsrc%2Fa.ts&session=s1",
    );
    streams()[0]?.dispatchEvent(new Event("connected"));
    expect(query(".file-viewer-live-indicator").title).toBe("Live sync active");
    expect(query(".file-viewer-live-label").textContent).toBe("live");
    expect(
      query(".file-viewer-live-indicator").classList.contains("is-live"),
    ).toBe(true);
    streams()[0]?.dispatchEvent(new Event("error"));
    expect(query(".file-viewer-live-label").textContent).toBe("static");
    expect(
      query(".file-viewer-live-indicator").classList.contains("is-live"),
    ).toBe(false);
  });

  it("works from the picked folder when there is no session", async () => {
    page({ session: "" });
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/README.md", "preview");
    expect(ajaxUrls()).toEqual([
      "/files/view?cwd=%2Frepo%2Fone&path=%2Frepo%2Fone%2FREADME.md&mode=preview",
    ]);
  });

  it("opens anything that carries a path, at the mode it names", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a href="/x" data-file-path="/repo/one/changed.ts" data-file-mode="diff"><span>changed.ts</span></a>',
    );
    const { setUpFiles } = await load();
    setUpFiles();
    expect(click(query("[data-file-path] span")).defaultPrevented).toBe(true);
    expect(ajaxUrls()[0]).toContain(
      "path=%2Frepo%2Fone%2Fchanged.ts&mode=diff",
    );
  });

  it("switches between tabs by click and closes them by button or middle click", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    openFile("/repo/one/b.ts");
    await deliver(viewer("b.ts"));
    expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    click(query('.file-tab[data-path="/repo/one/a.ts"] span'));
    expect(ajaxUrls()).toHaveLength(3);
    expect(ajaxUrls()[2]).toContain("path=%2Frepo%2Fone%2Fa.ts");
    await deliver(viewer("a.ts"));
    // Closing the inactive tab leaves the viewer alone.
    click(query('.file-tab[data-path="/repo/one/b.ts"] [data-close]'));
    expect(tabs()).toHaveLength(1);
    expect(ajaxUrls()).toHaveLength(3);
    openFile("/repo/one/c.ts");
    await deliver(viewer("c.ts"));
    const middle = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    const previousWatch = streams().at(-1);
    query('.file-tab[data-path="/repo/one/c.ts"]').dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(true);
    expect(tabs().map((tab) => tab.dataset["path"])).toEqual([
      "/repo/one/a.ts",
    ]);
    // The neighbour becomes active and is loaded again.
    expect(ajaxUrls().at(-1)).toContain("path=%2Frepo%2Fone%2Fa.ts");
    await deliver(viewer("a.ts"));
    expect(previousWatch?.closed).toBe(true);
    expect(streams().at(-1)?.url).toContain("path=%2Frepo%2Fone%2Fa.ts");
    const beforeChange = ajaxUrls().length;
    streams().at(-1)?.dispatchEvent(new Event("change"));
    expect(ajaxUrls()).toHaveLength(beforeChange + 1);
    expect(ajaxUrls().at(-1)).toContain("path=%2Frepo%2Fone%2Fa.ts");
  });

  it("empties the viewer and closes the panel with the last tab", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    click(query(".file-tab [data-close]"));
    expect(tabs()).toHaveLength(0);
    expect(byId("file-tabs").hidden).toBe(true);
    expect(byId("file-view").textContent).toBe("No file open");
    expect(byId("file-panel").classList.contains("right-panel-closed")).toBe(
      true,
    );
    expect(streams()[0]?.closed).toBe(true);
  });

  it("hides and shows the panel from its buttons and drops the watch while hidden", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    click(byId("file-panel-close"));
    expect(byId("file-panel").classList.contains("right-panel-open")).toBe(
      false,
    );
    expect(byId("file-panel-toggle").title).toBe("Show file panel");
    expect(streams()[0]?.closed).toBe(true);
    click(byId("file-panel-toggle"));
    expect(byId("file-panel").classList.contains("right-panel-open")).toBe(
      true,
    );
    expect(streams()).toHaveLength(2);
    window.dispatchEvent(new Event("pagehide"));
    expect(streams()[1]?.closed).toBe(true);
  });
});

describe("per-tab state", () => {
  it("keeps wrap and the scroll position of each tab", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    click(query("[data-wrap-toggle]"));
    expect(query(".file-source-view").classList.contains("is-wrapped")).toBe(
      true,
    );
    expect(query("[data-wrap-toggle]").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(query("[data-wrap-toggle]").title).toBe("Disable word wrap");
    const body = query(".file-viewer-content");
    body.scrollTop = 120;
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    openFile("/repo/one/b.ts");
    await deliver(viewer("b.ts"));
    expect(query(".file-source-view").classList.contains("is-wrapped")).toBe(
      false,
    );
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    expect(query(".file-source-view").classList.contains("is-wrapped")).toBe(
      true,
    );
    expect(query(".file-viewer-content").scrollTop).toBe(120);
  });

  it("restores the tab's state when htmx swaps the viewer itself", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    click(query("[data-wrap-toggle]"));
    // A mode button is an hx-get that swaps #file-view on its own.
    byId("file-view").innerHTML = viewer("a.ts", "diff");
    htmxEvent(byId("file-view"), "htmx:after:settle");
    expect(query(".file-source-view").classList.contains("is-wrapped")).toBe(
      true,
    );
    // The mode the server answered with is what the tab reopens at.
    openFile("/repo/one/b.ts");
    openFile("/repo/one/a.ts");
    expect(ajaxUrls().at(-1)).toContain("mode=diff");
  });

  it("reloads the viewer when the watched file changes", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/a.ts");
    await deliver(viewer("a.ts"));
    streams()[0]?.dispatchEvent(new Event("change"));
    expect(ajaxUrls()).toHaveLength(2);
    await deliver(viewer("a.ts"));
    // Still the same file: no second stream.
    expect(streams()).toHaveLength(1);
  });
});

describe("mentioning the open file", () => {
  function select(startLine: number, endLine: number, endOffset = 1): void {
    const rows = document.querySelectorAll(".file-source-line");
    const start = rows[startLine - 1]?.firstElementChild;
    const end = rows[endLine - 1]?.firstElementChild;
    if (!start || !end) throw new Error("no such lines");
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, endOffset);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  it("inserts the relative path with the selected line range", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/src/a.ts");
    await deliver(viewer("src/a.ts", "source", 5));
    select(2, 4);
    const press = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    query("[data-mention-file]").dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    click(query("[data-mention-file]"));
    expect(area().value).toBe("@src/a.ts:2-4 ");
  });

  it("does not count a row the selection only reaches the start of", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/src/a.ts");
    await deliver(viewer("src/a.ts", "source", 5));
    select(3, 4, 0);
    click(query("[data-mention-file]"));
    expect(area().value).toBe("@src/a.ts:3 ");
  });

  it("inserts the bare path without a selection", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/src/a.ts");
    await deliver(viewer("src/a.ts"));
    click(query("[data-mention-file]"));
    expect(area().value).toBe("@src/a.ts ");
  });
});

describe("the explorer tree", () => {
  const TREE =
    treeItem("/repo/one/src", {
      dir: true,
      children: treeItem("/repo/one/src/a.ts") + treeItem("/repo/one/src/b.ts"),
    }) + treeItem("/repo/one/README.md");

  function item(path: string): HTMLElement {
    return query(`[role="treeitem"][data-path="${path}"]`);
  }

  it("moves with the arrows, opens folders, and activates with Enter", async () => {
    page({ tree: TREE });
    const { setUpFiles } = await load();
    setUpFiles();
    const src = item("/repo/one/src");
    src.focus();
    let expanded = 0;
    src.addEventListener("expand", () => {
      expanded += 1;
    });
    expect(keydown(src, "ArrowRight").defaultPrevented).toBe(true);
    expect(src.getAttribute("aria-expanded")).toBe("true");
    expect(src.querySelector<HTMLElement>("[data-children]")?.hidden).toBe(
      false,
    );
    expect(expanded).toBe(1);
    expect(
      src
        .querySelector<HTMLElement>(".catppuccin-file-icon")
        ?.style.getPropertyValue("--catppuccin-icon-light"),
    ).toContain("_folder_open");
    keydown(src, "ArrowRight");
    expect(document.activeElement).toBe(item("/repo/one/src/a.ts"));
    keydown(item("/repo/one/src/a.ts"), "ArrowDown");
    expect(document.activeElement).toBe(item("/repo/one/src/b.ts"));
    keydown(item("/repo/one/src/b.ts"), "ArrowLeft");
    expect(document.activeElement).toBe(src);
    keydown(src, "ArrowLeft");
    expect(src.getAttribute("aria-expanded")).toBe("false");
    keydown(src, "End");
    expect(document.activeElement).toBe(item("/repo/one/README.md"));
    keydown(item("/repo/one/README.md"), "Home");
    expect(document.activeElement).toBe(src);
    keydown(src, "ArrowDown");
    keydown(item("/repo/one/src/a.ts"), "Enter");
    expect(ajaxUrls()[0]).toContain("path=%2Frepo%2Fone%2Fsrc%2Fa.ts");
    expect(item("/repo/one/src/a.ts").tabIndex).toBe(0);
    expect(keydown(src, "x").defaultPrevented).toBe(false);
  });

  it("opens a file from a click on its row, but not on its action", async () => {
    page({ tree: TREE });
    const { setUpFiles } = await load();
    setUpFiles();
    click(query('[data-path="/repo/one/README.md"] .file-tree-row span'));
    expect(ajaxUrls()).toHaveLength(1);
    click(query('[data-path="/repo/one/README.md"] .file-tree-action'));
    expect(ajaxUrls()).toHaveLength(1);
    click(query('[data-path="/repo/one/src"] .file-tree-row'));
    expect(item("/repo/one/src").getAttribute("aria-expanded")).toBe("true");
    expect(ajaxUrls()).toHaveLength(1);
  });

  it("makes the first row the keyboard entry after a refresh", async () => {
    page({ tree: TREE, changes: 0 });
    const { setUpFiles } = await load();
    setUpFiles();
    htmxEvent(byId("file-tree"), "htmx:after:settle");
    expect(item("/repo/one/src").tabIndex).toBe(0);
  });
});

describe("changed files and search", () => {
  it("toggles the changed-files view and keeps it through a refresh", async () => {
    page({ changes: 2 });
    const { setUpFiles } = await load();
    setUpFiles();
    const toggle = byId("explorer-changes-toggle");
    click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(htmx().ajax).toHaveBeenCalledWith(
      "GET",
      "/files/explorer?session=s1&changes=1",
      {
        target: "#file-tree",
        swap: "outerHTML",
      },
    );
    const body = new FormData();
    htmxEvent(byId("file-tree"), "htmx:config:request", {
      ctx: {
        target: byId("file-tree"),
        request: { action: "/files/explorer", body },
      },
    });
    expect(body.get("changes")).toBe("1");
    click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(ajaxUrls().at(-1)).toBe("/files/explorer?session=s1");
  });

  it("hides the toggle while nothing is changed", async () => {
    page({ changes: 2 });
    const { setUpFiles } = await load();
    setUpFiles();
    const toggle = byId("explorer-changes-toggle");
    toggle.setAttribute("aria-pressed", "true");
    htmxEvent(byId("file-tree"), "htmx:after:settle");
    expect(toggle.hidden).toBe(false);
    expect(toggle.title).toBe("2 changed files");
    byId("file-tree").dataset["changes"] = "0";
    htmxEvent(byId("file-tree"), "htmx:after:settle");
    expect(toggle.hidden).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the search field, and clearing it puts the tree back", async () => {
    page();
    const { setUpFiles } = await load();
    setUpFiles();
    const input = byId("file-search");
    if (!(input instanceof HTMLInputElement)) throw new Error("no input");
    let searches = 0;
    input.addEventListener("search", () => {
      searches += 1;
    });
    click(byId("explorer-search-toggle"));
    expect(byId("file-search-field").hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    input.value = "read";
    expect(keydown(input, "Escape").defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(searches).toBe(1);
    input.value = "again";
    click(byId("explorer-search-toggle"));
    expect(byId("file-search-field").hidden).toBe(true);
    expect(input.value).toBe("");
    expect(searches).toBe(2);
  });
});

describe("media", () => {
  it("reports an image's pixels and an audio file's length", async () => {
    page();
    const { openFile, setUpFiles } = await load();
    setUpFiles();
    openFile("/repo/one/pic.png");
    byId("file-view").innerHTML =
      '<div class="file-viewer-shell" data-path="/repo/one/pic.png" data-mode="source">' +
      '<span class="file-viewer-measured"></span><img src="data:," alt=""></div>';
    const image = query("img");
    Object.defineProperty(image, "naturalWidth", { value: 640 });
    Object.defineProperty(image, "naturalHeight", { value: 480 });
    Object.defineProperty(image, "complete", { value: true });
    htmxEvent(byId("file-view"), "htmx:after:settle");
    await flush();
    expect(query(".file-viewer-measured").textContent).toBe("640 × 480");

    byId("file-view").innerHTML =
      '<div class="file-viewer-shell" data-path="/repo/one/song.mp3" data-mode="source">' +
      '<span class="file-viewer-measured"></span><audio></audio></div>';
    const audio = query("audio");
    Object.defineProperty(audio, "duration", { value: 125.4 });
    Object.defineProperty(audio, "readyState", { value: 1 });
    htmxEvent(byId("file-view"), "htmx:after:settle");
    expect(query(".file-viewer-measured").textContent).toBe("2:05");
  });
});
