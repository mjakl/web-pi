import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readdir: vi.fn(actual.readdir),
  };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-pi-saved-observation-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const manager = SessionManager.create(
    "/repo",
    join(root, "sessions", "repo"),
    { id: "saved" },
  );
  manager.appendMessage({ role: "user", content: "Question", timestamp: 1 });
  const answer = assistantEntry("unused", null, "Answer", 2);
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Expected assistant fixture");
  manager.appendMessage(answer.message);
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing session file");
  const catalog = createPiSessionCatalog({ agentDir: root });
  catalog.remember("saved", file);
  return { manager, file, catalog };
}

function diskState(file: string) {
  return {
    bytes: readFileSync(file),
    mtime: statSync(file, { bigint: true }).mtimeNs,
    siblings: readdirSync(dirname(file)).sort(),
  };
}

describe("conditional saved snapshots", () => {
  it("carries the initial snapshot revision and only stats an unchanged known file", async () => {
    const { file, catalog } = fixture();
    const initial = await catalog.read("saved");
    expect(initial?.revision).toBeTruthy();
    const before = diskState(file);
    vi.mocked(files.open).mockClear();
    vi.mocked(files.readdir).mockClear();
    expect(await catalog.readSaved("saved", initial?.revision)).toEqual({
      kind: "unchanged",
    });
    expect(files.open).not.toHaveBeenCalled();
    expect(files.readdir).not.toHaveBeenCalled();
    expect(diskState(file)).toEqual(before);
  });

  it("accepts complete final entries and header-only snapshots without adding a newline", async () => {
    const { file, catalog, manager } = fixture();
    for (const contents of [
      readFileSync(file, "utf8").trimEnd(),
      JSON.stringify(manager.getHeader()),
    ]) {
      writeFileSync(file, contents);
      const before = diskState(file);
      const result = await catalog.readSaved("saved");
      expect(result.kind).toBe("changed");
      if (result.kind !== "changed") throw new Error("Expected saved snapshot");
      expect(result.snapshot.leafId).toBe(
        contents.includes("\n") ? manager.getLeafId() : null,
      );
      expect(diskState(file)).toEqual(before);
    }
  });

  it("leaves a partial append untouched and retries it only after a new stamp", async () => {
    const { file, catalog, manager } = fixture();
    const initial = await catalog.read("saved");
    const complete = JSON.stringify(
      userEntry("next", manager.getLeafId(), "Next question"),
    );
    appendFileSync(file, complete.slice(0, -4));
    const partial = diskState(file);
    const unavailable = await catalog.readSaved("saved", initial?.revision);
    expect(unavailable.kind).toBe("unavailable");
    if (unavailable.kind !== "unavailable")
      throw new Error("Expected unavailable read");
    expect(unavailable.revision).toBeTruthy();
    // The existing initial reader deliberately remains tolerant.
    expect((await catalog.read("saved"))?.branch).toHaveLength(2);
    vi.mocked(files.open).mockClear();
    expect(await catalog.readSaved("saved", unavailable.revision)).toEqual({
      kind: "unchanged",
    });
    expect(files.open).not.toHaveBeenCalled();
    expect(diskState(file)).toEqual(partial);
    appendFileSync(file, `${complete.slice(-4)}\n`);
    const before = diskState(file);
    const changed = await catalog.readSaved("saved", unavailable.revision);
    expect(changed).toMatchObject({
      kind: "changed",
      snapshot: { leafId: "next" },
    });
    expect(diskState(file)).toEqual(before);
  });

  it.each([
    "",
    "not-json\n",
    "null\n",
    "missing-parent",
    "duplicate",
    "cycle",
    "second-header",
    "replaced-header",
  ])(
    "rejects unsafe saved state %s without repairing or migrating it",
    async (corruption) => {
      const { file, catalog, manager } = fixture();
      const initial = await catalog.read("saved");
      const header = manager.getHeader();
      const entries = manager.getEntries();
      const first = entries[0];
      if (!first) throw new Error("Expected fixture entries");
      const contents =
        corruption === "missing-parent"
          ? [header, { ...first, parentId: "missing" }]
          : corruption === "duplicate"
            ? [header, ...entries, first]
            : corruption === "cycle"
              ? [header, { ...first, parentId: first.id }]
              : corruption === "second-header"
                ? [header, ...entries, header]
                : corruption === "replaced-header"
                  ? [{ ...header, id: "another" }, ...entries]
                  : undefined;
      writeFileSync(
        file,
        contents
          ? contents.map((entry) => JSON.stringify(entry)).join("\n")
          : corruption,
      );
      const before = diskState(file);
      expect(await catalog.readSaved("saved", initial?.revision)).toMatchObject(
        { kind: "unavailable" },
      );
      expect(diskState(file)).toEqual(before);
    },
  );

  it("detects an atomic replacement even when size and mtime are unchanged", async () => {
    const { file, catalog } = fixture();
    const initial = await catalog.read("saved");
    const before = statSync(file);
    const replacement = `${file}.replacement`;
    writeFileSync(
      replacement,
      readFileSync(file, "utf8").replace("Answer", "Edited"),
    );
    await files.utimes(replacement, before.atime, before.mtime);
    renameSync(replacement, file);
    const updated = await catalog.readSaved("saved", initial?.revision);
    expect(updated.kind).toBe("changed");
    if (updated.kind !== "changed") throw new Error("Expected changed read");
    expect(updated.revision).not.toBe(initial?.revision);
    expect(updated.snapshot.branch.at(-1)).toMatchObject({
      message: { content: [{ type: "text", text: "Edited" }] },
    });
  });

  it("does not publish bytes that changed while they were being read", async () => {
    const { file, catalog, manager } = fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(files.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.readFile.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementationOnce(async () => {
        const content = await read("utf8");
        appendFileSync(
          file,
          `${JSON.stringify(userEntry("later", manager.getLeafId(), "Later"))}\n`,
        );
        return content;
      });
      return handle;
    });
    const during = await catalog.readSaved("saved");
    expect(during.kind).toBe("unavailable");
    if (during.kind !== "unavailable")
      throw new Error("Expected unavailable read");
    expect(await catalog.readSaved("saved", during.revision)).toMatchObject({
      kind: "changed",
      snapshot: { leafId: "later" },
    });
  });

  it("keeps the observed branch and loaded history across truncate, missing file, and restored contents", async () => {
    const { file, catalog, manager } = fixture();
    const workspace = createWorkspace({
      ...createFakeWorld(),
      sessions: catalog,
    });
    const initial = await workspace.viewSession("saved");
    if (!initial?.savedObservation)
      throw new Error("Expected saved observation");
    const original = readFileSync(file);
    writeFileSync(file, JSON.stringify(manager.getHeader()));
    const truncated = await workspace.observeSavedSession(
      "saved",
      initial.savedObservation,
    );
    expect(truncated.kind).toBe("unavailable");
    if (truncated.kind !== "unavailable")
      throw new Error("Expected unavailable read");
    vi.mocked(files.open).mockClear();
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial.savedObservation,
        revision: truncated.revision ?? "",
      }),
    ).toEqual({ kind: "unchanged" });
    expect(files.open).not.toHaveBeenCalled();
    rmSync(file);
    expect(
      await workspace.observeSavedSession("saved", initial.savedObservation),
    ).toEqual({ kind: "unavailable" });
    writeFileSync(file, original);
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial.savedObservation,
        revision: truncated.revision ?? "",
      }),
    ).toMatchObject({
      kind: "changed",
      view: { savedObservation: { leaf: initial.savedObservation.leaf } },
    });
  });

  it("retains displayed history after an external rewind reparents its metadata leaf", async () => {
    const { file, catalog, manager } = fixture();
    const removedPrompt = manager.appendMessage({
      role: "user",
      content: "Second question",
      timestamp: 3,
    });
    const answer = assistantEntry("unused", null, "Second answer", 4);
    if (answer.type !== "message" || answer.message.role !== "assistant")
      throw new Error("Expected assistant fixture");
    const contentLeaf = manager.appendMessage(answer.message);
    const metadataLeaf = manager.appendSessionInfo(
      "Named after the second answer",
    );
    const workspace = createWorkspace({
      ...createFakeWorld(),
      sessions: catalog,
    });
    const initial = await workspace.viewSession("saved");
    if (!initial?.savedObservation || !initial.oldestId)
      throw new Error("Expected saved observation and loaded history");
    expect(initial.items).toHaveLength(4);
    expect(initial.savedObservation.leaf).toBe(metadataLeaf);
    expect(initial.savedObservation.contentLeaf).toBe(contentLeaf);

    const external = createPiSessionCatalog({ agentDir: root });
    external.remember("saved", file);
    await external.rewind("saved", removedPrompt);
    const afterWriter = diskState(file);
    const rewritten = await catalog.read("saved");
    expect(rewritten?.branch.some((entry) => entry.id === metadataLeaf)).toBe(
      true,
    );
    expect(
      rewritten?.branch.some((entry) => entry.id === initial.oldestId),
    ).toBe(true);
    expect(rewritten?.entries.some((entry) => entry.id === contentLeaf)).toBe(
      false,
    );

    const observed = await workspace.observeSavedSession("saved", {
      ...initial.savedObservation,
      through: initial.oldestId,
    });
    expect(observed.kind).toBe("unavailable");
    if (observed.kind !== "unavailable")
      throw new Error("Expected unavailable observation");
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial.savedObservation,
        revision: observed.revision ?? "",
        through: initial.oldestId,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(diskState(file)).toEqual(afterWriter);
  });

  it("rejects a rewind that leaves the content entry saved but outside the reparented branch", async () => {
    const { file, catalog, manager } = fixture();
    const contentLeaf = manager.getLeafId();
    const oldest = manager.getEntries()[0]?.id;
    if (!contentLeaf || !oldest) throw new Error("Expected fixture history");
    manager.branch(oldest);
    const removedPrompt = manager.appendMessage({
      role: "user",
      content: "Sibling question",
      timestamp: 3,
    });
    manager.branch(contentLeaf);
    manager.appendSessionInfo("Named on the observed branch");
    const workspace = createWorkspace({
      ...createFakeWorld(),
      sessions: catalog,
    });
    const initial = await workspace.viewSession("saved");
    if (!initial?.savedObservation)
      throw new Error("Expected saved observation");

    const external = createPiSessionCatalog({ agentDir: root });
    external.remember("saved", file);
    await external.rewind("saved", removedPrompt);
    const afterWriter = diskState(file);
    const rewritten = await catalog.read("saved");
    expect(rewritten?.entries.some((entry) => entry.id === contentLeaf)).toBe(
      true,
    );
    expect(rewritten?.branch.some((entry) => entry.id === contentLeaf)).toBe(
      false,
    );
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial.savedObservation,
        through: oldest,
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(diskState(file)).toEqual(afterWriter);
  });

  it("retains a completed tool card when external rewind removes only its result and reparents metadata", async () => {
    const { file, catalog, manager } = fixture();
    const call = assistantEntry("unused", null, "", 3);
    if (call.type !== "message" || call.message.role !== "assistant")
      throw new Error("Expected assistant fixture");
    call.message.content = [
      {
        type: "toolCall",
        id: "read-call",
        name: "read",
        arguments: { path: "/repo/file" },
      },
    ];
    const callId = manager.appendMessage(call.message);
    const removedPrompt = manager.appendMessage({
      role: "user",
      content: "Another branch",
      timestamp: 4,
    });
    manager.branch(callId);
    const resultId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "read-call",
      toolName: "read",
      content: [{ type: "text", text: "Complete saved output" }],
      isError: false,
      timestamp: 5,
    });
    const metadataLeaf = manager.appendSessionInfo("Named after the result");
    const workspace = createWorkspace({
      ...createFakeWorld(),
      sessions: catalog,
    });
    const initial = await workspace.viewSession("saved");
    if (!initial?.savedObservation || !initial.oldestId)
      throw new Error("Expected saved observation and loaded history");
    expect(initial.savedObservation.leaf).toBe(metadataLeaf);
    expect(initial.savedObservation.contentLeaf).toBe(resultId);
    expect(initial.items.at(-1)).toMatchObject({
      entryId: callId,
      blocks: [
        {
          kind: "tool",
          call: {
            result: { entryId: resultId, text: "Complete saved output" },
          },
        },
      ],
    });

    const external = createPiSessionCatalog({ agentDir: root });
    external.remember("saved", file);
    await external.rewind("saved", removedPrompt);
    const afterWriter = diskState(file);
    const rewritten = await catalog.read("saved");
    expect(rewritten?.branch.some((entry) => entry.id === metadataLeaf)).toBe(
      true,
    );
    expect(rewritten?.branch.some((entry) => entry.id === callId)).toBe(true);
    expect(
      rewritten?.branch.some((entry) => entry.id === initial.oldestId),
    ).toBe(true);
    expect(rewritten?.entries.some((entry) => entry.id === resultId)).toBe(
      false,
    );

    expect(
      await workspace.observeSavedSession("saved", {
        ...initial.savedObservation,
        through: initial.oldestId,
      }),
    ).toMatchObject({ kind: "unavailable" });
    expect(diskState(file)).toEqual(afterWriter);
  });

  it("advances a legacy observation after a writer migrates IDs, without writing itself", async () => {
    const { file, catalog, manager } = fixture();
    const legacy = manager
      .getEntries()
      .map(({ id: _id, parentId: _parentId, ...entry }) => entry);
    writeFileSync(
      file,
      [{ ...manager.getHeader(), version: 1 }, ...legacy]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const workspace = createWorkspace({
      ...createFakeWorld(),
      sessions: catalog,
    });
    const initial = await workspace.viewSession("saved");
    if (!initial?.savedObservation)
      throw new Error("Expected saved observation");
    expect(initial.savedObservation.leaf).toMatch(/^legacy-/);
    expect(initial.savedObservation.contentLeaf).toMatch(/^legacy-/);
    const writer = SessionManager.open(file);
    writer.appendMessage({
      role: "user",
      content: "After migration",
      timestamp: 3,
    });
    const before = diskState(file);
    const changed = await workspace.observeSavedSession("saved", {
      ...initial.savedObservation,
      through: initial.oldestId,
    });
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed")
      throw new Error("Expected changed projection");
    expect(changed.view.items.map((item) => item.entryId)).toEqual(
      writer.getEntries().map((entry) => entry.id),
    );
    expect(changed.view.savedObservation?.leaf).toBe(writer.getLeafId());
    expect(changed.view.savedObservation?.contentLeaf).toBe(writer.getLeafId());
    expect(diskState(file)).toEqual(before);
  });
});
