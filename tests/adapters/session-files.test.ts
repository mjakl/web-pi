import { assistantEntry } from "@adapters/fake/index";
import { exportSessionHtml } from "@adapters/pi/session-export";
import {
  createPiSessionCatalog,
  defaultSessionDir,
} from "@adapters/pi/session-catalog";
import {
  branchToNewFile,
  removeSessionFile,
  rewindSessionFile,
} from "@adapters/pi/session-files";
import { readStars, rowMetadata, userMessageText } from "@core/session-entries";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Window, type HTMLElement } from "happy-dom";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

// These run against real session files the Pi SDK wrote, in a throwaway agent
// directory. Never point them at ~/.pi/agent.

let root = "";
let sessionDir = "";
const cwd = "/repo/demo";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-pi-test-"));
  sessionDir = join(root, "sessions", "demo");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function answer(text: string) {
  const entry = assistantEntry("ignored", null, text, 1000);
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    throw new Error("unreachable");
  }
  return entry.message;
}

/** A session with `count` user/assistant exchanges, written to disk. */
function makeSession(
  texts: string[],
  options: { parentSession?: string } = {},
): SessionManager {
  const manager = SessionManager.create(cwd, sessionDir, options);
  for (const text of texts) {
    manager.appendMessage({ role: "user", content: text, timestamp: 1 });
    manager.appendMessage(answer(`answer to ${text}`));
  }
  return manager;
}

function lines(filePath: string): SessionEntry[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEntry);
}

function fileOf(manager: SessionManager): string {
  const file = manager.getSessionFile();
  if (!file) throw new Error("session has no file");
  return file;
}

describe("session file edits", () => {
  it("re-attaches children to the deleted session's own parent", () => {
    const grandparent = makeSession(["root"]);
    const parent = makeSession(["middle"], {
      parentSession: fileOf(grandparent),
    });
    const child = makeSession(["leaf"], { parentSession: fileOf(parent) });
    const subagent = makeSession(["subagent"], {
      parentSession: fileOf(parent),
    });
    const subagentFile = fileOf(subagent);
    writeFileSync(
      subagentFile,
      `${readFileSync(subagentFile, "utf8")}${JSON.stringify({
        type: "custom",
        customType: "web-pi:subagent",
        id: "s1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`,
    );
    const before = readFileSync(subagentFile, "utf8");
    const childEntriesBefore = readFileSync(fileOf(child), "utf8")
      .split("\n")
      .slice(1)
      .join("\n");

    removeSessionFile(fileOf(parent));

    const header = lines(fileOf(child))[0] as unknown as {
      parentSession?: string;
    };
    expect(header.parentSession).toBe(fileOf(grandparent));
    // Only the header line is rewritten.
    expect(
      readFileSync(fileOf(child), "utf8").split("\n").slice(1).join("\n"),
    ).toBe(childEntriesBefore);
    // Marked subagent transcripts are left byte for byte alone.
    expect(readFileSync(subagentFile, "utf8")).toBe(before);
  });

  it("does not treat the old subagent marker as a reparenting exemption", () => {
    const parent = makeSession(["parent"]);
    const child = makeSession(["child"], { parentSession: fileOf(parent) });
    child.appendCustomEntry("pi-web:subagent", {});
    const file = fileOf(child);
    const entriesBefore = readFileSync(file, "utf8").split("\n").slice(1);

    removeSessionFile(fileOf(parent));

    expect(
      SessionManager.open(file).getHeader()?.parentSession,
    ).toBeUndefined();
    expect(readFileSync(file, "utf8").split("\n").slice(1)).toEqual(
      entriesBefore,
    );
  });

  it("rewinds to a user message, keeping earlier lines verbatim", () => {
    const manager = makeSession(["first", "second"]);
    const file = fileOf(manager);
    const entries = manager.getEntries();
    const firstAnswer = entries[1];
    const secondPrompt = entries[2];
    if (!firstAnswer || !secondPrompt) throw new Error("missing entries");
    manager.appendCustomEntry("web-pi:star", {
      targetId: firstAnswer.id,
      starred: true,
    });
    manager.appendSessionInfo("Named later");
    const kept = readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n");

    const removed = rewindSessionFile(file, secondPrompt.id);

    expect(removed).toEqual({ text: "second", images: [] });
    const after = lines(file);
    expect(readFileSync(file, "utf8").split("\n").slice(0, 3).join("\n")).toBe(
      kept,
    );
    expect(after.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "custom",
      "session_info",
      "custom",
    ]);
    const reopened = SessionManager.open(file);
    expect(reopened.getSessionName()).toBe("Named later");
    expect(reopened.getEntries().at(-1)).toMatchObject({
      type: "custom",
      customType: "web-pi-rewind",
    });
    expect(readStars(reopened.getEntries())).toEqual(new Set([firstAnswer.id]));
    // The reopened branch no longer contains the removed message.
    expect(
      reopened.getBranch().some((entry) => entry.id === secondPrompt.id),
    ).toBe(false);
  });

  it("copies a branch into a new file with its stars", () => {
    const manager = makeSession(["first", "second"]);
    const file = fileOf(manager);
    const entries = manager.getEntries();
    const firstAnswer = entries[1];
    if (!firstAnswer) throw new Error("missing entry");
    manager.appendCustomEntry("web-pi:star", {
      targetId: firstAnswer.id,
      starred: true,
    });

    const forked = branchToNewFile(file, firstAnswer.id);

    const copy = SessionManager.open(forked.file);
    expect(copy.getSessionId()).toBe(forked.id);
    expect(
      copy
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => userMessageText(entry) ?? "answer"),
    ).toEqual(["first", "answer"]);
    expect(readStars(copy.getEntries()).size).toBe(1);
    const header = copy.getHeader();
    expect(header?.parentSession).toBe(file);
    // The source file is untouched.
    expect(SessionManager.open(file).getEntries()).toHaveLength(5);
  });
});

describe("Pi session catalog", () => {
  it("reads the current folder without opening or rewriting the transcript", async () => {
    const manager = makeSession(["folder lookup"]);
    manager.appendSessionInfo("Name still comes from the transcript");
    const file = fileOf(manager);
    // SessionManager.open would append a newline to this synthetic fixture.
    writeFileSync(file, readFileSync(file, "utf8").trimEnd());
    const before = readFileSync(file, "utf8");
    const catalog = createPiSessionCatalog({ agentDir: root });
    const open = vi.spyOn(SessionManager, "open");
    expect(await catalog.folder(manager.getSessionId())).toBe(cwd);
    expect(open).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);

    const newline = before.indexOf("\n");
    const header = JSON.parse(before.slice(0, newline)) as Record<
      string,
      unknown
    >;
    writeFileSync(
      file,
      JSON.stringify({ ...header, cwd: "/repo/moved" }) + before.slice(newline),
    );
    expect(await catalog.folder(manager.getSessionId())).toBe("/repo/moved");
    expect((await catalog.read(manager.getSessionId()))?.summary.name).toBe(
      "Name still comes from the transcript",
    );
    rmSync(file);
    expect(await catalog.folder(manager.getSessionId())).toBeUndefined();
    expect(await catalog.folder("unknown")).toBeUndefined();
  });

  it("does not trust a remembered path with a malformed or mismatched header", async () => {
    const manager = makeSession(["header"]);
    const file = fileOf(manager);
    const catalog = createPiSessionCatalog({ agentDir: root });
    await catalog.list();
    writeFileSync(file, "not json\n");
    expect(await catalog.folder(manager.getSessionId())).toBeUndefined();
    const other = makeSession(["other"]);
    writeFileSync(file, readFileSync(fileOf(other)));
    expect(await catalog.folder(manager.getSessionId())).toBeUndefined();
  });

  it("stores a new session where the host Pi's SessionManager would", () => {
    // The SDK reads its default store from PI_CODING_AGENT_DIR and keeps the
    // cwd encoding private, so this is the one test that sets the variable:
    // it pins the mirrored encoding to whatever Pi is on PATH.
    const previous = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = root;
    try {
      expect(defaultSessionDir(root, cwd)).toBe(
        SessionManager.create(cwd).getSessionDir(),
      );
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previous;
    }
  });

  it("streams row metadata that matches the in-memory derivation", async () => {
    const manager = makeSession(["hello world", "again"]);
    const answers = manager
      .getEntries()
      .filter((entry) => entry.type === "message" && entry.id);
    const target = answers[1];
    if (!target) throw new Error("missing answer");
    manager.appendCustomEntry("web-pi:star", {
      targetId: target.id,
      starred: true,
    });
    manager.appendSessionInfo("  Named  ");

    const catalog = createPiSessionCatalog({ agentDir: root });
    const listed = await catalog.list();
    expect(listed.map((session) => session.cwd)).toEqual([cwd]);
    const id = manager.getSessionId();
    const row = await catalog.rowMetadata(id);
    const stored = await catalog.read(id);
    expect(row?.summary).toMatchObject({ id, cwd, name: "Named" });
    expect(row?.metadata).toEqual(
      rowMetadata(stored?.entries ?? [], {
        modifiedAt: row?.metadata.modifiedAt ?? "",
        fileSize: row?.metadata.fileSize ?? 0,
      }),
    );
    expect(row?.metadata).toMatchObject({
      name: "Named",
      firstMessage: "hello world",
      messageCount: 4,
      starCount: 1,
    });
  });

  it("ignores old star metadata without rewriting it on read", async () => {
    const manager = makeSession(["old star"]);
    const reply = manager.getEntries()[1];
    if (!reply) throw new Error("missing answer");
    manager.appendCustomEntry("pi-web:star", {
      targetId: reply.id,
      starred: true,
    });
    const file = fileOf(manager);
    const before = readFileSync(file, "utf8");
    const catalog = createPiSessionCatalog({ agentDir: root });
    await catalog.list();

    expect(
      (await catalog.rowMetadata(manager.getSessionId()))?.metadata.starCount,
    ).toBe(0);
    expect(
      readStars((await catalog.read(manager.getSessionId()))?.entries ?? []),
    ).toEqual(new Set());
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("renames, stars only answers, and deletes", async () => {
    const manager = makeSession(["hello"]);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const id = manager.getSessionId();
    await catalog.list();

    await catalog.rename(id, "Renamed");
    expect((await catalog.rowMetadata(id))?.metadata.name).toBe("Renamed");

    const entries = manager.getEntries();
    const prompt = entries[0];
    const reply = entries[1];
    if (!prompt || !reply) throw new Error("missing entries");
    await expect(catalog.setStar(id, prompt.id, true)).rejects.toThrow(
      /assistant answer/,
    );
    await catalog.setStar(id, reply.id, true);
    expect((await catalog.rowMetadata(id))?.metadata.starCount).toBe(1);
    expect(
      SessionManager.open(fileOf(manager)).getEntries().at(-1),
    ).toMatchObject({
      type: "custom",
      customType: "web-pi:star",
      data: { targetId: reply.id, starred: true },
    });

    await catalog.remove(id);
    expect(await catalog.read(id)).toBeUndefined();
  });

  it("says nothing rather than throwing for a file Pi has not written", async () => {
    const catalog = createPiSessionCatalog({ agentDir: root });
    // The runtime remembers where a new session will live before Pi flushes
    // it; the sidebar row must not 500 over that.
    catalog.remember(
      "01999999-9999-7999-8999-999999999999",
      join(sessionDir, "not-written-yet.jsonl"),
    );
    expect(
      await catalog.rowMetadata("01999999-9999-7999-8999-999999999999"),
    ).toBeUndefined();
  });

  it.each(["header", "stream"])(
    "omits a file removed before the %s read",
    async (phase) => {
      const removed = makeSession(["removed"]);
      const kept = makeSession(["kept"]);
      const file = fileOf(removed);
      const catalog = createPiSessionCatalog({ agentDir: root });
      await catalog.list();
      if (phase === "header") {
        const stat = fsp.stat;
        vi.spyOn(fsp, "stat").mockImplementationOnce(async (...args) => {
          const info = await stat(...args);
          rmSync(file);
          return info;
        });
      } else {
        const createReadStream = fs.createReadStream;
        vi.spyOn(fs, "createReadStream").mockImplementationOnce((...args) => {
          rmSync(file);
          return createReadStream(...args);
        });
      }
      expect(await catalog.rowMetadata(removed.getSessionId())).toBeUndefined();
      expect(
        (await catalog.rowMetadata(kept.getSessionId()))?.metadata,
      ).toMatchObject({
        firstMessage: "kept",
        messageCount: 2,
      });
    },
  );

  it("does not hide unexpected errors while reading metadata", async () => {
    const manager = makeSession(["hello"]);
    const catalog = createPiSessionCatalog({ agentDir: root });
    await catalog.list();
    vi.spyOn(fs, "createReadStream").mockImplementationOnce(() => {
      throw new TypeError("unexpected reader bug");
    });
    await expect(catalog.rowMetadata(manager.getSessionId())).rejects.toThrow(
      "unexpected reader bug",
    );
  });

  it("skips malformed JSONL lines and retains the latest title on repeated reads", async () => {
    const manager = makeSession(["hello"]);
    manager.appendSessionInfo("Old title");
    manager.appendSessionInfo("Latest title");
    const file = fileOf(manager);
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n`);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const first = await catalog.rowMetadata(manager.getSessionId());
    expect(first?.metadata).toMatchObject({
      name: "Latest title",
      firstMessage: "hello",
      messageCount: 2,
    });
    expect(await catalog.rowMetadata(manager.getSessionId())).toEqual(first);
  });

  it("re-reads a file that changed instead of serving the cached counts", async () => {
    const manager = makeSession(["hello"]);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const id = manager.getSessionId();
    await catalog.list();
    expect((await catalog.rowMetadata(id))?.metadata.messageCount).toBe(2);

    manager.appendMessage({ role: "user", content: "more", timestamp: 2 });
    // The cache is keyed by file and stamped by size and mtime, so the older
    // stamp cannot linger and win.
    expect((await catalog.rowMetadata(id))?.metadata.messageCount).toBe(3);
  });

  it.each([
    { shape: "flat", text: "" },
    { shape: "nested", text: "  Explain\n\tthese images  " },
  ])(
    "restores $shape images and text '$text' when forking and rewinding saved history",
    async ({ shape, text }) => {
      const manager = makeSession(["earlier"]);
      const earlier = manager.getBranch();
      const images = [
        { data: "AAEC/w==", mimeType: "image/png" },
        { data: "//79AA==", mimeType: "image/jpeg" },
      ];
      const content = [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((image) =>
          shape === "flat"
            ? { type: "image", ...image }
            : {
                type: "image",
                source: {
                  type: "base64",
                  data: image.data,
                  media_type: image.mimeType,
                },
              },
        ),
      ];
      const targetId = manager.appendMessage({
        role: "user",
        content: content as never,
        timestamp: 3,
      });
      manager.appendMessage(answer("later answer"));
      const file = fileOf(manager);
      const before = readFileSync(file, "utf8");
      const catalog = createPiSessionCatalog({ agentDir: root });
      await catalog.list();
      const id = manager.getSessionId();

      const forked = await catalog.fork(id, targetId);
      expect(forked).toMatchObject({ text, images });
      expect(readFileSync(file, "utf8")).toBe(before);
      expect((await catalog.read(forked.id))?.branch).toEqual(earlier);

      const recalled = await catalog.rewind(id, targetId);
      expect(recalled).toEqual({ text, images });
      const reopened = SessionManager.open(file);
      expect(
        reopened.getEntries().filter((entry) => entry.type === "message"),
      ).toEqual(earlier);
      expect(
        reopened.getBranch().filter((entry) => entry.type === "message"),
      ).toEqual(earlier);
    },
  );

  it("does not offer tool-result images for editing or destructively rewind them", async () => {
    const manager = makeSession(["hello"]);
    const targetId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      timestamp: 3,
      content: [
        { type: "text", text: "tool output" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    });
    const file = fileOf(manager);
    const before = readFileSync(file, "utf8");
    const catalog = createPiSessionCatalog({ agentDir: root });
    await catalog.list();
    const forked = await catalog.fork(manager.getSessionId(), targetId);
    expect(forked).toMatchObject({ text: "", images: [] });
    await expect(
      catalog.rewind(manager.getSessionId(), targetId),
    ).rejects.toThrow("Rewind requires an existing user message");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("estimates context at an ordinary saved answer", async () => {
    const manager = makeSession(["hello"]);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const id = manager.getSessionId();
    await catalog.list();
    const entries = manager.getEntries();
    const last = entries.at(-1);
    if (!last) throw new Error("missing entry");
    expect(catalog.contextTokensAt(id, entries, last.id)).toBeGreaterThan(0);
  });
});

describe("HTML export", () => {
  it("renders and navigates a deeply nested session exported by the Pi CLI", async () => {
    const manager = makeSession(["root prompt"]);
    const branchPoint = manager.getLeafId();
    if (!branchPoint) throw new Error("missing branch point");
    // Hidden metadata makes a deep tree without thousands of rendered messages.
    for (let i = 0; i < 40_000; i += 1) {
      manager.appendCustomEntry("depth", {});
    }
    const deepPrompt = manager.appendMessage({
      role: "user",
      content: "deep prompt",
      timestamp: 2,
    });
    manager.appendMessage(answer("deep answer"));
    manager.branch(branchPoint);
    manager.appendMessage({
      role: "user",
      content: "other prompt",
      timestamp: 3,
    });
    manager.appendMessage(answer("other answer"));
    const exported = await exportSessionHtml(fileOf(manager));
    expect(exported.filename).toMatch(/^pi-session-.*\.html$/);

    const window = new Window({
      url: "http://export.test/",
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
      },
    });
    try {
      Object.assign(window, { TextDecoder });
      window.document.write(exported.html);
      // Execute the shipped artifact, including its bundled renderers.
      for (const script of window.document.querySelectorAll(
        'script:not([type="application/json"])',
      )) {
        window.eval(script.textContent);
      }
      const messages = () =>
        window.document.getElementById("messages")?.textContent;
      expect(messages()).toContain("other answer");
      expect(messages()).not.toContain("deep answer");
      const target = window.document.querySelector<HTMLElement>(
        `#tree-container [data-id="${deepPrompt}"]`,
      );
      if (!target) throw new Error("deep branch is missing from the tree");
      target.click();
      expect(messages()).toContain("root prompt");
      expect(messages()).toContain("deep answer");
      expect(messages()).not.toContain("other answer");
    } finally {
      await window.happyDOM.close();
    }
  });
});
