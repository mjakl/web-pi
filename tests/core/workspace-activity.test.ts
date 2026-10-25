import { createFakeWorld } from "@adapters/fake";
import type { RuntimeEvent } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import type { UnreadActivity } from "@core/session-activity";
import { afterEach, expect, it, vi } from "vitest";

function fixture() {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo",
          createdAt: "2026-09-01",
          modifiedAt: "2026-09-01",
          fileSize: 0,
        },
        entries: [],
      },
    ],
  });
  const listeners = new Set<(event: RuntimeEvent) => void>();
  vi.spyOn(world.runtime, "subscribeAll").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const workspace = createWorkspace(world);
  return {
    world,
    workspace,
    emit: (type: RuntimeEvent["type"], stopping?: boolean) => {
      for (const listener of listeners)
        listener({
          type,
          sessionId: "s1",
          ...(stopping === undefined ? {} : { stopping }),
        });
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("shares versioned reads without letting a stale acknowledgment erase a newer completion", () => {
  const { workspace, emit } = fixture();
  const a: UnreadActivity[] = [];
  const b: UnreadActivity[] = [];
  workspace.subscribeActivity((state) => a.push(state));
  workspace.subscribeActivity((state) => b.push(state));
  emit("finished");
  const first = required(workspace.unreadActivity()["s1"]);
  workspace.acknowledgeActivity("s1", first);
  expect(a.at(-1)).toEqual({});
  expect(b).toEqual(a);
  emit("finished");
  const second = required(workspace.unreadActivity()["s1"]);
  expect(second).not.toBe(first);
  workspace.acknowledgeActivity("s1", first);
  expect(workspace.unreadActivity()).toEqual({ s1: second });
  // Stopping a session that genuinely completed unread must not dismiss it.
  emit("stopped");
  emit("opened");
  expect(workspace.unreadActivity()).toEqual({ s1: second });
  emit("started");
  expect(workspace.unreadActivity()).toEqual({});
  // Stop-induced agent/shell/prompt settlement must not recreate a read halo.
  emit("finished", true);
  emit("stopped");
  expect(workspace.unreadActivity()).toEqual({});
  emit("finished", false);
  expect(workspace.unreadActivity()["s1"]).toBeTruthy();
});

it("acknowledges only activity observed before an asynchronously enriched transcript read", async () => {
  const { world, workspace, emit } = fixture();
  await world.runtime.open({ sessionId: "s1" });
  emit("finished");
  const first = required(workspace.unreadActivity()["s1"]);
  const project =
    Promise.withResolvers<Awaited<ReturnType<typeof world.projects.resolve>>>();
  const resolve = vi
    .spyOn(world.projects, "resolve")
    .mockReturnValue(project.promise);
  const reading = workspace.viewSession("s1");
  await vi.waitFor(() => {
    expect(resolve).toHaveBeenCalled();
  });
  emit("finished");
  const second = required(workspace.unreadActivity()["s1"]);
  project.resolve({
    root: "/repo",
    branch: "main",
    isTopLevel: true,
    isWorktree: false,
  });
  const view = await reading;
  expect(view?.activityVersion).toBe(first);
  workspace.acknowledgeActivity("s1", required(view?.activityVersion));
  expect(workspace.unreadActivity()).toEqual({ s1: second });
});

it("fails a read acknowledgment explicitly when its durable write fails", () => {
  const { world, workspace, emit } = fixture();
  emit("finished");
  const first = required(workspace.unreadActivity()["s1"]);
  vi.spyOn(world.activity, "save").mockImplementation(() => {
    throw new Error("disk full");
  });
  expect(() => {
    workspace.acknowledgeActivity("s1", first);
  }).toThrow("disk full");
  expect(workspace.unreadActivity()).toEqual({ s1: first });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected activity version");
  return value;
}
