import { createFakeWorld, type FakeStoredSession } from "@adapters/fake/index";
import {
  createWebPushNotifier,
  type WebPushOptions,
} from "@adapters/pi/web-push";
import type { PushMessage, PushNotifier, RuntimeEvent } from "@core/ports";
import { DELEGATION_TYPE } from "@core/session-delegation";
import { createWorkspace } from "@core/workspace";
import type { ProjectInfo } from "@core/workspaces";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const GRACE_MS = 1_000;
const PROJECT: ProjectInfo = {
  root: "/repo",
  branch: "main",
  isTopLevel: true,
  isWorktree: false,
};
const directories: string[] = [];
const notifiers: PushNotifier[] = [];

function session(id: string): FakeStoredSession {
  return {
    summary: {
      id,
      cwd: `/repo/${id}`,
      name: `  Task ${id}  `,
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-01T00:00:00.000Z",
      fileSize: 0,
    },
    entries: [],
  };
}

function origin(
  childSessionId: string,
  parentSessionId = "parent",
  version = 1,
): FakeStoredSession["entries"][number] {
  return {
    type: "custom",
    id: `origin-${parentSessionId}`,
    parentId: null,
    timestamp: "2026-09-01T00:00:00.000Z",
    customType: DELEGATION_TYPE,
    data: {
      version,
      childSessionId,
      parentSessionId,
      agent: "coder",
      handle: "task",
    },
  };
}

async function fixture(sessions = [session("root")]) {
  vi.useFakeTimers();
  const agentDir = mkdtempSync(join(tmpdir(), "web-pi-workspace-push-"));
  directories.push(agentDir);
  const send = vi
    .fn<NonNullable<WebPushOptions["send"]>>()
    .mockResolvedValue(undefined);
  const push = createWebPushNotifier({
    agentDir,
    send,
    gracePeriodMs: GRACE_MS,
  });
  notifiers.push(push);
  const world = createFakeWorld({ sessions });
  for (const stored of sessions)
    await world.runtime.open({ sessionId: stored.summary.id });
  const listeners = new Set<(event: RuntimeEvent) => void>();
  vi.spyOn(world.runtime, "subscribeAll").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  const workspace = createWorkspace({ ...world, push });
  workspace.subscribePush({
    endpoint: "https://push.example/device",
    keys: { p256dh: "p", auth: "a" },
  });
  return {
    world,
    workspace,
    send,
    complete: (id = "root") => {
      for (const listener of listeners)
        listener({ type: "completed", sessionId: id });
    },
    payloads: () =>
      send.mock.calls.map(([, payload]) => JSON.parse(payload) as PushMessage),
  };
}

afterEach(() => {
  for (const notifier of notifiers.splice(0)) notifier.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workspace completion ingress", () => {
  it("cannot revive a pre-return completion when deferred project lookup finishes after departure", async () => {
    const { world, workspace, send, complete, payloads } = await fixture();
    const lookup = Promise.withResolvers<ProjectInfo>();
    vi.spyOn(world.projects, "resolve").mockReturnValue(lookup.promise);
    complete();
    // Let the old summary path reach its deferred lookup before the return.
    await vi.advanceTimersByTimeAsync(500);
    workspace.reportPushPresence({
      clientId: "device",
      sequence: 1,
      foreground: true,
    });
    workspace.reportPushPresence({
      clientId: "device",
      sequence: 2,
      foreground: false,
    });
    lookup.resolve(PROJECT);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(send).not.toHaveBeenCalled();
    complete();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(payloads()).toEqual([
      {
        title: "Task root",
        body: "Task finished.",
        url: "/sessions/root",
        tag: "web-pi:session-complete:root",
      },
    ]);
  });

  it("measures the deadline from the completion event, not project resolution", async () => {
    const { world, send, complete, payloads } = await fixture();
    const lookup = Promise.withResolvers<ProjectInfo>();
    vi.spyOn(world.projects, "resolve").mockReturnValue(lookup.promise);
    complete();
    await vi.advanceTimersByTimeAsync(400);
    lookup.resolve(PROJECT);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 401);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(payloads()).toEqual([
      {
        title: "Task root",
        body: "Task finished.",
        url: "/sessions/root",
        tag: "web-pi:session-complete:root",
      },
    ]);
  });

  it("counts an additional completion even if its project metadata stays blocked through the deadline", async () => {
    const { world, send, complete, payloads } = await fixture([
      session("root"),
      session("second"),
    ]);
    const lookup = Promise.withResolvers<ProjectInfo>();
    vi.spyOn(world.projects, "resolve").mockImplementation((cwd) =>
      cwd === "/repo/second" ? lookup.promise : Promise.resolve(PROJECT),
    );
    complete();
    await vi.advanceTimersByTimeAsync(500);
    complete("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(payloads()).toEqual([
      {
        title: "2 tasks completed",
        body: "2 tasks finished while you were away.",
        url: "/",
        tag: "web-pi:session-complete",
      },
    ]);
    lookup.resolve(PROJECT);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "legacy ID",
      id: "subagent.child",
      entries: [],
      inspectionOnly: false,
      eligible: false,
    },
    {
      name: "inspection-only summary",
      id: "child",
      entries: [],
      inspectionOnly: true,
      eligible: false,
    },
    {
      name: "own-ID origin",
      id: "child",
      entries: [origin("child")],
      inspectionOnly: false,
      eligible: false,
    },
    {
      name: "malformed own-ID origin",
      id: "child",
      entries: [origin("child", "parent", 2)],
      inspectionOnly: false,
      eligible: false,
    },
    {
      name: "conflicting own-ID origins",
      id: "child",
      entries: [origin("child"), origin("child", "different-parent")],
      inspectionOnly: false,
      eligible: false,
    },
    {
      name: "copied foreign origin",
      id: "child",
      entries: [origin("foreign")],
      inspectionOnly: false,
      eligible: true,
    },
  ])(
    "uses runtime ownership for $name eligibility",
    async ({ id, entries, inspectionOnly, eligible }) => {
      const candidate = session(id);
      candidate.entries = entries;
      candidate.summary.inspectionOnly = inspectionOnly;
      const { send, complete, payloads } = await fixture([
        candidate,
        session("root"),
      ]);
      complete(id);
      await vi.advanceTimersByTimeAsync(GRACE_MS);
      if (eligible) {
        expect(payloads()).toEqual([
          {
            title: `Task ${id}`,
            body: "Task finished.",
            url: `/sessions/${id}`,
            tag: `web-pi:session-complete:${id}`,
          },
        ]);
      } else {
        expect(send).not.toHaveBeenCalled();
        // An excluded completion must not spend the root's allowance.
        complete();
        await vi.advanceTimersByTimeAsync(GRACE_MS);
        expect(payloads()).toEqual([
          {
            title: "Task root",
            body: "Task finished.",
            url: "/sessions/root",
            tag: "web-pi:session-complete:root",
          },
        ]);
      }
    },
  );

  it("requires a present runtime with a matching snapshot before admitting a completion", async () => {
    const { world, send, complete, payloads } = await fixture([
      session("root"),
      session("ordinary"),
    ]);
    const live = world.runtime.get("root");
    if (!live) throw new Error("Missing owned fixture runtime");
    const snapshot = live.snapshot();
    vi.spyOn(live, "snapshot").mockReturnValue({
      ...snapshot,
      summary: { ...snapshot.summary, id: "unrelated" },
    });
    complete("missing");
    complete();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(send).not.toHaveBeenCalled();
    complete("ordinary");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(payloads()).toEqual([
      {
        title: "Task ordinary",
        body: "Task finished.",
        url: "/sessions/ordinary",
        tag: "web-pi:session-complete:ordinary",
      },
    ]);
  });
});
