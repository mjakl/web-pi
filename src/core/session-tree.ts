import type { SessionSummary } from "@core/sessions";

export type SessionTreeNode = {
  summary: SessionSummary;
  children: SessionTreeNode[];
  parentId?: string;
};

export type SessionTree = {
  roots: SessionTreeNode[];
  byId: ReadonlyMap<string, SessionTreeNode>;
};

/** Delegation is the only edge: Pi's parentId describes a fork, not a child. */
export function sessionTree(summaries: readonly SessionSummary[]): SessionTree {
  const byId = new Map<string, SessionTreeNode>(
    summaries.map((summary) => [summary.id, { summary, children: [] }]),
  );
  const parents = new Map<string, string>();
  for (const summary of summaries) {
    const parent = summary.delegation?.parentSessionId;
    if (parent && parent !== summary.id && byId.has(parent)) {
      parents.set(summary.id, parent);
    }
  }

  // Remove every edge within each cycle, rather than choosing an arbitrary
  // member to promote. Valid descendants of those members remain attached.
  const visited = new Set<string>();
  for (const id of byId.keys()) {
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | undefined = id;
    while (cursor !== undefined && !visited.has(cursor)) {
      const cycle = positions.get(cursor);
      if (cycle !== undefined) {
        for (const member of path.slice(cycle)) parents.delete(member);
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor);
    }
    for (const member of path) visited.add(member);
  }

  const roots: SessionTreeNode[] = [];
  const scores = new Map<string, { rank: number; modifiedAt: string }>();
  const remaining = new Map<string, number>();
  for (const [id, node] of byId) {
    const parentId = parents.get(id);
    const parent = parentId === undefined ? undefined : byId.get(parentId);
    if (parent && parentId !== undefined) {
      node.parentId = parentId;
      parent.children.push(node);
    } else roots.push(node);
    scores.set(id, {
      rank: node.summary.running ? 0 : node.summary.live ? 1 : 2,
      modifiedAt: node.summary.modifiedAt,
    });
  }
  const ready: SessionTreeNode[] = [];
  for (const [id, node] of byId) {
    remaining.set(id, node.children.length);
    if (node.children.length === 0) ready.push(node);
  }
  const compare = (a: SessionTreeNode, b: SessionTreeNode) => {
    const left = scores.get(a.summary.id);
    const right = scores.get(b.summary.id);
    if (!left || !right) throw new Error("Missing session tree rank");
    return (
      left.rank - right.rank ||
      right.modifiedAt.localeCompare(left.modifiedAt) ||
      a.summary.id.localeCompare(b.summary.id)
    );
  };
  // Leaves first avoids recursive walks even for deeply nested delegation.
  for (const node of ready) {
    node.children.sort(compare);
    const parentId = node.parentId;
    if (parentId === undefined) continue;
    const score = scores.get(node.summary.id);
    const parentScore = scores.get(parentId);
    const parent = byId.get(parentId);
    if (!score || !parentScore || !parent)
      throw new Error("Missing session tree parent");
    parentScore.rank = Math.min(parentScore.rank, score.rank);
    if (score.modifiedAt > parentScore.modifiedAt) {
      parentScore.modifiedAt = score.modifiedAt;
    }
    const left = (remaining.get(parentId) ?? 0) - 1;
    remaining.set(parentId, left);
    if (left === 0) ready.push(parent);
  }
  roots.sort(compare);
  return { roots, byId };
}

export type SessionTreePageOptions = {
  offset?: number;
  parentId?: string;
  selectedId?: string;
};

/** A page counts siblings, not descendants or unreadable row metadata. */
export function sessionTreePage(
  tree: SessionTree,
  options: SessionTreePageOptions = {},
) {
  const siblings =
    options.parentId === undefined
      ? tree.roots
      : (tree.byId.get(options.parentId)?.children ?? []);
  const selectedPath = new Set<string>();
  let selected =
    options.selectedId === undefined
      ? undefined
      : tree.byId.get(options.selectedId);
  while (selected) {
    selectedPath.add(selected.summary.id);
    selected =
      selected.parentId === undefined
        ? undefined
        : tree.byId.get(selected.parentId);
  }
  const pinned = siblings.findIndex((node) =>
    selectedPath.has(node.summary.id),
  );
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const next = offset + 50;
  const nodes = siblings
    .slice(offset, next)
    .filter((node) => offset === 0 || pinned < 50 || node !== siblings[pinned]);
  const pinnedNode = siblings[pinned];
  if (offset === 0 && pinned >= 50 && pinnedNode) nodes.push(pinnedNode);
  return {
    nodes,
    selectedPath,
    ...(next < siblings.length ? { nextOffset: next } : {}),
  };
}
