// Everything the composer decides from the text in the box: which slash
// command menu to show, where an `@` token starts and what completing it
// inserts, and where ArrowUp lands in the input history. Pure rules, shared
// by the server (which renders the command menu) and the client bundle
// (which owns the keyboard and the local file index).

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

function depth(path: string): number {
  return path.split("/").length;
}

/** Files plus the directories they imply, shallow first. */
export function buildEntriesFromFiles(files: readonly string[]): FileEntry[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  const entries: FileEntry[] = [
    ...[...directories].map((path) => ({ path, isDir: true })),
    ...files.map((path) => ({ path, isDir: false })),
  ];
  return entries.sort(
    (a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path),
  );
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/** Higher is better; 0 means "not a match". */
export function scoreEntry(entry: FileEntry, query: string): number {
  const needle = query.toLowerCase();
  const path = entry.path.toLowerCase();
  const base = path.slice(path.lastIndexOf("/") + 1);
  let score = 0;
  if (needle.includes("/")) {
    if (path === needle) score = 100;
    else if (path.startsWith(needle)) score = 80;
    else if (path.includes(needle)) score = 50;
    else if (isSubsequence(needle, path)) score = 10;
  } else if (base === needle) score = 100;
  else if (base.startsWith(needle)) score = 80;
  else if (base.includes(needle)) score = 50;
  else if (path.includes(needle)) score = 30;
  else if (isSubsequence(needle, base)) score = 10;
  return score > 0 && entry.isDir ? score + 10 : score;
}

export const AT_RESULT_LIMIT = 20;

export function filterFileEntries(
  entries: readonly FileEntry[],
  query: string,
  limit = AT_RESULT_LIMIT,
): FileEntry[] {
  if (query === "") return entries.slice(0, limit);
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((scored) => scored.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        depth(a.entry.path) - depth(b.entry.path) ||
        a.entry.path.localeCompare(b.entry.path, "en"),
    )
    .slice(0, limit)
    .map((scored) => scored.entry);
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

/** Last 50 distinct user texts, oldest first, newest kept on a repeat. */
export function inputHistory(texts: readonly string[], cap = 50): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index]?.trim() ?? "";
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    collected.push(text);
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
