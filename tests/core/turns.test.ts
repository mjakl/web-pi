import type { TranscriptItem } from "@core/transcript";
import {
  activityLabel,
  groupTurns,
  toolFilePath,
  isEditToolName,
  isWriteToolName,
  pageItems,
  timestampedEntries,
} from "@core/turns";
import { describe, expect, it } from "vitest";

function user(id: string): TranscriptItem {
  return {
    kind: "user",
    entryId: id,
    text: `ask ${id}`,
    images: [],
    timestamp: "2026-09-10T00:00:00.000Z",
  };
}

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

function assistant(
  id: string,
  blocks: unknown[],
  usage?: Usage,
): TranscriptItem {
  return {
    kind: "assistant",
    entryId: id,
    model: "fake-1",
    provider: "fake",
    blocks: blocks as never,
    stopReason: "stop",
    timestamp: "2026-09-10T00:00:00.000Z",
    ...(usage === undefined ? {} : { usage }),
  };
}

const tool = (id: string) => ({
  kind: "tool" as const,
  call: { id, name: "read", arguments: {}, preview: "x" },
});
const text = (value: string) => ({ kind: "text" as const, text: value });
const thinking = {
  kind: "thinking" as const,
  index: 0,
  text: "hm",
  deferred: false,
};

/** A tool call with a result, the shape the written-files rule reads. */
function writeCall(id: string, name: string, args: unknown, isError = false) {
  return {
    kind: "tool" as const,
    call: {
      id,
      name,
      arguments: args,
      preview: "x",
      result: { entryId: `r${id}`, text: "ok", isError, images: [] },
    },
  };
}

describe("written files", () => {
  it("accepts the decorated names an MCP server exposes", () => {
    expect(
      ["write", "write_file", "fs.write", "mcp_write"].every(isWriteToolName),
    ).toBe(true);
    expect(
      ["edit", "str_replace_editor", "fs.edit", "replace_editor"].every(
        isEditToolName,
      ),
    ).toBe(true);
    expect(isWriteToolName("read")).toBe(false);
    expect(isEditToolName("grep")).toBe(false);
  });

  it("lists the files a turn wrote, once each, in first-seen order", () => {
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [
        writeCall("c1", "write", { file_path: "/repo/a.ts" }),
        writeCall("c2", "edit", { path: "/repo/b.ts" }),
        writeCall("c3", "edit", { file_path: "/repo/a.ts" }),
      ]),
      assistant("a2", [text("done")]),
    ]);
    expect(turn?.written).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("ignores failed writes, calls with no result, and other tools", () => {
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [
        writeCall("c1", "write", { file_path: "/repo/failed.ts" }, true),
        {
          kind: "tool" as const,
          call: {
            id: "c2",
            name: "edit",
            arguments: { file_path: "/repo/pending.ts" },
            preview: "x",
          },
        },
        writeCall("c3", "read", { file_path: "/repo/read.ts" }),
        writeCall("c4", "write", { contents: "no path" }),
      ]),
      assistant("a2", [text("done")]),
    ]);
    expect(turn?.written).toEqual([]);
  });

  it("resolves a path a tool reported relative to the folder it ran in", () => {
    const items = [
      user("u1"),
      assistant("a1", [
        writeCall("c1", "write", { file_path: "src/a.ts" }),
        writeCall("c2", "edit", { file_path: "/abs/b.ts" }),
      ]),
      assistant("a2", [text("done")]),
    ];
    const [turn] = groupTurns(items, "/repo");
    expect(turn?.written).toEqual(["/repo/src/a.ts", "/abs/b.ts"]);
  });

  it("follows Pi's path rules: one leading @ goes, a home path is no chip", () => {
    const [turn] = groupTurns(
      [
        user("u1"),
        assistant("a1", [
          writeCall("c1", "write", { file_path: "@src/a.ts" }),
          writeCall("c2", "edit", { path: "~/notes.md" }),
          writeCall("c3", "write", { path: "@~/notes.md" }),
        ]),
        assistant("a2", [text("done")]),
      ],
      "/repo",
    );
    expect(turn?.written).toEqual(["/repo/src/a.ts"]);
  });
});

describe("toolFilePath", () => {
  it("links a read, write, or edit path and nothing else", () => {
    const call = (name: string, args: unknown) => ({ name, arguments: args });
    expect(toolFilePath(call("read", { path: "src/a.ts" }), "/repo")).toBe(
      "/repo/src/a.ts",
    );
    expect(toolFilePath(call("edit", { file_path: "/abs/b.ts" }))).toBe(
      "/abs/b.ts",
    );
    expect(
      toolFilePath(call("grep", { path: "src" }), "/repo"),
    ).toBeUndefined();
    expect(
      toolFilePath(call("read", { path: "src/*.ts" }), "/repo"),
    ).toBeUndefined();
  });

  it("strips one leading @ as Pi does, and refuses a home path", () => {
    const call = (path: string) => ({ name: "read", arguments: { path } });
    expect(toolFilePath(call("@src/a.ts"), "/repo")).toBe("/repo/src/a.ts");
    expect(toolFilePath(call("@@src/a.ts"), "/repo")).toBe("/repo/@src/a.ts");
    expect(toolFilePath(call("~/notes.md"), "/repo")).toBeUndefined();
    expect(toolFilePath(call("@~/notes.md"), "/repo")).toBeUndefined();
    expect(toolFilePath(call("@"), "/repo")).toBeUndefined();
  });
});

describe("groupTurns", () => {
  it("splits a turn into process details and the final answer", () => {
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [thinking, tool("c1")]),
      assistant("a2", [tool("c2"), text("here it is")]),
    ]);
    expect(turn?.boundary?.entryId).toBe("u1");
    expect(turn?.processMessages).toBe(2);
    expect(turn?.processToolCalls).toBe(2);
    expect(turn?.answer?.blocks).toEqual([text("here it is")]);
    // The answer message keeps its tool call in the process half.
    expect(turn?.process.at(-1)).toMatchObject({
      entryId: "a2",
      blocks: [tool("c2")],
    });
    expect(turn?.expanded).toBe(false);
  });

  it("leaves the turn's usage on the answer alone", () => {
    const usage = {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      total: 15,
    };
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [thinking, text("here it is")], usage),
    ]);
    const half = turn?.process.at(-1);
    expect(half).toMatchObject({ entryId: "a1", processHalf: true });
    expect(half?.kind === "assistant" && half.usage).toBeUndefined();
    expect(turn?.answer?.usage).toEqual(usage);
    expect(turn?.answer?.processHalf).toBeUndefined();
  });

  it("draws a page that opens mid-turn message by message", () => {
    // No question on the page: pi-web has no group to fold these into, so
    // they stay visible and the last answer keeps its star.
    const [turn] = groupTurns([
      assistant("a1", [thinking, tool("c1")]),
      assistant("a2", [text("here it is")]),
      assistant("a3", [tool("c3")]),
    ]);
    expect(turn?.boundary).toBeUndefined();
    expect(turn?.process).toEqual([]);
    expect(turn?.answer).toBeUndefined();
    expect(turn?.trailing.map((item) => item.entryId)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
    expect(turn?.loneAnswerId).toBe("a2");
    expect(turn?.processMessages).toBe(0);
  });

  it.each<TranscriptItem>([
    user("u1"),
    {
      kind: "compaction",
      entryId: "c1",
      summary: "Earlier context",
      readFiles: [],
      modifiedFiles: [],
      tokensBefore: 10,
      timestamp: "",
    },
    {
      kind: "branch_summary",
      entryId: "b1",
      summary: "Earlier branch",
      timestamp: "",
    },
  ])("preserves a mid-turn prefix before a $kind boundary", (boundary) => {
    const prefix = [
      assistant("a1", [thinking, tool("c1")]),
      assistant("a2", [text("Earlier answer")]),
    ];
    const answer = assistant("a3", [text("Later answer")]);
    const turns = groupTurns([...prefix, boundary, answer]);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      trailing: prefix,
      process: [],
      expanded: true,
      loneAnswerId: "a2",
    });
    expect(turns[0]?.boundary).toBeUndefined();
    expect(turns[1]).toMatchObject({ boundary, answer });
  });

  it("opens the disclosure when prose is hidden inside it", () => {
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [text("a thought along the way"), tool("c1")]),
      assistant("a2", [text("final")]),
    ]);
    expect(turn?.expanded).toBe(true);
  });

  it("opens the disclosure when the turn has no answer at all", () => {
    const [turn] = groupTurns([user("u1"), assistant("a1", [tool("c1")])]);
    expect(turn?.answer).toBeUndefined();
    expect(turn?.expanded).toBe(true);
  });

  it("starts a new turn at every user message and compaction", () => {
    const turns = groupTurns([
      user("u1"),
      assistant("a1", [text("one")]),
      {
        kind: "compaction",
        entryId: "c1",
        summary: "s",
        readFiles: [],
        modifiedFiles: [],
        tokensBefore: 10,
        timestamp: "",
      },
      user("u2"),
      assistant("a2", [text("two")]),
    ]);
    expect(turns.map((turn) => turn.boundary?.entryId)).toEqual([
      "u1",
      "c1",
      "u2",
    ]);
  });

  it("drops blocks a settled message would render blank", () => {
    const [turn] = groupTurns([
      user("u1"),
      assistant("a1", [
        text("  "),
        { kind: "thinking", index: 0, text: "", deferred: false },
        { kind: "thinking", index: 1, text: " \n\t", deferred: false },
        text("kept"),
      ]),
    ]);
    expect(turn?.answer?.blocks).toEqual([text("kept")]);
    expect(turn?.process).toEqual([]);
  });
});

describe("timestampedEntries", () => {
  it("marks the answer before each question and the last one", () => {
    const marked = timestampedEntries([
      user("u1"),
      assistant("a1", [text("one")]),
      assistant("a2", [text("two")]),
      user("u2"),
      assistant("a3", [text("three")]),
    ]);
    expect([...marked]).toEqual(["a2", "a3"]);
  });
});

describe("pageItems", () => {
  const items = [
    user("u1"),
    assistant("a1", [text("one")]),
    user("u2"),
    assistant("a2", [text("two")]),
    user("u3"),
    assistant("a3", [text("three")]),
  ];

  it("takes the plain tail, mid-turn or not", () => {
    const page = pageItems(items, { tail: 3 });
    expect(page.items.map((item) => item.entryId)).toEqual(["a2", "u3", "a3"]);
    expect(page.hasMore).toBe(true);
    expect(page.oldestId).toBe("a2");
  });

  it("counts the tail in entries when the branch is given", () => {
    // a1 stands for two entries, its call and the result, so five entries
    // back is four cards where counting cards would have shown five.
    const page = pageItems(items, {
      tail: 5,
      entryIds: ["u1", "a1", "a1r", "u2", "a2", "u3", "a3"],
    });
    expect(page.items.map((item) => item.entryId)).toEqual([
      "u2",
      "a2",
      "u3",
      "a3",
    ]);
    expect(page.hasMore).toBe(true);
  });

  it("never widens a tail past its size on a session with one long turn", () => {
    const long = [
      user("u1"),
      ...Array.from({ length: 40 }, (_, i) =>
        assistant(`a${String(i)}`, [text(String(i))]),
      ),
    ];
    const page = pageItems(long, { tail: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.hasMore).toBe(true);
  });

  it("pages backwards from an entry already on screen", () => {
    const page = pageItems(items, { tail: 2, before: "u2" });
    expect(page.items.map((item) => item.entryId)).toEqual(["u1", "a1"]);
    expect(page.hasMore).toBe(false);
  });

  it("widens the page until the requested entry is on it", () => {
    const page = pageItems(items, { tail: 1, through: "a1" });
    expect(page.items[0]?.entryId).toBe("a1");
  });

  it("reconciles after an invisible raw entry without applying the backwards tail limit", () => {
    const entryIds = ["u1", "a1", "result1", "u2", "a2", "u3", "a3"];
    expect(
      pageItems(items, { after: "result1", entryIds, tail: 1 }).items.map(
        (item) => item.entryId,
      ),
    ).toEqual(["u2", "a2", "u3", "a3"]);
    expect(pageItems(items, { after: "a3", entryIds }).items).toEqual([]);
    expect(pageItems(items, { after: "", entryIds }).items).toEqual(items);
  });

  it("refuses an entry that is not on this branch", () => {
    expect(() => pageItems(items, { before: "nope" })).toThrow(RangeError);
  });

  it("marks a missing settled cursor as a bounded replacement, including an empty branch", () => {
    expect(pageItems(items, { after: "gone", tail: 2 })).toEqual({
      items: items.slice(-2),
      hasMore: true,
      oldestId: "u3",
      reset: true,
    });
    expect(pageItems([], { after: "gone" })).toEqual({
      items: [],
      hasMore: false,
      oldestId: undefined,
      reset: true,
    });
    expect(pageItems(items, { after: "a3" }).reset).toBe(false);
  });
});

describe("activityLabel", () => {
  it("names the running tools, and the shell by itself", () => {
    expect(activityLabel({ bashRunning: true, tools: [] })).toBe(
      "Running command...",
    );
    expect(activityLabel({ bashRunning: false, tools: [] })).toBeNull();
    expect(
      activityLabel({
        bashRunning: false,
        tools: [{ id: "t1", name: "bash", progress: "line 3" }],
      }),
    ).toBe("Running bash... line 3");
    expect(
      activityLabel({
        bashRunning: false,
        tools: [
          { id: "a", name: "a" },
          { id: "b", name: "b" },
          { id: "c", name: "c" },
        ],
      }),
    ).toBe("Running a, b, c...");
    expect(
      activityLabel({
        bashRunning: false,
        tools: [
          { id: "a", name: "a" },
          { id: "b", name: "b" },
          { id: "c", name: "c" },
          { id: "d", name: "d" },
        ],
      }),
    ).toBe("Running a, b (+2)...");
  });
});
