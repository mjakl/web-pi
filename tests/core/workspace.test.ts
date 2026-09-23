import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { describe, expect, it, vi } from "vitest";

async function sendFirst(
  workspace: ReturnType<typeof createWorkspace>,
  cwd: string,
  text: string,
) {
  const id = await workspace.createSession(cwd);
  await workspace.send(id, text);
  return id;
}

async function waitForIdle(
  workspace: ReturnType<typeof createWorkspace>,
  id: string,
) {
  await vi.waitFor(async () => {
    expect((await workspace.viewSession(id))?.status?.running).toBe(false);
  });
}

describe("workspace over the fake runtime", () => {
  it("streams a turn and settles it into the transcript", async () => {
    const world = createFakeWorld({ delayMs: 2, reply: () => "one two three" });
    const workspace = createWorkspace(world);
    const id = await sendFirst(workspace, "/tmp/project", "hi");

    const during = await workspace.viewSession(id);
    expect(during?.status?.running).toBe(true);
    expect(during?.turn.map((item) => item.kind)).toEqual(["user"]);

    await waitForIdle(workspace, id);
    const after = await workspace.viewSession(id);
    expect(after?.status?.running).toBe(false);
    // Reconciliation after the delivered cursor must never repeat the turn.
    expect(
      (await workspace.viewSession(id, { after: after?.settledCursor ?? "" }))
        ?.items,
    ).toEqual([]);
    expect(after?.turn).toEqual([]);
    expect(after?.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
    ]);
    expect(after?.usage).toMatchObject({
      tokens: 1500,
      contextWindow: 100_000,
      level: "ok",
    });
    expect(Math.round(after?.usage.percent ?? 0)).toBe(2);
  });

  it("lists sessions globally and derives directory choices separately", async () => {
    const world = createFakeWorld({ delayMs: 2 });
    const workspace = createWorkspace(world);
    const first = await sendFirst(workspace, "/repo/a", "x");
    await waitForIdle(workspace, first);
    const second = await sendFirst(workspace, "/repo/b", "y");
    await waitForIdle(workspace, second);

    const sidebar = await workspace.sidebar();
    expect(sidebar.rows.map((row) => row.summary.cwd)).toEqual([
      "/repo/b",
      "/repo/a",
    ]);
    expect(sidebar.rows.every((row) => row.summary.live)).toBe(true);
    const metadata = vi.spyOn(world.sessions, "rowMetadata");
    expect((await workspace.projects()).map((project) => project.key)).toEqual([
      "/repo/b",
      "/repo/a",
    ]);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("builds a live session's row from the runtime, not its file", async () => {
    const world = createFakeWorld({ delayMs: 2, reply: () => "answer" });
    const workspace = createWorkspace(world);
    const id = await sendFirst(workspace, "/repo/a", "first question");
    await waitForIdle(workspace, id);
    const stored = await world.sessions.rowMetadata(id);
    if (!stored) throw new Error("Expected a stored session");
    vi.spyOn(world.sessions, "rowMetadata").mockResolvedValue({
      ...stored,
      metadata: {
        ...stored.metadata,
        messageCount: 0,
        firstMessage: "stale file",
      },
    });
    const row = await workspace.row(id);
    expect(row?.summary.live).toBe(true);
    expect(row?.metadata.messageCount).toBe(2);
    expect(row?.metadata.firstMessage).toBe("first question");
  });

  it("does not re-render a settled turn when something else happens", async () => {
    const world = createFakeWorld({ delayMs: 2, reply: () => "answer" });
    const workspace = createWorkspace(world);
    const id = await sendFirst(workspace, "/tmp/project", "hi");
    await waitForIdle(workspace, id);

    // A star, a rename, an extension status: all of them are `activity`, and
    // none of them may put the turn that already settled back on screen.
    const answer = (await workspace.viewSession(id))?.items.find(
      (item) => item.kind === "assistant",
    );
    await workspace.setStar(id, answer?.entryId ?? "", true);
    const after = await workspace.viewSession(id);
    expect(after?.turn).toEqual([]);
    const ids = (after?.items ?? []).map((item) => item.entryId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads another branch of a running session from the runtime", async () => {
    const world = createFakeWorld({ delayMs: 2, reply: () => "answer" });
    const workspace = createWorkspace(world);
    const id = await sendFirst(workspace, "/tmp/project", "first");
    await waitForIdle(workspace, id);
    const first = (await workspace.viewSession(id))?.items[0]?.entryId ?? "";
    // A live session owns its file; reading it from disk could serve a branch
    // Pi has not flushed yet, so the file must not be touched at all.
    world.sessions.read = () => {
      throw new Error("the file must not be read while the session is live");
    };

    const branch = await workspace.viewSession(id, { leaf: first });
    expect(branch?.otherBranch).toBe(true);
    expect(branch?.items.map((item) => item.kind)).toEqual(["user"]);
  });

  it.each([false, true])(
    "rewinds into an active idle session without sending the recalled message (previously active: %s)",
    async (active) => {
      const world = createFakeWorld({
        sessions: [
          {
            summary: {
              id: "rewind",
              cwd: "/repo",
              name: "Rewind fixture",
              createdAt: "2026-09-01T00:00:00Z",
              modifiedAt: "2026-09-01T00:00:00Z",
              fileSize: 100,
            },
            entries: [
              userEntry("u1", null, "first"),
              assistantEntry("a1", "u1", "first answer", 100),
              userEntry("u2", "a1", "edit this"),
              assistantEntry("a2", "u2", "second answer", 100),
            ],
          },
        ],
      });
      const workspace = createWorkspace(world);
      if (active) await workspace.activate("rewind");

      expect(await workspace.rewind("rewind", "u2")).toEqual({
        text: "edit this",
        images: [],
      });

      const resumed = world.runtime.get("rewind");
      expect(resumed).toBeDefined();
      expect(resumed?.snapshot().status.running).toBe(false);
      const view = await workspace.viewSession("rewind");
      expect(view?.summary.live).toBe(true);
      expect(view?.items.map((item) => item.entryId)).toEqual(["u1", "a1"]);
      expect(view?.turn).toEqual([]);
      await resumed?.stop();
    },
  );

  it("recalls the queue with the images its messages carried", async () => {
    const world = createFakeWorld({ delayMs: 20, reply: () => "slow answer" });
    const workspace = createWorkspace(world);
    const id = await sendFirst(workspace, "/tmp/project", "first");
    await workspace.send(id, "second", {
      behavior: "followUp",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });

    const recalled = await workspace.recallQueue(id);
    expect(recalled.text).toBe("second");
    expect(recalled.images).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
  });

  it("puts the post-compaction estimate on the compaction card", async () => {
    const world = createFakeWorld({
      delayMs: 2,
      sessions: [
        {
          summary: {
            id: "c1",
            cwd: "/repo/one",
            createdAt: "2026-09-01T00:00:00.000Z",
            modifiedAt: "2026-09-01T00:00:00.000Z",
            fileSize: 3,
          },
          entries: [
            userEntry("u1", null, "question"),
            {
              type: "compaction",
              id: "k1",
              parentId: "u1",
              timestamp: "2026-09-01T00:00:00.000Z",
              summary: "what happened",
              tokensBefore: 40_000,
              firstKeptEntryId: "u1",
            } as never,
          ],
        },
      ],
    });
    vi.spyOn(world.sessions, "contextTokensAt").mockReturnValue(1_234);
    const workspace = createWorkspace(world);
    const view = await workspace.viewSession("c1");
    const card = view?.items.find((item) => item.kind === "compaction");
    expect(card).toMatchObject({ tokensBefore: 40_000, tokensAfter: 1_234 });
  });
});
