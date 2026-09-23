import type {
  AssistantItem,
  ToolCallView,
  TranscriptItem,
} from "@core/transcript";

export const answerItem: AssistantItem = {
  kind: "assistant",
  entryId: "a2",
  model: "fake-model",
  provider: "fake",
  blocks: [
    { kind: "text", text: "Done. See `app.ts`.\n\n```ts\nconst x = 1;\n```" },
  ],
  stopReason: "stop",
  usage: {
    input: 1200,
    output: 34,
    cacheRead: 500,
    cacheWrite: 0,
    total: 1734,
  },
  timestamp: "2026-01-05T13:09:00.000Z",
};

const editCall: ToolCallView = {
  id: "call-edit",
  name: "edit",
  arguments: { file_path: "src/app.ts", old_string: "1", new_string: "2" },
  preview: "src/app.ts",
  result: {
    entryId: "r2",
    text: "ok",
    isError: false,
    images: [],
    patch:
      "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-export const app = 1;\n+export const app = 2;\n context\n" +
      "--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1 +1 @@\n-a\n+b\n",
    seconds: 1,
  },
};

const longDiffCall: ToolCallView = {
  ...editCall,
  id: "call-long",
  result: {
    entryId: "r4",
    text: "ok",
    isError: false,
    images: [],
    // The first file overruns the 200-row budget; the second must be omitted.
    patch: [
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -0,0 +1,210 @@",
      ...Array.from(
        { length: 210 },
        (_, index) => `+new line ${String(index + 1)}`,
      ),
      "--- a/src/tail.ts",
      "+++ b/src/tail.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n"),
  },
};

const longTextCall: ToolCallView = {
  id: "call-cat",
  name: "bash",
  arguments: { command: "cat big.log" },
  preview: "cat big.log",
  result: {
    entryId: "r7",
    text: "x".repeat(17 * 1024),
    isError: false,
    images: [],
  },
};

export const fixtureCalls = { longTextCall, longDiffCall, editCall };

/** Non-assistant entries must not acquire assistant history controls. */
export const settledItems: TranscriptItem[] = [
  {
    kind: "user",
    entryId: "u1",
    text: "Fix the <b>bug</b> in `app.ts`",
    images: [0, 1],
    timestamp: "2026-01-05T13:07:00.000Z",
  },
  {
    kind: "compaction",
    entryId: "c1",
    summary: "## Summary\n\nEverything before this.",
    readFiles: ["src/app.ts", "README.md"],
    modifiedFiles: ["src/app.ts"],
    tokensBefore: 84_000,
    tokensAfter: 12_000,
    timestamp: "2026-01-05T13:10:00.000Z",
  },
  {
    kind: "branch_summary",
    entryId: "b1",
    summary: "Tried another approach and *came back*.",
    timestamp: "2026-01-05T13:11:00.000Z",
  },
  {
    kind: "note",
    entryId: "n1",
    customType: "my-ext",
    text: "Extension says **hi**",
    preview: "Extension says hi",
    images: [0],
    details: "raw <details> payload",
    timestamp: "2026-01-05T13:12:00.000Z",
  },
  {
    kind: "bash",
    entryId: "sh1",
    command: "ls -la",
    output: "total 0\n",
    exitCode: 0,
    cancelled: false,
    truncated: true,
    outputPath: "/tmp/pi-bash-1.log",
    excluded: false,
    pending: false,
    timestamp: "2026-01-05T13:13:00.000Z",
  },
];
