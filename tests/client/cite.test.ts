import { required } from "#/web/helpers";
import type { AssistantBlock } from "@core/transcript";
import { Composer } from "@web/views/Composer";
import { AssistantMessage } from "@web/views/transcript/assistant";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  htmxEvent,
  keydown,
  mount,
  query,
  render,
  type,
} from "./helpers.ts";

function reply(
  id: string,
  blocks: AssistantBlock[] = [
    { kind: "text", text: "First selected line\n\nSecond selected line" },
  ],
) {
  return render(
    AssistantMessage({
      item: {
        kind: "assistant",
        entryId: id,
        model: "model",
        provider: "test",
        blocks,
        stopReason: "stop",
        timestamp: "2026-09-01T00:00:00Z",
      },
    }),
  );
}

async function page() {
  mount(
    `<main data-session-id="s1"><div id="log">${reply("a1")}${reply("a2")}</div>${render(Composer({ sessionId: "s1", cwd: "/repo" }))}</main>`,
  );
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    new DOMRect(100, 100, 200, 20),
  ] as unknown as DOMRectList);
  vi.spyOn(byId("log"), "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 600, 500),
  );
  const { setUpComposer } = await import("@web/client/composer");
  const { setUpTranscript } = await import("@web/client/transcript");
  setUpComposer();
  setUpTranscript();
}

function select(
  start: Node,
  end = start,
  startOffset = 0,
  endOffset = end.textContent?.length ?? 0,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = required(getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function paragraph(id = "a1") {
  return required(
    query(`[id^="entry-${id}"] .markdown-assistant-message p`).firstChild,
  );
}

function cite() {
  return query(".transcript-cite") as HTMLButtonElement;
}

describe("selection-based Cite", () => {
  it("waits for activation, appends repeated multiline quotes, saves the draft and never submits", async () => {
    await page();
    const submits = vi.fn((event: Event) => {
      event.preventDefault();
    });
    byId("composer").addEventListener("submit", submits);
    type(area(), "Unsent draft");
    area().setSelectionRange(0, 6);
    select(paragraph());
    expect(cite().hidden).toBe(false);
    expect(cite().textContent).toBe("“ Cite");
    expect(cite().querySelector('[aria-hidden="true"]')?.textContent).toBe("“");
    expect(area().value).toBe("Unsent draft");
    cite().click();
    expect(area().value).toBe(
      "Unsent draft\n\nRegarding\n> First selected line\n\n",
    );
    expect(area().selectionStart).toBe(area().value.length);
    expect(document.activeElement).toBe(area());
    byId("log").insertAdjacentHTML(
      "beforeend",
      reply("multi", [
        {
          kind: "text",
          text: "```\nFirst selected line\nSecond selected line\n```",
        },
      ]),
    );
    const code = required(query("#entry-multi code").firstChild);
    select(code, code, 0, required(code.textContent).trimEnd().length);
    cite().click();
    expect(area().value).toBe(
      "Unsent draft\n\nRegarding\n> First selected line\n\nRegarding\n> First selected line\n> Second selected line\n\n",
    );
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBe(area().value);
    expect(
      (query(".composer-action-primary") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(submits).not.toHaveBeenCalled();
  });

  it.each(["", "draft\n", "draft\n\n", "draft\n\n\n"])(
    "preserves existing whitespace when appending to %j",
    async (draft) => {
      await page();
      type(area(), draft);
      select(paragraph());
      cite().click();
      const prefix =
        draft === "" ? "" : draft === "draft\n" ? "draft\n\n" : draft;
      expect(area().value).toBe(
        `${prefix}Regarding\n> First selected line\n\n`,
      );
    },
  );

  it("clears a dismissed selection and revalidates a composer made read-only", async () => {
    await page();
    select(paragraph());
    required(getSelection()).removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(cite().hidden).toBe(true);
    select(paragraph());
    area().readOnly = true;
    cite().click();
    expect(area().value).toBe("");
    expect(cite().hidden).toBe(true);
  });

  it("retains the captured selection when activating by pointer or keyboard", async () => {
    await page();
    select(paragraph());
    const mark = required(cite().querySelector<HTMLElement>("[aria-hidden]"));
    mark.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    required(getSelection()).removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    mark.click();
    expect(area().value).toBe("Regarding\n> First selected line\n\n");
    select(paragraph("a2"));
    keydown(document, "Tab");
    expect(document.activeElement).toBe(cite());
    required(getSelection()).removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    cite().click();
    expect(area().value.match(/Regarding/g)).toHaveLength(2);
    select(paragraph());
    keydown(document, "Escape");
    expect(cite().hidden).toBe(true);
  });

  it("accepts heading, list and paragraph selections at containing-element boundaries", async () => {
    await page();
    byId("log").insertAdjacentHTML(
      "beforeend",
      reply("boundaries", [
        {
          kind: "text",
          text: "## Heading\n\n- First **bold** item\n- Second item\n\nFollowing paragraph",
        },
      ]),
    );
    const answer = query("#entry-boundaries [data-cite-answer]");
    const blocks = required(answer.parentElement);
    select(blocks, blocks, 0, blocks.childNodes.length);
    expect(cite().hidden).toBe(false);
    cite().click();
    expect(area().value).toContain("Heading");
    expect(area().value).toContain("First bold item");
    expect(area().value).toContain("Following paragraph");

    select(
      required(answer.querySelector("li")?.firstChild),
      blocks,
      0,
      blocks.childNodes.length,
    );
    expect(cite().hidden).toBe(false);
  });

  it("keeps file-reference labels and accepts selections crossing incidental controls", async () => {
    await page();
    byId("log").insertAdjacentHTML(
      "beforeend",
      reply("controls", [
        {
          kind: "text",
          text: "Before [the helper](/repo/helper.ts).\n\n```ts\nconst first = 1;\nconst second = 2;\n```\n\nAfter",
        },
      ]),
    );
    const answer = query("#entry-controls [data-cite-answer]");
    select(required(answer.querySelector(".markdown-file-ref")?.firstChild));
    expect(cite().hidden).toBe(false);
    cite().click();
    expect(area().value).toBe("Regarding\n> the helper\n\n");
    select(answer, answer, 0, answer.childNodes.length);
    expect(cite().hidden).toBe(false);
    select(required(answer.querySelector("[data-copy-code]")?.firstChild));
    expect(cite().hidden).toBe(true);
  });

  it("rejects thinking, unrelated DOM and selections crossing replies", async () => {
    await page();
    byId("log").insertAdjacentHTML(
      "beforeend",
      reply("mixed", [
        {
          kind: "thinking",
          index: 0,
          deferred: false,
          text: "Private reasoning",
        },
        { kind: "text", text: "Answer" },
        {
          kind: "tool",
          call: {
            id: "tool",
            name: "bash",
            arguments: {},
            preview: "tool output",
          },
        },
        { kind: "text", text: "Final answer" },
      ]),
    );
    select(required(query(".thinking-body p").firstChild));
    expect(cite().hidden).toBe(true);
    select(paragraph(), paragraph("a2"));
    expect(cite().hidden).toBe(true);
    select(required(query(".assistant-model-name").firstChild));
    expect(cite().hidden).toBe(true);
    select(required(query(".tool-input").firstChild));
    expect(cite().hidden).toBe(true);
    const answer = query("#entry-mixed [data-cite-answer]");
    const final = query("#entry-mixed [data-cite-answer]:last-child p");
    select(
      required(answer.querySelector("p")?.firstChild),
      required(final.firstChild),
    );
    expect(cite().hidden).toBe(true);
    select(
      required(query(".thinking-body p").firstChild),
      required(answer.querySelector("p")?.firstChild),
    );
    expect(cite().hidden).toBe(true);
    // Merely touching the neighboring thinking/tool nodes is not selecting them.
    const blocks = required(answer.parentElement);
    select(blocks, blocks, 1, 2);
    expect(cite().hidden).toBe(false);
  });

  it.each(["readOnly", "disabled", "absent"])(
    "does not offer Cite with an %s composer",
    async (state) => {
      await page();
      if (state === "absent") area().remove();
      else if (state === "readOnly") area().readOnly = true;
      else area().disabled = true;
      select(paragraph());
      expect(cite().hidden).toBe(true);
    },
  );

  it("accepts new streamed answers but discards changed text and navigation state", async () => {
    await page();
    byId("log").insertAdjacentHTML(
      "beforeend",
      `<div id="turn-live">${reply("partial")}</div>`,
    );
    select(paragraph("partial"));
    expect(cite().hidden).toBe(false);
    paragraph("partial").textContent = "Changed answer";
    cite().click();
    expect(area().value).toBe("");
    select(paragraph("partial"));
    byId("composer").dataset["sessionId"] = "s2";
    cite().click();
    expect(area().value).toBe("");
    htmxEvent(byId("log"), "htmx:before:cleanup");
    expect(document.querySelector(".transcript-cite")).toBeNull();
  });
});
