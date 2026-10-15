import { ExtensionDialog } from "@web/views/Extensions";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  click,
  flush,
  htmxEvent,
  keydown,
  mockFetch,
  mount,
  query,
  render,
  text,
} from "./helpers.ts";

// The browser half of the extension bridge: Escape on a dialog becomes its
// Cancel, keystrokes in a custom-UI panel become terminal bytes, an editor
// insert lands at the caret, and a title set by an extension names the tab.

async function load(html: string): Promise<void> {
  mount(`<main data-session-id="s1">${html}</main>`);
  const { setUpExtensions } = await import("@web/client/extensions");
  setUpExtensions();
}

function cancel(dialog: Element): Event {
  const event = new Event("cancel", { bubbles: true, cancelable: true });
  dialog.dispatchEvent(event);
  return event;
}

describe("dialogs", () => {
  it("turns Escape into the form's own Cancel", async () => {
    await load(
      '<dialog open><button type="button" data-dialog-cancel>Cancel</button></dialog>',
    );
    let cancelled = 0;
    query("[data-dialog-cancel]").addEventListener("click", () => {
      cancelled += 1;
    });
    expect(cancel(query("dialog")).defaultPrevented).toBe(true);
    expect(cancelled).toBe(1);
  });

  it("keeps Escape for the component in a no-escape dialog, and lets others close", async () => {
    await load(
      "<dialog id='a' open data-no-escape></dialog><dialog id='b' open></dialog>",
    );
    expect(cancel(byId("a")).defaultPrevented).toBe(true);
    expect(cancel(byId("b")).defaultPrevented).toBe(false);
  });

  it("counts down the time an extension gave the reader", async () => {
    await load(
      render(
        ExtensionDialog({
          sessionId: "s1",
          dialog: {
            id: "d",
            method: "confirm",
            title: "Push?",
            expiresAt: Date.now() + 30_000,
          },
        }),
      ),
    );
    const line = query(".extension-dialog-timeout");
    expect(line.textContent).toBe("Closes in 30s if unanswered.");
    vi.advanceTimersByTime(1000);
    expect(line.textContent).toBe("Closes in 29s if unanswered.");
    vi.advanceTimersByTime(40_000);
    expect(line.textContent).toBe("Closes in 0s if unanswered.");
  });

  it("counts down from the time left, whatever the browser's clock says", async () => {
    const html = render(
      ExtensionDialog({
        sessionId: "s1",
        dialog: {
          id: "d",
          method: "confirm",
          title: "Push?",
          expiresAt: Date.now() + 30_000,
        },
      }),
    );
    // This browser's clock runs two minutes ahead of the server's.
    vi.setSystemTime(Date.now() + 120_000);
    await load(html);
    const line = query(".extension-dialog-timeout");
    vi.advanceTimersByTime(1000);
    expect(line.textContent).toBe("Closes in 29s if unanswered.");
  });

  it("saves the editor dialog on Ctrl+Enter", async () => {
    await load(
      '<form><textarea data-dialog-submit></textarea><textarea id="other"></textarea></form>',
    );
    let submitted = 0;
    query("form").addEventListener("submit", (event) => {
      event.preventDefault();
      submitted += 1;
    });
    const editor = query("[data-dialog-submit]");
    expect(keydown(editor, "Enter").defaultPrevented).toBe(false);
    expect(keydown(editor, "Enter", { ctrlKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(keydown(editor, "Enter", { metaKey: true }).defaultPrevented).toBe(
      true,
    );
    keydown(byId("other"), "Enter", { ctrlKey: true });
    expect(submitted).toBe(2);
  });
});

describe("the custom-UI panel", () => {
  const PANEL =
    '<div id="custom-ui"><div data-custom-ui="/sessions/s1/custom-ui/input">' +
    '<div id="custom-frame" tabindex="0"></div>' +
    '<button type="button" data-custom-close>Close</button></div></div>';

  function posted(fetch: {
    mock: { calls: [unknown, RequestInit?][] };
  }): string[] {
    return fetch.mock.calls.map((call) => {
      const body = call[1]?.body;
      return (
        new URLSearchParams(typeof body === "string" ? body : "").get("data") ??
        ""
      );
    });
  }

  it("posts keystrokes as terminal bytes and leaves browser shortcuts alone", async () => {
    const fetch = mockFetch(() => text(""));
    await load(PANEL);
    const frame = byId("custom-frame");
    expect(keydown(frame, "ArrowUp").defaultPrevented).toBe(true);
    expect(keydown(frame, "Enter").defaultPrevented).toBe(true);
    expect(keydown(frame, "v", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(keydown(frame, "a").defaultPrevented).toBe(false);
    await flush();
    expect(posted(fetch)).toEqual(["[A", "\r"]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/sessions/s1/custom-ui/input");
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });
  });

  it("brackets a paste, sends Ctrl+C for close, and focuses the frame on click", async () => {
    const fetch = mockFetch(() => text(""));
    await load(PANEL);
    const paste = Object.assign(
      new Event("paste", { bubbles: true, cancelable: true }),
      {
        clipboardData: { getData: () => "pasted text" },
      },
    );
    byId("custom-frame").dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    click(query("[data-custom-close]"));
    await flush();
    expect(posted(fetch)).toEqual(["[200~pasted text[201~", ""]);
    click(query("[data-custom-ui]"));
    expect(document.activeElement).toBe(byId("custom-frame"));
  });

  it("sends one keystroke at a time, so they arrive in the order typed", async () => {
    const answers: (() => void)[] = [];
    const fetch = vi.fn(
      (_url: unknown, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          answers.push(() => {
            resolve(text(""));
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await load(PANEL);
    keydown(byId("custom-frame"), "ArrowUp");
    keydown(byId("custom-frame"), "ArrowDown");
    keydown(byId("custom-frame"), "Enter");
    await flush();
    expect(posted(fetch)).toEqual(["\u001b[A"]);
    answers[0]?.();
    await flush();
    expect(posted(fetch)).toEqual(["\u001b[A", "\u001b[B"]);
    answers[1]?.();
    await flush();
    expect(posted(fetch)).toEqual(["\u001b[A", "\u001b[B", "\r"]);
  });

  it("takes focus when a panel arrives", async () => {
    await load('<div id="custom-ui"></div>');
    byId("custom-ui").innerHTML = '<div id="custom-frame" tabindex="0"></div>';
    htmxEvent(byId("custom-ui"), "htmx:after:settle");
    expect(document.activeElement).toBe(byId("custom-frame"));
  });
});

describe("what an extension writes into the page", () => {
  it("inserts text at the caret, spaced from what is before it", async () => {
    await load(
      '<textarea id="composer-text"></textarea><div id="editor-insert"></div>',
    );
    const insert = (value: string) => {
      byId("editor-insert").innerHTML = `<span data-insert="${value}"></span>`;
      htmxEvent(byId("editor-insert"), "htmx:after:settle");
    };
    insert("first");
    expect(area().value).toBe("first");
    insert("second");
    expect(area().value).toBe("first second");
    area().setSelectionRange(0, 0);
    insert("zero");
    expect(area().value).toBe("zerofirst second");
    expect(byId("editor-insert").childElementCount).toBe(0);
  });

  it("names the tab after the extension's title, on load and on a status swap", async () => {
    await load(
      '<div id="status"><span id="extension-title" data-title="Deploying"></span></div>',
    );
    expect(document.title).toBe("Deploying");
    byId("status").innerHTML =
      '<span id="extension-title" data-title="Done"></span>';
    htmxEvent(byId("status"), "htmx:after:settle");
    expect(document.title).toBe("Done");
    byId("status").innerHTML = "";
    htmxEvent(byId("status"), "htmx:after:settle");
    expect(document.title).toBe("Done");
  });
});
