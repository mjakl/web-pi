import { DELEGATION_TYPE, delegationFold } from "@core/session-delegation";
import { isSubagentSession, type SessionSummary } from "@core/sessions";
import { describe, expect, it } from "vitest";

const origin = {
  version: 1,
  childSessionId: "child",
  parentSessionId: "parent",
  agent: "coder-senior",
  handle: "topic",
};

function entry(data: unknown) {
  return { type: "custom", customType: DELEGATION_TYPE, data };
}

function classify(records: unknown[], id = "child") {
  const fold = delegationFold(id);
  for (const record of records) fold.add(record);
  return fold.finish();
}

describe("persisted delegation ownership", () => {
  it("accepts matching origin records, including identical repeats", () => {
    expect(classify([entry(origin), entry(origin)])).toEqual({
      inspectionOnly: true,
      delegation: {
        parentSessionId: "parent",
        agent: "coder-senior",
        handle: "topic",
      },
    });
  });

  it("ignores copied origins without masking a seeded child's own origin", () => {
    const copied = entry({ ...origin, childSessionId: "ancestor" });
    expect(classify([copied])).toEqual({});
    expect(classify([copied, entry(origin)])).toEqual(
      classify([entry(origin)]),
    );
  });

  it.each([
    { version: 2 },
    { version: undefined },
    { parentSessionId: "child" },
    { parentSessionId: "" },
    { parentSessionId: "../parent" },
    { agent: "" },
    { agent: " coder-senior" },
    { handle: "topic " },
    { handle: 1 },
  ])(
    "keeps an own-ID malformed origin readonly without an edge: %j",
    (change) => {
      const invalid = entry({ ...origin, ...change });
      expect(classify([invalid])).toEqual({ inspectionOnly: true });
      expect(classify([entry(origin), invalid])).toEqual({
        inspectionOnly: true,
      });
      expect(classify([invalid, entry(origin)])).toEqual({
        inspectionOnly: true,
      });
    },
  );

  it.each([
    { parentSessionId: "different" },
    { agent: "reviewer" },
    { handle: "different-topic" },
  ])("refuses conflicting origin claims: %j", (change) => {
    expect(classify([entry(origin), entry({ ...origin, ...change })])).toEqual({
      inspectionOnly: true,
    });
  });

  it("does not infer ownership from unidentifiable or unrelated records", () => {
    expect(
      classify([
        null,
        "not an entry",
        entry(null),
        entry({ ...origin, childSessionId: undefined }),
        entry({ ...origin, childSessionId: "other", version: 7 }),
        { ...entry(origin), type: "custom_message" },
        { ...entry(origin), customType: "web-pi:subagent" },
      ]),
    ).toEqual({});
  });

  it("leaves missing-parent and cycle resolution to tree policy", () => {
    expect(classify([entry(origin)]).delegation?.parentSessionId).toBe(
      "parent",
    );
    expect(
      classify(
        [
          entry({
            ...origin,
            childSessionId: "parent",
            parentSessionId: "child",
          }),
        ],
        "parent",
      ).delegation?.parentSessionId,
    ).toBe("child");
  });

  it("recognizes legacy IDs as inspection-only without inferred ancestry", () => {
    expect(classify([], "subagent.abc123")).toEqual({ inspectionOnly: true });
    const summary: SessionSummary = {
      id: "ordinary",
      cwd: "/repo",
      createdAt: "",
      modifiedAt: "",
      fileSize: 0,
    };
    expect(isSubagentSession(summary)).toBe(false);
    expect(isSubagentSession({ ...summary, inspectionOnly: true })).toBe(true);
    expect(isSubagentSession({ ...summary, id: "subagent.abc123" })).toBe(true);
  });
});
