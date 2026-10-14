// Everything the composer decides from the text in the box: which slash
// command menu to show, where an `@` token starts and what completing it
// inserts, and where ArrowUp lands in the input history. Pure rules, shared
// by the server (which renders the command menu) and the client bundle
// (which owns the keyboard and the local file index).

import { Fzf } from "fzf";
import type { SkillSelection } from "./ports.ts";

export type SlashSource = "builtin" | "extension" | "prompt" | "skill";

export type SlashCommand = {
  name: string;
  description: string;
  source: SlashSource;
  /** A skill Pi may not invoke on its own; only a person can run it. */
  manual?: boolean;
  /** The discovered skill file identity; absent for non-skill commands. */
  skillId?: string;
  /** Built-ins that still work while a turn is running. */
  whileRunning?: boolean;
};

// The descriptions are pi-web's own (lib/i18n/messages/en.ts, `chat.command*`).
export const BUILTIN_COMMANDS: readonly SlashCommand[] = [
  {
    name: "compact",
    description: "Compress context, optionally with instructions",
    source: "builtin",
  },
  {
    name: "reload",
    description: "Reload extensions, skills, prompts, and tools",
    source: "builtin",
  },
  {
    name: "name",
    description: "Set the session display name",
    source: "builtin",
  },
  {
    name: "session",
    description: "Show session message and token stats",
    source: "builtin",
    whileRunning: true,
  },
  {
    name: "copy",
    description: "Copy the last assistant message",
    source: "builtin",
    whileRunning: true,
  },
  {
    name: "clone",
    description: "Clone the current branch into a new session",
    source: "builtin",
  },
];

/** Text after `/` while the whole value is one word; null closes the menu. */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const rest = value.slice(1);
  return /\s/.test(rest) ? null : rest.toLowerCase();
}

/** Only a leading skill token may be completed after request text exists. */
export function slashCompletionQuery(
  value: string,
  caret: number,
): string | null {
  if (!value.startsWith("/skill:")) return slashQuery(value);
  const separator = value.search(/\s/);
  const end = separator < 0 ? value.length : separator;
  if (caret < 1 || caret > end) return null;
  return value.slice(1, caret).toLowerCase();
}

const SOURCE_ORDER: Record<SlashSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function matchRank(command: SlashCommand, query: string): number {
  const name = command.name.toLowerCase();
  const description = command.description.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

/** Filter by name or description, then rank, source, name. */
export function rankCommands(
  commands: readonly SlashCommand[],
  query: string,
  options: { running?: boolean } = {},
): SlashCommand[] {
  const needle = query.toLowerCase();
  return commands
    .filter(
      (command) =>
        !(options.running && command.source === "builtin") ||
        command.whileRunning === true,
    )
    .filter((command) => matchRank(command, needle) < 4)
    .sort(
      (a, b) =>
        matchRank(a, needle) - matchRank(b, needle) ||
        SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
        collator.compare(a.name, b.name),
    );
}

/** `/name` typed in full: Enter runs it instead of completing the menu. */
export function exactBuiltin(value: string): SlashCommand | undefined {
  const query = slashQuery(value);
  if (query === null) return undefined;
  return BUILTIN_COMMANDS.find((command) => command.name === query);
}

/** A built-in as submitted, `/name Fix it`: its name and trimmed argument. */
export function parseBuiltin(
  text: string,
): { name: string; argument: string } | undefined {
  const [, name = "", argument = ""] =
    /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text) ?? [];
  return BUILTIN_COMMANDS.some((command) => command.name === name)
    ? { name, argument: argument.trim() }
    : undefined;
}

/**
 * Selected skills go with a request or a leading `/skill:` command, never
 * with another slash command or a shell command; this says why not.
 */
export function skillsConflict(text: string): string | undefined {
  const start = text.trimStart();
  return (start.startsWith("/") && !start.startsWith("/skill:")) ||
    start.startsWith("!")
    ? "Remove selected skills before sending a slash or shell command."
    : undefined;
}

export type AtQuery = { start: number; query: string; quoted: boolean };

const QUOTED_AT = /(?:^|\s)@"([^"\n]*)$/;
const PLAIN_AT = /(?:^|\s)@([^\s"]*)$/;

/**
 * The `@` token the caret sits in. `@` must open the text or follow
 * whitespace, so an e-mail address never opens the menu.
 */
export function extractAtQuery(beforeCaret: string): AtQuery | null {
  const quoted = QUOTED_AT.exec(beforeCaret);
  if (quoted?.[1] !== undefined) {
    return {
      start: quoted.index + quoted[0].indexOf("@"),
      query: quoted[1],
      quoted: true,
    };
  }
  const plain = PLAIN_AT.exec(beforeCaret);
  if (plain?.[1] === undefined) return null;
  return {
    start: plain.index + plain[0].indexOf("@"),
    query: plain[1],
    quoted: false,
  };
}

/** `~/`, `/`, `./`, `../`, `C:\`, `\\`: browse the filesystem, not the index. */
export function isFilePathQuery(query: string): boolean {
  return /^(?:~(?:\/|$)|\.{1,2}([\\/]|$)|\/|[a-zA-Z]:[\\/]|\\\\)/.test(query);
}

export type FileEntry = { path: string; isDir: boolean };

/**
 * Completing a directory leaves the token open so the next keystroke drills
 * into it; completing a file closes it with a trailing space.
 */
/** `:12` or `:12-20`, clamped to real line numbers and put back in order. */
function lineSuffix(range: { start: number; end?: number }): string {
  const first = Math.max(1, Math.trunc(range.start));
  const last = Math.max(1, Math.trunc(range.end ?? first));
  const from = Math.min(first, last);
  const to = Math.max(first, last);
  return from === to ? `:${String(from)}` : `:${String(from)}-${String(to)}`;
}

export function buildAtInsertText(
  entry: FileEntry,
  quoted: boolean,
  range?: { start: number; end?: number },
): { text: string; caret: number } {
  const path =
    entry.isDir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
  const quote = quoted || path.includes(" ");
  if (entry.isDir) {
    const text = quote ? `@"${path}"` : `@${path}`;
    return { text, caret: quote ? text.length - 1 : text.length };
  }
  // The range sits inside the quotes, so the whole reference stays one token.
  const token = range === undefined ? path : `${path}${lineSuffix(range)}`;
  const text = quote ? `@"${token}" ` : `@${token} `;
  return { text, caret: text.length };
}

export const AT_RESULT_LIMIT = 20;

/** The best `limit` entries for a query; `"files"` leaves the folders out. */
export type FileSearch = (
  query: string,
  limit?: number,
  only?: "files",
) => FileEntry[];

/**
 * A listing's files and the folders they imply, ranked with fzf's algorithm
 * so the browser and the server order matches alike: abbreviations match
 * across folder and file names, and a `/` in the query has to match one.
 * An empty query and every tie keep one fixed order: shallow first, folders
 * before files, then by path. Built once per listing; the first query
 * prepares the matcher, and each query after it is one pass.
 */
export function fileSearch(files: readonly string[]): FileSearch {
  const folders = new Set<string>();
  for (const file of files) {
    for (
      let at = file.indexOf("/");
      at !== -1;
      at = file.indexOf("/", at + 1)
    ) {
      folders.add(file.slice(0, at));
    }
  }
  const entries = [
    ...[...folders].map((path) => ({ path, isDir: true })),
    ...files.map((path) => ({ path, isDir: false })),
  ]
    .map((entry) => ({ entry, depth: entry.path.split("/").length }))
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(b.entry.isDir) - Number(a.entry.isDir) ||
        a.entry.path.localeCompare(b.entry.path, "en"),
    )
    .map(({ entry }) => entry);
  let matcher: Fzf<FileEntry[]> | undefined;
  return (query, limit = AT_RESULT_LIMIT, only) => {
    let ranked = entries;
    if (query !== "") {
      matcher ??= new Fzf(entries, { selector: (entry) => entry.path });
      ranked = matcher.find(query).map((found) => found.item);
    }
    const wanted =
      only === "files" ? ranked.filter((entry) => !entry.isDir) : ranked;
    return wanted.slice(0, limit);
  };
}

/** ArrowUp walks back through `history` (oldest first); down past 0 exits. */
export function cycleHistory(
  history: readonly string[],
  cycle: number | null,
  direction: "up" | "down",
): { cycle: number | null; text: string } {
  if (history.length === 0) return { cycle: null, text: "" };
  if (direction === "up") {
    const next = Math.min(cycle === null ? 0 : cycle + 1, history.length - 1);
    return { cycle: next, text: history[history.length - 1 - next] ?? "" };
  }
  if (cycle === null || cycle === 0) return { cycle: null, text: "" };
  const next = cycle - 1;
  return { cycle: next, text: history[history.length - 1 - next] ?? "" };
}

/** A sent request as history shows it; `skills` only when it recorded them. */
export type SentRequest = { text: string; skills?: SkillSelection[] };

/**
 * The last 50 distinct requests, oldest first, a repeat keeping its newest
 * place. A request that recorded its skills comes back exactly as typed, and
 * the same words with other skills stay distinct; plain text is trimmed.
 */
export function inputHistory(
  sent: readonly SentRequest[],
  cap = 50,
): Required<SentRequest>[] {
  const seen = new Set<string>();
  const collected: Required<SentRequest>[] = [];
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    const request = sent[index];
    if (!request) continue;
    const skills = request.skills ?? [];
    const text =
      request.skills === undefined ? request.text.trim() : request.text;
    const key = JSON.stringify([text, skills]);
    if ((text === "" && skills.length === 0) || seen.has(key)) continue;
    seen.add(key);
    collected.push({ text, skills });
    if (collected.length === cap) break;
  }
  return collected.reverse();
}

/** `!cmd` runs a shell command; `!!cmd` keeps its output out of context. */
export function bashCommand(
  value: string,
): { command: string; excluded: boolean } | null {
  const text = value.trimStart();
  if (!text.startsWith("!")) return null;
  const excluded = text.startsWith("!!");
  const command = text.slice(excluded ? 2 : 1).trim();
  return command === "" ? null : { command, excluded };
}

/**
 * Whether the page should size itself to the visual viewport instead of the
 * layout one: pi-web's `shouldUseVisualViewportHeight`. Only while an on-screen
 * keyboard is actually covering part of the page — a focused editable, no
 * pinch zoom, and a viewport shorter than the layout — because at every other
 * moment the layout height is the right one and pinning it fights the browser.
 */
export function useVisualViewport(state: {
  focusedEditable: boolean;
  scale: number;
  layoutHeight: number;
  viewportHeight: number;
}): boolean {
  return (
    state.focusedEditable &&
    Math.abs(state.scale - 1) < 0.01 &&
    state.layoutHeight - state.viewportHeight > 1
  );
}

/**
 * The follow-up queue as the composer recalls it. Two halves can hold
 * something at once — the SDK's own queue and the mirror the runtime keeps
 * from `queue_update` — and dropping either would lose a message a reader
 * typed, so they are merged and only exact repeats are dropped.
 */
export function mergeQueue<T extends { text: string; behavior: string }>(
  fromSdk: readonly T[],
  mirrored: readonly T[],
): T[] {
  const key = (message: T) => `${message.behavior}\0${message.text}`;
  const seen = new Set(fromSdk.map(key));
  return [...fromSdk, ...mirrored.filter((message) => !seen.has(key(message)))];
}

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Why an attachment set cannot be sent, or undefined when it can. */
export function imageLimitError(
  images: readonly { mimeType: string; bytes: number }[],
): string | undefined {
  if (images.length > MAX_IMAGES) {
    return `At most ${String(MAX_IMAGES)} images per message.`;
  }
  if (images.some((image) => !image.mimeType.startsWith("image/"))) {
    return "Only images can be attached.";
  }
  if (images.some((image) => image.bytes > MAX_IMAGE_BYTES)) {
    return "Each image must be 10 MB or smaller.";
  }
  return undefined;
}
