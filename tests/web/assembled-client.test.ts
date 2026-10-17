import type { SidebarView } from "@core/workspace";
import { Composer } from "@web/views/Composer";
import { SessionList } from "@web/views/Sidebar";
import { html } from "hono/html";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmxBrowser, page } from "#/web/htmx4-browser";

afterEach(() => {
  vi.restoreAllMocks();
});

function row(id: string): SidebarView["rows"][number] {
  return {
    summary: {
      id,
      cwd: "/repo",
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 0,
    },
    metadata: {
      firstMessage: id,
      messageCount: 2,
      starCount: 0,
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 0,
    },
  };
}

async function region(id: string): Promise<string> {
  return String(
    await html`<div id="session-region">
      <main data-session-id="${id}" data-cwd="/repo">
        ${Composer({ sessionId: id, cwd: "/repo" })}
      </main>
    </div>`,
  );
}

async function open() {
  const view: SidebarView = {
    rows: [
      {
        ...row("s1"),
        childCount: 1,
        children: { parentId: "s1", rows: [row("hidden-child")] },
      },
      ...Array.from({ length: 9 }, (_, index) => row(`s${String(index + 2)}`)),
    ],
  };
  const browser = await htmxBrowser(
    page(
      `<aside id="sidebar">${String(await html`${SessionList({ view })}`)}</aside>${await region("s1")}<input id="search"><select id="choice"><option>One</option></select><textarea id="notes"></textarea>`,
    ),
    async (request) =>
      new Response(
        await region(new URL(request.url).pathname.split("/").at(-1) ?? ""),
      ),
  );
  // Observe a full-page departure without allowing happy-dom to fetch a page.
  const depart = vi
    .spyOn(browser.window.location, "assign")
    .mockImplementation(() => {});
  return { ...browser, depart };
}

describe("assembled client shortcuts", () => {
  it("opens exactly one visible session through HTMX for each digit shortcut", async () => {
    const { document, window, requests, depart } = await open();
    for (const [key, code, id] of [
      ["@", "Digit2", "s2"],
      ["(", "Digit9", "s9"],
      ["+", "Digit1", "s1"],
    ] as const) {
      const before = requests.length;
      const event = new window.KeyboardEvent("keydown", {
        key,
        code,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const composer = document.getElementById("composer-text");
      if (!(composer instanceof window.HTMLTextAreaElement))
        throw new Error("Missing composer");
      composer.focus();
      composer.dispatchEvent(event);
      await expect
        .poll(() => document.querySelector("main")?.dataset["sessionId"])
        .toBe(id);
      expect(event.defaultPrevented).toBe(true);
      expect(
        requests.slice(before).map((request) => new URL(request.url).pathname),
      ).toEqual([`/sessions/${id}`]);
      expect(depart).not.toHaveBeenCalled();
    }
    const count = requests.length;
    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { metaKey: true, shiftKey: true },
      { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true, repeat: true },
      {},
    ]) {
      const event = new window.KeyboardEvent("keydown", {
        key: "@",
        code: "Digit2",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    document.getElementById("node-s9")?.remove();
    document.getElementById("node-s10")?.remove();
    const missing = new window.KeyboardEvent("keydown", {
      key: "(",
      code: "Digit9",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(missing);
    expect(missing.defaultPrevented).toBe(false);
    expect(requests).toHaveLength(count);
    expect(depart).not.toHaveBeenCalled();
  });

  it("does not hijack session shortcuts from other form fields", async () => {
    const { document, window, requests, depart } = await open();
    for (const id of ["notes", "search", "choice"]) {
      const field = document.getElementById(id);
      if (!(field instanceof window.HTMLElement))
        throw new Error(`Missing ${id}`);
      field.focus();
      const event = new window.KeyboardEvent("keydown", {
        key: "@",
        code: "Digit2",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(field);
    }
    expect(requests).toHaveLength(0);
    expect(depart).not.toHaveBeenCalled();
    expect(document.querySelector("main")?.dataset["sessionId"]).toBe("s1");
  });
});
