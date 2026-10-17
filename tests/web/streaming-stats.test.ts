import { assistantEntry } from "@adapters/fake/index";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HTMLElement } from "happy-dom";
import { expect, it, onTestFinished } from "vitest";
import { open, streamingFixture } from "#/web/fixtures/streaming";
import { nextEvent, parseHtml, requestFinished, required } from "#/web/helpers";

it("shows SDK usage in session totals without adding it to the main-model context", async () => {
  const f = await streamingFixture();
  onTestFinished(() => f.live.stop());
  const manager = SessionManager.inMemory("/fixture");
  const answer = assistantEntry("unused", null, "ordinary answer", 100);
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Expected assistant");
  manager.appendMessage(answer.message);
  manager.appendUsage("cache_warm", "fixture", "model", {
    input: 0,
    output: 0,
    cacheRead: 50_000,
    cacheWrite: 0,
    totalTokens: 50_000,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0.015,
      cacheWrite: 0,
      total: 0.015,
    },
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "nested",
    toolName: "codemode",
    content: [],
    isError: false,
    timestamp: 1,
    usage: {
      input: 200,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 210,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.003,
      },
    },
  });
  f.update({
    entries: manager.getEntries(),
    branch: manager.getBranch(),
    turnStart: manager.getBranch().length,
  });
  const view = required(await f.workspace.viewSession(f.id));
  expect(view.usage.tokens).toBe(100);
  expect(view.tokens.total).toBe(50_310);
  for (const live of [true, false]) {
    if (!live) {
      f.world.store.set(f.id, {
        summary: { ...f.snapshot.summary, live: false },
        entries: manager.getEntries(),
      });
      await f.live.stop();
    }
    const response = await f.app.request(`/sessions/${f.id}/stats`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("50,310");
    const page = parseHtml(
      await (await f.app.request(`/sessions/${f.id}`)).text(),
    );
    const title = required(page.querySelector("#stats-trigger")).getAttribute(
      "title",
    );
    expect(title).toContain("in: 290");
    expect(title).toContain("cache read: 50,000");
  }
});

it.each([0, 1])(
  "refreshes ordinary assistant totals and the tooltip from %i prior answers without replacing focused controls",
  async (prior) => {
    const f = await streamingFixture();
    for (let index = 0; index < prior; index += 1)
      f.finish("earlier answer", false);
    const { document, window, firstFrame } = await open(f);
    await firstFrame;
    const trigger = required(
      document.querySelector<HTMLElement>("#stats-trigger"),
    );
    const panel = required(document.querySelector("#stats-panel"));
    const loaded = requestFinished(document, `/sessions/${f.id}/stats`);
    // happy-dom has no native popover action; deliver its platform event.
    panel.dispatchEvent(
      Object.assign(new window.Event("toggle"), {
        newState: "open",
        oldState: "closed",
      }),
    );
    await loaded;
    const content = required(panel.firstElementChild);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.querySelectorAll(".mobile-session-stat-io")).toHaveLength(
      prior ? 2 : 0,
    );
    expect(trigger.querySelector("[data-cache-read]")).toBeNull();

    const done = nextEvent(document.body, "done");
    f.finish("new ordinary answer", false);
    const answer = required(f.snapshot.entries.at(-1));
    if (answer.type !== "message" || answer.message.role !== "assistant")
      throw new Error("Expected assistant");
    answer.message.usage.cacheRead = 300;
    answer.message.usage.totalTokens = 400;
    f.emit("turn_done");
    f.emit("completed");
    await done;

    expect(document.querySelector("#stats-trigger")).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector("#stats-panel")).toBe(panel);
    expect(panel.firstElementChild).toBe(content);
    expect(
      [...trigger.querySelectorAll(".mobile-session-stat-io")].map(
        (node) => node.textContent,
      ),
    ).toEqual([String(90 * (prior + 1)), String(10 * (prior + 1))]);
    expect(trigger.querySelector("[data-cache-read]")?.textContent).toBe("300");
    expect(trigger.getAttribute("title")).toContain(
      `in: ${String(90 * (prior + 1))}`,
    );
    expect(trigger.getAttribute("title")).toContain(
      `out: ${String(10 * (prior + 1))}`,
    );
    expect(trigger.getAttribute("title")).toContain("cache read: 300");
    const fresh = parseHtml(
      await (await f.app.request(`/sessions/${f.id}`)).text(),
    );
    expect(trigger.outerHTML).toBe(
      required(fresh.querySelector("#stats-trigger")).outerHTML,
    );
  },
);
