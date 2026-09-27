import type { EditableMessage } from "./ports.ts";
import { displaySkillPrompt, recoverSkillPrompt } from "./skill-prompt.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionRowMetadata } from "./sessions.ts";

// Everything the UI derives from a session's raw entries: stars, statistics,
// the branch leaves of the entry tree, and the sidebar row summary. Pure
// functions over what the SessionCatalog read; no file or SDK access.

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
      case "compaction":
      case "branch_summary":
        add(entry.usage);
        break;
      case "message": {
        const { message } = entry;
        if (message.role === "user") userMessages += 1;
        else if (message.role === "toolResult") {
          toolResults += 1;
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

export type BranchLeaf = {
  /** Entry to view or navigate to; the tip of this branch. */
  id: string;
  /** Last user message on the path, as a label. */
  label: string;
  timestamp: string;
  current: boolean;
};

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
  const { content } = entry.message;
  if (typeof content === "string")
    return { ...recoverSkillPrompt(content), images: [] };
  const text: string[] = [];
  const images: EditableMessage["images"] = [];
  for (const value of content) {
    const part = value as unknown as Record<string, unknown>;
    if (!part || typeof part !== "object") continue;
    if (part["type"] === "text" && typeof part["text"] === "string") {
      text.push(part["text"]);
    } else if (part["type"] === "image") {
      // Pi writes flat blocks; older pi-web messages can use Anthropic's source shape.
      const source = part["source"];
      const nested =
        source && typeof source === "object"
          ? (source as Record<string, unknown>)
          : undefined;
      const data = part["data"] ?? nested?.["data"];
      const mimeType = part["mimeType"] ?? nested?.["media_type"];
      if (typeof data === "string" && typeof mimeType === "string") {
        images.push({ data, mimeType });
      }
    }
  }
  return { ...recoverSkillPrompt(text.join("\n")), images };
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
 * One entry per branch tip. A session with no branching has a single leaf, so
 * the switcher only appears once the user actually forked the conversation.
 */
export function branchLeaves(
  entries: readonly SessionEntry[],
  currentLeafId: string | null,
): BranchLeaf[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parents = new Set(
    entries.map((entry) => entry.parentId).filter((id) => id !== null),
  );
  const onCurrentPath = new Set<string>();
  for (
    let entry = currentLeafId === null ? undefined : byId.get(currentLeafId);
    entry;
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
  ) {
    onCurrentPath.add(entry.id);
  }

  const leaves: BranchLeaf[] = [];
  for (const entry of entries) {
    if (parents.has(entry.id)) continue;
    let label = "";
    for (
      let step: SessionEntry | undefined = entry;
      step && !label;
      step = step.parentId === null ? undefined : byId.get(step.parentId)
    ) {
      label = userMessageText(step) ?? "";
    }
    leaves.push({
      id: entry.id,
      label: label.slice(0, 60) || entry.id.slice(0, 8),
      timestamp: entry.timestamp,
      current: onCurrentPath.has(entry.id),
    });
  }
  // The branch being viewed first, then the most recently touched.
  return leaves.sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      b.timestamp.localeCompare(a.timestamp),
  );
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
      else if (!firstMessage) firstMessage = userMessageText(entry) ?? "";
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
