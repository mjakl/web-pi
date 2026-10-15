import { resolveUnder } from "./path-access.ts";
import type { RunningTool } from "./ports.ts";
import type {
  AssistantBlock,
  AssistantItem,
  TranscriptItem,
} from "./transcript.ts";

// How a settled transcript is grouped for reading, and what the live turn
// says while it runs. Both are pure rules over projected items.

/** Entries shown on first load; the rest arrives when the reader scrolls up. */
export const PAGE_SIZE = 50;

/** A user message, a compaction, or a branch summary starts a new turn. */
export function isTurnBoundary(item: TranscriptItem): boolean {
  return (
    item.kind === "user" ||
    item.kind === "compaction" ||
    item.kind === "branch_summary"
  );
}

/**
 * Pi's own tools are plain `write` and `edit`, but MCP servers expose the same
 * operations under prefixed or namespaced names.
 */
export function isWriteToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "write" ||
    lower.startsWith("write_") ||
    lower.endsWith(".write") ||
    lower.endsWith("_write")
  );
}

export function isEditToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "edit" ||
    lower.startsWith("edit_") ||
    lower.endsWith(".edit") ||
    lower.endsWith("_edit") ||
    lower.includes("str_replace") ||
    lower.includes("replace_editor")
  );
}

export function isReadToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "read" ||
    lower.startsWith("read_") ||
    lower.endsWith(".read") ||
    lower.endsWith("_read")
  );
}

/**
 * The absolute file a read, write, or edit call names, by Pi's rule: one
 * leading `@` is dropped, and a `~` path is left alone because only Pi's
 * process knows the home folder it meant. The transcript turns it into a
 * link into the file panel; anything else keeps its plain preview.
 */
export function toolFilePath(
  call: { name: string; arguments: unknown },
  cwd = "",
): string | undefined {
  if (
    !isReadToolName(call.name) &&
    !isWriteToolName(call.name) &&
    !isEditToolName(call.name)
  ) {
    return undefined;
  }
  const args = call.arguments;
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const reported = record["file_path"] ?? record["path"];
  if (typeof reported !== "string") return undefined;
  const path = reported.startsWith("@") ? reported.slice(1) : reported;
  if (path === "" || path.startsWith("~")) return undefined;
  // A pattern or a glob is not a file; a path is what the panel can open.
  return /[*?]/.test(path) ? undefined : resolveUnder(cwd, path);
}

/**
 * The files a turn actually wrote: only write/edit calls whose result came
 * back without an error, in first-seen order. A path the answer merely
 * mentions is no evidence that anything was written, so prose is never read.
 */
export function writtenFiles(
  items: readonly TranscriptItem[],
  cwd = "",
): string[] {
  const files: string[] = [];
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    for (const block of item.blocks) {
      if (block.kind !== "tool") continue;
      const { call } = block;
      if (!isWriteToolName(call.name) && !isEditToolName(call.name)) continue;
      if (!call.result || call.result.isError) continue;
      const path = toolFilePath(call, cwd);
      if (path !== undefined && !files.includes(path)) files.push(path);
    }
  }
  return files;
}

export type Turn = {
  boundary?: TranscriptItem;
  /** Thinking, tool calls, and intermediate messages, behind a disclosure. */
  process: TranscriptItem[];
  /** The trailing text of the last assistant message: the answer itself. */
  answer?: AssistantItem;
  /** Anything after the answer, up to the next boundary. */
  trailing: TranscriptItem[];
  /**
   * The ungrouped answer of a page that opens mid-turn: pi-web still offers
   * the star on the last answer it can see (ChatWindow.tsx L1355-L1368).
   */
  loneAnswerId?: string;
  processMessages: number;
  processToolCalls: number;
  /** Files this turn wrote or edited, shown as chips under the answer. */
  written: string[];
  /** Open the disclosure without being asked. */
  expanded: boolean;
};

function isAnswerBlock(block: AssistantBlock): boolean {
  return block.kind === "text" || block.kind === "image";
}

function isEmptyBlock(block: AssistantBlock): boolean {
  if (block.kind === "text") return block.text.trim() === "";
  if (block.kind === "thinking")
    return !block.deferred && block.text.trim() === "";
  return false;
}

function withBlocks(
  item: AssistantItem,
  blocks: AssistantBlock[],
): AssistantItem {
  return { ...item, blocks };
}

/** Drop blocks a settled message would render as blank. */
function cleaned(item: TranscriptItem): TranscriptItem {
  if (item.kind !== "assistant") return item;
  return withBlocks(
    item,
    item.blocks.filter((block) => !isEmptyBlock(block)),
  );
}

function hasAnswerContent(item: TranscriptItem): boolean {
  return item.kind === "assistant" && item.blocks.some(isAnswerBlock);
}

function countToolCalls(items: readonly TranscriptItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind !== "assistant") continue;
    total += item.blocks.filter((block) => block.kind === "tool").length;
  }
  return total;
}

function buildTurn(
  boundary: TranscriptItem | undefined,
  rest: readonly TranscriptItem[],
  cwd: string,
): Turn {
  const items = rest.map(cleaned);
  // pi-web groups a turn under its own question and nothing else: messages a
  // page starts in the middle of belong to no group and are drawn one by one
  // (ChatWindow.tsx L810-L890 keys its groups on the boundary positions). So
  // a window that opens mid-turn shows those messages, not a fold over them.
  if (!boundary) {
    const lone = items.findLast(hasAnswerContent)?.entryId;
    return {
      process: [],
      trailing: items,
      ...(lone === undefined ? {} : { loneAnswerId: lone }),
      processMessages: 0,
      processToolCalls: 0,
      written: [],
      expanded: true,
    };
  }
  const assistants = items
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item.kind === "assistant");
  const finalIndex =
    assistants.findLast((entry) => hasAnswerContent(entry.item))?.index ??
    assistants.at(-1)?.index;

  const written = writtenFiles(items, cwd);
  if (finalIndex === undefined) {
    return {
      boundary,
      process: items,
      trailing: [],
      processMessages: items.length,
      processToolCalls: countToolCalls(items),
      written,
      expanded: true,
    };
  }

  const final = items[finalIndex];
  if (final?.kind !== "assistant") throw new Error("unreachable");
  const lastProcess = final.blocks.findLastIndex(
    (block) => !isAnswerBlock(block),
  );
  const answerBlocks =
    lastProcess === -1 ? final.blocks : final.blocks.slice(lastProcess + 1);
  const processBlocks =
    lastProcess === -1 ? [] : final.blocks.slice(0, lastProcess + 1);

  const process = [...items.slice(0, finalIndex)];
  if (processBlocks.length > 0) {
    const { usage: _usage, ...half } = withBlocks(final, processBlocks);
    process.push({ ...half, processHalf: true });
  }
  const answer =
    answerBlocks.length > 0 ? withBlocks(final, answerBlocks) : undefined;

  return {
    boundary,
    process,
    ...(answer ? { answer } : {}),
    trailing: items.slice(finalIndex + 1),
    processMessages: process.length,
    processToolCalls: countToolCalls(process),
    written,
    // Nothing to fold into, or the reader would lose prose by folding it.
    expanded: answer === undefined || process.some(hasAnswerContent),
  };
}

/**
 * Group a settled transcript into turns: boundary, process, answer, rest.
 * `cwd` resolves the paths tools reported relative to the folder they ran in.
 */
export function groupTurns(items: readonly TranscriptItem[], cwd = ""): Turn[] {
  const turns: Turn[] = [];
  let boundary: TranscriptItem | undefined;
  let rest: TranscriptItem[] = [];
  let started = false;
  for (const item of items) {
    if (isTurnBoundary(item)) {
      if (started || rest.length > 0)
        turns.push(buildTurn(boundary, rest, cwd));
      boundary = item;
      rest = [];
      started = true;
      continue;
    }
    rest.push(item);
  }
  if (started || rest.length > 0) turns.push(buildTurn(boundary, rest, cwd));
  return turns;
}

/**
 * Which answers carry a visible time: the last one before every question, and
 * the last one of the conversation. Timestamps everywhere are noise.
 */
export function timestampedEntries(
  items: readonly TranscriptItem[],
): Set<string> {
  const marked = new Set<string>();
  let pending: string | undefined;
  for (const item of items) {
    if (item.kind === "assistant") pending = item.entryId;
    else if (item.kind === "user" && pending !== undefined) {
      marked.add(pending);
      pending = undefined;
    }
  }
  if (pending !== undefined) marked.add(pending);
  return marked;
}

/**
 * The window of a branch a page shows. `before` pages backwards from an entry
 * already on screen, `through` widens the page until a target entry is in it.
 * The page is the plain tail pi-web asks for (`SESSION_TAIL_DEFAULT`), counted
 * in session entries: one card can stand for several of them (a tool call and
 * its result), so counting cards would put twice pi-web's history on screen.
 * `groupTurns` renders a page that opens mid-turn, so nothing is snapped back
 * to a turn boundary — a session whose last question is thousands of entries
 * back is one turn, and snapping put the whole of it on screen.
 */
export function pageItems(
  items: readonly TranscriptItem[],
  options: {
    /** Reconcile only entries after this settled cursor; empty means root. */
    after?: string;
    before?: string;
    through?: string;
    /** The branch's entry ids, root first, for counting the tail in entries. */
    entryIds?: readonly string[];
  } = {},
): {
  items: TranscriptItem[];
  hasMore: boolean;
  oldestId: string | undefined;
  reset: boolean;
} {
  let reset = false;
  if (options.after !== undefined) {
    const ids = options.entryIds ?? items.map((item) => item.entryId);
    const cursor = options.after === "" ? -1 : ids.indexOf(options.after);
    reset = options.after !== "" && cursor === -1;
    if (!reset) {
      const missing = new Set(ids.slice(cursor + 1));
      const page = items.filter((item) => missing.has(item.entryId));
      return { items: page, hasMore: false, oldestId: page[0]?.entryId, reset };
    }
    // A rewrite removed the delivered cursor. Return a fresh bounded page,
    // explicitly marked for replacement, never append the new branch to it.
  }
  let end = items.length;
  if (options.before !== undefined) {
    const index = items.findIndex((item) => item.entryId === options.before);
    if (index === -1) throw new RangeError("Unknown entry for this branch");
    end = index;
  }
  let start = Math.max(0, end - PAGE_SIZE);
  if (options.entryIds !== undefined && end > 0) {
    const rank = new Map(options.entryIds.map((id, index) => [id, index]));
    const last = rank.get(items[end - 1]?.entryId ?? "");
    if (last !== undefined) {
      const floor = last - PAGE_SIZE + 1;
      start = end;
      while (
        start > 0 &&
        (rank.get(items[start - 1]?.entryId ?? "") ?? 0) >= floor
      ) {
        start -= 1;
      }
    }
  }
  if (options.through !== undefined) {
    const index = items.findIndex((item) => item.entryId === options.through);
    if (index === -1 || index >= end) {
      throw new RangeError("Unknown entry for this branch");
    }
    start = Math.min(start, index);
  }
  const page = items.slice(start, end);
  return {
    items: page,
    hasMore: start > 0,
    oldestId: page[0]?.entryId,
    reset,
  };
}

/**
 * The pulsing line while a turn runs and nothing has streamed yet. Null keeps
 * the status bar's own spinner as the only sign of work.
 */
export function activityLabel(status: {
  bashRunning: boolean;
  tools: readonly RunningTool[];
}): string | null {
  if (status.bashRunning) return "Running command...";
  const names = status.tools.map((tool) => tool.name);
  if (names.length === 0) return null;
  if (names.length === 1) {
    const only = status.tools[0];
    if (!only) return null;
    return only.progress
      ? `Running ${only.name}... ${only.progress}`
      : `Running ${only.name}...`;
  }
  if (names.length <= 3) return `Running ${names.join(", ")}...`;
  return `Running ${names.slice(0, 2).join(", ")} (+${String(names.length - 2)})...`;
}
