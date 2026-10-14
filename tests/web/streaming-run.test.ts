// A long agent run: each connection sends a finished message once and then
// morphs only what is still in flight, finished reasoning follows the same
// budget as a settled page, and reasoning the reader already has stays put.

import { assistantEntry } from "@adapters/fake/index";
import type { HTMLDetailsElement } from "happy-dom";
import { expect, it } from "vitest";
import { reconnected, required } from "#/web/helpers";
import { disconnectable } from "#/web/fixtures/disconnect";
import {
  open,
  openDetails,
  rawFrames,
  renderStart,
  streamingFixture,
} from "#/web/fixtures/streaming";

function thinkingRequests(requests: Request[]) {
  return requests.filter((request) =>
    new URL(request.url).pathname.includes("/thinking/"),
  );
}

/** `count` rounds of the fixture's agent loop, each reasoning `chars`. */
function rounds(count: number, chars = 100): number[] {
  return Array.from({ length: count }, () => chars);
}

/** Ids of the rounds the page shows in its running turn, in page order. */
function roundsInTurn(document: {
  querySelectorAll(selector: string): Iterable<{ id: string }>;
}) {
  return [...document.querySelectorAll('#turn [id^="entry-round-"]')].map(
    (element) => element.id,
  );
}

function roundIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_, round) => `entry-round-${String(round).padStart(4, "0")}`,
  );
}

it("keeps a live update the same size however many messages the run finished", async () => {
  const f = await streamingFixture();
  f.agentRun([]);
  const next = await rawFrames(f);
  const nextRender = async () => {
    for (;;) {
      const frame = await next();
      if (renderStart(frame)) return frame;
    }
  };
  await nextRender();
  const updates: string[] = [];
  for (let count = 1; count <= 30; count += 1) {
    f.agentRun(rounds(count, 2_000));
    f.emit("activity");
    updates.push(await nextRender());
  }
  const sizes = updates.map((frame) => new TextEncoder().encode(frame).length);
  expect(new Set(sizes).size).toBe(1);
  // Each update carries only the round that finished since the one before.
  updates.forEach((frame, round) => {
    expect(new Set(frame.match(/Step \d{4}/g))).toEqual(
      new Set([`Step ${String(round).padStart(4, "0")}`]),
    );
  });
});

it("starts every connection with the whole run, a reconnection too", async () => {
  const f = await streamingFixture();
  f.agentRun(rounds(3));
  const first = await (await rawFrames(f))();
  const reconnection = await (
    await rawFrames(f, "", { headers: { "Last-Event-ID": "settled=" } })
  )();
  for (const frame of [first, reconnection]) {
    expect(frame).toContain(
      '<hx-partial hx-target="#turn" hx-swap="innerMorph">',
    );
    expect(new Set(frame.match(/Step \d{4}/g))).toEqual(
      new Set(["Step 0000", "Step 0001", "Step 0002"]),
    );
  }
});

it("starts a reconnection with the whole run, without duplicates or gaps", async () => {
  const f = await streamingFixture();
  f.agentRun(rounds(2));
  const transport = disconnectable((request) => f.app.request(request));
  const { document, firstFrame } = await open(f, undefined, transport.request);
  await firstFrame;
  f.agentRun(rounds(3));
  f.emit("activity");
  await expect.poll(() => roundsInTurn(document)).toEqual(roundIds(3));
  const reconnect = reconnected(required(document.querySelector("main")));
  required(transport.connections[0]).disconnect();
  f.agentRun(rounds(5));
  await reconnect;
  expect(transport.connections).toHaveLength(2);
  expect(roundsInTurn(document)).toEqual(roundIds(5));
  f.agentRun(rounds(6));
  f.emit("activity");
  await expect.poll(() => roundsInTurn(document)).toEqual(roundIds(6));
  expect(
    document.querySelectorAll('#turn [id^="entry-partial-"]'),
  ).toHaveLength(1);
  expect(document.querySelectorAll("#entry-run-user")).toHaveLength(1);
});

it("sends a message that failed with its tool call unanswered once", async () => {
  const f = await streamingFixture();
  f.agentRun(rounds(1));
  // Pi runs no tool call of a failed message; the retry streams on behind it.
  const failed = assistantEntry("failed", "result-0000", "", 100);
  if (failed.type !== "message" || failed.message.role !== "assistant")
    throw new Error("Invalid failed fixture");
  failed.message.stopReason = "error";
  failed.message.errorMessage = "overloaded";
  failed.message.content = [
    { type: "text", text: "Half an answer" },
    {
      type: "toolCall",
      id: "call-lost",
      name: "read",
      arguments: { path: "src/lost.ts" },
    },
  ];
  const branch = [...f.snapshot.branch, failed];
  f.update({ branch, entries: branch });
  const next = await rawFrames(f);
  const nextRender = async () => {
    for (;;) {
      const frame = await next();
      if (renderStart(frame)) return frame;
    }
  };
  expect(await nextRender()).toContain("Half an answer");
  f.emit("activity");
  const update = await nextRender();
  expect(update).toContain('hx-target="#turn-live"');
  expect(update).not.toContain("Half an answer");
});

it("hands a run that streamed in parts over to settled history in one copy", async () => {
  const f = await streamingFixture();
  f.agentRun(rounds(1));
  const { document, firstFrame } = await open(f);
  await firstFrame;
  f.agentRun(rounds(2));
  f.emit("activity");
  await expect.poll(() => roundsInTurn(document)).toEqual(roundIds(2));
  const answer = assistantEntry("final-answer", "result-0001", "All done", 100);
  const branch = [...f.snapshot.branch, answer];
  f.update(
    {
      branch,
      entries: branch,
      turnStart: branch.length,
      partial: undefined,
      status: { ...f.snapshot.status, running: false, tools: [] },
    },
    "turn_done",
  );
  await expect
    .poll(() => document.querySelector("#messages")?.textContent)
    .toContain("All done");
  expect(document.querySelector("#turn")?.textContent).toBe("");
  for (const id of ["entry-run-user", ...roundIds(2), "entry-final-answer"]) {
    expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    expect(document.querySelector(`#messages [id="${id}"]`)).not.toBeNull();
  }
});

it("keeps finished reasoning beyond the budget out of live frames, never the partial's", async () => {
  const f = await streamingFixture();
  f.agentRun([25_000, 25_000, 25_000], 25_000);
  const next = await rawFrames(f);
  const frame = await next();
  expect(renderStart(frame)).toBe(true);
  expect(frame).toContain("partial reasoning ");
  expect(frame).toContain("reasoning 0002 ");
  for (const round of ["0000", "0001"]) {
    expect(frame).not.toContain(`reasoning ${round} `);
    expect(frame).toContain(`/entries/round-${round}/thinking/0`);
  }
});

it("keeps reasoning on the page when a later frame defers it", async () => {
  const f = await streamingFixture();
  f.agentRun([100]);
  const { document, requests, firstFrame } = await open(f);
  await firstFrame;
  const card = required(
    document.querySelector<HTMLDetailsElement>("#thinking-round-0000-0"),
  );
  openDetails(card);
  expect(card.textContent).toContain("reasoning 0000 ");
  f.agentRun([100, 25_000]);
  f.emit("activity");
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("reasoning 0001 ");
  expect(document.querySelector("#thinking-round-0000-0")).toBe(card);
  expect(card.open).toBe(true);
  expect(card.textContent).toContain("reasoning 0000 ");
  expect(thinkingRequests(requests)).toEqual([]);
});

it("fetches deferred reasoning in the running turn on open and keeps it", async () => {
  const f = await streamingFixture();
  f.agentRun([100, 25_000, 100]);
  const { document, requests, firstFrame } = await open(f);
  await firstFrame;
  const card = required(
    document.querySelector<HTMLDetailsElement>("#thinking-round-0000-0"),
  );
  expect(card.textContent).toContain("Loading thinking...");
  openDetails(card);
  await expect.poll(() => card.textContent).toContain("reasoning 0000 ");
  f.update(
    {
      partial: {
        ...required(f.snapshot.partial),
        content: [{ type: "text", text: "next words" }],
      },
    },
    "activity",
  );
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("next words");
  expect(document.querySelector("#thinking-round-0000-0")).toBe(card);
  expect(card.textContent).toContain("reasoning 0000 ");
  expect(thinkingRequests(requests)).toHaveLength(1);
});
