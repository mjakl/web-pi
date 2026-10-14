// A long agent run: finished reasoning in the running turn follows the same
// budget as a settled page, and reasoning the reader already has stays put.

import type { HTMLDetailsElement } from "happy-dom";
import { expect, it } from "vitest";
import { required } from "#/web/helpers";
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
