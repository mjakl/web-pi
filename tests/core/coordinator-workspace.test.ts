import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { projectIdentity } from "@core/workspaces";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

function fixture() {
  const summary = (id: string, cwd = "/repo") => ({
    id,
    cwd,
    createdAt: "2026-01-01",
    modifiedAt: "2026-01-01",
    fileSize: 1,
  });
  const world = createFakeWorld({
    delayMs: 2,
    sessions: [
      {
        summary: summary("one"),
        entries: [
          userEntry("u1", null, "Fix the timer test"),
          assistantEntry("a1", "u1", "Which timeout should I use?", 10),
        ],
      },
      {
        summary: summary("two"),
        entries: [userEntry("u2", null, "Review the timer code")],
      },
      { summary: { ...summary("child"), inspectionOnly: true }, entries: [] },
    ],
  });
  return { world, workspace: createWorkspace(world) };
}

describe("coordinator workspace boundary", () => {
  it("lists ordinary sessions and reads bounded text without opening a writer", async () => {
    const { world, workspace } = fixture();
    const open = vi.spyOn(world.runtime, "open");
    const list = await workspace.coordinatorSessions();
    expect(list.map((s) => s.id).sort()).toEqual(["one", "two"]);
    const view = await workspace.coordinatorContext("one");
    expect(view.messages).toEqual([
      { id: "u1", role: "user", text: "Fix the timer test" },
      { id: "a1", role: "assistant", text: "Which timeout should I use?" },
    ]);
    expect(view.writable).toBe(false);
    expect(open).not.toHaveBeenCalled();
    await expect(workspace.coordinatorContext("child")).rejects.toThrow();
  });

  it("describes the current request and latest outcome rather than only the first task", async () => {
    const { world, workspace } = fixture();
    const stored = world.store.get("one");
    assert(stored);
    stored.entries.push(
      userEntry("u3", "a1", "Now fix the API login timeout"),
      assistantEntry(
        "a3",
        "u3",
        "The API login fix passes its focused test",
        20,
      ),
    );
    stored.leafId = "a3";
    for (let i = 1; i <= 12; i++) {
      const id = `progress${String(i)}`;
      stored.entries.push(
        assistantEntry(id, stored.leafId, `Progress step ${String(i)}`, 20),
      );
      stored.leafId = id;
    }
    const saved = (await workspace.coordinatorSessions()).find(
      (s) => s.id === "one",
    );
    expect(saved).toMatchObject({
      task: "Fix the timer test",
      currentRequest: "Now fix the API login timeout",
      latestOutcome: "Progress step 12",
      root: true,
      writable: false,
      available: true,
    });
    await workspace.activate("one");
    expect(
      (await workspace.coordinatorSessions()).find((s) => s.id === "one"),
    ).toMatchObject({
      writable: true,
      revision: (await workspace.coordinatorContext("one")).revision,
    });
    await workspace.stop("one");
  });

  it("admits a literal prompt only to the reviewed live session, once its context is current", async () => {
    const { world, workspace } = fixture();
    await workspace.activate("one");
    const live = world.runtime.get("one");
    assert(live);
    const prompt = vi.spyOn(live, "prompt");
    const view = await workspace.coordinatorContext("one");
    await workspace.coordinatorSend(
      "one",
      view.revision,
      "/review !not-shell",
      "prompt",
    );
    expect(prompt).toHaveBeenCalledWith("/review !not-shell", {
      literal: true,
    });
    await expect(
      workspace.coordinatorSend("one", view.revision, "again", "prompt"),
    ).rejects.toThrow(/changed/);
    await live.stop();
  });

  it("binds answers to the newest typed question and runtime, not a reused dialog ID", async () => {
    const world = createFakeWorld({
      delayMs: 1,
      sessions: [
        {
          summary: {
            id: "question",
            cwd: "/repo",
            createdAt: "2026-01-01",
            modifiedAt: "2026-01-01",
            fileSize: 1,
          },
          entries: [userEntry("q1", null, "Configure release")],
        },
      ],
      script: () => [
        { insert: "keep this browser notice" },
        {
          dialog: {
            method: "select",
            title: "Choose branch",
            options: ["main", "release"],
          },
        },
        { text: "done" },
      ],
    });
    const workspace = createWorkspace(world);
    const id = "question";
    await workspace.activate(id);
    await workspace.send(id, "start");
    await vi.waitFor(async () => {
      expect((await workspace.coordinatorContext(id)).dialog?.id).toBe("d1");
    });
    const before = await workspace.coordinatorContext(id);
    expect(world.runtime.get(id)?.snapshot().status.editorText).toContain(
      "keep this browser notice",
    );
    await expect(
      workspace.coordinatorAnswer(id, before.revision, "d1", {
        value: "invented",
      }),
    ).rejects.toThrow(/offered/);
    await workspace.stop(id);
    await workspace.activate(id);
    await workspace.send(id, "start again");
    await vi.waitFor(async () => {
      expect((await workspace.coordinatorContext(id)).dialog?.id).toBe("d1");
    });
    await expect(
      workspace.coordinatorAnswer(id, before.revision, "d1", { value: "main" }),
    ).rejects.toThrow(/changed/);
    const after = await workspace.coordinatorContext(id);
    await workspace.coordinatorAnswer(id, after.revision, "d1", {
      value: "release",
    });
    await expect(
      workspace.coordinatorAnswer(id, after.revision, "d1", {
        value: "release",
      }),
    ).rejects.toThrow();
    await workspace.stop(id);
  });

  it("watches a known saved root without opening a writer and preserves incomplete snapshots", async () => {
    const { world, workspace } = fixture();
    const stored = world.store.get("one");
    assert(stored);
    stored.summary.filePath = "/isolated/one.jsonl";
    let notify: (() => void) | undefined;
    const dispose = vi.fn();
    const watch = vi
      .spyOn(world.watcher, "watch")
      .mockImplementation((_path, handlers) => {
        notify = () => {
          handlers.change({ mtime: 1, size: 1 });
        };
        return dispose;
      });
    const changed = vi.fn();
    const open = vi.spyOn(world.runtime, "open");
    const stop = await workspace.coordinatorWatch("one", changed);
    expect(watch.mock.calls[0]?.[0]).toBe("/isolated/one.jsonl");
    stored.entries.push(
      assistantEntry("a2", "a1", "The external result is ready.", 20),
    );
    stored.leafId = "a2";
    notify?.();
    expect(changed).toHaveBeenCalledOnce();
    expect(
      (await workspace.coordinatorContext("one")).messages.at(-1)?.text,
    ).toBe("The external result is ready.");
    vi.spyOn(world.sessions, "readSaved").mockResolvedValueOnce({
      kind: "unavailable",
    });
    await expect(workspace.coordinatorContext("one")).rejects.toThrow(
      /incomplete/,
    );
    expect(open).not.toHaveBeenCalled();
    stop();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("blocks a browser from racing a coordinator turn in the same project", async () => {
    const { world, workspace } = fixture();
    await workspace.activate("one");
    await workspace.activate("two");
    const context = await workspace.coordinatorContext("one");
    await workspace.coordinatorSend("one", context.revision, "go", "prompt");
    await expect(workspace.send("two", "browser prompt")).rejects.toThrow(
      /another session/i,
    );
    await expect(workspace.runBash("two", "echo test", false)).rejects.toThrow(
      /another session/i,
    );
    await world.runtime.get("one")?.stop();
  });

  it("excludes sibling worktrees even when both sessions start in checkout subdirectories", async () => {
    const { workspace, world } = fixture();
    for (const id of ["one", "two"]) {
      const stored = world.store.get(id);
      assert(stored);
      stored.summary.cwd = `/worktrees/${id}/src`;
    }
    vi.spyOn(world.projects, "resolve").mockImplementation((cwd) =>
      Promise.resolve(
        projectIdentity({
          cwd,
          root: "/repo",
          toplevel: cwd.replace(/\/src$/, ""),
          gitDir: `/repo/.git/worktrees/${String(cwd.split("/")[2])}`,
          commonDir: "/repo/.git",
          bare: false,
          branch: "feature",
        }),
      ),
    );
    await workspace.activate("one");
    await workspace.activate("two");
    await workspace.send("two", "start");
    const context = await workspace.coordinatorContext("one");
    await expect(
      workspace.coordinatorSend("one", context.revision, "go", "prompt"),
    ).rejects.toThrow(/another session/i);
    await world.runtime.get("two")?.stop();
  });

  it("preserves concurrent ordinary prompt admission when no coordinator is involved", async () => {
    const { world, workspace } = fixture();
    await workspace.activate("one");
    const live = world.runtime.get("one");
    assert(live);
    const prompt = vi.spyOn(live, "prompt");
    await Promise.all([
      workspace.send("one", "first"),
      workspace.send("one", "second", { behavior: "followUp" }),
    ]);
    expect(prompt).toHaveBeenCalledTimes(2);
    await live.stop();
  });

  it("resumes a saved ordinary root only with a revision-bound user handoff", async () => {
    const { workspace, world } = fixture();
    const saved = await workspace.coordinatorContext("one");
    const open = vi.spyOn(world.runtime, "open");
    await expect(
      workspace.coordinatorSend("one", saved.revision, "Review the fix"),
    ).rejects.toThrow(/stopped in other apps/i);
    expect(open).not.toHaveBeenCalled();
    const admitted = await workspace.coordinatorSend(
      "one",
      saved.revision,
      "Review the fix",
      undefined,
      { handoff: true },
    );
    expect(admitted.mode).toBe("prompt");
    expect(
      world.runtime
        .get("one")
        ?.snapshot()
        .branch.some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            JSON.stringify(entry.message.content).includes("Review the fix"),
        ),
    ).toBe(true);
    await workspace.stop("one");
  });

  it("refuses trust, delegated and unavailable roots before opening, even with a handoff", async () => {
    const { workspace, world } = fixture();
    const saved = await workspace.coordinatorContext("one");
    const open = vi.spyOn(world.runtime, "open");
    const grant = vi.spyOn(world.trust, "trust");
    vi.spyOn(world.trust, "status").mockResolvedValue({
      requiresTrust: true,
      trusted: false,
    });
    await expect(
      workspace.coordinatorSend("one", saved.revision, "work", undefined, {
        handoff: true,
      }),
    ).rejects.toThrow(/trust.*visible review/i);
    await expect(
      workspace.coordinatorSend("child", saved.revision, "work", undefined, {
        handoff: true,
      }),
    ).rejects.toThrow(/inspection/i);
    vi.spyOn(world.projects, "available").mockResolvedValue(false);
    await expect(
      workspace.coordinatorSend("one", saved.revision, "work", undefined, {
        handoff: true,
      }),
    ).rejects.toThrow(/folder/i);
    expect(open).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])(
    "refuses a saved revision changed %s runtime opening",
    async (when) => {
      const { workspace, world } = fixture();
      const saved = await workspace.coordinatorContext("one");
      const stored = world.store.get("one");
      assert(stored);
      const change = () => {
        stored.entries.push(userEntry("new", "a1", "Changed external request"));
        stored.leafId = "new";
      };
      const original = world.runtime.open.bind(world.runtime);
      const open = vi
        .spyOn(world.runtime, "open")
        .mockImplementation(async (target) => {
          const live = await original(target);
          if (when === "during") change();
          return live;
        });
      if (when === "before") change();
      await expect(
        workspace.coordinatorSend(
          "one",
          saved.revision,
          "Wrong stale instruction",
          undefined,
          { handoff: true },
        ),
      ).rejects.toThrow(/changed/);
      if (when === "before") expect(open).not.toHaveBeenCalled();
      else {
        const current = await workspace.coordinatorContext("one");
        await expect(
          workspace.coordinatorSend(
            "one",
            current.revision,
            "Wrong stale instruction",
          ),
        ).rejects.toThrow(/failed resume validation/);
      }
      expect(
        stored.entries.some(
          (entry) =>
            entry.type === "message" &&
            JSON.stringify(entry.message).includes("Wrong stale instruction"),
        ),
      ).toBe(false);
      await workspace.stop("one");
    },
  );

  it("rejects wrong-target resumes and superseded input at the final admission check", async () => {
    const { workspace, world } = fixture();
    await workspace.activate("two");
    const other = world.runtime.get("two");
    assert(other);
    const saved = await workspace.coordinatorContext("one");
    vi.spyOn(world.runtime, "open").mockResolvedValue(other);
    await expect(
      workspace.coordinatorSend("one", saved.revision, "wrong", undefined, {
        handoff: true,
      }),
    ).rejects.toThrow(/changed/);
    const context = await workspace.coordinatorContext("two");
    await expect(
      workspace.coordinatorSend(
        "two",
        context.revision,
        "superseded",
        undefined,
        { current: () => false },
      ),
    ).rejects.toThrow(/unresolved/);
    expect(other.snapshot().status.running).toBe(false);
    await workspace.stop("two");
  });

  it("chooses automatic delivery from actual admission state and reads bounded status without consuming notices", async () => {
    const { workspace, world } = fixture();
    await workspace.activate("one");
    const live = world.runtime.get("one");
    assert(live);
    const original = live.snapshot.bind(live);
    let running = false;
    vi.spyOn(live, "snapshot").mockImplementation(() => {
      const snapshot = original();
      return {
        ...snapshot,
        status: {
          ...snapshot.status,
          running,
          tools: [{ id: "t", name: "bash", progress: "secret raw log" }],
          retry: { attempt: 1, maxAttempts: 3, message: "private retry trace" },
          notices: [{ level: "error", message: "Failed to run test" }],
        },
      };
    });
    const context = await workspace.coordinatorContext("one");
    running = true;
    const prompt = vi.spyOn(live, "prompt");
    const result = await workspace.coordinatorSend(
      "one",
      context.revision,
      "Include regression tests",
    );
    expect(result.mode).toBe("followUp");
    expect(prompt).toHaveBeenCalledWith("Include regression tests", {
      literal: true,
      behavior: "followUp",
    });
    const status = (await workspace.coordinatorContext("one")).status;
    expect(status).toMatchObject({
      tools: ["bash"],
      retry: { attempt: 1, maxAttempts: 3 },
      notices: [{ level: "error", message: "Failed to run test" }],
    });
    expect(JSON.stringify(status)).not.toContain("raw log");
    expect(live.snapshot().status.notices).toHaveLength(1);
    await workspace.stop("one");
  });

  it("never activates saved sessions to stop work", async () => {
    const { workspace, world } = fixture();
    const saved = await workspace.coordinatorContext("one");
    const open = vi.spyOn(world.runtime, "open");
    await expect(
      workspace.coordinatorAbort("one", saved.revision),
    ).rejects.toThrow(/no local turn/i);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses saved, unknown and overlapping-project dispatches", async () => {
    const { workspace, world } = fixture();
    const saved = await workspace.coordinatorContext("one");
    await expect(
      workspace.coordinatorSend("one", saved.revision, "go", "prompt"),
    ).rejects.toThrow(/stopped in other apps/i);
    await expect(workspace.coordinatorContext("missing")).rejects.toThrow(
      /Unknown/,
    );
    await workspace.activate("one");
    await workspace.activate("two");
    await workspace.send("two", "start");
    const context = await workspace.coordinatorContext("one");
    await expect(
      workspace.coordinatorSend("one", context.revision, "go", "prompt"),
    ).rejects.toThrow(/another session/i);
    await world.runtime.get("two")?.stop();
  });
});
