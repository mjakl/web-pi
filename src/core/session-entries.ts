import type { EditableMessage, LiveStatus } from "./ports.ts";
import { displaySkillPrompt, recoverSkillPrompt } from "./skill-prompt.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type SessionRowMetadata, TITLE_CHARS } from "./sessions.ts";
import { contentParts, preview } from "./transcript.ts";

// Everything the UI derives from a session's raw entries: stars, statistics,
// the path to a branch tip, and the sidebar row summary, plus the rules both
// session writers apply: what a star may mark, where a fork ends, what a
// rewind keeps, and when a session is busy. Pure functions over what the
// SessionCatalog read; no file or SDK access.

/** Custom-entry type for web-pi's stars. */
export const STAR_TYPE = "web-pi:star";

type StarData = { targetId: string; starred: boolean };

function starData(entry: SessionEntry): StarData | undefined {
  if (entry.type !== "custom" || entry.customType !== STAR_TYPE) return;
  const data = entry.data;
  if (typeof data !== "object" || data === null) return;
  const { targetId, starred } = data as Partial<StarData>;
  if (typeof targetId !== "string" || typeof starred !== "boolean") return;
  return { targetId, starred };
}

function isAssistantMessage(entry: SessionEntry | undefined): boolean {
  return entry?.type === "message" && entry.message.role === "assistant";
}

/** Stars only ever mark an assistant answer; anything else is refused. */
export function starTarget(entry: SessionEntry | undefined): SessionEntry {
  if (entry === undefined || !isAssistantMessage(entry)) {
    throw new Error("Star target must be an assistant answer");
  }
  return entry;
}

/**
 * Ids of starred answers. Append-only storage: the last write per target wins
 * across every branch, and only assistant messages of this file count.
 */
export function readStars(entries: readonly SessionEntry[]): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const state = new Map<string, boolean>();
  for (const entry of entries) {
    const star = starData(entry);
    if (star) state.set(star.targetId, star.starred);
  }
  const starred = new Set<string>();
  for (const [targetId, on] of state) {
    if (on && isAssistantMessage(byId.get(targetId))) starred.add(targetId);
  }
  return starred;
}

export type SessionStats = {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  /** Time between consecutive entries, ignoring gaps where a human was typing. */
  activeMs: number;
  /** cacheRead / (cacheRead + cacheWrite + input), or null without cache use. */
  cacheHitRate: number | null;
};

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
};

/**
 * Aggregates over *all* entries, including branches and history that was
 * compacted away, so the totals say what the session actually cost.
 */
export function sessionStats(entries: readonly SessionEntry[]): SessionStats {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let cost = 0;
  let activeMs = 0;
  let previous: number | undefined;

  const add = (usage: Usage | undefined) => {
    if (!usage) return;
    tokens.input += usage.input;
    tokens.output += usage.output;
    tokens.cacheRead += usage.cacheRead;
    tokens.cacheWrite += usage.cacheWrite;
    cost += usage.cost?.total ?? 0;
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "usage":
      case "compaction":
      case "branch_summary":
        add(entry.usage);
        break;
      case "message": {
        const { message } = entry;
        if (message.role === "user") userMessages += 1;
        else if (message.role === "toolResult") {
          toolResults += 1;
          add(message.usage);
        } else if (message.role === "assistant") {
          assistantMessages += 1;
          toolCalls += message.content.filter(
            (part) => part.type === "toolCall",
          ).length;
          add(message.usage);
        }
        break;
      }
      default:
        break;
    }
    if (
      entry.type === "message" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary" ||
      entry.type === "custom_message"
    ) {
      const at = Date.parse(entry.timestamp);
      if (!Number.isNaN(at)) {
        // A user prompt or a manual bash command starts a new stretch of work:
        // the gap before it is somebody thinking, not the agent running.
        const resets =
          entry.type === "message" &&
          (entry.message.role === "user" ||
            entry.message.role === "bashExecution");
        if (!resets && previous !== undefined && at > previous) {
          activeMs += at - previous;
        }
        previous = at;
      }
    }
  }

  tokens.total =
    tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const cacheBase = tokens.cacheRead + tokens.cacheWrite + tokens.input;
  return {
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages + toolResults,
    tokens,
    cost,
    activeMs,
    cacheHitRate:
      tokens.cacheRead + tokens.cacheWrite > 0
        ? tokens.cacheRead / cacheBase
        : null,
  };
}

/** Root-first path from an entry to the root, the way Pi walks a branch. */
export function branchTo(
  entries: readonly SessionEntry[],
  leafId: string | null,
): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  for (
    let entry = leafId === null ? undefined : byId.get(leafId);
    entry;
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
  ) {
    path.push(entry);
  }
  return path.reverse();
}

/** Pi's /copy selection rule, retaining source whitespace rather than trimming it. */
export function lastAssistantText(
  branch: readonly SessionEntry[],
): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant")
      continue;
    const message = entry.message;
    if (message.stopReason === "aborted" && message.content.length === 0)
      continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    return text.trim() ? text : undefined;
  }
  return undefined;
}

/** Only user-authored content may become an editable draft, never tool output. */
export function editableUserMessage(
  entry: SessionEntry,
): EditableMessage | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return;
  const text: string[] = [];
  const images: EditableMessage["images"] = [];
  for (const part of contentParts(entry.message.content)) {
    if (part.type === "text" && typeof part.text === "string") {
      text.push(part.text);
    } else if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      images.push({ data: part.data, mimeType: part.mimeType });
    }
  }
  return { ...recoverSkillPrompt(text.join("\n")), images };
}

/**
 * Where a fork from `entry` ends, and what it hands back to edit. Editing a
 * user message reopens the history before it; anything else is copied up to
 * and including itself. The role decides, not the text: a question that is
 * only images is still a question.
 */
export function forkPoint(entry: SessionEntry | undefined): {
  leafId: string;
  draft: EditableMessage;
} {
  if (!entry) throw new Error("Select an existing conversation message");
  const draft = editableUserMessage(entry) ?? { text: "", images: [] };
  const isUserMessage =
    entry.type === "message" && entry.message.role === "user";
  const leafId = isUserMessage ? entry.parentId : entry.id;
  if (leafId === null) {
    throw new Error(
      "Nothing precedes the first message; use New for an empty session.",
    );
  }
  return { leafId, draft };
}

const KEPT_AFTER_REWIND = new Set([
  "session_info",
  "model_change",
  "thinking_level_change",
]);

/**
 * Rewinding to a user message removes it and everything that followed,
 * except the preferences recorded later (name, model, thinking level) and
 * the stars of entries that stay, re-chained after the cut. A marker leaf
 * with `markerId` ends the chain, so the reopened session points before the
 * removed message without resurrecting anything after it. Returns how many
 * entries stay as they are, the entries that follow them, and the removed
 * message for the composer.
 */
export function rewindSelection(
  entries: readonly SessionEntry[],
  entryId: string,
  markerId: string,
): { kept: number; tail: SessionEntry[]; removed: EditableMessage } {
  const index = entries.findIndex((entry) => entry.id === entryId);
  const target = entries[index];
  const removed = target && editableUserMessage(target);
  if (!target || !removed) {
    throw new Error("Rewind requires an existing user message");
  }
  const keptIds = new Set(entries.slice(0, index).map((entry) => entry.id));
  let parentId = target.parentId;
  const tail: SessionEntry[] = [];
  const chain = (entry: SessionEntry) => {
    tail.push({ ...entry, parentId });
    parentId = entry.id;
  };
  for (const entry of entries.slice(index + 1)) {
    const starred = starredId(entry);
    if (KEPT_AFTER_REWIND.has(entry.type)) chain(entry);
    // Both stars and unstars are kept, or an unstar recorded after the cut
    // would leave an earlier star line standing.
    else if (starred !== undefined && keptIds.has(starred)) chain(entry);
  }
  tail.push({
    type: "custom",
    customType: "web-pi-rewind",
    data: {},
    id: markerId,
    parentId,
    timestamp: new Date().toISOString(),
  });
  return { kept: index, tail, removed };
}

/** The entry a star line names, whatever it says about it. */
function starredId(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom" || entry.customType !== STAR_TYPE) return;
  const targetId = (entry.data as { targetId?: unknown } | undefined)?.targetId;
  return typeof targetId === "string" ? targetId : undefined;
}

/** A session is busy while its agent runs or a shell command does. */
export function isBusy(
  status: Pick<LiveStatus, "running" | "bashRunning">,
): boolean {
  return status.running || status.bashRunning;
}

/** Plain text of a user message entry; undefined for anything else. */
export function userMessageText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return;
  const { content } = entry.message;
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(" ");
  return displaySkillPrompt(text).text.replaceAll(/\s+/g, " ").trim();
}

/**
 * The sidebar row rule as a fold, so the streaming reader in the Pi adapter
 * and the in-memory caller apply exactly the same one: the last `session_info`
 * wins, the first user message is the title, and a star only counts while its
 * target is an assistant answer of this file.
 */
export function rowMetadataFold(): {
  add(entry: SessionEntry): void;
  finish(file: { modifiedAt: string; fileSize: number }): SessionRowMetadata;
} {
  const stars = new Map<string, boolean>();
  const answers = new Set<string>();
  let name: string | undefined;
  let firstMessage = "";
  let messageCount = 0;
  return {
    add(entry) {
      if (entry.type === "session_info") {
        const trimmed = entry.name?.trim();
        name = trimmed === "" ? undefined : trimmed;
        return;
      }
      const star = starData(entry);
      if (star) {
        stars.set(star.targetId, star.starred);
        return;
      }
      if (entry.type !== "message") return;
      messageCount += 1;
      if (entry.message.role === "assistant") answers.add(entry.id);
      // Only the title's worth: a cache holds thousands of these rows.
      else if (!firstMessage)
        firstMessage = preview(userMessageText(entry) ?? "", TITLE_CHARS);
    },
    finish(file) {
      let starCount = 0;
      for (const [targetId, starred] of stars) {
        if (starred && answers.has(targetId)) starCount += 1;
      }
      return {
        ...(name ? { name } : {}),
        firstMessage,
        messageCount,
        starCount,
        ...file,
      };
    },
  };
}

/** Sidebar row summary for a session held in memory (see the Pi adapter for files). */
export function rowMetadata(
  entries: readonly SessionEntry[],
  file: { modifiedAt: string; fileSize: number },
): SessionRowMetadata {
  const fold = rowMetadataFold();
  for (const entry of entries) fold.add(entry);
  return fold.finish(file);
}
