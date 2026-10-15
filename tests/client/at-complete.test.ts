import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  flush,
  json,
  keydown,
  mockFetch,
  mount,
  query,
  text,
} from "./helpers.ts";

// `@` completion: plain names come from a cached index, path-like queries
// from the server, and what a pick inserts. The menu element is the one
// views/Composer.tsx renders; the rows are built here in the browser.

async function load(session = "s1") {
  mount(
    `<form id="composer" data-session-id="${session}">` +
      '<div id="slash-menu" hidden></div><div id="at-menu" hidden></div>' +
      '<textarea id="composer-text"></textarea></form>',
  );
  const editor = await import("@web/client/editor");
  const { setUpAtCompletion } = await import("@web/client/at-complete");
  const form = document.getElementById("composer");
  if (!(form instanceof HTMLFormElement)) throw new Error("no form");
  return setUpAtCompletion(editor.menuEndpoints(form));
}

function typed(value: string, caret = value.length): void {
  area().value = value;
  area().setSelectionRange(caret, caret);
}

function rows(): string[] {
  return [...byId("at-menu").querySelectorAll<HTMLElement>("[data-path]")].map(
    (row) => row.dataset["path"] ?? "",
  );
}

const INDEX = { files: ["src/app.ts", "src/lib/util.ts", "README.md"] };

describe("the local index", () => {
  it("loads the folder index once and filters it in the browser", async () => {
    const fetch = mockFetch(() => json(INDEX));
    const at = await load();
    typed("look at @ut");
    at.refresh();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/sessions/s1/file-index?q=");
    expect(byId("at-menu").hidden).toBe(false);
    expect(rows()).toEqual(["src/lib/util.ts"]);
    expect(byId("at-menu").textContent).toContain("Files · 1 match");
    typed("look at @src");
    at.refresh();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    // Folders rank above files at the same score, shallow paths first.
    expect(rows()).toEqual(["src", "src/lib", "src/app.ts", "src/lib/util.ts"]);
    expect(byId("at-menu").textContent).toContain("4 matches");
  });

  it("opens the menu for the latest keystroke once a slow index arrives", async () => {
    let answer: (response: Response) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const at = await load();
    typed("@u");
    at.refresh();
    typed("@ut");
    at.refresh();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    answer(json(INDEX));
    await flush();
    expect(byId("at-menu").hidden).toBe(false);
    expect(rows()).toEqual(["src/lib/util.ts"]);
  });

  it("reloads the index once it is ten seconds old", async () => {
    const fetch = mockFetch(() => json(INDEX));
    const at = await load();
    typed("@a");
    at.refresh();
    await flush();
    vi.advanceTimersByTime(9_000);
    at.refresh();
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2_000);
    at.refresh();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("says when the index is cut short and asks the server for the rest", async () => {
    const fetch = mockFetch((url) =>
      url.includes("q=zz")
        ? json({ matches: [{ path: "deep/zz.ts", isDir: false }] })
        : json({ ...INDEX, truncated: true }),
    );
    const at = await load();
    typed("@");
    at.refresh();
    await flush();
    expect(byId("at-menu").textContent).toContain("index truncated");
    typed("@zz");
    at.refresh();
    await flush();
    expect(byId("at-menu").textContent).toContain("No matching files");
    expect(byId("at-menu").textContent).toContain("searching all files…");
    vi.advanceTimersByTime(150);
    await flush();
    expect(fetch).toHaveBeenLastCalledWith("/sessions/s1/file-index?q=zz", {
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(rows()).toEqual(["deep/zz.ts"]);
  });

  it("keeps what it had when the index cannot be fetched", async () => {
    mockFetch(() => text("", 500));
    const at = await load();
    typed("@a");
    at.refresh();
    await flush();
    expect(byId("at-menu").hidden).toBe(true);
  });

  it("does nothing without a folder to list", async () => {
    const fetch = mockFetch(() => json(INDEX));
    const at = await load("");
    typed("@a");
    at.refresh();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(byId("at-menu").hidden).toBe(true);
    expect(at.handleKey(keydown(area(), "ArrowDown"), true)).toBe(false);
  });
});

describe("path queries", () => {
  it("asks the server after a pause and drops the earlier request", async () => {
    const fetch = mockFetch((url) =>
      json({
        matches: [
          {
            path: url.includes("q=.%2Fsrc") ? "./src/app.ts" : "./x",
            isDir: false,
          },
        ],
      }),
    );
    const at = await load();
    typed("@./s");
    at.refresh();
    expect(byId("at-menu").textContent).toContain("Loading files...");
    vi.advanceTimersByTime(100);
    typed("@./src");
    at.refresh();
    vi.advanceTimersByTime(150);
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "/sessions/s1/file-completion?q=.%2Fsrc",
    );
    expect(rows()).toEqual(["./src/app.ts"]);
    // A slower answer to an older query is dropped by the signal.
    typed("@./srx");
    at.refresh();
    vi.advanceTimersByTime(150);
    const first = fetch.mock.calls[1]?.[1]?.signal;
    typed("@./srxy");
    at.refresh();
    vi.advanceTimersByTime(150);
    expect(first?.aborted).toBe(true);
  });

  it("reports a folder that cannot be listed", async () => {
    mockFetch(() => json({}, 404));
    const at = await load();
    typed("@/nope/");
    at.refresh();
    vi.advanceTimersByTime(150);
    await flush();
    expect(byId("at-menu").textContent).toContain("Cannot list this directory");
  });
});

describe("completing", () => {
  it("inserts a file with Tab and keeps a folder open for the next keystroke", async () => {
    mockFetch(() => json(INDEX));
    const at = await load();
    typed("see @sr");
    at.refresh();
    await flush();
    expect(rows()[0]).toBe("src");
    expect(at.handleKey(keydown(area(), "ArrowDown"), true)).toBe(true);
    expect(at.handleKey(keydown(area(), "ArrowDown"), true)).toBe(true);
    expect(query('[data-path="src/app.ts"]').dataset["active"]).toBe("true");
    expect(at.handleKey(keydown(area(), "Tab"), true)).toBe(true);
    expect(area().value).toBe("see @src/app.ts ");
    expect(byId("at-menu").hidden).toBe(true);
    typed("see @sr");
    at.refresh();
    await flush();
    expect(at.handleKey(keydown(area(), "Enter"), true)).toBe(true);
    expect(area().value).toBe("see @src/");
    await flush();
    expect(byId("at-menu").hidden).toBe(false);
    expect(rows()).toContain("src/lib");
  });

  it("swallows the closing quote of a quoted token", async () => {
    mockFetch(() => json({ files: ["my docs/a.md"] }));
    const at = await load();
    typed('@"my docs" tail', 9);
    at.refresh();
    await flush();
    at.handleKey(keydown(area(), "ArrowDown"), true);
    at.handleKey(keydown(area(), "Tab"), true);
    expect(area().value).toBe('@"my docs/a.md"  tail');
  });

  it("lets Shift+Enter and unknown keys through, closes on Escape", async () => {
    mockFetch(() => json(INDEX));
    const at = await load();
    typed("@a");
    at.refresh();
    await flush();
    expect(
      at.handleKey(keydown(area(), "Enter", { shiftKey: true }), false),
    ).toBe(false);
    expect(at.handleKey(keydown(area(), "a"), true)).toBe(false);
    expect(at.handleKey(keydown(area(), "Escape"), true)).toBe(true);
    expect(byId("at-menu").hidden).toBe(true);
    at.close();
  });

  it("highlights the row under the pointer and applies it on mouse down", async () => {
    mockFetch(() => json(INDEX));
    const at = await load();
    typed("@src");
    at.refresh();
    await flush();
    const row = query('[data-path="src/lib/util.ts"]');
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(row.dataset["active"]).toBe("true");
    row.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(area().value).toBe("@src/lib/util.ts ");
  });
});

describe("menu endpoints", () => {
  it("answers for a validated folder and refuses an unchecked one", async () => {
    const { menuEndpoints } = await import("@web/client/editor");
    const form = document.createElement("form");
    form.dataset["cwd"] = "/home/me/x y";
    expect(menuEndpoints(form)).toBeNull();
    form.dataset["complete"] = "folder";
    const folder = menuEndpoints(form);
    expect(folder?.commands("a b")).toBe(
      "/workspaces/commands?cwd=%2Fhome%2Fme%2Fx%20y&q=a%20b",
    );
    expect(folder?.index("")).toBe(
      "/workspaces/file-index?cwd=%2Fhome%2Fme%2Fx%20y&q=",
    );
    expect(folder?.completion("./")).toBe(
      "/workspaces/file-completion?cwd=%2Fhome%2Fme%2Fx%20y&q=.%2F",
    );
    form.dataset["sessionId"] = "s9";
    expect(menuEndpoints(form)?.commands("c")).toBe(
      "/sessions/s9/commands?q=c",
    );
  });
});
