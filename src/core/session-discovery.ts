import {
  SESSION_TREE_PAGE_SIZE,
  compareSessionTreeScores,
  sessionTree,
  type SessionTree,
} from "@core/session-tree";
import type { SessionSummary } from "@core/sessions";

export type SessionDiscoveryOptions = {
  offset?: number;
  selectedId?: string;
  /** All known runtimes, including ones not yet flushed to disk. */
  runtime: readonly SessionSummary[];
  /** Exact descendants within this parent's header creation bound. */
  parentId?: string;
};
export type SessionDiscovery = {
  summaries: SessionSummary[];
};

/** Lower times must dominate upper times, with the tree's actual ID tie break. */
function outranks(time: string, id: string, upper: string, otherId: string) {
  return time > upper || (time === upper && id.localeCompare(otherId) < 0);
}

function certified(
  tree: SessionTree,
  unread: { upperTime: string; bestId: string } | undefined,
  k: number,
) {
  if (!unread) return true;
  if (tree.roots.length <= k) return false; // One extra root proves cursor existence only.
  const { upperTime, bestId } = unread;
  const selected = tree.roots.slice(0, k);
  const score = (id: string) => {
    const value = tree.scores.get(id);
    if (!value) throw new Error("Missing discovery score");
    return value;
  };
  const dominates = (leftId: string, rightId: string) => {
    const left = score(leftId),
      right = score(rightId);
    return (
      left.rank !== right.rank ||
      outranks(
        left.modifiedAt,
        leftId,
        right.modifiedAt > upperTime ? right.modifiedAt : upperTime,
        rightId,
      )
    );
  };
  for (let i = 1; i < selected.length; i += 1) {
    const earlier = selected[i - 1],
      later = selected[i];
    if (earlier && later && !dominates(earlier.summary.id, later.summary.id))
      return false;
  }
  const last = selected.at(-1);
  if (!last) return false;
  const id = last.summary.id;
  for (const outside of tree.roots.slice(k)) {
    if (!dominates(id, outside.summary.id)) return false;
  }
  if (score(id).rank === 2) {
    if (!outranks(score(id).modifiedAt, id, upperTime, bestId)) return false;
  }
  return true;
}

/**
 * Header identities are authoritative, but never themselves classified rows.
 * Root requests resolve runtime and selected ancestry first, then certify the
 * prefix. Child requests classify the parent's creation window completely.
 * Both retain concrete ancestor/copy closure for the same tree protections.
 */
export async function discoverSessionRoots(
  headers: readonly SessionSummary[],
  classify: (header: SessionSummary) => Promise<SessionSummary | undefined>,
  options: SessionDiscoveryOptions,
  unflushed: readonly SessionSummary[] = [],
): Promise<SessionDiscovery> {
  const byId = new Map<string, SessionSummary[]>();
  for (const header of headers) {
    const copies = byId.get(header.id) ?? [];
    copies.push(header);
    byId.set(header.id, copies);
  }
  const duplicate = byId.size !== headers.length;
  const runtimeHeaders = new Set(unflushed);
  for (const summary of unflushed) {
    if (!byId.has(summary.id)) byId.set(summary.id, [summary]);
  }
  const seen = new Set<SessionSummary>();
  const classified = new Map<SessionSummary, SessionSummary>();
  const summaries: SessionSummary[] = [];
  async function resolve(id: string | undefined) {
    // Include every copy of a concrete identity, even outside the creation
    // window, so bounded discovery preserves the last-duplicate rule.
    const pending = [...(byId.get(id ?? "") ?? [])];
    while (pending.length > 0) {
      const header = pending.pop();
      if (!header || seen.has(header)) continue;
      seen.add(header);
      const summary = runtimeHeaders.has(header)
        ? header
        : await classify(header);
      if (!summary) continue;
      classified.set(header, summary);
      summaries.push(summary);
      pending.push(
        ...(byId.get(summary.delegation?.parentSessionId ?? "") ?? []),
      );
    }
  }
  const ordered = (runtime: readonly SessionSummary[]) => ({
    summaries: [
      ...runtime,
      ...headers.flatMap((header) => {
        const summary = classified.get(header);
        return summary ? [summary] : [];
      }),
    ],
  });
  if (options.parentId !== undefined) {
    await resolve(options.parentId);
    const parent = (byId.get(options.parentId) ?? [])
      .map((header) => classified.get(header))
      .filter((summary) => summary !== undefined)
      .at(-1);
    if (!parent) return { summaries: [] };
    const cutoff = Date.parse(parent.createdAt);
    const eligibleRuntime = unflushed.filter(
      (summary) => Date.parse(summary.createdAt) >= cutoff,
    );
    for (const summary of eligibleRuntime) await resolve(summary.id);
    for (const header of headers) {
      if (Date.parse(header.createdAt) >= cutoff) await resolve(header.id);
    }
    // All valid descendants are in the window. Older bodies are read only
    // for concrete ancestry/copy context, including cycle detection.
    return ordered(unflushed.filter((summary) => classified.has(summary)));
  }
  for (const summary of unflushed) await resolve(summary.id);
  for (const runtime of options.runtime) await resolve(runtime.id);
  await resolve(options.selectedId);
  if (duplicate) {
    for (const header of headers) await resolve(header.id);
    // Seed resolution must not change the tree's existing last-duplicate rule.
    return ordered(unflushed);
  }
  const sorted = [...headers].sort(
    (a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt) || a.id.localeCompare(b.id),
  );
  const k =
    Math.max(0, Math.floor(options.offset ?? 0)) + SESSION_TREE_PAGE_SIZE;
  // Suffix IDs include seeded ancestors already seen further down the list.
  // This is a conservative unknown-ID bound: ties may read more, never less.
  const bestIds: string[] = [];
  let bestId: string | undefined;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const header = sorted[i];
    if (!header) continue;
    if (bestId === undefined || header.id.localeCompare(bestId) < 0)
      bestId = header.id;
    bestIds[i] = bestId;
  }
  const rebuild = () => {
    const tree = sessionTree(summaries);
    return { ...tree, byId: new Map(tree.byId), scores: new Map(tree.scores) };
  };
  let tree = rebuild();
  let cursor = 0;
  for (;;) {
    while (cursor < sorted.length) {
      const header = sorted[cursor];
      if (!header || !seen.has(header)) break;
      cursor += 1;
    }
    const next = sorted[cursor];
    const idBound = bestIds[cursor];
    const bound =
      next && idBound !== undefined
        ? { upperTime: next.modifiedAt, bestId: idBound }
        : undefined;
    if (certified(tree, bound, k)) return { summaries };
    const before = summaries.length;
    await resolve(next?.id);
    const added = summaries.slice(before);
    if (added.some((summary) => summary.delegation !== undefined)) {
      tree = rebuild();
      continue;
    }
    // With unique IDs and ancestor closure, an edge-free new node cannot
    // acquire previously discovered children. Insert independent roots without
    // rebuilding the entire growing tree on an ambiguous all-archive scan.
    for (const summary of added) {
      const single = sessionTree([summary]);
      const node = single.roots[0],
        score = single.scores.get(summary.id);
      if (!node || !score)
        throw new Error("Missing independent discovery root");
      let low = 0,
        high = tree.roots.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const other = tree.roots[mid];
        const otherScore = other && tree.scores.get(other.summary.id);
        if (!other || !otherScore)
          throw new Error("Missing discovery root score");
        if (
          compareSessionTreeScores(
            score,
            summary.id,
            otherScore,
            other.summary.id,
          ) < 0
        )
          high = mid;
        else low = mid + 1;
      }
      tree.roots.splice(low, 0, node);
      tree.byId.set(summary.id, node);
      tree.scores.set(summary.id, score);
    }
  }
}
