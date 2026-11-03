import { AssistantMessage } from "@web/views/transcript/assistant";
import { Composer } from "@web/views/Composer";
import { html } from "hono/html";
import { expect, it } from "vitest";
import type { HTMLButtonElement, HTMLTextAreaElement } from "happy-dom";
import { controlledStream, htmxBrowser, page } from "#/web/htmx4-browser";
import { required } from "#/web/helpers";

function answer(text: string) {
  return AssistantMessage({
    item: {
      kind: "assistant",
      entryId: "partial",
      model: "model",
      provider: "test",
      stopReason: "stop",
      timestamp: "2026-09-01T00:00:00Z",
      blocks: [{ kind: "text", text }],
    },
  });
}

it("cites streamed content, rejects a stale range after a real SSE morph, and cleans up on navigation", async () => {
  const stream = controlledStream();
  const { window, document, requests } = await htmxBrowser(
    page(
      String(
        await html`<div
            id="live"
            hx-sse:connect="/events"
            hx-trigger="web-pi:sse-start"
            hx-swap="none"
          ></div>
          <div id="log">
            <div id="turn-live">${answer("Initial answer")}</div>
          </div>
          ${Composer({ sessionId: "s1", cwd: "/repo" })}`,
      ),
    ),
    () => stream.response,
    {
      afterMarkup(window) {
        window.eval(`Range.prototype.getClientRects = () => [new DOMRect(100, 100, 200, 20)];
      document.querySelector('#log').getBoundingClientRect = () => new DOMRect(0, 0, 600, 500);`);
      },
    },
  );
  const select = () => {
    window.eval(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-cite-answer] p'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  })()`);
  };
  const button = () =>
    required(document.querySelector<HTMLButtonElement>(".transcript-cite"));
  const area = () =>
    required(document.querySelector<HTMLTextAreaElement>("#composer-text"));
  await expect
    .poll(
      () =>
        window.eval(
          "document.getElementById('live')._htmx?.sse?.status",
        ) as unknown,
    )
    .toBe(200);
  select();
  expect(button().hidden).toBe(false);
  // Retain the candidate across normal focus loss; the morph must still invalidate it.
  button().focus();
  stream.send(
    String(
      await html`<hx-partial hx-target="#turn-live" hx-swap="innerMorph"
        >${answer("Replacement answer")}</hx-partial
      >`,
    ),
  );
  await expect
    .poll(() => document.querySelector("[data-cite-answer] p")?.textContent)
    .toBe("Replacement answer");
  expect(button().hidden).toBe(true);
  button().click();
  expect(area().value).toBe("");
  select();
  button().click();
  expect(area().value).toBe("Regarding\n> Replacement answer\n\n");
  expect(requests).toHaveLength(1);
  await window.eval(
    `htmx.swap({ target: document.body, sourceElement: document.body, swap: 'innerHTML', text: '<main>Another session</main>' })`,
  );
  expect(document.querySelector(".transcript-cite")).toBeNull();
});
