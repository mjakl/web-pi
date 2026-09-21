import { answerItem } from "#/web/fixtures/transcript-items";
import { Item, type ItemActions } from "@web/views/Items";
import { describe, expect, it, vi } from "vitest";
import {
  byId,
  click,
  device,
  flush,
  htmxEvent,
  mount,
  query,
  render,
  setGeometry,
} from "./helpers.ts";

// The transcript's scroll position: following the tail while a turn streams,
// holding still when an older page is prepended, the jump button, and the
// copy buttons and highlighter that run on settled content.

async function load(content = ""): Promise<HTMLElement> {
  mount(
    `<main data-session-id="s1"><div id="log"><div id="messages">${content}</div><div id="turn"></div></div>` +
      '<button type="button" id="jump-to-latest" hidden><span data-new-messages hidden>New messages</span></button></main>',
  );
  const view = byId("log");
  setGeometry(view, { scrollHeight: 2000, clientHeight: 500 });
  const { setUpTranscript } = await import("@web/client/transcript");
  setUpTranscript();
  return view;
}

describe("following the tail", () => {
  it("starts at the end with the jump button hidden", async () => {
    const view = await load();
    expect(view.scrollTop).toBe(2000);
    expect(byId("jump-to-latest").hidden).toBe(true);
  });

  it("shows the jump button once the reader scrolls up, and stops following", async () => {
    const view = await load();
    view.scrollTop = 1000;
    view.dispatchEvent(new Event("scroll"));
    expect(byId("jump-to-latest").hidden).toBe(false);
    setGeometry(view, { scrollHeight: 2400 });
    htmxEvent(byId("turn"), "htmx:after:settle");
    expect(view.scrollTop).toBe(1000);
  });

  it("follows again from the end, but only for the log and the turn", async () => {
    const view = await load();
    view.scrollTop = 1000;
    view.dispatchEvent(new Event("scroll"));
    view.scrollTop = 1500;
    view.dispatchEvent(new Event("scroll"));
    expect(byId("jump-to-latest").hidden).toBe(true);
    setGeometry(view, { scrollHeight: 2400 });
    byId("messages").insertAdjacentHTML("beforeend", '<div id="card"></div>');
    htmxEvent(byId("card"), "htmx:after:settle");
    expect(view.scrollTop).toBe(1500);
    htmxEvent(byId("messages"), "htmx:after:settle");
    expect(view.scrollTop).toBe(2400);
  });

  it("keeps the reader's place when an older page is prepended", async () => {
    const view = await load('<div class="load-earlier"></div>');
    view.scrollTop = 100;
    view.dispatchEvent(new Event("scroll"));
    htmxEvent(document.body, "htmx:before:swap", {
      tasks: [{ target: query(".load-earlier") }],
    });
    setGeometry(view, { scrollHeight: 3000 });
    htmxEvent(byId("messages"), "htmx:after:settle");
    expect(view.scrollTop).toBe(1100);
  });

  it("jumps to the end smoothly, or at once for reduced motion", async () => {
    const view = await load();
    const scrollTo = vi.spyOn(view, "scrollTo").mockImplementation(() => {});
    click(byId("jump-to-latest"));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 2000,
      behavior: "smooth",
    });
    device({ prefersReducedMotion: "reduce" });
    click(byId("jump-to-latest"));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2000, behavior: "auto" });
  });
});

describe("saved transcript updates", () => {
  it("anchors a detached reader and labels the existing jump button until they return to the tail", async () => {
    const view = await load(
      '<div id="entry-old">Old content</div><div id="entry-reading">Reading this</div>',
    );
    view.scrollTop = 1000;
    view.dispatchEvent(new Event("scroll"));
    vi.spyOn(byId("entry-old"), "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, -400, 600, 100),
    );
    let readingTop = 30;
    vi.spyOn(byId("entry-reading"), "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, readingTop, 600, 100),
    );
    view.dispatchEvent(new Event("web-pi:saved-before"));
    readingTop = 190;
    setGeometry(view, { scrollHeight: 2400 });
    htmxEvent(byId("messages"), "htmx:after:settle");
    view.dispatchEvent(new Event("web-pi:saved-after"));
    expect(view.scrollTop).toBe(1160);
    expect(byId("jump-to-latest").hidden).toBe(false);
    expect(query("[data-new-messages]").hidden).toBe(false);
    expect(byId("jump-to-latest").getAttribute("aria-label")).toBe(
      "New messages — jump to latest",
    );
    expect(document.querySelectorAll("#jump-to-latest")).toHaveLength(1);
    view.scrollTop = 1900;
    view.dispatchEvent(new Event("scroll"));
    expect(byId("jump-to-latest").hidden).toBe(true);
    expect(query("[data-new-messages]").hidden).toBe(true);
  });

  it("follows saved additions at the tail without advertising unread messages", async () => {
    const view = await load();
    view.dispatchEvent(new Event("web-pi:saved-before"));
    setGeometry(view, { scrollHeight: 2500 });
    htmxEvent(byId("messages"), "htmx:after:settle");
    view.dispatchEvent(new Event("web-pi:saved-after"));
    expect(view.scrollTop).toBe(2500);
    expect(byId("jump-to-latest").hidden).toBe(true);
    expect(query("[data-new-messages]").hidden).toBe(true);
  });
});

describe("copy buttons", () => {
  const actions: ItemActions = {
    sessionId: "s1",
    cwd: "/repo/one",
    starred: new Set(),
    timestamps: new Set([answerItem.entryId]),
  };

  it.each([false, true])(
    "groups assistant Copy with history actions (busy: %s)",
    async (busy) => {
      const write = vi
        .spyOn(navigator.clipboard, "writeText")
        .mockResolvedValue(undefined);
      await load(
        render(Item({ item: answerItem, actions: { ...actions, busy } })),
      );
      const row = query(".history-action-host > .history-actions");
      const copy = query("[data-copy]");
      expect(copy.parentElement).toBe(row);
      expect(
        Array.from(row.querySelectorAll("button")).map(
          (button) => button.title,
        ),
      ).toEqual([
        "Copy message",
        busy
          ? "Wait for the current operation to finish before branching"
          : "New branch — continue from this point within the current session",
        "New session — copy history to this point into a separate session",
      ]);
      expect(query('[aria-label="New branch"]').hasAttribute("disabled")).toBe(
        busy,
      );
      expect(
        query('[hx-post="/sessions/s1/fork"]').hasAttribute("disabled"),
      ).toBe(false);
      const metadata = query(".message-row > div:last-child");
      expect(metadata.textContent).toContain("1,200 in · 34 out · 500 cache R");
      expect(metadata.querySelector("[data-copy]")).toBeNull();
      expect(metadata.querySelector(".transcript-time")).not.toBeNull();
      click(copy);
      await flush();
      expect(write).toHaveBeenCalledWith(
        answerItem.blocks
          .filter((block) => block.kind === "text")
          .map((block) => block.text)
          .join("\n"),
      );
      expect(copy.dataset["copied"]).toBe("1");
      expect(copy.querySelector("[data-copy-done]")?.textContent).toBe(
        "Copied",
      );
      vi.advanceTimersByTime(1500);
      expect(copy.dataset["copied"]).toBeUndefined();
      expect(copy.querySelector("[data-copy-idle]")?.textContent).toBe("Copy");
    },
  );

  it.each([{ readOnly: true }, { live: true }])(
    "retains assistant Copy without history actions: %j",
    async (mode) => {
      await load(
        render(Item({ item: answerItem, actions: { ...actions, ...mode } })),
      );
      expect(document.querySelector(".history-actions")).toBeNull();
      expect(query(".message-row [data-copy]")).toBeTruthy();
    },
  );

  it("omits assistant Copy for streaming and textless messages", async () => {
    await load(
      render(
        Item({
          item: { ...answerItem, entryId: "partial" },
          actions: {
            ...actions,
            streaming: { tokens: 42, tokensPerSecond: 12 },
          },
        }),
      ),
    );
    expect(document.querySelector("[data-copy]")).toBeNull();
    await load(
      render(
        Item({
          item: {
            ...answerItem,
            blocks: [
              { kind: "thinking", text: "private", index: 0, deferred: false },
            ],
          },
          actions,
        }),
      ),
    );
    expect(document.querySelector("[data-copy]")).toBeNull();
  });

  it("copies a message and shows Copied for a moment", async () => {
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await load(
      '<div><div data-copy-source>the answer</div><button type="button" data-copy>Copy</button></div>',
    );
    click(query("[data-copy]"));
    await flush();
    expect(write).toHaveBeenCalledWith("the answer");
    expect(query("[data-copy]").textContent).toBe("Copied");
    expect(query("[data-copy]").dataset["copied"]).toBe("1");
    vi.advanceTimersByTime(1500);
    expect(query("[data-copy]").textContent).toBe("Copy");
    expect(query("[data-copy]").dataset["copied"]).toBeUndefined();
  });

  it("keeps a two-icon button's markup and does not open the summary it sits in", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await load(
      "<details><summary><span data-copy-source>x</span>" +
        '<button type="button" data-copy><span data-copy-idle>a</span><span data-copy-done hidden>b</span></button></summary></details>',
    );
    expect(click(query("[data-copy]")).defaultPrevented).toBe(true);
    await flush();
    expect(
      query("[data-copy]").querySelector("[data-copy-idle]"),
    ).not.toBeNull();
    expect(query("[data-copy]").dataset["copied"]).toBe("1");
  });

  it("copies a code block without its line numbers", async () => {
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    await load(
      '<div class="markdown-code-block"><button type="button" data-copy-code>Copy</button>' +
        '<pre><code class="language-ts">const a = 1;\nconst b = 2;\n</code></pre></div>',
    );
    click(query("[data-copy-code]"));
    await flush();
    expect(write).toHaveBeenCalledWith("const a = 1;\nconst b = 2;");
  });

  it("does nothing visible when the clipboard refuses", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
      new Error("no"),
    );
    await load(
      '<div><div data-copy-source>x</div><button type="button" data-copy>Copy</button></div>',
    );
    click(query("[data-copy]"));
    await flush();
    expect(query("[data-copy]").dataset["copied"]).toBeUndefined();
  });
});

describe("highlighting", () => {
  it("colours settled fences with numbered lines and leaves the running turn alone", async () => {
    await load(
      '<pre><code class="language-ts">const a = 1;\nlet b = "x";\n</code></pre>' +
        '<pre><code class="language-nonsense">plain &lt;b&gt;\n</code></pre>',
    );
    byId("turn").innerHTML =
      '<pre><code class="language-ts">streaming</code></pre>';
    htmxEvent(byId("turn"), "htmx:after:settle");
    const [typed, unknown] =
      document.querySelectorAll<HTMLElement>("#messages code");
    expect(typed?.dataset["highlighted"]).toBe("1");
    expect(typed?.querySelectorAll(".linenumber")).toHaveLength(2);
    expect(typed?.querySelector(".hljs-keyword")).not.toBeNull();
    expect(typed?.style.getPropertyValue("--linenumber-width")).toBe("1.25em");
    expect(unknown?.innerHTML).toContain("plain &lt;b&gt;");
    expect(unknown?.querySelectorAll(".linenumber")).toHaveLength(1);
    expect(query("#turn code").dataset["highlighted"]).toBeUndefined();
  });
});

describe("transcript owner replacement", () => {
  it("initializes a replacement log and stops listening to the old owner", async () => {
    const old = await load();
    const oldJump = byId("jump-to-latest");
    mount(
      '<main><div id="log"><div id="messages"></div><div id="turn"></div></div><button id="jump-to-latest" hidden></button></main>',
    );
    const view = byId("log");
    setGeometry(view, { scrollHeight: 3000, clientHeight: 500 });
    htmxEvent(document.body, "htmx:after:process");
    expect(view.scrollTop).toBe(3000);
    old.scrollTop = 500;
    old.dispatchEvent(new Event("scroll"));
    expect(oldJump.hidden).toBe(true);
    view.scrollTop = 1500;
    view.dispatchEvent(new Event("scroll"));
    expect(byId("jump-to-latest").hidden).toBe(false);
    htmxEvent(byId("turn"), "htmx:after:settle");
    expect(view.scrollTop).toBe(1500);
    htmxEvent(byId("messages"), "htmx:after:process");
    expect(view.scrollTop).toBe(1500);
  });
});
