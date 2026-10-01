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

  it("refuses saved, unknown and overlapping-project dispatches", async () => {
    const { workspace, world } = fixture();
    const saved = await workspace.coordinatorContext("one");
    await expect(
      workspace.coordinatorSend("one", saved.revision, "go", "prompt"),
    ).rejects.toThrow(/Activate/);
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
