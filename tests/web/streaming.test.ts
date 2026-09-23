import type {
  HTMLButtonElement,
  HTMLDetailsElement,
  HTMLElement,
  HTMLTextAreaElement,
} from "happy-dom";
import { afterEach, expect, it } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";
import { streamingFixture } from "#/web/fixtures/streaming";
import { disconnectable } from "#/web/fixtures/disconnect";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture element");
  return value;
}
function toggleDetails(card: HTMLDetailsElement) {
  card.open = !card.open;
  const view = required(card.ownerDocument.defaultView);
  card.dispatchEvent(new view.Event("toggle"));
}
function openDetails(card: HTMLDetailsElement) {
  if (!card.open) toggleDetails(card);
}
function toolRequests(requests: Request[], callId: string) {
  return requests.filter((request) =>
    new URL(request.url).pathname.endsWith(`/tool-result/${callId}`),
  );
}
async function liveFrameBytes(f: Awaited<ReturnType<typeof streamingFixture>>) {
  const response = await f.app.request(`/sessions/${f.id}/events?after=`);
  const reader = required(response.body?.getReader());
  const decoder = new TextDecoder();
  let received = "";
  const nextTurn = async () => {
    for (;;) {
      while (!received.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before the live frame");
        received += decoder.decode(chunk.value, { stream: true });
      }
      const end = received.indexOf("\n\n") + 2;
      const frame = received.slice(0, end);
      received = received.slice(end);
      if (!frame.includes('hx-target="#turn"')) continue;
      expect(frame).not.toContain("ordinary-output-body:");
      expect(frame).not.toContain("subagent-run-output:");
      expect(frame).not.toContain("subagent-raw-prompt:");
      expect(frame).toContain("still-running");
      expect(frame).toContain("partial thinking");
      return new TextEncoder().encode(frame).byteLength;
    }
  };
  try {
    const initial = await nextTurn();
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
    return { initial, update: await nextTurn() };
  } finally {
    await reader.cancel();
  }
}
async function open(
  f: Awaited<ReturnType<typeof streamingFixture>>,
  markup?: string,
  transport = (request: Request) => f.app.request(request),
) {
  const browser = await htmxBrowser(
    markup ?? (await (await f.app.request(`/sessions/${f.id}`)).text()),
    (request) =>
      new URL(request.url).pathname === "/events"
        ? new Response("")
        : transport(request),
  );
  browsers.push(browser);
  return browser;
}

it.each(["decoration", "models"] as const)(
  "captures pending events before awaited %s and delivers later events in the next live view",
  async (phase) => {
    const f = await streamingFixture();
    const { document } = await open(f);
    await expect.poll(() => f.subscribers).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let block = true;
    const pause = async () => {
      if (block) {
        block = false;
        entered.resolve(undefined);
        await release.promise;
      }
    };
    if (phase === "decoration") {
      const resolve = f.world.projects.resolve.bind(f.world.projects);
      f.world.projects.resolve = async (cwd) => {
        await pause();
        return resolve(cwd);
      };
    } else {
      const list = f.world.models.list.bind(f.world.models);
      f.world.models.list = async (cwd) => {
        await pause();
        return list(cwd);
      };
    }

    f.resetSnapshotReads();
    f.injectPending("first pending notice", "first pending text");
    f.emit("activity");
    await entered.promise;
    f.injectPending("second pending notice", "second pending text");
    release.resolve(undefined);

    await expect
      .poll(() => document.body.textContent)
      .toContain("first pending notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("first pending text");
    expect(document.body.textContent).not.toContain("second pending notice");
    expect(
      document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
    ).not.toContain("second pending text");
    expect(f.snapshotReads).toBe(1);

    f.resetSnapshotReads();
    f.emit("activity");
    await expect
      .poll(() => document.body.textContent)
      .toContain("second pending notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("second pending text");
    expect(
      document.body.textContent?.match(/first pending notice/g),
    ).toHaveLength(1);
    expect(f.snapshotReads).toBe(1);
  },
);

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

it("does not consume pending events while rendering an alternate live branch", async () => {
  const f = await streamingFixture();
  const alternate = f.alternateCompletedTools();
  f.injectPending("pending branch notice", "pending branch text");

  const response = await f.app.request(
    `/sessions/${f.id}?leaf=${alternate.leaf}`,
  );
  expect(response.status).toBe(200);
  expect(f.snapshot.status.notices).toContainEqual({
    level: "info",
    message: "pending branch notice",
  });
  expect(f.snapshot.status.editorText).toEqual(["pending branch text"]);
});

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

it.each(["refresh", "switch", "page"])(
  "preserves pending output through a %s request until the next SSE delivery",
  async (action) => {
    const f = await streamingFixture();
    const { document } = await open(f);
    await expect.poll(() => f.subscribers).toBe(1);
    f.injectPending("selector-safe notice", "selector-safe text");

    const model = required(f.snapshot.status.model);
    const response =
      action === "page"
        ? await f.app.request(`/sessions/${f.id}`)
        : action === "refresh"
          ? await f.app.request(`/sessions/${f.id}/model-selector`)
          : await f.app.request(
              `/sessions/${f.id}/model?model=${encodeURIComponent(`${model.provider}/${model.id}`)}`,
              { method: "POST" },
            );
    expect(response.status).toBe(200);
    const selector = await response.text();
    expect(selector).toContain('id="model-selector"');
    expect(selector).not.toContain("selector-safe notice");
    expect(selector).not.toContain("selector-safe text");
    expect(f.snapshot.status.notices).toContainEqual({
      level: "info",
      message: "selector-safe notice",
    });
    expect(f.snapshot.status.editorText).toEqual(["selector-safe text"]);

    f.emit("activity");
    await expect
      .poll(() => document.body.textContent)
      .toContain("selector-safe notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("selector-safe text");
    expect(f.snapshot.status.notices).toEqual([]);
    expect(f.snapshot.status.editorText).toEqual([]);
  },
);

it("leaves pending events for the live view after a deferred body request", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.injectPending("body-safe notice", "body-safe text");

  openDetails(
    required(
      document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
    ),
  );
  await expect
    .poll(() => document.body.textContent)
    .toContain("ordinary-output-body:");
  expect(f.snapshot.status.notices).toContainEqual({
    level: "info",
    message: "body-safe notice",
  });
  expect(f.snapshot.status.editorText).toEqual(["body-safe text"]);

  f.emit("activity");
  await expect
    .poll(() => document.body.textContent)
    .toContain("body-safe notice");
  await expect
    .poll(
      () =>
        document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
    )
    .toContain("body-safe text");
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
  openDetails(card);
  expect(card.textContent).toContain("reading files");
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
  openDetails(card);
  await expect.poll(() => attempts).toBe(1);
  await expect.poll(() => card.querySelector(".htmx-request")).toBeNull();
  toggleDetails(card);
  await new Promise((resolve) => setTimeout(resolve, 10));
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
  required(transport.connections[0]).disconnect();
  await expect.poll(() => transport.connections.length).toBe(2);
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

it("recovers a canonical answer settled between page render and initial subscription", async () => {
  const f = await streamingFixture();
  f.runningTools();
  const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
  f.finish("missed canonical answer", false);
  const { document } = await open(f, markup);
  await expect
    .poll(() => document.querySelector("#messages")?.textContent)
    .toContain("missed canonical answer");
  await expect
    .poll(() => document.querySelector("#status [data-running]"))
    .toBeNull();
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelector("#turn")?.textContent).toBe("");
});

it("keeps an opened completed tool and fetched full output while another message streams", async () => {
  const f = await streamingFixture();
  f.runningTools();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
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

it.each([0, 1, 3, 30])(
  "reconciles %i missed turns without replaying delivered history or pulling a paginated reader down",
  async (missed) => {
    const f = await streamingFixture();
    for (let i = 0; i < 40; i += 1)
      f.finish(`older answer ${String(i)}`, false);
    const transport = disconnectable((request) => f.app.request(request));
    const { document, window } = await open(f, undefined, transport.request);
    await expect.poll(() => transport.connections.length).toBe(1);
    const sentinel = required(document.querySelector(".load-earlier"));
    const url = required(sentinel.getAttribute("hx-get"));
    await window.eval(
      `htmx.ajax('GET', ${JSON.stringify(url)}, {target:'.load-earlier', swap:'outerHTML'})`,
    );
    const oldest = required(document.querySelector("#entry-u1"));
    const log = required(document.querySelector("#log"));
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 10_000 },
      clientHeight: { configurable: true, value: 500 },
    });
    log.scrollTop = 9500;
    log.dispatchEvent(new window.Event("scroll"));
    log.scrollTop = 500;
    log.dispatchEvent(new window.Event("scroll"));
    let done = 0;
    document.body.addEventListener("done", () => {
      done += 1;
    });
    f.finish("already delivered");
    await expect
      .poll(() => document.querySelector("#entry-a41")?.textContent)
      .toContain("already delivered");
    required(transport.connections[0]).disconnect();
    for (let i = 0; i < missed; i += 1)
      f.finish(`missed answer ${String(i)}`, false);
    // Also cover reconnection to an active newer turn, not only an empty idle tail.
    if (missed > 1) f.runningTools();
    await expect.poll(() => transport.connections.length).toBe(2);
    await expect
      .poll(() => document.querySelector(`#entry-a${String(41 + missed)}`))
      .not.toBeNull();
    expect(
      required(transport.connections[1]).request.headers.get("Last-Event-ID"),
    ).toBe("settled=a41");
    expect(document.querySelectorAll("#entry-a41")).toHaveLength(1);
    for (let i = 0; i < missed; i += 1)
      expect(
        document.querySelectorAll(`#entry-a${String(42 + i)}`),
      ).toHaveLength(1);
    expect(document.querySelector("#entry-u1")).toBe(oldest);
    expect(document.querySelector(".load-earlier")).toBeNull();
    expect(log.scrollTop).toBe(500);
    await expect
      .poll(() => document.querySelector("#status [data-running]") !== null)
      .toBe(missed > 1);
    expect(done).toBe(0);
  },
);

it("reconciles each live-end boundary from the current snapshot, including a newer active turn", async () => {
  const f = await streamingFixture();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.finish("first finished");
  f.finish("second finished");
  f.runningTools();
  f.emit("activity");
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent)
    .toContain("second finished");
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
  expect(document.querySelector("#turn")?.textContent).toContain(
    "streaming text",
  );
  await expect
    .poll(() => document.querySelector("#status [data-running]"))
    .not.toBeNull();
});

it("recovers settlement during the native initial 500ms subscription retry gap", async () => {
  const f = await streamingFixture();
  f.runningTools();
  let attempts = 0;
  const { document } = await open(f, undefined, (request) => {
    if (new URL(request.url).pathname.endsWith("/events") && ++attempts === 1) {
      f.finish("finished during retry", false);
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    return f.app.request(request);
  });
  await expect
    .poll(() => document.querySelector("#entry-a1")?.textContent)
    .toContain("finished during retry");
  expect(attempts).toBe(2);
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
});

it.each(["disconnect", "body replacement"])(
  "prevents a delayed old response from overwriting new activity after %s",
  async (action) => {
    const f = await streamingFixture();
    const transport = disconnectable((request) => f.app.request(request));
    const { document, window } = await open(f, undefined, transport.request);
    await expect.poll(() => f.subscribers).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const original = f.workspace.viewSession;
    const blocked = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let delay = true;
    f.workspace.viewSession = async (...args) => {
      const view = await original(...args);
      if (delay) {
        delay = false;
        blocked.resolve(undefined);
        await release.promise;
      }
      return view;
    };
    f.finish("delayed old answer");
    await blocked.promise;
    if (action === "disconnect")
      required(transport.connections[0]).disconnect();
    else
      await window.eval(
        "htmx.swap({target:document.body,sourceElement:document.body,text:'',swap:'innerHTML'})",
      );
    f.finish("new canonical answer", false);
    f.runningTools();
    if (action === "body replacement") {
      const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
      const body = required(/<body[^>]*>([\s\S]*)<\/body>/.exec(markup)?.[1]);
      await window.eval(
        `htmx.swap({target:document.body,sourceElement:document.body,text:${JSON.stringify(body)},swap:'innerHTML'})`,
      );
    }
    await expect.poll(() => transport.connections.length).toBe(2);
    await expect
      .poll(() => document.querySelector("#entry-a2")?.textContent)
      .toContain("new canonical answer");
    release.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
    expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
    expect(document.querySelector("#turn")?.textContent).toContain(
      "streaming text",
    );
    expect(document.querySelector("#status [data-running]")).not.toBeNull();
    expect(f.subscribers).toBe(1);
  },
);

it("recovers a new runtime after a no-owner connection returns to saved observation", async () => {
  const f = await streamingFixture();
  f.finish("stored answer", false);
  f.world.store.set(f.id, {
    summary: f.snapshot.summary,
    entries: [...f.snapshot.entries],
  });
  const get = f.world.runtime.get.bind(f.world.runtime);
  let attached = false;
  f.world.runtime.get = (id) => (attached ? get(id) : undefined);
  const { document } = await open(f);
  expect(f.subscribers).toBe(0);
  f.finish("finished before runtime subscription", false);
  attached = true;
  // The no-owner stream now closes; the next two-second saved check hands off.
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent, {
      timeout: 4000,
    })
    .toContain("finished before runtime subscription");
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
  expect(f.subscribers).toBe(1);
});

it("reconciles persisted entries at runtime removal before closing the stream", async () => {
  const f = await streamingFixture();
  f.finish("already rendered", false);
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.finish("persisted just before stop", false);
  f.world.store.set(f.id, {
    summary: f.snapshot.summary,
    entries: [...f.snapshot.entries],
  });
  f.world.runtime.get = () => undefined;
  f.emit("stopped");
  await expect
    .poll(() => document.querySelector("#entry-a2")?.textContent)
    .toContain("persisted just before stop");
  await expect.poll(() => f.subscribers).toBe(0);
  expect(document.querySelectorAll("#entry-a1")).toHaveLength(1);
  expect(document.querySelectorAll("#entry-a2")).toHaveLength(1);
});

it("dispatches completion only after canonical messages, live tail and status have settled", async () => {
  const f = await streamingFixture();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  const completed: unknown[] = [];
  document.body.addEventListener("done", () => {
    completed.push({
      answer: document.querySelectorAll("#entry-a1").length,
      tail: document.querySelector("#turn")?.textContent,
      running: document.querySelector("#status [data-running]") !== null,
    });
  });
  f.finish("completed answer");
  f.emit("completed");
  await expect
    .poll(() => completed)
    .toEqual([{ answer: 1, tail: "", running: false }]);
});
