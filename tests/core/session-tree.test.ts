import { sessionTree, sessionTreePage } from "@core/session-tree";
import type { SessionSummary } from "@core/sessions";
import { describe, expect, it } from "vitest";

function summary(
  id: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    cwd: `/projects/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    fileSize: 100,
    ...overrides,
  };
}

function child(
  id: string,
  parentSessionId: string,
  overrides: Partial<SessionSummary> = {},
) {
  return summary(id, {
    inspectionOnly: true,
    delegation: { parentSessionId, agent: "coder", handle: id },
    ...overrides,
  });
}

const ids = (nodes: readonly { summary: SessionSummary }[]) =>
  nodes.map((node) => node.summary.id);
const numbered = (prefix: string, count: number, parent?: string) =>
  Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${String(index).padStart(3, "0")}`;
    return parent === undefined ? summary(id) : child(id, parent);
  });

describe("persisted session tree", () => {
  it("uses delegation across folders, never Pi fork ancestry", () => {
    const tree = sessionTree([
      child("grandchild", "child"),
      summary("fork", { parentId: "root" }),
      child("child", "root"),
      summary("root"),
    ]);
    expect(ids(tree.roots)).toEqual(["fork", "root"]);
    expect(ids(tree.byId.get("root")?.children ?? [])).toEqual(["child"]);
    expect(tree.byId.get("grandchild")?.parentId).toBe("child");
    expect(tree.byId.get("fork")?.parentId).toBeUndefined();
  });

  it("removes every cycle edge and promotes orphans while retaining valid descendants", () => {
    const tree = sessionTree([
      child("leaf", "b"),
      child("a", "b"),
      child("b", "c"),
      child("c", "a"),
      child("self", "self"),
      child("orphan", "missing"),
      child("orphan-child", "orphan"),
    ]);
    expect(ids(tree.roots)).toEqual(["a", "b", "c", "orphan", "self"]);
    for (const id of ["a", "b", "c", "self", "orphan"])
      expect(tree.byId.get(id)?.parentId).toBeUndefined();
    expect(ids(tree.byId.get("b")?.children ?? [])).toEqual(["leaf"]);
    expect(ids(tree.byId.get("orphan")?.children ?? [])).toEqual([
      "orphan-child",
    ]);
  });

  it("ranks each sibling subtree by best activity then newest member then id without changing summaries", () => {
    const newer = "2026-02-01T00:00:00.000Z";
    const summaries = [
      summary("dormant", { modifiedAt: newer }),
      summary("live", { live: true }),
      summary("running", { running: true }),
      summary("ancestor"),
      child("worker", "ancestor", { running: true }),
      child("recent", "ancestor", { modifiedAt: newer }),
      child("z", "ancestor"),
      child("a", "ancestor"),
      child("live-child", "ancestor", { live: true }),
    ];
    const before = structuredClone(summaries);
    const tree = sessionTree(summaries);
    expect(ids(tree.roots)).toEqual(["ancestor", "running", "live", "dormant"]);
    expect(ids(tree.byId.get("ancestor")?.children ?? [])).toEqual([
      "worker",
      "live-child",
      "recent",
      "a",
      "z",
    ]);
    expect(summaries).toEqual(before);
    expect(tree.byId.get("ancestor")?.summary).toBe(summaries[3]);
  });

  it("pages 50 roots independently of descendants and 50 children independently of roots", () => {
    const roots = numbered("root", 101);
    const children = numbered("child", 101, "root-000");
    const tree = sessionTree([...roots, ...children]);
    expect(ids(sessionTreePage(tree).nodes)).toEqual(
      roots.slice(0, 50).map((s) => s.id),
    );
    expect(sessionTreePage(tree).nextOffset).toBe(50);
    expect(ids(sessionTreePage(tree, { offset: 100 }).nodes)).toEqual([
      "root-100",
    ]);
    expect(sessionTreePage(tree, { offset: 100 }).nextOffset).toBeUndefined();
    expect(
      ids(sessionTreePage(tree, { parentId: "root-000", offset: 50 }).nodes),
    ).toEqual(children.slice(50, 100).map((s) => s.id));
    expect(
      sessionTreePage(tree, { parentId: "root-000", offset: 50 }).nextOffset,
    ).toBe(100);
    expect(sessionTreePage(tree, { parentId: "missing" }).nodes).toEqual([]);
  });

  it("pins the entire off-page selection path and omits pins from subsequent sibling pages", () => {
    const tree = sessionTree([
      ...numbered("root", 60),
      ...numbered("child", 60, "root-059"),
      child("selected", "child-059"),
    ]);
    const options = { selectedId: "selected" };
    const first = sessionTreePage(tree, options);
    expect(ids(first.nodes)).toEqual([
      ...numbered("root", 50).map((s) => s.id),
      "root-059",
    ]);
    expect([...first.selectedPath].sort()).toEqual([
      "child-059",
      "root-059",
      "selected",
    ]);
    expect(
      ids(sessionTreePage(tree, { ...options, offset: 50 }).nodes),
    ).toEqual(
      numbered("root", 59)
        .slice(50)
        .map((s) => s.id),
    );
    const children = sessionTreePage(tree, {
      ...options,
      parentId: "root-059",
    });
    expect(children.nodes).toHaveLength(51);
    expect(ids(children.nodes).at(-1)).toBe("child-059");
    expect(
      ids(
        sessionTreePage(tree, { ...options, parentId: "root-059", offset: 50 })
          .nodes,
      ),
    ).not.toContain("child-059");
  });
});
