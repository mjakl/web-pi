import { assistantEntry } from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { DELEGATION_TYPE } from "@core/session-delegation";
import { readStars } from "@core/session-entries";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

let root: string;
let sessionDir: string;
const cwd = "/repo/delegation";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-pi-catalog-"));
  sessionDir = join(root, "sessions", "demo");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fileOf(manager: SessionManager): string {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing fixture file");
  return file;
}

function makeSession(id: string, parentSession?: string) {
  const manager = SessionManager.create(cwd, sessionDir, { id, parentSession });
  manager.appendMessage({
    role: "user",
    content: `Task for ${id}`,
    timestamp: 1,
  });
  const answer = assistantEntry("ignored", null, "Saved answer", 2);
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Missing fixture answer");
  manager.appendMessage(answer.message);
  return manager;
}

function origin(childSessionId: string, parentSessionId: string) {
  return {
    version: 1,
    childSessionId,
    parentSessionId,
    agent: "coder-senior",
    handle: "topic",
  };
}

function diskState(file: string) {
  return {
    bytes: readFileSync(file),
    mtime: statSync(file, { bigint: true }).mtimeNs,
    files: readdirSync(dirname(file)).sort(),
  };
}

function age(file: string) {
  const old = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(file, old, old);
}

describe("catalog delegation discovery", () => {
  it("discovers immediate nested ownership independently of copied records and fork ancestry", async () => {
    const parent = makeSession("parent");
    const child = makeSession("child", fileOf(parent));
    child.appendCustomEntry(DELEGATION_TYPE, origin("child", "parent"));
    const nested = SessionManager.forkFrom(fileOf(child), cwd, sessionDir, {
      id: "nested",
    });
    nested.appendCustomEntry(DELEGATION_TYPE, origin("nested", "child"));
    const catalog = createPiSessionCatalog({ agentDir: root });
    const listed = await catalog.list();

    expect(
      listed.find((row) => row.id === "parent")?.inspectionOnly,
    ).toBeUndefined();
    for (const [id, parentSessionId] of [
      ["child", "parent"],
      ["nested", "child"],
    ] as const) {
      const expected = {
        inspectionOnly: true,
        delegation: { parentSessionId, agent: "coder-senior", handle: "topic" },
      };
      expect(listed.find((row) => row.id === id)).toMatchObject({
        ...expected,
        parentId: parentSessionId,
      });
      expect((await catalog.rowMetadata(id))?.summary).toMatchObject(expected);
      expect((await catalog.read(id))?.summary).toMatchObject(expected);
    }

    const parentClone = await catalog.clone("parent");
    const childClone = await catalog.clone("child");
    const after = await catalog.list();
    for (const id of [parentClone, childClone]) {
      expect(
        after.find((row) => row.id === id)?.inspectionOnly,
      ).toBeUndefined();
      expect(after.find((row) => row.id === id)?.delegation).toBeUndefined();
      expect((await catalog.read(id))?.summary.delegation).toBeUndefined();
    }
    expect(
      after.find((row) => row.id === "child")?.delegation?.parentSessionId,
    ).toBe("parent");
    expect(
      after.find((row) => row.id === "nested")?.delegation?.parentSessionId,
    ).toBe("child");
  });

  it("deletes an ordinary parent without rewriting delegated or legacy fork children", async () => {
    const parent = makeSession("parent");
    const child = makeSession("child", fileOf(parent));
    child.appendCustomEntry(DELEGATION_TYPE, origin("child", "parent"));
    const legacy = makeSession("subagent.legacy", fileOf(parent));
    const fork = makeSession("ordinary-fork", fileOf(parent));
    const files = [fileOf(child), fileOf(legacy)];
    const before = files.map((file) => ({
      bytes: readFileSync(file),
      mtime: statSync(file, { bigint: true }).mtimeNs,
    }));
    const catalog = createPiSessionCatalog({ agentDir: root });
    await catalog.remove("parent");
    expect(
      files.map((file) => ({
        bytes: readFileSync(file),
        mtime: statSync(file, { bigint: true }).mtimeNs,
      })),
    ).toEqual(before);
    expect(
      (await catalog.list()).find((row) => row.id === "child")?.delegation
        ?.parentSessionId,
    ).toBe("parent");
    expect(
      SessionManager.open(fileOf(fork)).getHeader()?.parentSession,
    ).toBeUndefined();
  });

  it("classifies every discovered file before a caller selects its first sidebar page", async () => {
    for (let index = 0; index < 56; index += 1) {
      const id = `child-${String(index)}`;
      makeSession(id).appendCustomEntry(
        DELEGATION_TYPE,
        origin(id, "missing-parent"),
      );
    }
    const catalog = createPiSessionCatalog({ agentDir: root });
    const listed = await catalog.list();
    expect(listed).toHaveLength(56);
    expect(
      listed.every(
        (row) =>
          row.inspectionOnly &&
          row.delegation?.parentSessionId === "missing-parent",
      ),
    ).toBe(true);
  });

  it("keeps legacy, malformed and conflicting own-ID origins readonly without invented edges", async () => {
    const legacy = makeSession("subagent.abc123");
    const conflict = makeSession("conflict", fileOf(legacy));
    conflict.appendCustomEntry(DELEGATION_TYPE, origin("conflict", "parent-a"));
    conflict.appendCustomEntry(DELEGATION_TYPE, origin("conflict", "parent-b"));
    const self = makeSession("self");
    self.appendCustomEntry(DELEGATION_TYPE, origin("self", "self"));
    const malformed = makeSession("malformed");
    malformed.appendCustomEntry(DELEGATION_TYPE, {
      ...origin("malformed", "parent"),
      handle: null,
    });
    const copied = makeSession("copied");
    copied.appendCustomEntry(DELEGATION_TYPE, {
      ...origin("another", "parent"),
      version: 8,
    });
    const catalog = createPiSessionCatalog({ agentDir: root });
    const listed = await catalog.list();
    for (const manager of [legacy, conflict, self, malformed]) {
      const id = manager.getSessionId();
      const rows = [
        listed.find((row) => row.id === id),
        (await catalog.rowMetadata(id))?.summary,
        (await catalog.read(id))?.summary,
      ];
      for (const row of rows) {
        expect(row?.inspectionOnly).toBe(true);
        expect(row?.delegation).toBeUndefined();
      }
    }
    expect(
      listed.find((row) => row.id === "copied")?.inspectionOnly,
    ).toBeUndefined();
  });

  it("reuses stamped discovery and notices an origin appended after an earlier scan", async () => {
    const manager = makeSession("late");
    const catalog = createPiSessionCatalog({ agentDir: root });
    expect((await catalog.list())[0]?.delegation).toBeUndefined();
    vi.mocked(fs.createReadStream).mockClear();
    await catalog.list();
    expect(fs.createReadStream).not.toHaveBeenCalled();
    expect(
      (await catalog.rowMetadata("late"))?.summary.delegation,
    ).toBeUndefined();

    manager.appendCustomEntry(DELEGATION_TYPE, origin("late", "parent"));
    expect((await catalog.list())[0]?.delegation?.parentSessionId).toBe(
      "parent",
    );
    expect(
      (await catalog.rowMetadata("late"))?.summary.delegation?.parentSessionId,
    ).toBe("parent");
    expect(
      (await catalog.read("late"))?.summary.delegation?.parentSessionId,
    ).toBe("parent");
  });

  it("notices replacement with the same length and modification time", async () => {
    const manager = makeSession("replaced");
    manager.appendCustomEntry(DELEGATION_TYPE, origin("replaced", "parent-a"));
    const file = fileOf(manager);
    age(file);
    const catalog = createPiSessionCatalog({ agentDir: root });
    expect((await catalog.list())[0]?.delegation?.parentSessionId).toBe(
      "parent-a",
    );
    await catalog.rowMetadata("replaced");
    const before = statSync(file);
    const replacement = `${file}.replacement`;
    writeFileSync(
      replacement,
      readFileSync(file, "utf8").replace("parent-a", "parent-b"),
    );
    utimesSync(replacement, before.atime, before.mtime);
    renameSync(replacement, file);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect((await catalog.list())[0]?.delegation?.parentSessionId).toBe(
      "parent-b",
    );
    expect(
      (await catalog.rowMetadata("replaced"))?.summary.delegation
        ?.parentSessionId,
    ).toBe("parent-b");
  });
});

describe("non-writing catalog snapshots", () => {
  it.each(["ordinary", "subagent.legacy", "delegated"])(
    "preserves complete saved branches, leaves and names without repairing a trailing append: %s",
    async (id) => {
      const manager = makeSession(id);
      const oldTip = manager.getLeafId();
      if (!oldTip) throw new Error("Missing saved tip");
      if (id === "delegated")
        manager.appendCustomEntry(DELEGATION_TYPE, origin(id, "parent"));
      manager.appendMessage({
        role: "user",
        content: "Abandoned branch",
        timestamp: 3,
      });
      manager.branch(oldTip);
      manager.appendMessage({
        role: "user",
        content: "Later branch",
        timestamp: 3,
      });
      manager.appendSessionInfo("Latest title");
      const file = fileOf(manager);
      appendFileSync(file, '{"type":"message","id":');
      age(file);
      const before = diskState(file);
      const catalog = createPiSessionCatalog({ agentDir: root });
      await catalog.list();
      await catalog.rowMetadata(id);
      const snapshot = await catalog.read(id);
      expect(snapshot?.branch).toEqual(manager.getBranch());
      expect(snapshot?.entries).toEqual(manager.getEntries());
      expect(snapshot?.leafId).toBe(manager.getLeafId());
      expect(snapshot?.summary.name).toBe("Latest title");
      if (id === "delegated") {
        expect(snapshot?.summary.delegation?.parentSessionId).toBe("parent");
      }
      expect((await catalog.read(id, oldTip))?.branch).toEqual(
        manager.getBranch(oldTip),
      );
      expect((await catalog.read(id, "missing-entry"))?.branch).toEqual([]);
      expect(
        catalog.contextTokensAt(id, snapshot?.entries ?? [], oldTip),
      ).toBeGreaterThan(0);
      expect(diskState(file)).toEqual(before);
    },
  );

  it("does not add a newline to a complete final entry or to a header-only session", async () => {
    const manager = makeSession("no-newline");
    manager.appendSessionInfo("Earlier title");
    manager.appendSessionInfo("");
    const file = fileOf(manager);
    writeFileSync(file, readFileSync(file, "utf8").trimEnd());
    age(file);
    const before = diskState(file);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const snapshot = await catalog.read("no-newline");
    expect(snapshot?.entries).toEqual(manager.getEntries());
    expect(snapshot?.summary.name).toBeUndefined();
    expect(diskState(file)).toEqual(before);

    writeFileSync(file, JSON.stringify(manager.getHeader()));
    age(file);
    const headerOnly = diskState(file);
    expect(await catalog.list()).toHaveLength(1);
    expect(await catalog.read("no-newline")).toMatchObject({
      branch: [],
      entries: [],
      leafId: null,
    });
    expect(
      (await catalog.rowMetadata("no-newline"))?.metadata.messageCount,
    ).toBe(0);
    expect(diskState(file)).toEqual(headerOnly);
  });

  it.each(["", "not json\n", "null\n", '{"type":"session","id":"invalid"}\n'])(
    "does not initialize an empty or malformed remembered file: %j",
    async (contents) => {
      const manager = makeSession("broken");
      const file = fileOf(manager);
      writeFileSync(file, contents);
      age(file);
      const before = diskState(file);
      const catalog = createPiSessionCatalog({ agentDir: root });
      catalog.remember("broken", file);
      expect(await catalog.list()).toEqual([]);
      expect(await catalog.read("broken")).toBeUndefined();
      expect(await catalog.rowMetadata("broken")).toBeUndefined();
      expect(diskState(file)).toEqual(before);
    },
  );

  it("refuses stale remembered paths and missing files rather than initializing them", async () => {
    const manager = makeSession("actual");
    const file = fileOf(manager);
    const before = diskState(file);
    const catalog = createPiSessionCatalog({ agentDir: root });
    catalog.remember("different", file);
    expect(await catalog.read("different")).toBeUndefined();
    expect(await catalog.rowMetadata("different")).toBeUndefined();
    expect(diskState(file)).toEqual(before);
    rmSync(file);
    catalog.remember("actual", file);
    expect(await catalog.read("actual")).toBeUndefined();
    expect(readdirSync(sessionDir)).toEqual([]);
  });

  it.each([1, 2])(
    "migrates v%s only in memory, keeping stable branch IDs and compaction references",
    async (version) => {
      const manager = makeSession(`old-${String(version)}`);
      manager.appendMessage({
        role: "custom",
        customType: "old-hook",
        content: "Legacy note",
        display: true,
        timestamp: 3,
      });
      const kept = manager.getEntries()[1];
      if (!kept) throw new Error("Missing kept entry");
      manager.appendCompaction("Earlier context", kept.id, 1000);
      manager.appendSessionInfo("Old session name");
      const file = fileOf(manager);
      const header = { ...manager.getHeader(), version };
      const entries = manager.getEntries().map((entry) => {
        const value = JSON.parse(JSON.stringify(entry)) as Record<
          string,
          unknown
        >;
        const message = value["message"] as Record<string, unknown> | undefined;
        if (message?.["role"] === "custom") message["role"] = "hookMessage";
        if (version === 1) {
          delete value["id"];
          delete value["parentId"];
          if (value["type"] === "compaction") {
            delete value["firstKeptEntryId"];
            value["firstKeptEntryIndex"] = 2;
          }
        }
        return value;
      });
      writeFileSync(
        file,
        [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n"),
      );
      age(file);
      const before = diskState(file);
      const catalog = createPiSessionCatalog({ agentDir: root });
      const id = manager.getSessionId();
      const snapshot = await catalog.read(id);
      expect(snapshot?.entries).toHaveLength(5);
      expect(snapshot?.summary.name).toBe("Old session name");
      expect(snapshot?.entries[2]).toMatchObject({
        type: "message",
        message: { role: "custom", content: "Legacy note" },
      });
      const compaction = snapshot?.entries[3];
      expect(compaction).toMatchObject({
        type: "compaction",
        firstKeptEntryId: snapshot?.entries[1]?.id,
      });
      const tip = snapshot?.entries[1]?.id;
      expect(tip).toBeTruthy();
      expect((await catalog.read(id, tip))?.branch).toEqual(
        snapshot?.entries.slice(0, 2),
      );
      expect((await catalog.read(id))?.entries).toEqual(snapshot?.entries);
      expect(
        catalog.contextTokensAt(
          id,
          snapshot?.entries ?? [],
          compaction?.id ?? "",
        ),
      ).toBeGreaterThan(0);
      await catalog.rowMetadata(id);
      expect(diskState(file)).toEqual(before);
    },
  );

  it.each(["star", "fork", "clone", "rewind"])(
    "keeps a v1 snapshot selection usable when a later %s intentionally opens a writer",
    async (action) => {
      const manager = makeSession("linear");
      manager.appendMessage({
        role: "user",
        content: "Later question",
        timestamp: 3,
      });
      const entries = manager.getEntries().map((entry) => {
        const value = JSON.parse(JSON.stringify(entry)) as Record<
          string,
          unknown
        >;
        delete value["id"];
        delete value["parentId"];
        return value;
      });
      const file = fileOf(manager);
      writeFileSync(
        file,
        [{ ...manager.getHeader(), version: 1 }, ...entries]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      const catalog = createPiSessionCatalog({ agentDir: root });
      const snapshot = await catalog.read("linear");
      const answerId = snapshot?.entries[1]?.id;
      const questionId = snapshot?.entries[2]?.id;
      if (!answerId || !questionId)
        throw new Error("Missing snapshot selection");
      if (action === "star") {
        await catalog.setStar("linear", answerId, true);
        expect(
          readStars((await catalog.read("linear"))?.entries ?? []).size,
        ).toBe(1);
        // The first write migrated the file, but the page still holds its old IDs.
        expect((await catalog.read("linear", answerId))?.branch).toHaveLength(
          2,
        );
        await catalog.setStar("linear", answerId, false);
        const saved = await catalog.read("linear");
        if (!saved) throw new Error("Missing migrated session");
        expect(readStars(saved.entries).size).toBe(0);
        const reply = saved.entries[1];
        if (reply?.type !== "message" || reply.message.role !== "assistant")
          throw new Error("Missing migrated answer");
        reply.message.content = [{ type: "text", text: "Replacement answer" }];
        writeFileSync(
          file,
          `${[manager.getHeader(), ...saved.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        );
        expect((await catalog.read("linear", answerId))?.branch).toEqual([]);
        await expect(catalog.setStar("linear", answerId, true)).rejects.toThrow(
          "assistant answer",
        );
      } else if (action === "fork") {
        const forked = await catalog.fork("linear", answerId);
        expect((await catalog.read(forked.id))?.branch).toHaveLength(2);
      } else if (action === "clone") {
        const cloned = await catalog.clone("linear", answerId);
        expect((await catalog.read(cloned))?.branch).toHaveLength(2);
      } else {
        expect(await catalog.rewind("linear", questionId)).toEqual({
          text: "Later question",
          images: [],
        });
        expect(
          (await catalog.read("linear"))?.branch.filter(
            (entry) => entry.type === "message",
          ),
        ).toHaveLength(2);
      }
    },
  );

  it("exports a delegated old-format snapshot without letting the CLI rewrite its source", async () => {
    const manager = makeSession("exported-child");
    manager.appendCustomEntry(
      DELEGATION_TYPE,
      origin("exported-child", "parent"),
    );
    const file = fileOf(manager);
    const entries = [
      { ...manager.getHeader(), version: 2 },
      ...manager.getEntries(),
    ];
    writeFileSync(
      file,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    age(file);
    const before = diskState(file);
    const catalog = createPiSessionCatalog({ agentDir: root });
    const exported = await catalog.exportHtml("exported-child");
    expect(exported.html).toContain("<!DOCTYPE html>");
    expect(exported.filename).toContain("exported-child");
    expect(diskState(file)).toEqual(before);
  });
});
