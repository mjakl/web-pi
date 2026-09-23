import { BUILTIN_COMMANDS, rankCommands } from "@core/composer";
import { CommandMenu, Composer, ModelSelector } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  click,
  field,
  flush,
  frame,
  htmxEvent,
  keydown,
  keyup,
  mockFetch,
  mount,
  query,
  render,
  text,
  type,
} from "./helpers.ts";

// The composer's keyboard, against the markup views/Composer.tsx renders:
// which key sends, which completes a menu, which walks the history, and what
// the primary button does in each state of the session.

function load() {
  return import("@web/client/composer");
}

type Page = {
  sessionId?: string;
  running?: boolean;
  history?: string[];
  answers?: string[];
};

/** The session page as the composer sees it, with the real composer form. */
function page({
  sessionId = "s1",
  running = false,
  history = [],
  answers = [],
}: Page = {}): { submits: SubmitEvent[] } {
  const prompts = history
    .map(
      (entry) =>
        `<div data-role="user"><div data-user-text hidden>${entry}</div></div>`,
    )
    .join("");
  const replies = answers
    .map(
      (answer) =>
        `<div data-role="assistant"><div class="markdown-body">${answer}</div></div>`,
    )
    .join("");
  mount(
    `<main data-session-id="${sessionId}"><div id="toasts"></div>
      <button type="button" id="stats-trigger"></button>
      <div id="log">${prompts}${replies}</div>
      ${render(Composer({ sessionId, cwd: "/repo/one" }))}</main>`,
  );
  byId("status").innerHTML =
    `<span id="session-state" hidden${running ? ' data-running="true"' : ""}></span>`;
  const submits: SubmitEvent[] = [];
  byId("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    submits.push(event);
  });
  return { submits };
}

function behavior(): string {
  return field("#composer-behavior").value;
}

function primary(): HTMLButtonElement {
  const button = document.querySelector(".composer-action-primary");
  if (!(button instanceof HTMLButtonElement)) throw new Error("no button");
  return button;
}

function running(on: boolean): void {
  byId("session-state").toggleAttribute("data-running", on);
  htmxEvent(byId("status"), "htmx:after:settle");
}

describe("sending", () => {
  it("sends on Enter, keeps Shift+Enter as a newline", async () => {
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "hello");
    expect(keydown(area(), "Enter", { shiftKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(submits).toHaveLength(0);
    expect(keydown(area(), "Enter").defaultPrevented).toBe(true);
    expect(submits).toHaveLength(1);
    expect(behavior()).toBe("steer");
  });

  it("queues a follow-up with Alt+Enter", async () => {
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "later");
    keydown(area(), "Enter", { altKey: true });
    expect(submits).toHaveLength(1);
    expect(behavior()).toBe("followUp");
  });

  it("needs a modifier on a phone", async () => {
    window.innerWidth = 500;
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "hello");
    keydown(area(), "Enter");
    expect(submits).toHaveLength(0);
    keydown(area(), "Enter", { ctrlKey: true });
    expect(submits).toHaveLength(1);
  });

  it("ignores Enter while an IME composition is open or just ended", async () => {
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "日本");
    area().dispatchEvent(new Event("compositionstart", { bubbles: true }));
    keydown(area(), "Enter");
    expect(submits).toHaveLength(0);
    area().dispatchEvent(new Event("compositionend", { bubbles: true }));
    keydown(area(), "Enter");
    expect(submits).toHaveLength(0);
    vi.advanceTimersByTime(100);
    keydown(area(), "Enter");
    expect(submits).toHaveLength(1);
  });

  it("keeps the stored draft until acceptance", async () => {
    localStorage.setItem("web-pi:draft:s1", "kept");
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    expect(area().value).toBe("kept");
    keydown(area(), "Enter");
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("kept");
  });

  it("empties the composer only after an accepted submission", async () => {
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "retry me");
    keydown(area(), "Enter");
    const rejected = { response: { status: 500, headers: new Headers() } };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: rejected });
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: rejected });
    expect(area().value).toBe("retry me");
    const accepted = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: accepted });
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: accepted });
    expect(area().value).toBe("");
    expect(primary().disabled).toBe(true);
  });

  it("aborts the turn on Escape in the textarea", async () => {
    const fetch = mockFetch(() => text(""));
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    expect(keydown(area(), "Escape").defaultPrevented).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/sessions/s1/abort", {
      method: "POST",
    });
  });
});

describe("the primary button", () => {
  it("is disabled until there is text, and sends by click", async () => {
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    expect(primary().disabled).toBe(true);
    expect(primary().dataset["action"]).toBe("send");
    type(area(), "go");
    expect(primary().disabled).toBe(false);
    click(primary());
    expect(behavior()).toBe("steer");
  });

  it("steers while a turn runs, queues while Alt is held, stops when empty", async () => {
    page({ running: true });
    const { setUpComposer } = await load();
    setUpComposer();
    expect(primary().dataset["action"]).toBe("stop");
    expect(primary().disabled).toBe(false);
    expect(primary().getAttribute("aria-label")).toBe("Stop agent");
    type(area(), "change course");
    expect(primary().dataset["action"]).toBe("steer");
    keydown(document.body, "Alt", { altKey: true });
    expect(primary().dataset["action"]).toBe("followup");
    expect(primary().dataset["behavior"]).toBe("followUp");
    expect(primary().getAttribute("aria-label")).toBe("Queue");
    keyup(document.body, "Alt");
    expect(primary().dataset["action"]).toBe("steer");
    keydown(document.body, "Alt", { altKey: true });
    window.dispatchEvent(new Event("blur"));
    expect(primary().dataset["action"]).toBe("steer");
  });

  it("aborts instead of submitting while it shows stop", async () => {
    const fetch = mockFetch(() => text(""));
    const { submits } = page({ running: true });
    const { setUpComposer } = await load();
    setUpComposer();
    expect(click(primary()).defaultPrevented).toBe(true);
    expect(submits).toHaveLength(0);
    expect(fetch).toHaveBeenCalledWith("/sessions/s1/abort", {
      method: "POST",
    });
  });

  it("mirrors the session state onto the form and the model selector", async () => {
    page();
    byId("composer").insertAdjacentHTML(
      "beforeend",
      render(
        ModelSelector({ pick: { models: [], current: null, levels: [] } }),
      ),
    );
    const { setUpComposer } = await load();
    setUpComposer();
    running(true);
    expect(byId("composer").hasAttribute("data-running")).toBe(true);
    expect(byId("model-selector").classList.contains("is-disabled")).toBe(true);
    expect((byId("model-trigger") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("composer-running-note").textContent).toBe("Agent running");
    running(false);
    expect(byId("composer").hasAttribute("data-running")).toBe(false);
    expect((byId("model-trigger") as HTMLButtonElement).disabled).toBe(false);
    expect(byId("composer-running-note").textContent).toBe("");
  });
});

describe("local built-ins", () => {
  it("runs /session from the Send button without posting", async () => {
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    let opened = 0;
    byId("stats-trigger").addEventListener("click", () => {
      opened += 1;
    });
    type(area(), "/session");
    expect(click(primary()).defaultPrevented).toBe(true);
    expect(opened).toBe(1);
    expect(submits).toHaveLength(0);
    expect(area().value).toBe("");
  });

  it("copies the last answer on /copy and says so", async () => {
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    const fetch = mockFetch(() => text("  **the last one**\n "));
    const { submits } = page({ answers: ["first", "wrong DOM answer"] });
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "/copy");
    keydown(area(), "Enter");
    await flush();
    expect(fetch).toHaveBeenCalledWith("/sessions/s1/last-assistant-text", {
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(write).toHaveBeenCalledWith("  **the last one**\n ");
    expect(submits).toHaveLength(0);
    expect(byId("toasts").textContent).toContain("Answer copied.");
    expect(area().value).toBe("");
  });

  it("warns on /copy with nothing to copy", async () => {
    mockFetch(() => text(""));
    const write = vi.spyOn(navigator.clipboard, "writeText");
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "/copy");
    keydown(area(), "Enter");
    await flush();
    expect(write).not.toHaveBeenCalled();
    expect(byId("toasts").textContent).toContain("No answer to copy yet.");
    expect(area().value).toBe("/copy");
  });

  it.each(["clipboard rejected", "clipboard unavailable", "lookup rejected"])(
    "retains /copy when %s",
    async (failure) => {
      mockFetch(() =>
        text("raw answer", failure === "lookup rejected" ? 500 : 200),
      );
      const write = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockRejectedValue(new Error("denied"));
      if (failure === "clipboard unavailable")
        vi.spyOn(navigator, "clipboard", "get").mockReturnValue(
          undefined as never,
        );
      const { submits } = page();
      const { setUpComposer } = await load();
      setUpComposer();
      type(area(), "/copy");
      click(primary());
      await flush();
      expect(area().value).toBe("/copy");
      expect(submits).toHaveLength(0);
      expect(byId("toasts").textContent).toContain(
        failure === "lookup rejected"
          ? "Could not load the answer to copy."
          : "Could not reach the clipboard.",
      );
      if (failure !== "clipboard rejected")
        expect(write).not.toHaveBeenCalled();
    },
  );

  it("does not clear a newly typed /copy when an earlier clipboard write finishes", async () => {
    mockFetch(() => text("raw answer"));
    let finish: (() => void) | undefined;
    const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "/copy");
    keydown(area(), "Enter");
    await flush();
    expect(write).toHaveBeenCalledOnce();
    type(area(), "different");
    type(area(), "/copy");
    finish?.();
    await flush();
    expect(area().value).toBe("/copy");
    expect(byId("toasts").textContent).not.toContain("Answer copied.");
  });
});

describe("the slash menu", () => {
  const menuFor = (query: string) =>
    render(
      CommandMenu({ commands: rankCommands(BUILTIN_COMMANDS, query), query }),
    );

  async function openMenu(typed: string): Promise<void> {
    type(area(), typed);
    await vi.advanceTimersByTimeAsync(80);
    await flush();
  }

  it("fetches the commands after a pause and walks them with the arrows", async () => {
    const fetch = mockFetch((url) => {
      const query = new URL(url, "http://x").searchParams.get("q") ?? "";
      return text(menuFor(query));
    });
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    await openMenu("/c");
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/sessions/s1/commands?q=c");
    const menu = byId("slash-menu");
    expect(menu.hidden).toBe(false);
    const items = [...menu.querySelectorAll<HTMLElement>("[data-command]")];
    expect(items[0]?.dataset["active"]).toBe("true");
    keydown(area(), "ArrowDown");
    expect(items[0]?.dataset["active"]).toBeUndefined();
    expect(items[1]?.dataset["active"]).toBe("true");
    keydown(area(), "ArrowUp");
    keydown(area(), "ArrowUp");
    expect(items[0]?.dataset["active"]).toBe("true");
  });

  it("completes the highlighted command with Tab and with Enter", async () => {
    mockFetch(() => text(menuFor("co")));
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    await openMenu("/co");
    keydown(area(), "ArrowDown");
    expect(keydown(area(), "Enter").defaultPrevented).toBe(true);
    expect(submits).toHaveLength(0);
    expect(area().value).toBe("/copy ");
    expect(byId("slash-menu").hidden).toBe(true);

    await openMenu("/co");
    keydown(area(), "Tab");
    expect(area().value).toBe("/compact ");
  });

  it("runs a fully typed built-in on Enter instead of completing", async () => {
    mockFetch(() => text(menuFor("compact")));
    const { submits } = page();
    const { setUpComposer } = await load();
    setUpComposer();
    await openMenu("/compact");
    expect(byId("slash-menu").hidden).toBe(false);
    keydown(area(), "Enter");
    expect(submits).toHaveLength(1);
    expect(area().value).toBe("/compact");
  });

  it("closes on Escape and when the text stops being a command", async () => {
    mockFetch(() => text(menuFor("")));
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    await openMenu("/");
    expect(keydown(area(), "Escape").defaultPrevented).toBe(true);
    expect(byId("slash-menu").hidden).toBe(true);
    await openMenu("/");
    expect(byId("slash-menu").hidden).toBe(false);
    type(area(), "/name it");
    expect(byId("slash-menu").hidden).toBe(true);
  });

  it("drops a reply that arrives after the text changed", async () => {
    mockFetch(() => text(menuFor("")));
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "/");
    vi.advanceTimersByTime(80);
    type(area(), "plain text now");
    await flush();
    expect(byId("slash-menu").hidden).toBe(true);
  });

  it("applies a command on mouse down without moving focus", async () => {
    mockFetch(() => text(menuFor("")));
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    await openMenu("/");
    const item = query('[data-command="name"]');
    const press = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    item.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(area().value).toBe("/name ");
  });
});

describe("history", () => {
  it("walks back through earlier prompts from an empty box", async () => {
    page({ history: ["one", "two", "two", "three"] });
    const { setUpComposer } = await load();
    setUpComposer();
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("three");
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("two");
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("one");
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("one");
    keydown(area(), "ArrowDown");
    expect(area().value).toBe("two");
    keydown(area(), "ArrowDown");
    keydown(area(), "ArrowDown");
    expect(area().value).toBe("");
  });

  it("stays out of the way of typed text", async () => {
    page({ history: ["one"] });
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "draft");
    expect(keydown(area(), "ArrowUp").defaultPrevented).toBe(false);
    expect(area().value).toBe("draft");
  });

  it("ends the cycle on any edit", async () => {
    page({ history: ["one", "two"] });
    const { setUpComposer } = await load();
    setUpComposer();
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("two");
    type(area(), "two!");
    expect(keydown(area(), "ArrowUp").defaultPrevented).toBe(false);
    expect(area().value).toBe("two!");
  });
});

describe("mentions and hints", () => {
  it("inserts a file panel chip at the caret", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button type="button" data-mention="src/a b.ts">@</button>' +
        '<button type="button" data-mention="docs" data-mention-dir="1">@</button>',
    );
    const { setUpComposer } = await load();
    setUpComposer();
    type(area(), "see ");
    click(query('[data-mention="src/a b.ts"]'));
    expect(area().value).toBe('see @"src/a b.ts" ');
    click(query('[data-mention="docs"]'));
    expect(area().value).toBe('see @"src/a b.ts" @docs/');
  });

  it("names shell mode while the text starts with a bang", async () => {
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    const hint = byId("shell-hint");
    type(area(), "!ls");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe("Shell · output sent to model");
    type(area(), "!!ls");
    expect(hint.textContent).toBe("Shell · output stays local");
    type(area(), "plain");
    expect(hint.hidden).toBe(true);
  });

  it("re-reads a textarea the server swapped in", async () => {
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    const fresh = area();
    fresh.value = "recalled text";
    htmxEvent(query(".composer-surface"), "htmx:after:settle");
    expect(primary().disabled).toBe(false);
  });

  it("hands the composer the caret on a pointer device", async () => {
    page();
    const { setUpComposer } = await load();
    setUpComposer();
    frame();
    expect(document.activeElement).toBe(area());
  });
});

describe("the model menu", () => {
  const models = Array.from({ length: 9 }, (_, index) => ({
    provider: index < 5 ? "anthropic" : "openai",
    id: `m${String(index)}`,
    name: index === 0 ? "Claude Opus" : `Model ${String(index)}`,
    thinkingLevels: [],
    contextWindow: 200_000,
    reasoning: false,
  }));

  it("filters the list and forgets the filter when the menu closes", async () => {
    page();
    byId("composer").insertAdjacentHTML(
      "beforeend",
      render(ModelSelector({ pick: { models, current: null, levels: [] } })),
    );
    const { setUpComposer } = await load();
    setUpComposer();
    const filter = field("#model-filter");
    type(filter, "opus");
    const options = [
      ...document.querySelectorAll<HTMLElement>("[data-model-name]"),
    ];
    expect(options.filter((option) => !option.hidden)).toHaveLength(1);
    expect(query('[data-provider="openai"]').hidden).toBe(true);
    const menu = byId("model-menu");
    menu.showPopover();
    expect(byId("model-trigger").getAttribute("aria-expanded")).toBe("true");
    menu.hidePopover();
    expect(byId("model-trigger").getAttribute("aria-expanded")).toBe("false");
    expect(filter.value).toBe("");
    expect(options.filter((option) => !option.hidden)).toHaveLength(9);
  });
});

describe("the drop zone", () => {
  function drag(name: string, files = true): Event {
    const transfer = new DataTransfer();
    if (files)
      transfer.items.add(new File(["x"], "a.png", { type: "image/png" }));
    // A browser lists "Files" among the types; happy-dom lists the MIME types.
    Object.defineProperty(transfer, "types", { value: files ? ["Files"] : [] });
    // happy-dom's DragEvent is a bare Event, so the transfer rides on top.
    const event = Object.assign(
      new Event(name, { bubbles: true, cancelable: true }),
      { dataTransfer: transfer },
    );
    query(".chat-window").dispatchEvent(event);
    return event;
  }

  it("shows the overlay while files hover and takes the drop", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="chat-window"><div class="chat-drop-zone" hidden></div></div>',
    );
    const { setUpComposer } = await load();
    setUpComposer();
    const zone = query(".chat-drop-zone");
    drag("dragenter");
    expect(zone.hidden).toBe(false);
    expect(drag("dragover").defaultPrevented).toBe(true);
    drag("dragleave");
    expect(zone.hidden).toBe(true);
    drag("dragenter");
    expect(drag("drop").defaultPrevented).toBe(true);
    expect(zone.hidden).toBe(true);
    await flush();
    expect(byId("image-previews").querySelectorAll("img")).toHaveLength(1);
    expect(byId("composer").hasAttribute("data-has-images")).toBe(true);
  });

  it("ignores a drag that carries no files", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div class="chat-window"><div class="chat-drop-zone" hidden></div></div>',
    );
    const { setUpComposer } = await load();
    setUpComposer();
    drag("dragenter", false);
    expect(query(".chat-drop-zone").hidden).toBe(true);
  });
});

describe("the extension shelf", () => {
  const SHELF =
    '<div id="shelf" class="extension-status-shelf has-widgets has-status">' +
    '<div class="extension-widget-panels" hidden>' +
    '<section id="widget-panel-0" class="extension-widget-panel" hidden>a</section>' +
    '<section id="widget-panel-1" class="extension-widget-panel" hidden>b</section>' +
    "</div>" +
    '<button type="button" class="extension-widget-trigger" data-widget="a" aria-controls="widget-panel-0" aria-expanded="false">a</button>' +
    '<button type="button" class="extension-widget-trigger" data-widget="b" aria-controls="widget-panel-1" aria-expanded="false">b</button>' +
    '<div class="extension-status-line"><span class="extension-status-text">Linting <b>3</b></span></div>' +
    "</div>";

  it("opens one widget panel at a time and keeps it across re-renders", async () => {
    page();
    document.body.insertAdjacentHTML("beforeend", SHELF);
    const { setUpComposer } = await load();
    setUpComposer();
    expect(byId("composer-status-section").hidden).toBe(false);
    expect(byId("shelf-mobile").innerHTML).toBe("Linting <b>3</b>");
    click(query('[data-widget="a"]'));
    expect(byId("widget-panel-0").hidden).toBe(false);
    expect(query(".extension-widget-panels").hidden).toBe(false);
    click(query('[data-widget="b"]'));
    expect(byId("widget-panel-0").hidden).toBe(true);
    expect(byId("widget-panel-1").hidden).toBe(false);
    // The stream re-renders the strip with every panel closed.
    byId("shelf").outerHTML = SHELF;
    htmxEvent(document.body, "htmx:after:settle");
    expect(byId("widget-panel-1").hidden).toBe(false);
    expect(query('[data-widget="b"]').getAttribute("aria-expanded")).toBe(
      "true",
    );
    click(query('[data-widget="b"]'));
    expect(byId("widget-panel-1").hidden).toBe(true);
    expect(query(".extension-widget-panels").hidden).toBe(true);
  });

  it("adopts the panel the server opened", async () => {
    page();
    document.body.insertAdjacentHTML(
      "beforeend",
      SHELF.replace('data-widget="a"', 'data-widget="a" aria-expanded="true"'),
    );
    const { setUpComposer } = await load();
    setUpComposer();
    expect(byId("widget-panel-0").hidden).toBe(false);
    click(query('[data-widget="a"]'));
    expect(byId("widget-panel-0").hidden).toBe(true);
  });
});
