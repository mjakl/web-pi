import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import type { SessionSummary } from "@core/sessions";
import {
  createWorkspace,
  InspectionOnlySession,
  type Workspace,
} from "@core/workspace";
import { describe, expect, it, vi } from "vitest";

const summary = (id: string): SessionSummary => ({
  id,
  cwd: "/repo",
  createdAt: "2026-09-01T00:00:00.000Z",
  modifiedAt: "2026-09-01T00:00:00.000Z",
  fileSize: 100,
  ...(id.startsWith("subagent.")
    ? {}
    : {
        inspectionOnly: true,
        delegation: {
          parentSessionId: "parent",
          agent: "coder",
          handle: "task",
        },
      }),
});

const mutations: [
  string,
  (workspace: Workspace, id: string) => Promise<unknown>,
][] = [
  ["activate", (workspace, id) => workspace.activate(id)],
  ["send", (workspace, id) => workspace.send(id, "overwrite")],
  ["shell", (workspace, id) => workspace.runBash(id, "echo overwrite", false)],
  ["stop", (workspace, id) => workspace.stop(id)],
  ["abort", (workspace, id) => workspace.abort(id)],
  ["compact", (workspace, id) => workspace.compact(id)],
  ["abort compaction", (workspace, id) => workspace.abortCompaction(id)],
  ["reload", (workspace, id) => workspace.reload(id)],
  ["rename", (workspace, id) => workspace.rename(id, "overwrite")],
  ["remove", (workspace, id) => workspace.remove(id)],
  ["star", (workspace, id) => workspace.setStar(id, "a1", true)],
  ["clear stars", (workspace, id) => workspace.clearStars(id)],
  ["clone", (workspace, id) => workspace.clone(id)],
  ["fork", (workspace, id) => workspace.fork(id, "u1")],
  ["rewind", (workspace, id) => workspace.rewind(id, "u1")],
  ["navigate", (workspace, id) => workspace.navigateTree(id, "u1")],
  ["export", (workspace, id) => workspace.exportHtml(id)],
  [
    "model and thinking",
    (workspace, id) =>
      workspace.setModel(id, {
        provider: "test",
        modelId: "fake",
        thinkingLevel: "high",
      }),
  ],
  ["commands", (workspace, id) => workspace.commands(id, "")],
  ["tools", (workspace, id) => workspace.toolDefinitions(id)],
  ["system prompt", (workspace, id) => workspace.systemPrompt(id)],
  ["recall queue", (workspace, id) => workspace.recallQueue(id)],
  [
    "extension dialog",
    (workspace, id) =>
      workspace.answerDialog(id, "dialog", { cancelled: true }),
  ],
  [
    "extension input",
    (workspace, id) => workspace.customInput(id, "custom", "text"),
  ],
  ["subscribe", (workspace, id) => workspace.subscribe(id, () => {})],
];

function fixture(id: string) {
  const world = createFakeWorld({
    sessions: [
      {
        summary: summary(id),
        entries: [
          userEntry("u1", null, "Saved question"),
          assistantEntry("a1", "u1", "Saved answer", 100),
        ],
      },
    ],
  });
  return { world, workspace: createWorkspace(world) };
}

describe.each(["subagent.abc123", "11111111-1111-4111-8111-111111111111"])(
  "child workspace %s",
  (id) => {
    describe.each([false, true])("unexpected live runtime: %s", (live) => {
      it.each(mutations)(
        "refuses %s before reaching runtime, resources, or storage writes",
        async (_name, action) => {
          const { world, workspace } = fixture(id);
          if (live) await world.runtime.open({ sessionId: id });
          const before = structuredClone(world.store.get(id));
          const get = vi.spyOn(world.runtime, "get");
          const open = vi.spyOn(world.runtime, "open");
          const commands = vi.spyOn(world.resources, "commands");
          const models = vi.spyOn(world.models, "list");
          const exports = vi.spyOn(world.sessions, "exportHtml");
          await expect(action(workspace, id)).rejects.toBeInstanceOf(
            InspectionOnlySession,
          );
          expect(world.store.get(id)).toEqual(before);
          expect(get).not.toHaveBeenCalled();
          expect(open).not.toHaveBeenCalled();
          expect(commands).not.toHaveBeenCalled();
          expect(models).not.toHaveBeenCalled();
          expect(exports).not.toHaveBeenCalled();
        },
      );
    });

    it("reads the saved transcript and row, ignoring even a conflicting live snapshot", async () => {
      const { world, workspace } = fixture(id);
      const live = await world.runtime.open({ sessionId: id });
      const snapshot = live.snapshot();
      vi.spyOn(live, "snapshot").mockReturnValue({
        ...snapshot,
        summary: {
          ...snapshot.summary,
          id,
          inspectionOnly: false,
          cwd: "/wrong",
          name: "Unexpected live title",
          running: true,
          live: true,
        },
        entries: [userEntry("bad", null, "Unexpected live transcript")],
        branch: [userEntry("bad", null, "Unexpected live transcript")],
      });
      const get = vi.spyOn(world.runtime, "get");
      const models = vi.spyOn(world.models, "list");
      const available = vi.spyOn(world.models, "listAvailable");
      const thinking = vi.spyOn(world.models, "resolveThinking");
      const pending = vi.spyOn(live, "takePending");
      const view = await workspace.viewSession(id, { consumePending: true });
      expect(view?.summary).toMatchObject({
        cwd: "/repo",
        inspectionOnly: true,
        running: false,
        live: false,
      });
      expect(view?.status).toBeNull();
      expect(view?.models).toEqual([]);
      expect(view?.turn).toEqual([]);
      expect(view?.items.map((item) => item.entryId)).toEqual(["u1", "a1"]);
      expect(await workspace.lastAssistantText(id)).toBe("Saved answer");
      expect(await workspace.sessionFolder(id)).toBe("/repo");
      expect((await workspace.row(id))?.metadata.firstMessage).toBe(
        "Saved question",
      );
      expect((await workspace.sidebar()).rows[0]?.summary.running).toBe(false);
      expect((await workspace.sessionStats(id))?.summary.cwd).toBe("/repo");
      expect(get).not.toHaveBeenCalled();
      expect(models).not.toHaveBeenCalled();
      expect(available).not.toHaveBeenCalled();
      expect(thinking).not.toHaveBeenCalled();
      expect(pending).not.toHaveBeenCalled();
    });
  },
);

it("folder resource changes leave delegated runtimes untouched", async () => {
  const child = summary("child");
  const world = createFakeWorld({
    sessions: [
      { summary: child, entries: [] },
      {
        summary: {
          id: "ordinary",
          cwd: child.cwd,
          createdAt: child.createdAt,
          modifiedAt: child.modifiedAt,
          fileSize: 0,
        },
        entries: [],
      },
    ],
    trustRequired: ["/repo"],
  });
  const workspace = createWorkspace(world);
  const childLive = await world.runtime.open({ sessionId: "child" });
  const ordinary = await world.runtime.open({ sessionId: "ordinary" });
  const childReload = vi.spyOn(childLive, "reload");
  const childStop = vi.spyOn(childLive, "stop");
  const ordinaryReload = vi.spyOn(ordinary, "reload");
  const ordinaryStop = vi.spyOn(ordinary, "stop");

  expect(await workspace.reloadFolder("/repo")).toBe(1);
  expect(ordinaryReload).toHaveBeenCalledOnce();
  await workspace.trustProject("/repo");
  expect(ordinaryStop).toHaveBeenCalledOnce();
  expect(childReload).not.toHaveBeenCalled();
  expect(childStop).not.toHaveBeenCalled();
});

it("uses current per-file metadata instead of rescanning the store for every inspection", async () => {
  const { world, workspace } = fixture("child");
  const list = vi.spyOn(world.sessions, "list");
  expect((await workspace.viewSession("child"))?.summary.inspectionOnly).toBe(
    true,
  );
  await expect(workspace.send("child", "refuse")).rejects.toBeInstanceOf(
    InspectionOnlySession,
  );
  expect(list).not.toHaveBeenCalled();
});

it("classifies legacy child IDs even when no saved session can be read", async () => {
  const world = createFakeWorld();
  const workspace = createWorkspace(world);
  const list = vi.spyOn(world.sessions, "list");
  await expect(workspace.abort("subagent.missing")).rejects.toBeInstanceOf(
    InspectionOnlySession,
  );
  expect(list).not.toHaveBeenCalled();
});
