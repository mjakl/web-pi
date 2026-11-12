import {
  assistantEntry,
  bashEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import type { SessionSummary } from "@core/sessions";
import { createWorkspace } from "@core/workspace";
import { describe, expect, it, vi } from "vitest";

function stored(id: string, parentSessionId?: string) {
  const summary: SessionSummary = {
    id,
    cwd: `/projects/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    fileSize: 100,
    ...(parentSessionId === undefined
      ? {}
      : {
          inspectionOnly: true,
          delegation: { parentSessionId, agent: "coder", handle: id },
        }),
  };
  return {
    summary,
    entries: [userEntry(`${id}-message`, null, `Question for ${id}`)],
  };
}

function numbered(prefix: string, count: number, parent?: string) {
  return Array.from({ length: count }, (_, index) =>
    stored(`${prefix}-${String(index).padStart(3, "0")}`, parent),
  );
}
const ids = (rows: readonly { summary: SessionSummary }[]) =>
  rows.map((row) => row.summary.id);

describe("workspace persisted sidebar tree", () => {
  it("derives live order from the current branch's entry time on every fresh sidebar", async () => {
    const old = {
      ...userEntry("old", null, "old"),
      timestamp: "2026-01-02T00:00:00.000Z",
    };
    const recent = {
      ...userEntry("recent", "old", "recent"),
      timestamp: "2026-01-04T00:00:00.000Z",
    };
    const middle = {
      ...userEntry("middle", null, "middle"),
      timestamp: "2026-01-03T00:00:00.000Z",
    };
    // Queue-admission time disagrees with recording time.
    if (recent.type === "message") recent.message.timestamp = 1;
    const world = createFakeWorld({
      sessions: [
        { ...stored("a"), entries: [old, recent], leafId: "old" },
        {
          ...stored("b"),
          entries: [
            middle,
            assistantEntry("answer", "middle", "answer", Date.now()),
          ],
        },
        { ...stored("empty"), entries: [] },
        {
          ...stored("shell"),
          entries: [bashEntry("bash", null, "pwd", "/repo", false)],
        },
        stored("child", "a"),
        stored("saved"),
      ],
    });
    const workspace = createWorkspace(world);
    for (const id of ["a", "b", "empty", "shell"]) await workspace.activate(id);
    const read = vi.spyOn(world.sessions, "read");
    const open = vi.spyOn(world.runtime, "open");
    expect(ids((await workspace.sidebar()).rows)).toEqual([
      "b",
      "a",
      "empty",
      "shell",
      "saved",
    ]);
    const a = world.runtime.get("a");
    if (!a) throw new Error("Missing live session");
    await a.navigateTree("recent");
    expect(ids((await createWorkspace(world).sidebar()).rows)).toEqual([
      "a",
      "b",
      "empty",
      "shell",
      "saved",
    ]);
    const row = (await workspace.sidebar()).rows[0];
    expect(row?.summary.modifiedAt).toBe("2026-01-01T00:00:00.000Z");
    await a.navigateTree("old");
    expect(ids((await workspace.sidebar()).rows).slice(0, 2)).toEqual([
      "b",
      "a",
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("loads metadata only for the requested root or child page", async () => {
    const world = createFakeWorld({
      sessions: [
        ...numbered("root", 60),
        ...numbered("child", 60, "root-000"),
        stored("grandchild", "child-000"),
      ],
    });
    const workspace = createWorkspace(world);
    const metadata = vi.spyOn(world.sessions, "rowMetadata");
    const first = await workspace.sidebar();
    expect(ids(first.rows)).toEqual(
      numbered("root", 50).map((s) => s.summary.id),
    );
    expect(first.nextOffset).toBe(50);
    expect(first.rows[0]).toMatchObject({ childCount: 60 });
    expect(first.rows.every((row) => row.children === undefined)).toBe(true);
    expect(metadata.mock.calls.map(([id]) => id).sort()).toEqual(
      ids(first.rows),
    );
    metadata.mockClear();
    const children = await workspace.sidebar({ parentId: "root-000" });
    expect(children.parentId).toBe("root-000");
    expect(children.nextOffset).toBe(50);
    expect(children.rows).toHaveLength(50);
    expect(children.rows[0]).toMatchObject({
      childCount: 1,
      metadata: { firstMessage: "Question for child-000" },
    });
    expect(children.rows[0]?.children).toBeUndefined();
    expect(metadata.mock.calls.map(([id]) => id).sort()).toEqual(
      ids(children.rows),
    );
    expect(
      ids((await workspace.sidebar({ parentId: "root-000", offset: 50 })).rows),
    ).toEqual(
      numbered("child", 60)
        .slice(50)
        .map((s) => s.summary.id),
    );
  });

  it("preloads only selected ancestry, pins off-page ancestors, and leaves the selected node closed", async () => {
    const world = createFakeWorld({
      sessions: [
        ...numbered("root", 60),
        ...numbered("child", 60, "root-059"),
        stored("selected", "child-059"),
        stored("hidden", "selected"),
        stored("unrelated", "root-000"),
      ],
    });
    const workspace = createWorkspace(world);
    const metadata = vi.spyOn(world.sessions, "rowMetadata");
    const first = await workspace.sidebar({ selectedId: "selected" });
    expect(first.rows).toHaveLength(51);
    const root = first.rows.at(-1);
    expect(root?.summary.id).toBe("root-059");
    expect(root?.children?.rows).toHaveLength(51);
    const ancestor = root?.children?.rows.at(-1);
    expect(ancestor?.summary.id).toBe("child-059");
    expect(ids(ancestor?.children?.rows ?? [])).toEqual(["selected"]);
    expect(ancestor?.children?.rows[0]).toMatchObject({ childCount: 1 });
    expect(ancestor?.children?.rows[0]?.children).toBeUndefined();
    expect(first.rows[0]?.children).toBeUndefined();
    expect(metadata.mock.calls.map(([id]) => id)).not.toContain("hidden");
    expect(metadata.mock.calls.map(([id]) => id)).not.toContain("unrelated");
    expect(
      ids(
        (await workspace.sidebar({ selectedId: "selected", offset: 50 })).rows,
      ),
    ).not.toContain("root-059");
    expect(
      ids(
        (
          await workspace.sidebar({
            selectedId: "selected",
            parentId: "root-059",
            offset: 50,
          })
        ).rows,
      ),
    ).not.toContain("child-059");
  });

  it("counts unreadable siblings in offsets and still pins beyond a completely unreadable first page", async () => {
    const world = createFakeWorld({
      sessions: [...numbered("root", 60), ...numbered("child", 60, "root-059")],
    });
    const sessions = world.sessions;
    world.sessions = {
      ...sessions,
      rowMetadata: (id) => {
        const index = Number(id.split("-").at(-1));
        return index < 50
          ? Promise.resolve(undefined)
          : sessions.rowMetadata(id);
      },
    };
    const workspace = createWorkspace(world);
    const first = await workspace.sidebar({ selectedId: "child-059" });
    expect(ids(first.rows)).toEqual(["root-059"]);
    expect(first.nextOffset).toBe(50);
    expect(ids(first.rows[0]?.children?.rows ?? [])).toEqual(["child-059"]);
    expect(first.rows[0]?.children?.nextOffset).toBe(50);
    const next = await workspace.sidebar({
      selectedId: "child-059",
      offset: 50,
    });
    expect(ids(next.rows)).toEqual(
      numbered("root", 59)
        .slice(50)
        .map((s) => s.summary.id),
    );
    expect(next.nextOffset).toBeUndefined();
    const nextChildren = await workspace.sidebar({
      selectedId: "child-059",
      parentId: "root-059",
      offset: 50,
    });
    expect(ids(nextChildren.rows)).toEqual(
      numbered("child", 59)
        .slice(50)
        .map((s) => s.summary.id),
    );
    expect(nextChildren.nextOffset).toBeUndefined();
  });

  it("rescans after deleting a parent and promotes its surviving subtree without cascading deletion", async () => {
    const world = createFakeWorld({
      sessions: [
        stored("parent"),
        stored("child", "parent"),
        stored("grandchild", "child"),
      ],
    });
    const workspace = createWorkspace(world);
    expect(ids((await workspace.sidebar()).rows)).toEqual(["parent"]);
    await workspace.remove("parent");
    const refreshed = await workspace.sidebar({ selectedId: "grandchild" });
    expect(ids(refreshed.rows)).toEqual(["child"]);
    expect(ids(refreshed.rows[0]?.children?.rows ?? [])).toEqual([
      "grandchild",
    ]);
    expect(
      (await world.sessions.read("child"))?.summary.delegation?.parentSessionId,
    ).toBe("parent");
    expect((await world.sessions.read("grandchild"))?.entries).toHaveLength(1);
    expect(await world.sessions.read("parent")).toBeUndefined();
  });
});
