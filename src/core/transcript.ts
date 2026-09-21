import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// The conversation as the UI shows it: one item per visible entry on the
// active branch, each carrying the blocks it renders. Tool results are folded
// into the assistant message that requested them, so a turn renders as one
// block. Everything here is a pure projection of session entries.

/** §10: previews, and the point where thinking is fetched on demand. */
const TOOL_PREVIEW_CHARS = 120;
const NOTE_PREVIEW_CHARS = 140;
/**
 * Thinking text kept in the page, newest first. Beyond it a block renders as a
 * placeholder the browser fetches when the reader opens it, so a session with
 * megabytes of reasoning still sends a small page.
 */
const THINKING_INLINE_BUDGET = 20_000;

export type ContentPart = {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
};

export type SubagentCall = {
  agent: string;
  prompt: string;
  model?: string;
  cwd?: string;
  initialContext?: string;
  session?: string;
};

export type SubagentStatus = "completed" | "failed" | "cancelled" | "unknown";

export type SubagentRun = {
  status: SubagentStatus;
  output: string;
  error?: string;
  model?: string;
  cwd?: string;
  captureTruncated: boolean;
  handledWithoutAgent: boolean;
};

/** A recognised `subagent` tool call: its calls and, once done, their runs. */
export type SubagentView = {
  calls: SubagentCall[];
  /** Null when the result exists but does not match the calls it answers. */
  runs: SubagentRun[] | null;
  failed: boolean;
};

export type ToolResultView = {
  /** The entry the result lives in; its images are addressed through it. */
  entryId: string;
  text: string;
  isError: boolean;
  /** Indices of image parts in the result, for the entry image route. */
  images: number[];
  /** A unified patch the tool reported, rendered as a diff instead of text. */
  patch?: string;
  seconds?: number;
};

export type ToolCallView = {
  id: string;
  name: string;
  arguments: unknown;
  /** One line for the collapsed header. */
  preview: string;
  /** Set while the arguments are still streaming in. */
  partialArguments?: string;
  result?: ToolResultView;
  subagent?: SubagentView;
};

export type AssistantBlock =
  | { kind: "text"; text: string }
  | {
      kind: "thinking";
      /** Position among the thinking blocks of this entry. */
      index: number;
      text: string;
      /** True when the text was left out of the page and is fetched on open. */
      deferred: boolean;
      seconds?: number;
    }
  | { kind: "image"; index: number }
  | { kind: "tool"; call: ToolCallView };

export type UserItem = {
  kind: "user";
  entryId: string;
  text: string;
  images: number[];
  timestamp: string;
  /** `/skill:name args` when the text is Pi's skill expansion envelope. */
  command?: string;
};

export type AssistantItem = {
  kind: "assistant";
  entryId: string;
  model: string;
  provider: string;
  blocks: AssistantBlock[];
  stopReason: string;
  errorMessage?: string;
  timestamp: string;
  /**
   * The reasoning/tool half of a final message that was split around its
   * answer. pi-web renders this half without the turn's usage line, timestamp
   * or scroll anchor: all three belong to the answer under the disclosure.
   */
  processHalf?: true;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type CompactionItem = {
  kind: "compaction";
  entryId: string;
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
  tokensBefore: number;
  /** What Pi's context build estimates the compaction left behind. */
  tokensAfter?: number;
  timestamp: string;
};

export type BranchSummaryItem = {
  kind: "branch_summary";
  entryId: string;
  summary: string;
  timestamp: string;
};

export type NoteItem = {
  kind: "note";
  entryId: string;
  customType: string;
  text: string;
  preview: string;
  images: number[];
  details?: string;
  timestamp: string;
};

export type BashItem = {
  kind: "bash";
  entryId: string;
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  /** Capture file holding the full output of a truncated run. */
  outputPath?: string;
  /** A `!!` run: its output never reached the model. */
  excluded: boolean;
  /** Still running: no result pane yet. */
  pending: boolean;
  timestamp: string;
};

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | CompactionItem
  | BranchSummaryItem
  | NoteItem
  | BashItem;

export type Transcript = {
  items: TranscriptItem[];
  /** Last raw content entry, including a result folded into an earlier tool card. */
  contentLeaf: string | null;
  /** Tokens the last completed model call reported for its whole context. */
  lastContextTokens: number | null;
  lastModel: { provider: string; id: string } | null;
  /**
   * Reasoning level the branch last switched to, for the composer's selector
   * before a runtime exists. pi-web reads the same entry (session-reader.ts
   * `getSessionSettings`); null means Pi decides, which the picker calls
   * "auto".
   */
  lastThinking: string | null;
};

export function contentParts(content: unknown): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as ContentPart[]) : [];
}

const CJK = /[　-ヿ㐀-鿿豈-﫿\u{20000}-\u{2fa1f}가-힯]/u;

/**
 * pi-web's `estimateTokens`: a quarter of a token per character, a whole one
 * per CJK character. It is what the streaming header counts with, so the
 * number a reader sees while a message arrives is the same in both.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let rest = 0;
  for (const character of text) {
    if (CJK.test(character)) cjk += 1;
    else rest += 1;
  }
  return cjk + rest / 4;
}

/**
 * The text of a streaming assistant message that counts towards its token
 * estimate: what it has written, thought, and generated as tool arguments.
 */
export function streamedText(content: unknown): string {
  return contentParts(content)
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return part.thinking ?? "";
      if (part.type !== "toolCall") return "";
      const block = part as unknown as { rawInput?: string; input?: unknown };
      return block.rawInput ?? JSON.stringify(block.input ?? {});
    })
    .join("");
}

function contentText(content: unknown): string {
  return contentParts(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function imageIndices(content: unknown): number[] {
  const indices: number[] = [];
  let seen = 0;
  for (const part of contentParts(content)) {
    if (part.type !== "image") continue;
    indices.push(seen);
    seen += 1;
  }
  return indices;
}

function collapse(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Display-only restoration of Pi's skill expansion envelope: the stored text
 * stays the expansion, the header shows the command that produced it.
 */
const SKILL_EXPANSION =
  /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function skillCommand(text: string): string | undefined {
  const match = SKILL_EXPANSION.exec(text);
  if (!match) return undefined;
  const args = match[4];
  return args ? `/skill:${match[1] ?? ""} ${args}` : `/skill:${match[1] ?? ""}`;
}

/** The one line a collapsed tool call shows: its most telling argument. */
export function toolPreview(argumentsValue: unknown): string {
  if (!isRecord(argumentsValue)) {
    const text =
      typeof argumentsValue === "string"
        ? argumentsValue
        : (JSON.stringify(argumentsValue) ?? "");
    return clip(collapse(text), TOOL_PREVIEW_CHARS);
  }
  const named = ["command", "path", "file_path", "pattern", "query"].find(
    (key) => argumentsValue[key] !== undefined,
  );
  const key = named ?? Object.keys(argumentsValue)[0];
  if (key === undefined) return "";
  const value = argumentsValue[key];
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return clip(collapse(text ?? ""), TOOL_PREVIEW_CHARS);
}

const TOOL_PROGRESS_CHARS = 500;

/**
 * The line a running tool shows in the activity label: the last thing its
 * partial result printed, collapsed to one line.
 */
export function toolProgress(partialResult: unknown): string | undefined {
  if (!isRecord(partialResult)) return undefined;
  const text = contentParts(partialResult["content"])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const latest = text
    .split(/\r?\n/)
    .findLast((line) => line.trim() !== "")
    ?.trim();
  if (latest === undefined || latest === "") return undefined;
  const line = collapse(latest);
  return line.length <= TOOL_PROGRESS_CHARS
    ? line
    : `...${line.slice(-(TOOL_PROGRESS_CHARS - 3))}`;
}

/** Trailing `<read-files>` / `<modified-files>` sections of a compaction. */
const TRAILING_FILE_SECTIONS =
  /(?:\r?\n){2,}((?:[ \t]*<(?:read-files|modified-files)>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<\/(?:read-files|modified-files)>[ \t]*(?:\r?\n)?)+)\s*$/;
const FILE_SECTION = /<(read-files|modified-files)>\s*([\s\S]*?)\s*<\/\1>/g;

export function parseCompactionSummary(summary: string): {
  body: string;
  readFiles: string[];
  modifiedFiles: string[];
} {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const match = TRAILING_FILE_SECTIONS.exec(summary);
  const body = match === null ? summary : summary.slice(0, match.index);
  for (const section of (match?.[1] ?? "").matchAll(FILE_SECTION)) {
    const files = (section[2] ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (section[1] === "read-files") readFiles.push(...files);
    else modifiedFiles.push(...files);
  }
  return { body: body.trim(), readFiles, modifiedFiles };
}

/** Recognise the `subagent` calls API; anything else stays a plain tool call. */
export function subagentCalls(
  name: string,
  argumentsValue: unknown,
): SubagentCall[] | null {
  if (name !== "subagent" || !isRecord(argumentsValue)) return null;
  const calls = argumentsValue["calls"];
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const parsed: SubagentCall[] = [];
  for (const call of calls) {
    if (
      !isRecord(call) ||
      typeof call["agent"] !== "string" ||
      call["agent"].trim() === "" ||
      typeof call["prompt"] !== "string"
    ) {
      return null;
    }
    parsed.push({
      agent: call["agent"],
      prompt: call["prompt"],
      ...optional("model", stringOf(call["model"])),
      ...optional("cwd", stringOf(call["cwd"])),
      ...optional("initialContext", stringOf(call["initialContext"])),
      ...optional("session", stringOf(call["session"])),
    });
  }
  return parsed;
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message["role"] !== "assistant") continue;
    const output = contentParts(message["content"])
      .filter((part) => part.type === "text" && (part.text ?? "") !== "")
      .map((part) => part.text ?? "")
      .join("\n\n");
    if (output) return output;
  }
  return "";
}

/**
 * Pair a subagent result with its calls. Only a verified `pi-subagent` result
 * of matching shape is paired; anything else falls back to raw output, so a
 * run is never shown under the wrong agent.
 */
export function subagentRuns(
  calls: readonly SubagentCall[],
  details: unknown,
): SubagentRun[] | null {
  if (!isRecord(details) || details["kind"] !== "pi-subagent") return null;
  const results = details["results"];
  if (!Array.isArray(results) || results.length !== calls.length) return null;
  const runs = new Array<SubagentRun | undefined>(calls.length);
  for (const [position, item] of results.entries()) {
    if (!isRecord(item)) return null;
    const index = item["callIndex"] ?? position;
    const exitCode = item["exitCode"];
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= calls.length ||
      runs[index] !== undefined ||
      item["agent"] !== calls[index]?.agent ||
      !Array.isArray(item["messages"]) ||
      typeof exitCode !== "number" ||
      !Number.isFinite(exitCode)
    ) {
      return null;
    }
    const status: SubagentStatus =
      item["stopReason"] === "aborted"
        ? "cancelled"
        : item["processError"] === true || exitCode > 0
          ? "failed"
          : exitCode === 0
            ? "completed"
            : "unknown";
    const session = isRecord(item["session"]) ? item["session"] : undefined;
    const failure =
      (stringOf(item["errorMessage"]) ?? "") || stringOf(item["stderr"]);
    runs[index] = {
      status,
      output: finalAssistantText(item["messages"]),
      ...(status === "failed" || status === "cancelled"
        ? optional("error", failure)
        : {}),
      ...optional("model", stringOf(item["model"])),
      ...optional("cwd", stringOf(session?.["cwd"])),
      captureTruncated: item["captureTruncated"] === true,
      handledWithoutAgent: item["handledWithoutAgent"] === true,
    };
  }
  return runs.every((run) => run !== undefined) ? runs : null;
}

/** Context tokens as Pi's compaction code counts them for one model call. */
function contextTokensOf(message: AgentMessage): number | undefined {
  if (message.role !== "assistant") return undefined;
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    return undefined;
  }
  const { usage } = message;
  const total =
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return total > 0 ? total : undefined;
}

/** Live-turn rendering reuses this for the partial assistant message. */
export function assistantItem(
  entryId: string,
  message: Extract<AgentMessage, { role: "assistant" }>,
  options: {
    timestamp?: string;
    previousMs?: number;
    /** Arguments still streaming in, by index in the message's content. */
    partialArguments?: Record<string, string>;
  } = {},
): AssistantItem {
  const blocks: AssistantBlock[] = [];
  let thinkingCount = 0;
  let imageCount = 0;
  let index = -1;
  for (const part of contentParts(message.content)) {
    index += 1;
    switch (part.type) {
      case "text":
        blocks.push({ kind: "text", text: part.text ?? "" });
        break;
      case "thinking": {
        const seconds =
          options.previousMs === undefined
            ? 0
            : Math.round((message.timestamp - options.previousMs) / 1000);
        blocks.push({
          kind: "thinking",
          index: thinkingCount,
          text: part.thinking ?? "",
          deferred: false,
          ...(seconds > 0 ? { seconds } : {}),
        });
        thinkingCount += 1;
        break;
      }
      case "image":
        blocks.push({ kind: "image", index: imageCount });
        imageCount += 1;
        break;
      case "toolCall": {
        const call = part as unknown as {
          id: string;
          name: string;
          arguments: unknown;
        };
        const calls = subagentCalls(call.name, call.arguments);
        const streaming = options.partialArguments?.[String(index)];
        blocks.push({
          kind: "tool",
          call: {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            preview: toolPreview(call.arguments),
            ...(streaming === undefined ? {} : { partialArguments: streaming }),
            ...(calls
              ? { subagent: { calls, runs: null, failed: false } }
              : {}),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  const total = contextTokensOf(message);
  return {
    kind: "assistant",
    entryId,
    model: message.model,
    provider: message.provider,
    blocks,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: options.timestamp ?? new Date(message.timestamp).toISOString(),
    ...(total === undefined
      ? {}
      : {
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            total,
          },
        }),
  };
}

/** The unified patch a read/write/edit result reported, if any. */
function resultPatch(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  const patch = details["patch"] ?? details["diff"];
  return typeof patch === "string" && patch.trim() !== "" ? patch : undefined;
}

function attachResult(
  call: ToolCallView,
  entryId: string,
  message: Extract<AgentMessage, { role: "toolResult" }>,
  requestedMs: number | undefined,
): void {
  const seconds =
    requestedMs === undefined
      ? 0
      : Math.round((message.timestamp - requestedMs) / 1000);
  const patch = message.isError ? undefined : resultPatch(message.details);
  call.result = {
    entryId,
    text: contentText(message.content),
    isError: message.isError,
    images: imageIndices(message.content),
    ...optional("patch", patch),
    ...(seconds > 0 ? { seconds } : {}),
  };
  if (call.subagent) {
    call.subagent = {
      calls: call.subagent.calls,
      runs: subagentRuns(call.subagent.calls, message.details),
      failed:
        message.isError ||
        (isRecord(message.details) &&
          message.details["kind"] === "pi-subagent" &&
          message.details["failed"] === true),
    };
  }
}

/**
 * A non-message entry's own clock. Every entry pi-web turns into a chat
 * message counts towards the reasoning duration, hidden ones included, so a
 * note between two turns does not make the next one look minutes long.
 */
function entryMs(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Project the entries of one branch (root first) into transcript items.
 * Entries with no visible representation (model changes, labels, hidden
 * custom messages) are skipped.
 */
export function projectTranscript(branch: readonly SessionEntry[]): Transcript {
  const items: TranscriptItem[] = [];
  const openCalls = new Map<string, ToolCallView>();
  const requestedAt = new Map<string, number>();
  let lastContextTokens: number | null = null;
  let contentLeaf: string | null = null;
  let lastModel: Transcript["lastModel"] = null;
  let lastThinking: string | null = null;
  let previousMs: number | undefined;

  for (const entry of branch) {
    switch (entry.type) {
      case "message": {
        const { message } = entry;
        if (message.role === "user") {
          contentLeaf = entry.id;
          const text = contentText(message.content);
          items.push({
            kind: "user",
            entryId: entry.id,
            text,
            images: imageIndices(message.content),
            timestamp: entry.timestamp,
            ...optional("command", skillCommand(text)),
          });
        } else if (message.role === "assistant") {
          contentLeaf = entry.id;
          const item = assistantItem(entry.id, message, {
            timestamp: entry.timestamp,
            ...(previousMs === undefined ? {} : { previousMs }),
          });
          for (const block of item.blocks) {
            if (block.kind !== "tool") continue;
            openCalls.set(block.call.id, block.call);
            requestedAt.set(block.call.id, message.timestamp);
          }
          const tokens = contextTokensOf(message);
          if (tokens !== undefined) lastContextTokens = tokens;
          lastModel = { provider: message.provider, id: message.model };
          items.push(item);
        } else if (message.role === "toolResult") {
          contentLeaf = entry.id;
          const call = openCalls.get(message.toolCallId);
          if (call) {
            attachResult(
              call,
              entry.id,
              message,
              requestedAt.get(message.toolCallId),
            );
          }
        } else if (message.role === "bashExecution") {
          contentLeaf = entry.id;
          items.push({
            kind: "bash",
            entryId: entry.id,
            command: message.command,
            output: message.output,
            exitCode: message.exitCode ?? null,
            cancelled: message.cancelled,
            truncated: message.truncated,
            ...optional("outputPath", message.fullOutputPath),
            excluded: message.excludeFromContext === true,
            pending: false,
            timestamp: entry.timestamp,
          });
        }
        previousMs = message.timestamp;
        break;
      }
      case "compaction": {
        contentLeaf = entry.id;
        previousMs = entryMs(entry.timestamp);
        const parsed = parseCompactionSummary(entry.summary);
        items.push({
          kind: "compaction",
          entryId: entry.id,
          summary: parsed.body,
          readFiles: parsed.readFiles,
          modifiedFiles: parsed.modifiedFiles,
          tokensBefore: entry.tokensBefore,
          timestamp: entry.timestamp,
        });
        break;
      }
      case "model_change":
        lastModel = { provider: entry.provider, id: entry.modelId };
        break;
      case "thinking_level_change":
        lastThinking = entry.thinkingLevel;
        break;
      case "branch_summary":
        if (entry.summary.trim() !== "") {
          contentLeaf = entry.id;
          previousMs = entryMs(entry.timestamp);
          items.push({
            kind: "branch_summary",
            entryId: entry.id,
            summary: entry.summary,
            timestamp: entry.timestamp,
          });
        }
        break;
      case "custom_message":
        previousMs = entryMs(entry.timestamp);
        if (entry.display) {
          contentLeaf = entry.id;
          const text = contentText(entry.content);
          items.push({
            kind: "note",
            entryId: entry.id,
            customType: entry.customType,
            text,
            preview: clip(collapse(text), NOTE_PREVIEW_CHARS),
            images: imageIndices(entry.content),
            ...optional(
              "details",
              entry.details === undefined
                ? undefined
                : JSON.stringify(entry.details, null, 2),
            ),
            timestamp: entry.timestamp,
          });
        }
        break;
      default:
        break;
    }
  }
  return { items, contentLeaf, lastContextTokens, lastModel, lastThinking };
}

/**
 * Keep the newest reasoning in the page and turn the rest into placeholders
 * the browser fetches on demand. Long sessions are mostly thinking; sending
 * all of it is what makes a transcript page slow.
 */
export function deferThinking(items: readonly TranscriptItem[]): void {
  let budget = THINKING_INLINE_BUDGET;
  for (const item of [...items].reverse()) {
    if (item.kind !== "assistant") continue;
    for (const block of [...item.blocks].reverse()) {
      if (block.kind !== "thinking" || block.text.trim() === "") continue;
      if (budget > 0) {
        budget -= block.text.length;
        continue;
      }
      block.deferred = true;
      block.text = "";
    }
  }
}

/** Plain text of the first user message, for titles and previews. */
export function transcriptTitle(
  transcript: Transcript,
  maxLength = 80,
): string {
  const first = transcript.items.find((item) => item.kind === "user");
  if (!first) return "";
  const line = collapse(first.command ?? first.text);
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}
