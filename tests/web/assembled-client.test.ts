import type { SidebarView } from "@core/workspace";
import { Composer } from "@web/views/Composer";
import { SessionList } from "@web/views/Sidebar";
import { html } from "hono/html";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmxBrowser, page } from "#/web/htmx4-browser";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
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
      `<aside id="sidebar">${String(await html`${SessionList({ view })}`)}</aside>${await region("s1")}<input id="search"><select id="choice"><option>One</option></select>`,
    ),
    async (request) =>
      new Response(
        await region(new URL(request.url).pathname.split("/").at(-1) ?? ""),
      ),
  );
  browsers.push(browser);
  // Observe a full-page departure without allowing happy-dom to fetch a page.
  const depart = vi
    .spyOn(browser.window.location, "assign")
    .mockImplementation(() => {});
  return { ...browser, depart };
}

describe("assembled client shortcuts", () => {
  it("opens exactly one visible session through HTMX for each digit shortcut", async () => {
    const { document, window, requests, depart } = await open();
    for (const [key, modifier, id] of [
      ["2", "ctrlKey", "s2"],
      ["0", "metaKey", "s10"],
    ] as const) {
      const before = requests.length;
      const event = new window.KeyboardEvent("keydown", {
        key,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
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
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { ctrlKey: true, repeat: true },
      {},
    ]) {
      const event = new window.KeyboardEvent("keydown", {
        key: "2",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    document.getElementById("node-s10")?.remove();
    const missing = new window.KeyboardEvent("keydown", {
      key: "0",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(missing);
    expect(missing.defaultPrevented).toBe(false);
    expect(requests).toHaveLength(count);
    expect(depart).not.toHaveBeenCalled();
  });

  it("does not hijack session digits from textareas, inputs or selects", async () => {
    const { document, window, requests, depart } = await open();
    for (const id of ["composer-text", "search", "choice"]) {
      const field = document.getElementById(id);
      if (!(field instanceof window.HTMLElement))
        throw new Error(`Missing ${id}`);
      field.focus();
      const event = new window.KeyboardEvent("keydown", {
        key: "2",
        ctrlKey: true,
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
