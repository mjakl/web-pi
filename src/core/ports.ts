import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FileEntry, SlashCommand } from "./composer.ts";
import type {
  CustomFrame,
  DialogAnswer,
  DialogRequest,
} from "./extension-ui.ts";
import type { GitFileStatus } from "./git-status.ts";
import type { PackagesView, PackageScope } from "./packages.ts";
import type { SessionRowMetadata, SessionSummary } from "./sessions.ts";
import type {
  SkillInfo,
  SkillScope,
  SkillSearchHit,
  SkillUpdate,
} from "./skills.ts";
import type { ProjectInfo, WorktreeInfo } from "./workspaces.ts";

// Outbound ports. The core describes what it needs from Pi and the file
// system; adapters in src/adapters implement them. Everything here is an
// Internal interface: all consumers live in this repository.

/** A thinking level plus the label the model gives it. */
export type ThinkingChoice = { level: ThinkingLevel; label: string };

export type ModelOption = {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning: boolean;
  /** Reasoning level pinned for this model by an `enabledModels` pattern. */
  pin?: ThinkingLevel;
  /** The reasoning levels this model offers, for a picker before a session. */
  thinkingLevels?: ThinkingChoice[];
};

export type { ThinkingLevel };

export type SessionRead = {
  summary: SessionSummary;
  /** Entries of the requested branch (the active one by default), root first. */
  branch: SessionEntry[];
  /** Every entry in the file, all branches, for stars, stats, and leaves. */
  entries: SessionEntry[];
  leafId: string | null;
};

/** Pi's session files: read without starting an agent, and edited in place. */
export type SessionCatalog = {
  /** Headers only, so a store with thousands of sessions stays cheap. */
  list(): Promise<SessionSummary[]>;
  /** Working folder from the current header only; undefined if unreadable. */
  folder(id: string): Promise<string | undefined>;
  /** Undefined when the id is unknown. */
  read(id: string, leafId?: string): Promise<SessionRead | undefined>;
  /**
   * One sidebar row: the header summary plus the counts a full pass over the
   * file yields. Cached by size and mtime, so a second visit is free.
   */
  rowMetadata(
    id: string,
  ): Promise<
    { summary: SessionSummary; metadata: SessionRowMetadata } | undefined
  >;
  /**
   * Tokens the context holds right after the compaction at `entryId`: Pi's
   * own context build, estimated the way Pi estimates it. Undefined when the
   * entry is not on a branch that can be rebuilt.
   */
  contextTokensAt(
    sessionId: string,
    entries: readonly SessionEntry[],
    entryId: string,
  ): number | undefined;
  rename(id: string, name: string): Promise<void>;
  /** Deletes the file and re-attaches its children to its own parent. */
  remove(id: string): Promise<void>;
  setStar(id: string, targetId: string, starred: boolean): Promise<void>;
  /** New session file holding the path from root to `entryId`. */
  fork(id: string, entryId: string): Promise<{ id: string } & EditableMessage>;
  /** New session file holding the path from root to a branch tip. */
  clone(id: string, leafId?: string): Promise<string>;
  /** Removes a user message and everything after it. Returns it for editing. */
  rewind(id: string, entryId: string): Promise<EditableMessage>;
  exportHtml(id: string): Promise<{ html: string; filename: string }>;
};

/** Where a working folder belongs: its git top level and checked-out branch. */
export type ProjectResolver = {
  resolve(cwd: string): Promise<ProjectInfo>;
  /**
   * Whether the folder is still a directory on disk. A session whose folder
   * is gone stays readable but may not run anything, so this is asked before
   * every mutating command and is never served from a cache.
   */
  available(cwd: string): Promise<boolean>;
  /**
   * The sibling worktrees of a folder, always freshly probed: the picker is
   * the only caller and a stale list would hide a worktree just created.
   * `isGit` is false when git could not answer at all.
   */
  worktrees(cwd: string): Promise<{
    project: ProjectInfo;
    isGit: boolean;
    worktrees: WorktreeInfo[];
  }>;
};

/** Directories a reader may browse to when picking a working folder. */
export type DirectoryBrowser = {
  /**
   * Immediate subdirectories of a folder, hidden ones included: this lists
   * names only and grants no access to file contents. `path` accepts `~` and
   * defaults to the home directory.
   */
  browse(path?: string): Promise<{
    path: string;
    parentPath: string | null;
    directories: { name: string; path: string }[];
  }>;
};

/** Pi's trust store, shared with the terminal: `<agentDir>/trust.json`. */
export type ProjectTrust = {
  status(cwd: string): Promise<{ requiresTrust: boolean; trusted: boolean }>;
  /** No-op when the folder has no resources that require trust. */
  trust(cwd: string): Promise<void>;
};

/** Skills of a folder, and the registry operations the settings page offers. */
export type Skills = {
  list(cwd: string): Promise<{
    skills: SkillInfo[];
    diagnostics: string[];
    projectResourcesLoaded: boolean;
  }>;
  /** Rewrites one frontmatter line of the skill's own Markdown file. */
  setDisabled(filePath: string, disable: boolean): Promise<void>;
  search(query: string, limit: number): Promise<SkillSearchHit[]>;
  /** Throws with the command's output when the install did not report success. */
  install(pkg: string, scope: SkillScope, cwd: string): Promise<string>;
  check(
    cwd: string,
    target?: { package: string; scope: SkillScope },
  ): Promise<SkillUpdate[]>;
  update(cwd: string, pkg: string, scope: SkillScope): Promise<string>;
};

/** Extension packages: Pi's `packages` setting and its install roots. */
export type Packages = {
  list(cwd: string): Promise<PackagesView>;
  run(
    action: "install" | "remove" | "update" | "enable" | "disable",
    request: { cwd: string; source?: string; scope: PackageScope },
  ): Promise<void>;
};

export type Notice = { level: "info" | "warning" | "error"; message: string };

export type ImageAttachment = { data: string; mimeType: string };

/** A historical user message restored to the composer, without display normalization. */
export type EditableMessage = { text: string; images: ImageAttachment[] };

export type QueuedMessage = {
  text: string;
  behavior: "steer" | "followUp";
  /** Attachments the queued message carried, so a recall keeps them. */
  images?: ImageAttachment[];
};

export type CompactionSummary = {
  tokensBefore: number;
  tokensAfter: number | null;
  reason: string;
};

/** One parameter of a tool, as its JSON Schema describes it. */
export type ToolParameter = {
  name: string;
  required: boolean;
  type: string;
  description?: string;
  enum?: string[];
  default?: string;
};

/** A tool definition, for the panel behind the session header. */
export type ToolView = {
  name: string;
  description: string;
  active: boolean;
  parameters: ToolParameter[];
  promptGuidelines?: string[];
};

/** A tool executing right now, with the last line it reported. */
export type RunningTool = { id: string; name: string; progress?: string };

/** Pi is retrying a failed provider call by itself. */
export type RetryState = {
  attempt: number;
  maxAttempts: number;
  message: string;
};

/** A panel an extension keeps up to date, as lines of terminal output. */
export type ExtensionWidget = {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
};

/**
 * What the message being streamed has produced so far. pi-web counts this in
 * the browser and ticks a meter; web-pi has no such loop, so the runtime
 * counts it and the 100 ms turn re-render carries it (§4.4.2).
 */
export type StreamingRate = {
  /** Estimated tokens: a quarter per character, one per CJK character. */
  tokens: number;
  /** Null until half a second of the message has been streamed. */
  tokensPerSecond: number | null;
};

export type LiveStatus = {
  running: boolean;
  compacting: boolean;
  bashRunning: boolean;
  /** Set while a message is streaming: its size and speed so far. */
  streaming: StreamingRate | null;
  model: ModelOption | null;
  thinkingLevel: ThinkingLevel;
  thinkingLevels: ThinkingChoice[];
  /** Pi's context count, or an estimate of rebuilt messages after compaction. */
  contextTokens: number | null;
  contextTokensEstimated: boolean;
  queue: QueuedMessage[];
  /** The last compaction that finished, for the success strip. */
  compaction: CompactionSummary | null;
  /** Why the last compaction failed: an alert, not a toast that scrolls away. */
  compactionError: string | null;
  /** Tools running right now, for the activity line. */
  tools: RunningTool[];
  /** Set while Pi retries a failed provider call. */
  retry: RetryState | null;
  /**
   * What the two top-bar tabs tint their icons from: pi-web reads both off
   * the agent state it holds (AppShell.tsx L1341, L1406), so a session that
   * is attached says here whether it runs with a prompt and with tools.
   */
  hasSystemPrompt: boolean;
  hasActiveTools: boolean;
  /** Extension status texts keyed by extension-chosen key. */
  statuses: Record<string, string>;
  /** Extension widgets, in the order the extensions registered them. */
  widgets: ExtensionWidget[];
  /** The extension dialog waiting for an answer; only the newest is shown. */
  dialog: DialogRequest | null;
  /** The frame of the extension's custom terminal UI, while one is open. */
  custom: CustomFrame | null;
  /** A title an extension set for this session's page. */
  title: string | null;
  /** Text extensions asked to put in the composer, since the last take. */
  editorText: string[];
  /** Notices raised by extensions or failures since the last take. */
  notices: Notice[];
};

export type LiveSnapshot = {
  summary: SessionSummary;
  /** Every entry on the active branch, root first. */
  branch: SessionEntry[];
  /** Every entry of the session, all branches. */
  entries: SessionEntry[];
  /**
   * Index into `branch` where the current turn begins. It moves to the end of
   * the branch the moment the agent settles, so everything before it is
   * settled history and a re-render after the turn cannot show it twice.
   */
  turnStart: number;
  /** Arguments still streaming in, by index in the partial message's content. */
  partialArguments?: Record<string, string>;
  /** In-progress assistant message while streaming. */
  partial?: Extract<AgentMessage, { role: "assistant" }>;
  /** Shell command running right now, with the output collected so far. */
  bash?: { command: string; output: string };
  status: LiveStatus;
};

export type LiveEvent =
  | { type: "activity" }
  | { type: "turn_done" }
  /** The agent finished a run and the session is idle: worth notifying about. */
  | { type: "completed" }
  | { type: "stopped" };

export type PromptInput = {
  images?: ImageAttachment[];
  /** How to deliver the message while a turn runs. Default: steer. */
  behavior?: "steer" | "followUp";
};

/** One running Pi agent session. A deep module: callers only read
 *  snapshots and send commands; SDK event choreography stays inside. */
export type LiveSession = {
  readonly id: string;
  snapshot(): LiveSnapshot;
  prompt(text: string, input?: PromptInput): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setName(name: string): void;
  setStar(targetId: string, starred: boolean): void;
  /** Move the leaf to another entry. Returns the user text to re-edit, if any. */
  navigateTree(targetId: string): Promise<string | undefined>;
  /** Extension commands, prompt templates, and skills this session knows. */
  commands(): SlashCommand[];
  /** Every configured tool, with the ones this turn may call marked active. */
  toolDefinitions(): ToolView[];
  /** The prompt the model is running with, extension edits included. */
  systemPrompt(): string;
  compact(instructions?: string): Promise<void>;
  abortCompaction(): void;
  reload(): Promise<void>;
  /**
   * Forgets the notices and composer text the last snapshot reported. Only
   * the render that delivers them calls this: a sidebar row reading the same
   * snapshot for one boolean must not swallow a toast.
   */
  takePending(): void;
  /** Answers a pending extension dialog. False when it is already gone. */
  answerDialog(requestId: string, answer: DialogAnswer): boolean;
  /** One keystroke or paste for the open custom extension UI. */
  customInput(requestId: string, data: string): void;
  /** Empties the queue and hands the messages back for the composer. */
  clearQueue(): QueuedMessage[];
  /** Resolves on admission; settlement and later errors arrive through the snapshot/events. */
  runBash(command: string, excludeFromContext: boolean): Promise<void>;
  abortBash(): void;
  subscribe(listener: (event: LiveEvent) => void): () => void;
  stop(): Promise<void>;
};

/**
 * Lifecycle of every live session in this process. `finished` drives the
 * sidebar; `completed` is the narrower "the agent finished a run and is idle"
 * that notifications key off, and never fires for a stop or a shell command.
 */
export type RuntimeEvent = {
  type: "opened" | "started" | "finished" | "completed" | "stopped";
  sessionId: string;
};

export type AgentRuntime = {
  get(sessionId: string): LiveSession | undefined;
  /**
   * Every session this process holds open. Pi writes a new session's file
   * with its first assistant message, so until then this is the only place
   * the session exists.
   */
  live(): LiveSession[];
  /**
   * Resume a persisted session, or create a new one in `cwd`. An explicit
   * model or reasoning level starts the session there and is written back as
   * Pi's default when the session really started on it.
   */
  open(
    target:
      | { sessionId: string }
      | {
          cwd: string;
          model?: { provider: string; modelId: string };
          thinkingLevel?: ThinkingLevel;
        },
  ): Promise<LiveSession>;
  subscribeAll(listener: (event: RuntimeEvent) => void): () => void;
};

/** Models in scope for a folder, plus what `enabledModels` could not resolve. */
export type ModelListing = {
  models: ModelOption[];
  warnings: string[];
  /** `defaultProvider`/`defaultModel` from Pi's settings, when set. */
  preferred?: { provider: string; id: string };
};

export type ModelCatalog = {
  settings(
    cwd: string,
  ): Promise<import("@core/model-settings").ModelSettingsView>;
  saveSettings(
    cwd: string,
    edit: import("@core/model-settings").ModelSettingsEdit,
  ): Promise<void>;
  /** Credential-available models before Pi's cycling scope is applied. */
  listAvailable(cwd: string): Promise<ModelOption[]>;
  list(cwd: string): Promise<ModelListing>;
  /** Preview Pi's effective level without opening a session or writing defaults. */
  resolveThinking(
    cwd: string,
    model: ModelOption,
    level?: ThinkingLevel,
    continuing?: boolean,
  ): Promise<ThinkingLevel>;
  /** After a trust grant or a settings write, the cached listing is stale. */
  invalidate(cwd?: string): void;
};

/**
 * Prompt templates and skills a folder offers, read without starting an
 * agent. Project extensions are never loaded here: listing commands must not
 * run an untrusted repository's code.
 */
export type ProjectResources = {
  commands(cwd: string): Promise<SlashCommand[]>;
};

export type DirEntry = { name: string; isDir: boolean };

export type FileStat = {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
};

/** Files under a working folder, for `@` completion and shell output. */
export type Files = {
  /** Every tracked and untracked file, cwd-relative; capped. */
  index(cwd: string): Promise<{ files: string[]; truncated: boolean }>;
  /**
   * Immediate children matching a path-like query (`~/pro`, `./src/co`),
   * resolved against `cwd`. Absolute paths, capped; the caller decides which
   * of them the requester may see.
   */
  children(query: string, cwd: string): Promise<FileEntry[]>;
  /** A shell-output capture file, capped; throws when it cannot be read. */
  readOutput(path: string): Promise<string>;
  /** Directory children, sorted and filtered by the explorer's ignore list. */
  list(directory: string): Promise<DirEntry[]>;
  /** Undefined when the path does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
  /** The path with every symlink resolved; undefined when it cannot be. */
  realpath(path: string): Promise<string | undefined>;
  /** Complete UTF-8 text. */
  readText(path: string): Promise<string>;
  /** Bytes for a media response, optionally one Range slice. */
  stream(
    path: string,
    range?: { start: number; end: number },
  ): ReadableStream<Uint8Array>;
};

/** One file the working tree changed, as `git status` reports it. */
export type GitChangeFile = {
  /** Absolute, in the platform's own spelling. */
  path: string;
  status: GitFileStatus;
  code: string;
  /** Absolute path a rename or copy came from. */
  original?: string;
};

export type GitStatus = {
  isRepository: boolean;
  root: string | null;
  files: GitChangeFile[];
  additions: number;
  deletions: number;
};

/** Git as the explorer needs it: what changed, and the patch for one file. */
export type Git = {
  status(cwd: string): Promise<GitStatus>;
  /** Null when the file has no diff web-pi can show (binary, too large). */
  diff(cwd: string, file: GitChangeFile): Promise<string | null>;
};

/** One file's changes on disk, for the viewer's live indicator. */
export type Watcher = {
  watch(
    path: string,
    handlers: {
      change(info: { mtime: number; size: number }): void;
      error(): void;
    },
  ): () => void;
};

/** One browser that asked to be told when a session finishes. */
export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushMessage = {
  title: string;
  body: string;
  /** Where clicking the notification goes, relative to the server root. */
  url: string;
  tag: string;
};

/**
 * Web Push, so a closed tab still hears about a finished turn. Keys and
 * subscriptions live in Pi's agent directory; nothing leaves this machine
 * except the encrypted payload the browser's own push service delivers.
 */
export type PushNotifier = {
  /** The VAPID public key, generated and stored on first use. */
  publicKey(): string;
  /** Upsert by endpoint: a browser re-subscribing replaces its old record. */
  subscribe(subscription: PushSubscription): void;
  has(subscription: PushSubscription): boolean;
  unsubscribe(subscription: PushSubscription): void;
  /** Sends to every subscription, dropping the ones the service rejects. */
  send(message: PushMessage): Promise<void>;
};
