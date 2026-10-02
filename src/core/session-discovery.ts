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
  /** Explicit child expansion needs all incoming edges. */
  exhaustive?: boolean;
};
export type SessionDiscovery = {
  summaries: SessionSummary[];
  /** False means every row's incoming children may still be incomplete. */
  complete: boolean;
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
 * Resolve runtime and selected ancestry first. Each later candidate gets the
 * same ancestor closure, so unread files can only add stored members/roots.
 */
export async function discoverSessionRoots(
  headers: readonly SessionSummary[],
  classify: (header: SessionSummary) => Promise<SessionSummary | undefined>,
  options: SessionDiscoveryOptions,
  unflushed: readonly SessionSummary[] = [],
): Promise<SessionDiscovery> {
  const byId = new Map(headers.map((header) => [header.id, header]));
  const duplicate = byId.size !== headers.length;
  const seen = new Set<SessionSummary>();
  const classified = new Map<SessionSummary, SessionSummary>();
  const summaries: SessionSummary[] = [...unflushed];
  async function resolve(header: SessionSummary | undefined) {
    // Iteration handles long ancestry and cycles without consuming the stack.
    let cursor = header;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const summary = await classify(cursor);
      if (!summary) break;
      classified.set(cursor, summary);
      summaries.push(summary);
      cursor = byId.get(summary.delegation?.parentSessionId ?? "");
    }
  }
  for (const summary of unflushed)
    await resolve(byId.get(summary.delegation?.parentSessionId ?? ""));
  for (const runtime of options.runtime) await resolve(byId.get(runtime.id));
  await resolve(byId.get(options.selectedId ?? ""));
  if (duplicate || options.exhaustive) {
    for (const header of headers) await resolve(header);
    // Seed resolution must not change the tree's existing last-duplicate rule.
    return {
      summaries: [
        ...unflushed,
        ...headers.flatMap((header) => {
          const summary = classified.get(header);
          return summary ? [summary] : [];
        }),
      ],
      complete: true,
    };
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
    if (certified(tree, bound, k))
      return { summaries, complete: next === undefined };
    const before = summaries.length;
    await resolve(next);
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
