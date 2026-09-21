import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

function fixture(
  entries: SessionEntry[] = [
    userEntry("a", null, "Question"),
    assistantEntry("b", "a", "Answer", 20),
  ],
  inspectionOnly = false,
) {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "saved",
          cwd: "/repo",
          createdAt: "2026-09-01T00:00:00Z",
          modifiedAt: "2026-09-01T00:00:00Z",
          fileSize: 100,
          ...(inspectionOnly ? { inspectionOnly: true } : {}),
        },
        entries,
      },
    ],
  });
  const stored = world.store.get("saved");
  if (!stored) throw new Error("Missing fixture session");
  return { world, stored, workspace: createWorkspace(world) };
}

async function observation(
  workspace: ReturnType<typeof createWorkspace>,
  options = {},
) {
  const view = await workspace.viewSession("saved", options);
  if (!view?.savedObservation) throw new Error("Expected saved observation");
  return view.savedObservation;
}

describe("saved-only workspace observation", () => {
  it("returns unchanged without row metadata, catalogs, runtime snapshots or attachment", async () => {
    const { world, workspace } = fixture();
    const initial = await observation(workspace);
    const metadata = vi.spyOn(world.sessions, "rowMetadata");
    const models = vi.spyOn(world.models, "list");
    const available = vi.spyOn(world.models, "listAvailable");
    const thinking = vi.spyOn(world.models, "resolveThinking");
    const open = vi.spyOn(world.runtime, "open");
    expect(await workspace.observeSavedSession("saved", initial)).toEqual({
      kind: "unchanged",
    });
    expect(metadata).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
    expect(thinking).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("follows the observed chain even when a later saved entry belongs to a sibling", async () => {
    const { world, stored, workspace } = fixture();
    const initial = await observation(workspace);
    stored.entries.push(
      userEntry("c", "b", "Continuation"),
      userEntry("d", "a", "Sibling"),
    );
    const models = vi.spyOn(world.models, "list");
    const available = vi.spyOn(world.models, "listAvailable");
    const thinking = vi.spyOn(world.models, "resolveThinking");
    const open = vi.spyOn(world.runtime, "open");
    const result = await workspace.observeSavedSession("saved", initial);
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") throw new Error("Expected changed view");
    expect(result.view.items.map((item) => item.entryId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(result.view.savedObservation?.leaf).toBe("c");
    expect(result.view.savedObservation?.contentLeaf).toBe("c");
    expect(result.view.leaf).toBe("c");
    expect(result.view.rail.some((mark) => mark.id === "d")).toBe(true);
    expect(result.view.status).toBeNull();
    expect(result.view.models).toEqual([]);
    expect(result.view.model).toBeUndefined();
    expect(models).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
    expect(thinking).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not switch to a sibling when the observed chain did not advance", async () => {
    const { stored, workspace } = fixture();
    const initial = await observation(workspace);
    stored.entries.push(userEntry("sibling", "a", "Other branch"));
    const result = await workspace.observeSavedSession("saved", initial);
    expect(result).toMatchObject({
      kind: "changed",
      view: { savedObservation: { leaf: "b" } },
    });
    if (result.kind !== "changed") throw new Error("Expected changed view");
    expect(result.view.items.map((item) => item.entryId)).toEqual(["a", "b"]);
  });

  it.each([false, true])(
    "advances the shared continuation, then holds at an ambiguous fork (inspection only: %s)",
    async (inspectionOnly) => {
      const { stored, workspace } = fixture(undefined, inspectionOnly);
      const initial = await observation(workspace);
      stored.entries.push(
        userEntry("shared", "b", "Shared continuation"),
        assistantEntry("left", "shared", "First alternative", 20),
        assistantEntry("right", "shared", "Second alternative", 20),
      );
      const update = await workspace.observeSavedSession("saved", initial);
      expect(update.kind).toBe("changed");
      if (update.kind !== "changed")
        throw new Error("Expected shared continuation");
      expect(update.view.items.map((item) => item.entryId)).toEqual([
        "a",
        "b",
        "shared",
      ]);
      const held = update.view.savedObservation;
      if (!held) throw new Error("Expected saved observation");
      expect(held.leaf).toBe("shared");
      expect(held.contentLeaf).toBe("shared");
      expect(await workspace.observeSavedSession("saved", held)).toEqual({
        kind: "unchanged",
      });
      stored.entries.push(
        userEntry("later", "left", "More on one alternative"),
      );
      const next = await workspace.observeSavedSession("saved", held);
      expect(next).toMatchObject({
        kind: "changed",
        view: { savedObservation: { leaf: "shared", contentLeaf: "shared" } },
      });
      if (next.kind !== "changed") throw new Error("Expected held branch");
      expect(next.view.items.map((item) => item.entryId)).toEqual([
        "a",
        "b",
        "shared",
      ]);
      expect(
        (await workspace.viewSession("saved"))?.savedObservation?.leaf,
      ).toBe("later");
    },
  );

  it.each([false, true])(
    "holds at the observed tip when competing continuations arrive together (inspection only: %s)",
    async (inspectionOnly) => {
      const { stored, workspace } = fixture(undefined, inspectionOnly);
      const initial = await observation(workspace);
      stored.entries.push(
        userEntry("left", "b", "First continuation"),
        userEntry("right", "b", "Second continuation"),
      );
      const update = await workspace.observeSavedSession("saved", initial);
      expect(update).toMatchObject({
        kind: "changed",
        view: { savedObservation: { leaf: "b", contentLeaf: "b" } },
      });
      if (update.kind !== "changed") throw new Error("Expected held branch");
      expect(update.view.items.map((item) => item.entryId)).toEqual(["a", "b"]);
    },
  );

  it("holds an empty observation when competing roots arrive together", async () => {
    const { stored, workspace } = fixture([]);
    const initial = await observation(workspace);
    stored.entries.push(
      userEntry("left", null, "First root"),
      userEntry("right", null, "Second root"),
    );
    expect(await workspace.observeSavedSession("saved", initial)).toMatchObject(
      {
        kind: "changed",
        view: {
          items: [],
          savedObservation: { leaf: null, contentLeaf: null },
        },
      },
    );
  });

  it("advances a header-only observation from its null leaf", async () => {
    const { stored, workspace } = fixture([]);
    const initial = await observation(workspace);
    expect(initial.leaf).toBeNull();
    expect(initial.contentLeaf).toBeNull();
    stored.entries.push(userEntry("first", null, "Started"));
    expect(await workspace.observeSavedSession("saved", initial)).toMatchObject(
      {
        kind: "changed",
        view: {
          savedObservation: { leaf: "first", contentLeaf: "first" },
          items: [{ entryId: "first" }],
        },
      },
    );
  });

  it("retains the cursor if a rewrite removed the observed tip", async () => {
    const { stored, workspace } = fixture();
    const initial = await observation(workspace);
    stored.entries = [userEntry("replacement", null, "Replacement")];
    const result = await workspace.observeSavedSession("saved", initial);
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable")
      throw new Error("Expected unavailable observation");
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial,
        revision: result.revision ?? "",
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("retains loaded history when a rewrite kept the tip but removed its oldest loaded item", async () => {
    const { stored, workspace } = fixture();
    const initial = await observation(workspace);
    const tip = stored.entries[1];
    if (!tip) throw new Error("Expected fixture tip");
    stored.entries = [{ ...tip, parentId: null }];
    expect(
      await workspace.observeSavedSession("saved", {
        ...initial,
        through: "a",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("reprojects the full loaded window so a saved tool result completes its existing card", async () => {
    const entries = Array.from({ length: 65 }, (_, index) =>
      userEntry(
        `u${String(index)}`,
        index ? `u${String(index - 1)}` : null,
        `Question ${String(index)}`,
      ),
    );
    const call = assistantEntry("call", "u64", "", 20);
    if (call.type !== "message" || call.message.role !== "assistant")
      throw new Error("Expected assistant");
    call.message.content = [
      {
        type: "toolCall",
        id: "tool",
        name: "read",
        arguments: { path: "/repo/file" },
      },
    ];
    entries.push(call);
    const { stored, workspace } = fixture(entries);
    const initial = await observation(workspace, { through: "u0" });
    stored.entries.push({
      type: "message",
      id: "result",
      parentId: "call",
      timestamp: "2026-09-01T00:00:00Z",
      message: {
        role: "toolResult",
        toolCallId: "tool",
        toolName: "read",
        content: [{ type: "text", text: "Saved result" }],
        isError: false,
        timestamp: 3,
      },
    });
    const changed = await workspace.observeSavedSession("saved", {
      ...initial,
      through: "u0",
    });
    expect(changed.kind).toBe("changed");
    if (changed.kind !== "changed")
      throw new Error("Expected changed projection");
    expect(changed.view.items).toHaveLength(66);
    expect(changed.view.hasMore).toBe(false);
    expect(changed.view.oldestId).toBe("u0");
    expect(changed.view.savedObservation?.leaf).toBe("result");
    expect(changed.view.savedObservation?.contentLeaf).toBe("result");
    expect(changed.view.items.at(-1)).toMatchObject({
      kind: "assistant",
      entryId: "call",
      blocks: [{ kind: "tool", call: { result: { text: "Saved result" } } }],
    });
  });

  it("hands an ordinary session to its existing runtime and excludes live alternate branches", async () => {
    const { world, workspace } = fixture();
    const initial = await observation(workspace);
    const live = await world.runtime.open({ sessionId: "saved" });
    const snapshot = vi.spyOn(live, "snapshot");
    const read = vi.spyOn(world.sessions, "readSaved");
    expect(await workspace.observeSavedSession("saved", initial)).toEqual({
      kind: "owned",
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(
      (await workspace.viewSession("saved"))?.savedObservation,
    ).toBeUndefined();
    expect(
      (await workspace.viewSession("saved", { leaf: "a" }))?.savedObservation,
    ).toBeUndefined();
  });

  it("hands off if a runtime acquired the session while its saved file was being read", async () => {
    const { world, stored, workspace } = fixture();
    const initial = await observation(workspace);
    stored.entries.push(userEntry("c", "b", "External append"));
    const readSaved = world.sessions.readSaved.bind(world.sessions);
    vi.spyOn(world.sessions, "readSaved").mockImplementationOnce(
      async (...args) => {
        const result = await readSaved(...args);
        await world.runtime.open({ sessionId: "saved" });
        return result;
      },
    );
    expect(await workspace.observeSavedSession("saved", initial)).toEqual({
      kind: "owned",
    });
  });

  it("keeps persisted child authority even if a conflicting runtime is present", async () => {
    const { world, stored, workspace } = fixture(undefined, true);
    const initial = await observation(workspace);
    const live = await world.runtime.open({ sessionId: "saved" });
    const snapshot = vi.spyOn(live, "snapshot").mockImplementation(() => {
      throw new Error("Do not consult a conflicting runtime");
    });
    const open = vi.spyOn(world.runtime, "open");
    stored.entries.push(userEntry("c", "b", "External child append"));
    const updated = await workspace.observeSavedSession("saved", initial);
    expect(updated).toMatchObject({
      kind: "changed",
      view: {
        summary: { inspectionOnly: true, live: false, running: false },
        savedObservation: { leaf: "c" },
      },
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
