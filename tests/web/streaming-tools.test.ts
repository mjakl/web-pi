// Completed tool bodies stay out of live frames until a reader opens their
// card, and opened cards keep their content, scroll and selection.

import type {
  HTMLButtonElement,
  HTMLDetailsElement,
  HTMLElement,
  HTMLTextAreaElement,
} from "happy-dom";
import { expect, it } from "vitest";
import { reconnected, requestFinished, required } from "#/web/helpers";
import {
  open,
  openDetails,
  rawFrames,
  renderStart,
  streamingFixture,
  toggleDetails,
} from "#/web/fixtures/streaming";
import { disconnectable } from "#/web/fixtures/disconnect";

function toolRequests(requests: Request[], callId: string) {
  return requests.filter((request) =>
    new URL(request.url).pathname.endsWith(`/tool-result/${callId}`),
  );
}
async function liveFrameBytes(f: Awaited<ReturnType<typeof streamingFixture>>) {
  const next = await rawFrames(f);
  const nextRender = async () => {
    for (;;) {
      const frame = await next();
      if (!renderStart(frame)) continue;
      expect(frame).not.toContain("ordinary-output-body:");
      expect(frame).not.toContain("subagent-run-output:");
      expect(frame).not.toContain("subagent-raw-prompt:");
      expect(frame).toContain("still-running");
      expect(frame).toContain("partial thinking");
      return new TextEncoder().encode(frame).byteLength;
    }
  };
  const initial = await nextRender();
  f.update(
    {
      partial: {
        ...required(f.snapshot.partial),
        content: [
          { type: "thinking", thinking: "partial thinking" },
          { type: "text", text: "partial answer next" },
        ],
      },
    },
    "activity",
  );
  return { initial, update: await nextRender() };
}

it("omits completed ordinary and subagent bodies until their collapsed cards open", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const browser = await open(f);
  const { document, requests } = browser;
  await expect.poll(() => f.subscribers).toBe(1);

  expect(document.body.textContent).not.toContain("ordinary-output-body:");
  expect(document.body.textContent).not.toContain("subagent-raw-prompt:");
  expect(document.body.textContent).not.toContain("subagent-run-output:");
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(0);
  expect(toolRequests(requests, "call-rich-subagent")).toHaveLength(0);

  openDetails(
    required(
      document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
    ),
  );
  await expect
    .poll(() => document.body.textContent)
    .toContain("ordinary-output-body:");
  expect(document.body.textContent).toContain("ordinary-input-body:");
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(1);

  openDetails(
    required(
      document.querySelector<HTMLDetailsElement>("#tool-call-rich-subagent"),
    ),
  );
  await expect
    .poll(() => document.body.textContent)
    .toContain("subagent-run-output:");
  expect(document.body.textContent).toContain("subagent-raw-prompt:");
  expect(document.body.textContent).toContain("subagent-raw-result:");
  expect(toolRequests(requests, "call-rich-subagent")).toHaveLength(1);
});

it.each(["live", "stored"] as const)(
  "serves completed ordinary and subagent bodies from an alternate %s branch",
  async (source) => {
    const f = await streamingFixture();
    const alternate = f.alternateCompletedTools();
    if (source === "stored") await f.persistAndStop();

    const page = await (
      await f.app.request(`/sessions/${f.id}?leaf=${alternate.leaf}`)
    ).text();
    const ordinaryUrl = `/sessions/${f.id}/entries/alternate-ordinary-result/tool-result/call-alternate-ordinary`;
    const subagentUrl = `/sessions/${f.id}/entries/alternate-subagent-result/tool-result/call-alternate-subagent`;
    expect(page).toContain(ordinaryUrl);
    expect(page).toContain(subagentUrl);

    const ordinary = await f.app.request(ordinaryUrl);
    expect(ordinary.status).toBe(200);
    expect(await ordinary.text()).toContain("alternate ordinary body");
    const subagent = await f.app.request(subagentUrl);
    expect(subagent.status).toBe(200);
    expect(await subagent.text()).toContain("alternate subagent body");

    for (const path of [
      `/sessions/${f.id}/entries/alternate-ordinary-result/tool-result/call-alternate-subagent`,
      `/sessions/${f.id}/entries/alternate-subagent-result/tool-result/call-alternate-ordinary`,
    ]) {
      expect((await f.app.request(path)).status).toBe(404);
    }
  },
);

it("only serves deferred subagent content for its session and matching entry and call", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  for (const path of [
    `/sessions/${f.id}/entries/rich-ordinary-result/tool-result/call-rich-subagent`,
    `/sessions/${f.id}/entries/rich-subagent-result/tool-result/unknown-call`,
    "/sessions/missing/entries/rich-subagent-result/tool-result/call-rich-subagent",
  ]) {
    expect((await f.app.request(path)).status).toBe(404);
  }
});

it("fetches a running tool automatically when it completes while open", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const { document, requests } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  const card = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-rich-unfinished"),
  );
  openDetails(card);
  expect(card.textContent).not.toContain("unfinished tool completed");

  f.completeRichUnfinished();
  f.emit("activity");

  await expect
    .poll(() => card.textContent)
    .toContain("unfinished tool completed");
  expect(toolRequests(requests, "call-rich-unfinished")).toHaveLength(1);
  expect(document.querySelector("#tool-call-rich-unfinished")).toBe(card);
  expect(card.open).toBe(true);
});

it("updates running subagent progress and fetches its result when it completes open", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const completed = f.snapshot.branch;
  const branch = completed.filter(
    (entry) => entry.id !== "rich-subagent-result",
  );
  f.update({
    branch,
    entries: branch,
    status: {
      ...f.snapshot.status,
      tools: [
        {
          id: "call-rich-subagent",
          name: "subagent",
          progress: "reading files",
        },
      ],
    },
  });
  const { document, requests } = await open(f, undefined, (request) => {
    if (
      new URL(request.url).pathname.endsWith("/tool-result/call-rich-subagent")
    ) {
      // Arrive after the completion frame was captured, before its automatic
      // body request. Only the next live frame may consume this batch.
      f.injectPending("automatic-body notice", "automatic-body text");
    }
    return f.app.request(request);
  });
  await expect.poll(() => f.subscribers).toBe(1);
  const card = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-rich-subagent"),
  );
  expect(card.open).toBe(false);
  expect(card.querySelector("summary")?.textContent).toContain("reading files");
  expect(document.body.textContent?.split("reading files")).toHaveLength(2);
  expect(document.querySelector(".chat-activity")).toBeNull();
  openDetails(card);
  f.update(
    {
      status: {
        ...f.snapshot.status,
        tools: [
          {
            id: "call-rich-subagent",
            name: "subagent",
            progress: "checking results",
          },
        ],
      },
    },
    "activity",
  );
  await expect.poll(() => card.textContent).toContain("checking results");
  expect(document.body.textContent?.split("checking results")).toHaveLength(2);
  expect(document.body.textContent).not.toContain("reading files");
  expect(document.querySelector(".chat-activity")).toBeNull();
  expect(card.open).toBe(true);
  expect(toolRequests(requests, "call-rich-subagent")).toHaveLength(0);
  f.update(
    {
      branch: completed,
      entries: completed,
      status: { ...f.snapshot.status, tools: [] },
    },
    "activity",
  );
  await expect.poll(() => card.textContent).toContain("subagent-run-output:");
  expect(card.open).toBe(true);
  expect(card.querySelector(".subagent-progress")).toBeNull();
  expect(card.querySelector(".subagent-counts")?.textContent).toBe(
    "1 completed · 1 failed",
  );
  expect(card.querySelector(".subagent-error")?.textContent).toContain(
    "representative failure",
  );
  expect(toolRequests(requests, "call-rich-subagent")).toHaveLength(1);
  expect(f.snapshot.status.editorText).toEqual(["automatic-body text"]);
  expect(f.snapshot.status.notices).toContainEqual({
    level: "info",
    message: "automatic-body notice",
  });
  f.emit("activity");
  await expect
    .poll(() => document.body.textContent)
    .toContain("automatic-body notice");
  await expect
    .poll(
      () =>
        document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
    )
    .toContain("automatic-body text");
});

it("keeps an expanded nested subagent body, scroll and selection across live frames", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const { document, window } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  const card = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-rich-subagent"),
  );
  openDetails(card);
  await expect
    .poll(() => card.querySelectorAll(".subagent-agent").length)
    .toBe(2);
  const body = required(card.querySelector<HTMLElement>(".tool-result"));
  const nested = required(
    body.querySelector<HTMLDetailsElement>(".subagent-agent"),
  );
  nested.open = true;
  body.scrollTop = 137;
  const selected = required(
    [...body.querySelectorAll(".subagent-plain")].find((node) =>
      node.textContent?.includes("subagent-raw-prompt:"),
    ),
  );
  const range = document.createRange();
  range.selectNodeContents(selected);
  const selection = required(window.getSelection());
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();

  const partial = required(f.snapshot.partial);
  f.update(
    {
      partial: {
        ...partial,
        content: [
          { type: "thinking", thinking: "new partial thinking" },
          { type: "text", text: "new partial answer" },
        ],
      },
    },
    "activity",
  );

  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("new partial answer");
  expect(document.querySelector("#tool-call-rich-subagent")).toBe(card);
  expect(card.querySelector(".tool-result")).toBe(body);
  expect(nested.open).toBe(true);
  expect(body.scrollTop).toBe(137);
  expect(selection.toString()).toBe(selectedText);
  expect(selectedText).toContain("subagent-raw-prompt:");
  expect(document.querySelector("#turn")?.textContent).toContain(
    "new partial thinking",
  );
});

it("does not duplicate an in-flight deferred request during a live morph", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const release = Promise.withResolvers<undefined>();
  let started = false;
  const { document, requests } = await open(f, undefined, async (request) => {
    if (
      new URL(request.url).pathname.endsWith("/tool-result/call-rich-ordinary")
    ) {
      started = true;
      await release.promise;
    }
    return f.app.request(request);
  });
  const card = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
  );
  openDetails(card);
  await expect.poll(() => started).toBe(true);
  const partial = required(f.snapshot.partial);
  f.update(
    {
      partial: {
        ...partial,
        content: [{ type: "text", text: "update while fetching" }],
      },
    },
    "activity",
  );
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("update while fetching");
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(1);
  release.resolve(undefined);
  await expect.poll(() => card.textContent).toContain("ordinary-output-body:");
});

it("retries a failed deferred request when the card is reopened", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  let attempts = 0;
  const { document, requests } = await open(f, undefined, (request) => {
    if (
      new URL(request.url).pathname.endsWith(
        "/tool-result/call-rich-ordinary",
      ) &&
      ++attempts === 1
    ) {
      return new Response("temporary failure", { status: 503 });
    }
    return f.app.request(request);
  });
  const card = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
  );
  const failed = requestFinished(
    document,
    required(card.querySelector(".tool-result")?.getAttribute("hx-get")),
  );
  openDetails(card);
  await failed;
  expect(attempts).toBe(1);
  toggleDetails(card);
  toggleDetails(card);
  await expect.poll(() => card.textContent).toContain("ordinary-output-body:");
  expect(attempts).toBe(2);
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(2);
});

it("keeps completed tools lazy through SSE reconnect and fetches on later open", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const transport = disconnectable((request) => f.app.request(request));
  const { document, requests } = await open(f, undefined, transport.request);
  await expect.poll(() => transport.connections.length).toBe(1);
  const reconnect = reconnected(required(document.querySelector("main")));
  required(transport.connections[0]).disconnect();
  await reconnect;
  expect(transport.connections).toHaveLength(2);
  expect(document.body.textContent).not.toContain("ordinary-output-body:");
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(0);

  openDetails(
    required(
      document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
    ),
  );
  await expect
    .poll(() => document.body.textContent)
    .toContain("ordinary-output-body:");
  expect(toolRequests(requests, "call-rich-ordinary")).toHaveLength(1);
});

it("keeps actual SSE frame bytes independent of large completed tool bodies", async () => {
  const small = await streamingFixture();
  small.richRunningTools(1);
  const large = await streamingFixture();
  large.richRunningTools(80_000);

  const sizes = {
    small: await liveFrameBytes(small),
    large: await liveFrameBytes(large),
  };
  expect(sizes.large).toEqual(sizes.small);
  expect(sizes.large.initial).toBeLessThan(20_000);
  expect(sizes.large.update).toBeLessThan(20_000);
});

it("keeps an opened completed tool and fetched full output while another message streams", async () => {
  const f = await streamingFixture();
  f.runningTools();
  const { document, firstFrame } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  await firstFrame;
  const card = required(
    document.querySelector<HTMLDetailsElement>('[data-tool="read"]'),
  );
  openDetails(card);
  await expect
    .poll(() => card.querySelector('button[hx-get*="full=1"]'))
    .not.toBeNull();
  required(
    card.querySelector<HTMLButtonElement>('button[hx-get*="full=1"]'),
  ).click();
  await expect
    .poll(() => card.querySelector('button[hx-get*="full=1"]'))
    .toBeNull();
  const body = required(card.querySelector(".tool-result"));
  const output = required(body.querySelector("div > pre"));
  output.scrollTop = 120;
  const changing = required(
    document.querySelector<HTMLDetailsElement>("#tool-call-changing"),
  );
  changing.open = true;
  expect(body.textContent?.length).toBeGreaterThan(30_000);
  const partial = required(f.snapshot.partial);
  f.update(
    {
      partial: {
        ...partial,
        content: [{ type: "text", text: "updated streaming text" }],
      },
    },
    "activity",
  );
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("updated streaming text");
  expect(document.querySelector('[data-tool="read"]')).toBe(card);
  expect(card.open).toBe(true);
  expect(card.querySelector(".tool-result")).toBe(body);
  expect(output.scrollTop).toBe(120);
  const branch = [
    ...f.snapshot.branch,
    {
      type: "message" as const,
      id: "changing-result",
      parentId: "tool-result",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult" as const,
        toolCallId: "call-changing",
        toolName: "read",
        content: [{ type: "text" as const, text: "truthful changed result" }],
        isError: true,
        timestamp: Date.now(),
      },
    },
  ];
  f.update({ branch, entries: branch }, "activity");
  await expect
    .poll(() => changing.textContent)
    .toContain("truthful changed result");
  expect(changing.open).toBe(true);
  expect(document.querySelector("#tool-call-changing")).toBe(changing);
  expect(card.querySelector(".tool-result")).toBe(body);
  f.update(
    {
      turnStart: branch.length,
      partial: undefined,
      status: { ...f.snapshot.status, running: false, tools: [] },
    },
    "turn_done",
  );
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toBe("");
  expect(document.querySelectorAll("#tool-call-complete")).toHaveLength(1);
  expect(document.querySelectorAll("#tool-call-changing")).toHaveLength(1);
});
