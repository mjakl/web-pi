import { assistantEntry, userEntry } from "@adapters/fake/index";
import {
  editableUserMessage,
  lastAssistantText,
  readStars,
  rowMetadata,
  sessionStats,
  STAR_TYPE,
} from "@core/session-entries";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("last assistant text", () => {
  it("keeps every text block verbatim and ignores other roles and content", () => {
    const entry = assistantEntry("answer", null, "", 100);
    if (entry.type !== "message" || entry.message.role !== "assistant")
      throw new Error("Expected assistant");
    entry.message.content = [
      { type: "text", text: "  **first**\n\t" },
      { type: "thinking", thinking: "not text" },
      { type: "toolCall", id: "tool", name: "read", arguments: {} },
      { type: "text", text: "second  \n" },
    ];
    expect(
      lastAssistantText([entry, userEntry("user", "answer", "not the answer")]),
    ).toBe("  **first**\n\tsecond  \n");
  });

  it.each(["empty", "whitespace", "thinking", "tool", "empty aborted"])(
    "matches Pi's latest-message selection for %s",
    (kind) => {
      const older = assistantEntry("older", null, "old answer", 100);
      const latest = assistantEntry("latest", "older", "", 100);
      if (latest.type !== "message" || latest.message.role !== "assistant")
        throw new Error("Expected assistant");
      latest.message.content =
        kind === "thinking"
          ? [{ type: "thinking", thinking: "private" }]
          : kind === "tool"
            ? [{ type: "toolCall", id: "tool", name: "read", arguments: {} }]
            : kind === "whitespace"
              ? [{ type: "text", text: " \n\t " }]
              : [];
      if (kind === "empty aborted") latest.message.stopReason = "aborted";
      expect(lastAssistantText([older, latest])).toBe(
        kind === "empty aborted" ? "old answer" : undefined,
      );
    },
  );

  it("does not confuse no assistant with a user message", () => {
    expect(lastAssistantText([])).toBeUndefined();
    expect(
      lastAssistantText([userEntry("u", null, "question")]),
    ).toBeUndefined();
  });
});

describe("editable history messages", () => {
  it("preserves text whitespace and both stored image shapes in order", () => {
    const entry = userEntry("u1", null, "");
    if (entry.type !== "message") throw new Error("missing message");
    entry.message = {
      role: "user",
      timestamp: 1,
      content: [
        { type: "text", text: "  first\n\tline " },
        { type: "image", data: "AAEC/w==", mimeType: "image/png" },
        { type: "text", text: " second  " },
        {
          type: "image",
          source: {
            type: "base64",
            data: "//79AA==",
            media_type: "image/jpeg",
          },
        },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image.png" },
        },
        { type: "image", data: 42, mimeType: "image/png" },
      ] as never,
    };
    expect(editableUserMessage(entry)).toEqual({
      text: "  first\n\tline \n second  ",
      images: [
        { data: "AAEC/w==", mimeType: "image/png" },
        { data: "//79AA==", mimeType: "image/jpeg" },
      ],
    });
    expect(
      editableUserMessage(userEntry("plain", null, "  raw\n\ttext  ")),
    ).toEqual({
      text: "  raw\n\ttext  ",
      images: [],
    });
  });

  it.each(["assistant", "toolResult", "custom"])(
    "never recalls %s content",
    (role) => {
      const entry = {
        ...userEntry("not-user", null, ""),
        message: {
          role,
          content: [
            { type: "text", text: "secret" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      } as unknown as SessionEntry;
      expect(editableUserMessage(entry)).toBeUndefined();
    },
  );

  it("does not inspect data belonging to a non-message entry", () => {
    const entry = {
      type: "custom",
      data: {
        role: "user",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      },
    } as unknown as SessionEntry;
    expect(editableUserMessage(entry)).toBeUndefined();
  });
});

function star(
  id: string,
  parentId: string,
  targetId: string,
  starred: boolean,
): SessionEntry {
  return {
    type: "custom",
    customType: STAR_TYPE,
    data: { targetId, starred },
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function at(entry: SessionEntry, timestamp: string): SessionEntry {
  return { ...entry, timestamp };
}

describe("stars", () => {
  it("only reads web-pi star entries, even when an old unstar comes later", () => {
    const entries: SessionEntry[] = [
      assistantEntry("a1", null, "one", 100),
      assistantEntry("a2", "a1", "two", 200),
      {
        ...star("s1", "a2", "a1", true),
        customType: "web-pi:star",
      } as SessionEntry,
      {
        ...star("s2", "s1", "a1", false),
        customType: "pi-web:star",
      } as SessionEntry,
      {
        ...star("s3", "s2", "a2", true),
        customType: "pi-web:star",
      } as SessionEntry,
    ];
    expect(readStars(entries)).toEqual(new Set(["a1"]));
  });

  it("takes the last write per target and only counts answers", () => {
    const entries = [
      userEntry("u1", null, "hi"),
      assistantEntry("a1", "u1", "one", 100),
      assistantEntry("a2", "a1", "two", 200),
      star("s1", "a2", "a1", true),
      star("s2", "s1", "a1", false),
      star("s3", "s2", "a2", true),
      star("s4", "s3", "u1", true),
    ];
    expect(readStars(entries)).toEqual(new Set(["a2"]));
  });
});

describe("session statistics", () => {
  it("counts every branch and skips the time a human spent typing", () => {
    const entries = [
      at(userEntry("u1", null, "hi"), "2026-01-01T00:00:00.000Z"),
      at(assistantEntry("a1", "u1", "one", 100), "2026-01-01T00:00:10.000Z"),
      // A minute of thinking before the next prompt is not active time.
      at(userEntry("u2", "a1", "more"), "2026-01-01T00:01:10.000Z"),
      at(assistantEntry("a2", "u2", "two", 300), "2026-01-01T00:01:15.000Z"),
      // A second branch off the first answer still counts towards totals.
      at(userEntry("u3", "a1", "other"), "2026-01-01T00:02:00.000Z"),
    ];
    const stats = sessionStats(entries);
    expect(stats).toMatchObject({
      userMessages: 3,
      assistantMessages: 2,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 5,
      activeMs: 15_000,
    });
    expect(stats.tokens.total).toBe(400);
    expect(stats.cacheHitRate).toBeNull();
  });
});

describe("row metadata", () => {
  it("takes the last name, the first request, and counts messages", () => {
    const entries: SessionEntry[] = [
      userEntry("u1", null, "  first   request "),
      assistantEntry("a1", "u1", "one", 100),
      {
        type: "session_info",
        name: "Named",
        id: "i1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "session_info",
        name: "  ",
        id: "i2",
        parentId: "i1",
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      star("s1", "i2", "a1", true),
    ];
    expect(
      rowMetadata(entries, { modifiedAt: "2026-01-01", fileSize: 12 }),
    ).toEqual({
      firstMessage: "first request",
      messageCount: 2,
      starCount: 1,
      modifiedAt: "2026-01-01",
      fileSize: 12,
    });
  });
});
