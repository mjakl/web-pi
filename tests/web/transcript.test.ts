// The transcript's routes and rendering: messages and turns, paging, entry
// sub-resources, stars, branching, the rail, and the export.

import {
  assistantEntry,
  type ScriptedStep,
  userEntry,
} from "@adapters/fake/index";
import { describe, expect, it, vi } from "vitest";
import { testApp } from "#/web/fixtures/test-app";
import { parseHtml, required } from "#/web/helpers";

/** The URL behind a collapsed tool card, as htmx would follow it. */
function deferredUrl(page: string): string {
  const url = /hx-get="([^"]*tool-result[^"]*)"/.exec(page)?.[1] ?? "";
  expect(url).not.toBe("");
  return url.replaceAll("&amp;", "&");
}

it("renders a stored session with escaped user text and markdown answers", async () => {
  const { app } = testApp();
  const html = await (await app.request("/sessions/s1")).text();
  expect(html).toContain("first &lt;b&gt;question&lt;/b&gt;");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).not.toContain("<script>x</script>");
  expect(html).toContain('id="composer"');
});

it("stars an answer, updates the row out of band, and clears again", async () => {
  const { app } = testApp();
  const form = new FormData();
  form.set("entryId", "a1");
  form.set("starred", "true");
  const starred = await (
    await app.request("/sessions/s1/star", { method: "POST", body: form })
  ).text();
  expect(starred).toContain('aria-pressed="true"');
  expect(starred).toContain('hx-swap-oob="true"');
  expect(starred).toContain("1 starred answers");

  const cleared = await (
    await app.request("/sessions/s1/stars/clear", { method: "POST" })
  ).text();
  expect(cleared).not.toContain("1 starred answers");
  const page = await (await app.request("/sessions/s1")).text();
  expect(page).toContain('aria-label="Star answer"');
});

it("answers a star with its button and row, not a rebuilt session view", async () => {
  const { app, workspace } = testApp();
  const view = vi.spyOn(workspace, "viewSession");
  const form = new FormData();
  form.set("entryId", "a1");
  form.set("starred", "true");
  const html = await (
    await app.request("/sessions/s1/star", { method: "POST", body: form })
  ).text();
  const document = parseHtml(html);
  const button = document.querySelector(".answer-star-toggle");
  expect(button?.getAttribute("aria-pressed")).toBe("true");
  expect(JSON.parse(button?.getAttribute("hx-vals") ?? "{}")).toEqual({
    entryId: "a1",
    starred: false,
  });
  expect(document.querySelector("#row-s1")).not.toBeNull();
  expect(view).not.toHaveBeenCalled();
});

it("forks a message into a new session with the text as its draft", async () => {
  const { app, world } = testApp();
  const form = new FormData();
  form.set("entryId", "a1");
  const res = await app.request("/sessions/s1/fork", {
    method: "POST",
    body: form,
    headers: { "HX-Request": "true" },
  });
  const id = res.headers.get("hx-push-url")?.split("/").pop() ?? "";
  expect(world.store.has(id)).toBe(true);
  expect(world.store.get(id)?.entries).toHaveLength(2);
});

it.each([
  { action: "fork", text: "" },
  { action: "fork", text: "  Explain\n\t<b>this</b>  " },
  { action: "rewind", text: "" },
  { action: "rewind", text: "  Explain\n\t<b>this</b>  " },
])(
  "restores images into the $action response with draft '$text' only once",
  async ({ action, text }) => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("missing session");
    const prompt = userEntry("u2", "a1", "");
    if (prompt.type !== "message") throw new Error("missing message");
    prompt.message = {
      role: "user",
      timestamp: 3,
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        { type: "image", data: "AAEC/w==", mimeType: "image/png" },
        { type: "image", data: "//79AA==", mimeType: "image/jpeg" },
      ],
    };
    stored.entries.push(prompt, assistantEntry("a2", "u2", "later", 4));
    stored.leafId = "a2";
    const original = structuredClone(stored.entries);
    const form = new FormData();
    form.set("entryId", "u2");
    const res = await app.request(`/sessions/s1/${action}`, {
      method: "POST",
      body: form,
      headers: { "HX-Request": "true" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `${text.replace("<b>", "&lt;b&gt;").replace("</b>", "&lt;/b&gt;")}</textarea>`,
    );
    expect(html).toContain(
      '<div id="recalled-images" hidden=""><span data-image="AAEC/w==" data-mime="image/png"></span><span data-image="//79AA==" data-mime="image/jpeg"></span></div>',
    );
    expect(html.match(/id="recalled-images"/g)).toHaveLength(1);
    const destination = res.headers.get("hx-push-url") ?? "";
    if (action === "fork") expect(stored.entries).toEqual(original);
    // A rewind keeps the history before the message and ends it with
    // Pi's marker leaf.
    else
      expect(
        stored.entries.map((entry) =>
          entry.type === "custom" ? entry.customType : entry.id,
        ),
      ).toEqual(["u1", "a1", "web-pi-rewind"]);
    const reloaded = await (await app.request(destination)).text();
    expect(reloaded).not.toContain("data-image=");
  },
);

it("switches branch read-only and offers to continue from it", async () => {
  const { app, world } = testApp();
  const stored = world.store.get("s1");
  if (!stored) throw new Error("missing session");
  stored.entries.push(userEntry("u2", "u1", "other branch"));
  stored.leafId = "a1";

  const other = await (await app.request("/sessions/s1?leaf=u2")).text();
  expect(other).toContain("other branch");
  expect(other).toContain("read only");
  expect(other).not.toContain('id="composer"');
  // pi-web has no branch menu in the header: branches are rail marks.
  expect(other).toContain('data-branched="true"');
  const continueFrom = (html: string) =>
    parseHtml(html)
      .querySelector(".branch-sync-notice button")
      ?.getAttribute("hx-vals");
  expect(continueFrom(other)).toBe(JSON.stringify({ entryId: "u2" }));
  // An entry with later replies is a place to continue from too.
  const earlier = await (await app.request("/sessions/s1?leaf=u1")).text();
  expect(continueFrom(earlier)).toBe(JSON.stringify({ entryId: "u1" }));

  const form = new FormData();
  form.set("entryId", "u2");
  const switched = await app.request("/sessions/s1/navigate", {
    method: "POST",
    body: form,
  });
  expect(switched.headers.get("hx-push-url")).toBe("/sessions/s1");
  // The user message came back as the composer draft.
  expect(await switched.text()).toContain("other branch</textarea>");
});

it("reports a failed action as a toast", async () => {
  const { app } = testApp();
  const form = new FormData();
  form.set("entryId", "u1");
  const res = await app.request("/sessions/s1/star", {
    method: "POST",
    body: form,
  });
  expect(res.headers.get("hx-trigger")).toContain("assistant answer");
  expect(res.headers.get("hx-trigger")).toContain("web-pi:toast");
});

it("serves the exported transcript with safe response headers", async () => {
  const { app } = testApp();
  const exported = await app.request("/sessions/s1/export");
  expect(exported.headers.get("content-disposition")).toBe(
    'inline; filename="pi-session-s1.html"',
  );
  expect(exported.headers.get("x-frame-options")).toBe("DENY");
});

it("renders a persisted compaction summary without a duplicate success notice", async () => {
  const { app, world } = testApp();
  const stored = world.store.get("s1");
  if (!stored) throw new Error("no session");
  stored.entries.push({
    type: "compaction",
    id: "c1",
    parentId: "a1",
    timestamp: "2026-09-02T00:00:00.000Z",
    summary: "Preserved compaction summary",
    tokensBefore: 40_000,
    firstKeptEntryId: "u1",
  });
  const page = await (await app.request("/sessions/s1")).text();
  expect(page).toContain("Conversation compacted: 40k");
  expect(page).toContain("Preserved compaction summary");
  expect(page).not.toContain("tokens (32k saved)");
});

it("renders a mark per prompt, star, and branch, with previews", async () => {
  const { app, world } = testApp();
  const stored = world.store.get("s1");
  if (!stored) throw new Error("no session");
  // A second branch off the first question.
  stored.entries.push(userEntry("u2", "u1", "another approach"));
  stored.entries.push(assistantEntry("a2", "u2", "other answer", 41_000));
  stored.leafId = "a1";

  const page = await (await app.request("/sessions/s1")).text();
  expect(page).toContain('id="rail"');
  expect(page).toContain('data-branched="true"');
  expect(page).toContain('data-preview="first &lt;b&gt;question&lt;/b&gt;"');
  // The mark on the other branch navigates instead of scrolling.
  expect(page).toContain('data-branch="true"');
  expect(page).toContain('hx-post="/sessions/s1/navigate"');
  expect(page).toContain("minimap-graph");
});

it("re-sends the rail out of band when a turn settles", async () => {
  const { app } = testApp({ reply: () => "done" });
  const form = new FormData();
  form.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body: form });
  const res = await app.request("/sessions/s1/events");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  let received = "";
  const decoder = new TextDecoder();
  while (!received.includes("event: settled")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value);
  }
  await reader.cancel();
  expect(received).toContain('id="rail" class="minimap-layer"');
  expect(received).toContain('hx-swap-oob="true"');
});

it("chips the files a turn wrote and offers them as mentions", async () => {
  const { app, world } = testApp({
    script: () => [
      {
        tool: "edit",
        arguments: { file_path: "/repo/one/src/answer.ts" },
        result: "edited",
      },
      { text: "changed it" },
    ],
  });
  const form = new FormData();
  form.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body: form });
  await vi.waitFor(() => {
    expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
  });
  const page = await (await app.request("/sessions/s1")).text();
  expect(page).toContain('aria-label="Files changed"');
  // The chip opens the file panel rather than typing a mention.
  expect(page).toContain('data-file-path="/repo/one/src/answer.ts"');
  expect(page).toContain('title="/repo/one/src/answer.ts"');
});

it("keeps a huge tool result off the page and cuts it when opened", async () => {
  const output = "x".repeat(40_000);
  const { app, world } = testApp({
    script: () => [
      { tool: "grep", arguments: { pattern: "x" }, result: output },
      { text: "found them" },
    ],
  });
  const baseline = await (await app.request("/sessions/s1")).text();
  const form = new FormData();
  form.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body: form });
  await vi.waitFor(() => {
    expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
  });
  const page = await (await app.request("/sessions/s1")).text();
  expect(page).not.toContain("xxxxx");
  // Compare the turn's added markup, not the unrelated shell overhead.
  expect(page.length - baseline.length).toBeLessThan(output.length);

  const url = deferredUrl(page);
  const opened = await (await app.request(url)).text();
  expect(opened).toContain("view full output");
  expect(opened.length).toBeLessThan(output.length);
  const full = await (await app.request(`${url}?full=1`)).text();
  expect(full).toContain(output);
  expect(full).not.toContain("view full output");
});

it("cuts a diff that is longer than the budget", async () => {
  const hunk = Array.from(
    { length: 300 },
    (_, index) => `-old ${String(index)}\n+new ${String(index)}`,
  ).join("\n");
  const patch = `--- a/x.ts\n+++ b/x.ts\n@@ -1,600 +1,600 @@\n${hunk}\n`;
  const { app, world } = testApp({
    script: () => [
      {
        tool: "edit",
        arguments: { file_path: "/repo/one/x.ts" },
        details: { patch },
        result: "edited",
      },
      { text: "done" },
    ],
  });
  const form = new FormData();
  form.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body: form });
  await vi.waitFor(() => {
    expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
  });
  const url = deferredUrl(await (await app.request("/sessions/s1")).text());
  const opened = await (await app.request(url)).text();
  expect(opened).toContain("view full output");
  expect(opened).not.toContain("new 299");
  const full = await (await app.request(`${url}?full=1`)).text();
  expect(full).toContain("new 299");
});

it("keeps the history row while a turn runs, with branching disabled", async () => {
  // pi-web leaves the row rendered and disables only what the turn owns:
  // New branch waits, Rewind goes away, New session stays
  // (ChatWindow.tsx `branchDisabledReason` and `onRewind`).
  const { app, world } = testApp({ delayMs: 1000 });
  const live = await world.runtime.open({ sessionId: "s1" });
  await live.prompt("go");
  const running = await (await app.request("/sessions/s1")).text();
  expect(running).toMatch(/aria-label="New branch"[^>]*disabled/);
  expect(running).toContain(
    "Wait for the current operation to finish before branching",
  );
  expect(running).toContain("New session");
  expect(running).not.toContain('class="message-rewind"');
  await live.abort();
  const settled = await (await app.request("/sessions/s1")).text();
  expect(settled).not.toMatch(/aria-label="New branch"[^>]*disabled/);
  expect(settled).toContain('class="message-rewind"');
});

it("lists what a subagent run was given, and its progress while it runs", async () => {
  vi.useFakeTimers();
  try {
    const { app } = testApp({
      delayMs: 40,
      script: (): ScriptedStep[] => [
        {
          tool: "subagent",
          arguments: {
            calls: [
              { agent: "explorer", prompt: "look around", model: "fake-1" },
            ],
          },
          progress: ["reading src/"],
          details: {
            kind: "pi-subagent",
            results: [
              {
                agent: "explorer",
                exitCode: 0,
                model: "fake-1",
                messages: [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "ok" }],
                  },
                ],
              },
            ],
          },
        },
        { text: "done" },
      ],
    });
    const form = new FormData();
    form.set("text", "explore");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });

    // The progress window is only 80–120ms; wall-clock rendering can miss it.
    await vi.advanceTimersByTimeAsync(100);
    const running = await (await app.request("/sessions/s1")).text();
    expect(running).toContain("reading src/");

    await vi.advanceTimersByTimeAsync(150);
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).not.toContain("<dt>Agent</dt>");
    expect(page).toContain("explorer");
    const body = await (await app.request(deferredUrl(page))).text();
    expect(body).toContain("<dl");
    expect(body).toContain("<dt>Agent</dt>");
    expect(body).toContain("look around");
    expect(body).toContain("fake-1");
  } finally {
    vi.useRealTimers();
  }
});

it("shows the post-compaction estimate on the card", async () => {
  const { app, world } = testApp();
  world.store.set("k1", {
    summary: {
      id: "k1",
      cwd: "/repo/one",
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-01T00:00:00.000Z",
      fileSize: 2,
    },
    entries: [
      userEntry("u1", null, "question"),
      {
        type: "compaction",
        id: "c1",
        parentId: "u1",
        timestamp: "2026-09-01T00:00:00.000Z",
        summary: "what happened",
        tokensBefore: 40_000,
        firstKeptEntryId: "u1",
      } as never,
    ],
  });
  const page = await (await app.request("/sessions/k1")).text();
  expect(page).toContain("40k → ~");
});

/** A session long enough to page, with one thinking block per answer. */
function longApp(answers = 60) {
  const entries = [];
  let parent: string | null = null;
  for (let index = 0; index < answers; index += 1) {
    const userId = `u${String(index)}`;
    const answerId = `a${String(index)}`;
    entries.push(userEntry(userId, parent, `question ${String(index)}`));
    const answer = assistantEntry(
      answerId,
      userId,
      `answer ${String(index)}`,
      100,
    );
    if (answer.type === "message" && answer.message.role === "assistant") {
      answer.message.content = [
        { type: "thinking", thinking: "z".repeat(2000) },
        ...answer.message.content,
      ];
    }
    entries.push(answer);
    parent = answerId;
  }
  return testApp({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo/one",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 10,
        },
        entries,
      },
    ],
  });
}

describe("transcript rendering", () => {
  it("keeps an extension card's copy button and details toggle on one row", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("no session");
    stored.entries.push({
      type: "custom_message",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-09-02T00:00:00.000Z",
      customType: "pi-processes:update",
      content: "process finished",
      display: true,
      details: { exitCode: 0 },
    } as never);

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('class="transcript-details note-details"');
    expect(page).toContain(
      '<span class="note-details-closed">Show details</span>',
    );
    expect(page).toContain(
      '<span class="note-details-open">Hide details</span>',
    );
    expect(page).toContain('data-copy="true" title="Copy message"');
  });

  it("keeps the turn's usage, time and anchor on the answer alone", async () => {
    // One assistant message that reasons and then answers: pi-web splits it
    // around the answer and the process half carries none of the footer.
    const reasoned = assistantEntry("a1", "u1", "the answer", 40_000);
    if (reasoned.type === "message" && reasoned.message.role === "assistant") {
      reasoned.message.content = [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "the answer" },
      ] as never;
    }
    const { app } = testApp({
      sessions: [
        {
          summary: {
            id: "s1",
            cwd: "/repo/one",
            name: "Stored one",
            createdAt: "2026-09-01T00:00:00.000Z",
            modifiedAt: "2026-09-02T00:00:00.000Z",
            fileSize: 10,
          },
          entries: [userEntry("u1", null, "ask"), reasoned],
        },
      ],
    });
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("39,990 in · 10 out");
    expect(page.split("39,990 in · 10 out")).toHaveLength(2);
    // Both halves render, but only the answer answers to the rail.
    expect(page.split('data-role="assistant"')).toHaveLength(3);
    expect(page.split('id="entry-a1"')).toHaveLength(2);
  });

  it("renders a notice as pi-web's shelf card", async () => {
    const { app, world } = testApp();
    await world.runtime.open({ sessionId: "s1" });
    const body = new FormData();
    body.set("cwd", "/repo/one");
    await app.request("/settings/plugins/reload", { method: "POST", body });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes('hx-target="#toasts"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain('hx-target="#toasts"');
    expect(received).toContain("Resources reloaded.");
  });

  it("groups a turn into process details and the answer", async () => {
    const { app, world } = testApp({
      script: (): ScriptedStep[] => [
        { thinking: "checking the file" },
        { tool: "read", arguments: { path: "/repo/one/a.ts" }, result: "ok" },
        { text: "all done" },
      ],
    });
    const form = new FormData();
    form.set("text", "look");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await vi.waitFor(() => {
      expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
    });

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Process details · 1 message · 1 tool call");
    expect(page).toContain("checking the file");
    expect(page).toContain("/repo/one/a.ts");
    expect(page).toContain("all done");
  });

  it("serves a reported patch when its card opens", async () => {
    const { app, world } = testApp({
      script: (): ScriptedStep[] => [
        {
          tool: "edit",
          arguments: { file_path: "/repo/one/a.ts" },
          details: {
            patch:
              "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
          },
        },
        { text: "changed it" },
      ],
    });
    const form = new FormData();
    form.set("text", "edit it");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await vi.waitFor(() => {
      expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
    });

    // A settled card ships a placeholder; the diff arrives when it opens.
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).not.toContain("const a = 1;");
    const body = await (await app.request(deferredUrl(page))).text();
    expect(body).toContain("const a = 1;");
    expect(body).toContain("const a = 2;");
    // Edit tools show the diff instead of repeating their arguments.
    expect(body).not.toContain("&quot;file_path&quot;");
  });

  it("names the running tool while a turn works", async () => {
    // Hold the scripted tool in its progress phase, independent of CI load.
    vi.useFakeTimers();
    try {
      const { app } = testApp({
        delayMs: 40,
        script: (): ScriptedStep[] => [
          {
            tool: "bash",
            arguments: { command: "ls" },
            progress: ["scanning"],
          },
          { text: "done" },
        ],
      });
      const form = new FormData();
      form.set("text", "run it");
      await app.request("/sessions/s1/prompt", { method: "POST", body: form });
      await vi.advanceTimersByTimeAsync(100);
      expect(await (await app.request("/sessions/s1")).text()).toContain(
        "Running bash... scanning",
      );
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a starred answer when the default page opens mid-turn before a later prompt", async () => {
    const { app, world } = testApp();
    await world.sessions.setStar("s1", "a1", true);
    const stored = world.store.get("s1");
    if (!stored) throw new Error("missing session");
    let parent = stored.entries.at(-1)?.id ?? "a1";
    stored.entries.push(userEntry("u2", parent, "Later question"));
    parent = "u2";
    // Including the star entry, the last 50 entries start at a1, not u1.
    for (let index = 0; index < 47; index++) {
      const id = `later-${String(index)}`;
      stored.entries.push(
        assistantEntry(id, parent, `Later answer ${String(index)}`, 4),
      );
      parent = id;
    }
    stored.leafId = parent;

    const response = await app.request("/sessions/s1");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).not.toContain('id="entry-u1"');
    expect(page).toContain("before=a1");
    expect(page).toContain('id="entry-a1"');
    const answer = page.slice(
      page.indexOf('id="entry-a1"'),
      page.indexOf('id="entry-u2"'),
    );
    expect(answer).toContain("<strong>bold</strong>");
    expect(answer).toContain('aria-label="Unstar answer"');
    expect(answer).toContain('aria-pressed="true"');
    expect(page).toContain('id="entry-later-46"');
  });

  it("pages a long transcript and prepends the page before it", async () => {
    const { app } = longApp();
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Scroll up to load earlier messages");
    expect(page).toContain("question 59");
    // The rail carries a preview of every prompt, so only the transcript
    // itself is checked for the messages the page left out.
    expect(page).toContain(">question 59<");
    expect(page).not.toContain(">question 10<");

    const before = /before=([^&"]+)/.exec(page)?.[1] ?? "";
    expect(before).not.toBe("");
    const earlier = await (
      await app.request(`/sessions/s1/earlier?before=${before}`)
    ).text();
    expect(earlier).toContain("question 34");
    expect(earlier).toContain('hx-get="/sessions/s1/earlier?before=');

    const bad = await app.request("/sessions/s1/earlier?before=nope");
    expect(bad.status).toBe(400);
  });

  it("fetches a thinking block the page was too long to carry", async () => {
    const { app } = longApp();
    const page = await (await app.request("/sessions/s1")).text();
    const url = /\/sessions\/s1\/entries\/[^/]+\/thinking\/0/.exec(page)?.[0];
    expect(url).toBeDefined();
    const block = await (await app.request(url ?? "")).text();
    expect(block).toContain("zzz");
    const missing = await app.request("/sessions/s1/entries/nope/thinking/0");
    expect(await missing.text()).toContain("unavailable");
  });

  it("resolves a fetched thinking block's links and images in the session folder", async () => {
    const { app, world } = testApp();
    const reasoning = assistantEntry("a2", "a1", "answer", 100);
    if (
      reasoning.type === "message" &&
      reasoning.message.role === "assistant"
    ) {
      reasoning.message.content = [
        {
          type: "thinking",
          thinking: "See [the file](src/a.ts) and ![shot](shot.png)",
        },
        { type: "text", text: "answer" },
      ];
    }
    required(world.store.get("s1")).entries.push(reasoning);
    const document = parseHtml(
      await (await app.request("/sessions/s1/entries/a2/thinking/0")).text(),
    );
    expect(
      document.querySelector(".markdown-body.markdown-assistant-message"),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-file-path="/repo/one/src/a.ts"]')?.tagName,
    ).toBe("BUTTON");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/files/raw?path=%2Frepo%2Fone%2Fshot.png&session=s1",
    );
  });

  it("serves an image an old pi-web session stored in Anthropic's shape", async () => {
    const { app, world } = testApp();
    const question = userEntry("q1", null, "look at this");
    if (question.type === "message" && question.message.role === "user") {
      question.message.content = [
        { type: "text", text: "look at this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAEC/w==" },
        },
      ] as never;
    }
    world.store.set("s2", {
      summary: {
        id: "s2",
        cwd: "/repo/one",
        createdAt: "2026-09-01T00:00:00.000Z",
        modifiedAt: "2026-09-02T00:00:00.000Z",
        fileSize: 2,
      },
      entries: [question],
    });
    const page = await (await app.request("/sessions/s2")).text();
    expect(page).toContain(
      'data-image-preview="/sessions/s2/entries/q1/image/0"',
    );
    const image = await app.request("/sessions/s2/entries/q1/image/0");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(
      Buffer.from("AAEC/w==", "base64"),
    );
  });
});
