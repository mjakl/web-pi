import { assistantEntry, bashEntry, userEntry } from "@adapters/fake/index";
import { conversationRail } from "@core/conversation-rail";
import {
  assistantItem,
  deferThinking,
  estimateTokens,
  projectTranscript,
  streamedText,
  toolPreview,
  toolProgress,
  transcriptTitle,
} from "@core/transcript";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

function assistantWith(
  id: string,
  parentId: string | null,
  content: unknown[],
  timestamp = 0,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-10T00:00:00.000Z",
    message: {
      role: "assistant",
      content: content as never,
      api: "openai-responses",
      provider: "fake",
      model: "fake-1",
      usage: {
        input: 90,
        output: 10,
        cacheRead: 5,
        cacheWrite: 3,
        totalTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp,
    },
  };
}

function toolResult(
  id: string,
  parentId: string,
  options: {
    toolCallId?: string;
    text?: string;
    details?: JsonValue;
    isError?: boolean;
    timestamp?: number;
  } = {},
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-10T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: options.toolCallId ?? "call-1",
      toolName: "read",
      content: [{ type: "text", text: options.text ?? "file contents" }],
      ...(options.details === undefined ? {} : { details: options.details }),
      isError: options.isError ?? false,
      timestamp: options.timestamp ?? 0,
    },
  };
}

const readCall = {
  type: "toolCall",
  id: "call-1",
  name: "read",
  arguments: { path: "/repo/x.ts", extra: 1 },
};

describe("projectTranscript", () => {
  it("folds a tool result into the call that asked for it", () => {
    const transcript = projectTranscript([
      userEntry("u1", null, "read x"),
      assistantWith("a1", "u1", [
        { type: "thinking", thinking: "let me look" },
        readCall,
      ]),
      toolResult("t1", "a1", { timestamp: 4000 }),
      assistantEntry("a2", "t1", "done", 250),
    ]);
    expect(transcript.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    const first = transcript.items[1];
    if (first?.kind !== "assistant") throw new Error("expected an assistant");
    expect(first.blocks[0]).toMatchObject({
      kind: "thinking",
      text: "let me look",
      index: 0,
    });
    const call = first.blocks[1];
    if (call?.kind !== "tool") throw new Error("expected a tool call");
    expect(call.call.preview).toBe("/repo/x.ts");
    expect(call.call.result).toMatchObject({
      entryId: "t1",
      text: "file contents",
      isError: false,
      seconds: 4,
    });
    expect(first.usage).toMatchObject({ cacheRead: 5, cacheWrite: 3 });
    expect(transcript.lastContextTokens).toBe(250);
  });

  it("times reasoning from the last entry of any kind, hidden ones too", () => {
    const thinking = [{ type: "thinking", thinking: "hm" }];
    const note = (id: string, parentId: string, display: boolean) =>
      ({
        type: "custom_message",
        id,
        parentId,
        timestamp: "2026-09-10T00:05:00.000Z",
        customType: "note",
        content: "x",
        display,
      }) as SessionEntry;
    const transcript = projectTranscript([
      assistantWith("a0", null, [], Date.parse("2026-09-10T00:00:00.000Z")),
      note("n1", "a0", true),
      note("n2", "n1", false),
      assistantWith(
        "a1",
        "n2",
        thinking,
        Date.parse("2026-09-10T00:05:04.000Z"),
      ),
    ]);
    const item = transcript.items.at(-1);
    if (item?.kind !== "assistant") throw new Error("expected an assistant");
    // Four seconds since the last note, not the five minutes since "a0".
    expect(item.blocks[0]).toMatchObject({ kind: "thinking", seconds: 4 });
  });

  it("rounds a duration to the nearest second, as pi-web does", () => {
    // 5.6s must read "6s", not "5s": pi-web rounds both badges
    // (components/MessageView.tsx thinkingDurationFromFile, toolCallDurations).
    const transcript = projectTranscript([
      assistantWith("a1", null, [readCall], 0),
      toolResult("t1", "a1", { timestamp: 5600 }),
      assistantWith("a2", "t1", [{ type: "thinking", thinking: "hm" }], 11100),
    ]);
    const call = transcript.items[0];
    if (call?.kind !== "assistant") throw new Error("expected an assistant");
    const tool = call.blocks[0];
    expect(tool?.kind === "tool" && tool.call.result?.seconds).toBe(6);
    const reasoning = transcript.items[1];
    if (reasoning?.kind !== "assistant") throw new Error("expected assistant");
    expect(reasoning.blocks[0]).toMatchObject({ kind: "thinking", seconds: 6 });
  });

  it("drops a hidden custom message from the transcript", () => {
    const custom = (id: string, parentId: string, display: boolean) =>
      ({
        type: "custom_message",
        id,
        parentId,
        timestamp: "2026-09-10T00:00:00.000Z",
        customType: "context-prune-summary",
        content: "internal bookkeeping",
        display,
      }) as SessionEntry;
    const entries: SessionEntry[] = [
      userEntry("u1", null, "go"),
      custom("n1", "u1", false),
      custom("n2", "n1", true),
      assistantEntry("a1", "n2", "done", 100),
    ];
    const transcript = projectTranscript(entries);
    expect(transcript.items.map((item) => [item.kind, item.entryId])).toEqual([
      ["user", "u1"],
      ["note", "n2"],
      ["assistant", "a1"],
    ]);
    // The rail must not anchor on it either (pi-web's isMessageGroupAnchor).
    expect(conversationRail(entries, "a1", new Set()).map((m) => m.id)).toEqual(
      ["u1"],
    );
  });

  it("renders a reported patch as a diff instead of text", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";
    const transcript = projectTranscript([
      assistantWith("a1", null, [readCall]),
      toolResult("t1", "a1", { details: { patch } }),
    ]);
    const item = transcript.items[0];
    if (item?.kind !== "assistant") throw new Error("expected an assistant");
    const call = item.blocks[0];
    expect(call?.kind === "tool" && call.call.result?.patch).toBe(patch);
  });

  it("keeps an errored result as text, never as a diff", () => {
    const transcript = projectTranscript([
      assistantWith("a1", null, [readCall]),
      toolResult("t1", "a1", { details: { patch: "x" }, isError: true }),
    ]);
    const item = transcript.items[0];
    if (item?.kind !== "assistant") throw new Error("expected an assistant");
    const call = item.blocks[0];
    expect(call?.kind === "tool" && call.call.result?.patch).toBeUndefined();
    expect(call?.kind === "tool" && call.call.result?.isError).toBe(true);
  });

  it("pairs subagent runs with their calls and refuses a mismatch", () => {
    const calls = {
      type: "toolCall",
      id: "call-2",
      name: "subagent",
      arguments: {
        calls: [
          { agent: "explorer", prompt: "look around", model: "fake-1" },
          { agent: "writer", prompt: "write it up" },
        ],
      },
    };
    const details: JsonValue = {
      kind: "pi-subagent",
      results: [
        {
          agent: "explorer",
          exitCode: 0,
          model: "fake-1",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "found it" }],
            },
          ],
        },
        { agent: "writer", exitCode: 2, messages: [], stderr: "boom" },
      ],
    };
    const paired = projectTranscript([
      assistantWith("a1", null, [calls]),
      toolResult("t1", "a1", { toolCallId: "call-2", details }),
    ]);
    const item = paired.items[0];
    if (item?.kind !== "assistant") throw new Error("expected an assistant");
    const block = item.blocks[0];
    if (block?.kind !== "tool") throw new Error("expected a tool call");
    expect(block.call.subagent?.runs).toEqual([
      {
        status: "completed",
        output: "found it",
        model: "fake-1",
        captureTruncated: false,
        handledWithoutAgent: false,
      },
      {
        status: "failed",
        output: "",
        error: "boom",
        captureTruncated: false,
        handledWithoutAgent: false,
      },
    ]);

    const wrong = projectTranscript([
      assistantWith("a1", null, [calls]),
      toolResult("t1", "a1", {
        toolCallId: "call-2",
        details: { kind: "pi-subagent", results: [{ agent: "nope" }] },
      }),
    ]);
    const other = wrong.items[0];
    if (other?.kind !== "assistant") throw new Error("expected an assistant");
    const raw = other.blocks[0];
    expect(raw?.kind === "tool" && raw.call.subagent?.runs).toBeNull();
  });

  it("shows a skill expansion as the command that produced it", () => {
    const expansion = `<skill name="testing" location="/repo/.agents">\nReferences are relative to /repo/.agents.\n\nHow this repository tests things\n</skill>\n\nrun the unit tests`;
    const transcript = projectTranscript([userEntry("u1", null, expansion)]);
    const item = transcript.items[0];
    expect(item?.kind === "user" && item.command).toBe(
      "/skill:testing run the unit tests",
    );
    expect(transcriptTitle(transcript)).toBe(
      "/skill:testing run the unit tests",
    );
  });

  it("splits the file sections out of a compaction summary", () => {
    const transcript = projectTranscript([
      {
        type: "compaction",
        id: "c1",
        parentId: null,
        timestamp: "2026-09-10T00:00:00.000Z",
        summary:
          "We fixed the parser.\n\n<read-files>\n/repo/a.ts\n</read-files>\n<modified-files>\n/repo/b.ts\n</modified-files>",
        firstKeptEntryId: "u1",
        tokensBefore: 40_000,
      },
    ]);
    expect(transcript.items[0]).toMatchObject({
      kind: "compaction",
      summary: "We fixed the parser.",
      readFiles: ["/repo/a.ts"],
      modifiedFiles: ["/repo/b.ts"],
      tokensBefore: 40_000,
    });
  });

  it("skips hidden entries and keeps displayed custom messages", () => {
    const transcript = projectTranscript([
      userEntry("u1", null, "hi"),
      {
        type: "model_change",
        id: "m1",
        parentId: "u1",
        timestamp: "",
        provider: "p",
        modelId: "m",
      },
      {
        type: "custom_message",
        id: "c1",
        parentId: "m1",
        timestamp: "",
        customType: "note",
        content: "shown",
        display: true,
        details: { a: 1 },
      },
      {
        type: "custom_message",
        id: "c2",
        parentId: "c1",
        timestamp: "",
        customType: "note",
        content: "hidden",
        display: false,
      },
    ]);
    expect(transcript.items.map((item) => item.kind)).toEqual(["user", "note"]);
    const note = transcript.items[1];
    expect(note?.kind === "note" && note.details).toBe('{\n  "a": 1\n}');
    expect(transcriptTitle(transcript)).toBe("hi");
  });

  it("ignores usage of aborted messages for context accounting", () => {
    const aborted = assistantEntry("a1", null, "partial", 900);
    if (aborted.type === "message" && aborted.message.role === "assistant") {
      aborted.message.stopReason = "aborted";
    }
    const transcript = projectTranscript([
      assistantEntry("a0", null, "ok", 300),
      aborted,
    ]);
    expect(transcript.lastContextTokens).toBe(300);
  });

  it("defers the oldest reasoning once the page budget is spent", () => {
    const long = "x".repeat(15_000);
    const transcript = projectTranscript([
      assistantWith("empty", null, [{ type: "thinking", thinking: "" }]),
      assistantWith("blank", "empty", [
        { type: "thinking", thinking: " \n\t" },
      ]),
      assistantWith("a1", "blank", [{ type: "thinking", thinking: long }]),
      assistantWith("a2", "a1", [{ type: "thinking", thinking: long }]),
      assistantWith("a3", "a2", [{ type: "thinking", thinking: long }]),
    ]);
    deferThinking(transcript.items);
    const deferred = transcript.items.map((item) =>
      item.kind === "assistant" && item.blocks[0]?.kind === "thinking"
        ? item.blocks[0].deferred
        : null,
    );
    expect(deferred).toEqual([false, false, true, false, false]);
  });
});

describe("transcript content cursor", () => {
  const base = {
    id: "content",
    parentId: null,
    timestamp: "2026-09-10T00:00:00.000Z",
  };
  const examples: [string, SessionEntry, string | null][] = [
    ["user", userEntry("content", null, "Question"), "content"],
    ["assistant", assistantEntry("content", null, "Answer", 100), "content"],
    [
      "tool result",
      { ...toolResult("content", "call"), parentId: null },
      "content",
    ],
    ["bash", bashEntry("content", null, "pwd", "/repo", false), "content"],
    [
      "compaction",
      {
        ...base,
        type: "compaction",
        summary: "Summary",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
      },
      "content",
    ],
    [
      "branch summary",
      {
        ...base,
        type: "branch_summary",
        fromId: "before",
        summary: "Branch context",
      },
      "content",
    ],
    [
      "empty branch summary",
      { ...base, type: "branch_summary", fromId: "before", summary: "  " },
      null,
    ],
    [
      "displayed custom message",
      {
        ...base,
        type: "custom_message",
        customType: "note",
        content: "Visible",
        display: true,
      },
      "content",
    ],
    [
      "hidden custom message",
      {
        ...base,
        type: "custom_message",
        customType: "note",
        content: "Hidden",
        display: false,
      },
      null,
    ],
    [
      "model",
      { ...base, type: "model_change", provider: "fake", modelId: "fake-1" },
      null,
    ],
    [
      "thinking level",
      { ...base, type: "thinking_level_change", thinkingLevel: "high" },
      null,
    ],
    [
      "custom metadata",
      { ...base, type: "custom", customType: "metadata", data: {} },
      null,
    ],
  ];

  it.each(examples)(
    "tracks %s independently of a later metadata leaf",
    (_name, entry, expected) => {
      const transcript = projectTranscript([
        entry,
        {
          type: "session_info",
          id: "name",
          parentId: entry.id,
          timestamp: base.timestamp,
          name: "Later title",
        },
      ]);
      expect(transcript.contentLeaf).toBe(expected);
    },
  );

  it("has no content cursor for an empty transcript", () => {
    expect(projectTranscript([]).contentLeaf).toBeNull();
  });
});

describe("tool text helpers", () => {
  it("prefers the telling argument and caps the preview", () => {
    expect(toolPreview({ command: "ls  -la\n/tmp" })).toBe("ls -la /tmp");
    expect(toolPreview({ other: { a: 1 } })).toBe('{"a":1}');
    expect(toolPreview({ query: "y".repeat(200) })).toHaveLength(120);
  });

  it("reports the last non-blank line a running tool printed", () => {
    expect(
      toolProgress({ content: [{ type: "text", text: "one\n\n  two  \n" }] }),
    ).toBe("two");
    expect(toolProgress({ content: [] })).toBeUndefined();
    expect(toolProgress("nope")).toBeUndefined();
  });
});

describe("streaming tool arguments", () => {
  it("marks a call whose arguments are still arriving", () => {
    const item = assistantItem(
      "partial",
      {
        role: "assistant",
        content: [
          { type: "text", text: "one moment" },
          { type: "toolCall", id: "c1", name: "write", arguments: {} },
        ],
        api: "openai-responses",
        provider: "fake",
        model: "fake-1",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: 0,
      } as never,
      { partialArguments: { "1": '{"path":"/re' } },
    );
    const tool = item.blocks.find((block) => block.kind === "tool");
    expect(tool?.call.partialArguments).toBe('{"path":"/re');
  });

  it("estimates streamed tokens as pi-web does: a quarter, one per CJK", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("\u4f60\u597d")).toBe(2);
    expect(estimateTokens("\u4f60\u597dabcd")).toBe(3);
    // Text, reasoning and the arguments being generated all count.
    expect(
      streamedText([
        { type: "text", text: "hi" },
        { type: "thinking", thinking: "hm" },
        { type: "toolCall", rawInput: '{"a":' },
        { type: "image", data: "ignored" },
      ]),
    ).toBe('hihm{"a":');
  });
});
