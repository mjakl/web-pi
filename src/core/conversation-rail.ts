import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { userMessageText } from "./session-entries.ts";
import { preview } from "./transcript.ts";

// The conversation rail: one mark per prompt, star, and compaction, laid out
// as a graph so a branched session shows where it forked. A port of pi-web's
// lib/conversation-rail.ts, fed from the flat entry list instead of a
// compressed tree — web-pi already holds every entry with its parent, so the
// tree walk and the re-expansion of compressed ids are not needed here.

/** How many marks a rail carries at most; older ones are dropped first. */
const MAX_MARKS = 400;

export type RailMark = {
  /** Entry this mark stands for; also the element it scrolls to. */
  id: string;
  /**
   * `junction` is pi-web's structural node: the root, a fork and a branch
   * tip carry a mark even when nothing there is a prompt, which is what puts
   * an inactive branch on the rail and gives it a lane of its own
   * (lib/project-tree.ts keeps exactly those nodes).
   */
  kind: "prompt" | "star" | "compaction" | "junction";
  /** Nearest kept ancestor, for the connector drawn to it. */
  parentId: string | null;
  /** Branch tip to move the session to when this mark is on another branch. */
  targetLeafId: string;
  /** On the branch being viewed. */
  active: boolean;
  /** First 100 characters of the prompt, for the hover popover. */
  preview?: string;
  lane: number;
  row: number;
};

/** pi-web cuts a prompt's hover preview at 100 characters. */
const PREVIEW_CHARS = 100;

/** True as soon as two entries share a parent: the rail can then expand. */
export function hasBranches(entries: readonly SessionEntry[]): boolean {
  const seen = new Set<string | null>();
  for (const entry of entries) {
    if (seen.has(entry.parentId)) return true;
    seen.add(entry.parentId);
  }
  return false;
}

function markKind(
  entry: SessionEntry,
  starred: ReadonlySet<string>,
  active: ReadonlySet<string>,
): RailMark["kind"] | undefined {
  // A compaction or a summary is an anchor of the branch being read
  // (lib/session-reader.ts builds them from that branch alone). Off it, both
  // are only nodes when the graph needs one, which the structural test in
  // `conversationRail` decides: pi-web keeps prompts and stars everywhere,
  // and nothing else.
  const anchor = active.has(entry.id);
  if (anchor && entry.type === "compaction") return "compaction";
  if (starred.has(entry.id)) return "star";
  if (entry.type === "message" && entry.message.role === "user") {
    return "prompt";
  }
  if (
    anchor &&
    entry.type === "branch_summary" &&
    entry.summary.trim() !== ""
  ) {
    return "prompt";
  }
  return undefined;
}

/**
 * Marks for one session, in lanes and rows. The active path keeps lane 0 and
 * every other branch gets a lane of its own; a mark's `targetLeafId` is the
 * deepest mark of its lane, so clicking a branch mark selects the whole
 * branch rather than stranding the session mid-path.
 */
export function conversationRail(
  entries: readonly SessionEntry[],
  leafId: string | null,
  starred: ReadonlySet<string> = new Set(),
): RailMark[] {
  const parents = new Map<string, string | null>();
  for (const entry of entries) parents.set(entry.id, entry.parentId);

  const active = new Set<string>();
  for (
    let current = leafId !== null && parents.has(leafId) ? leafId : null;
    current !== null && !active.has(current);
    current = parents.get(current) ?? null
  ) {
    active.add(current);
  }

  const branched = hasBranches(entries);
  const childCount = new Map<string, number>();
  for (const entry of entries) {
    const parentId = entry.parentId;
    if (parentId === null || !parents.has(parentId)) continue;
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
  }

  const kinds = new Map<string, RailMark["kind"]>();
  for (const entry of entries) {
    const kind = markKind(entry, starred, active);
    if (kind !== undefined) {
      kinds.set(entry.id, kind);
      continue;
    }
    // Everything a linear run passes through is dropped; a root, a fork and
    // a tip stay, so the graph has somewhere to put a branch. A session with
    // no fork gets none of them: pi-web builds its graph from an empty tree
    // there and draws the anchors alone (ChatMinimap.tsx `branched && tree`).
    if (!branched) continue;
    const root = entry.parentId === null || !parents.has(entry.parentId);
    if (root || (childCount.get(entry.id) ?? 0) !== 1) {
      kinds.set(entry.id, "junction");
    }
  }
  // A very long session would otherwise draw thousands of marks into a rail
  // a few hundred pixels tall. The newest ones are the ones worth keeping.
  if (kinds.size > MAX_MARKS) {
    const drop = [...kinds.keys()].slice(0, kinds.size - MAX_MARKS);
    for (const id of drop) kinds.delete(id);
  }

  const previews = new Map<string, string>();
  for (const entry of entries) {
    if (!kinds.has(entry.id)) continue;
    const text = userMessageText(entry);
    if (text !== undefined && text !== "") {
      previews.set(entry.id, preview(text, PREVIEW_CHARS));
    }
  }

  const nodes = new Map<string, RailMark>();
  for (const [id, kind] of kinds) {
    let parentId = parents.get(id) ?? null;
    while (parentId !== null && !kinds.has(parentId)) {
      parentId = parents.get(parentId) ?? null;
    }
    const preview = previews.get(id);
    nodes.set(id, {
      id,
      kind,
      parentId,
      targetLeafId: id,
      active: active.has(id),
      ...(preview === undefined ? {} : { preview }),
      lane: 0,
      row: 0,
    });
  }

  const children = new Map<string | null, RailMark[]>();
  for (const node of nodes.values()) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  // The branch being viewed keeps lane 0 at every fork.
  for (const siblings of children.values()) {
    siblings.sort((a, b) => Number(b.active) - Number(a.active));
  }

  let nextLane = 0;
  const result: RailMark[] = [];
  const pending = (children.get(null) ?? [])
    .map((node) => ({ node, lane: nextLane++, row: 0 }))
    .reverse();
  for (let task = pending.pop(); task; task = pending.pop()) {
    task.node.lane = task.lane;
    task.node.row = task.row;
    result.push(task.node);
    const descendants = children.get(task.node.id) ?? [];
    pending.push(
      ...descendants
        .map((child, index) => ({
          node: child,
          lane: index === 0 ? task.lane : nextLane++,
          row: task.row + 1,
        }))
        .reverse(),
    );
  }

  const tips = new Map<number, string>();
  for (const node of [...result].reverse()) {
    node.targetLeafId = tips.get(node.lane) ?? node.id;
    tips.set(node.lane, node.targetLeafId);
  }
  return result;
}
