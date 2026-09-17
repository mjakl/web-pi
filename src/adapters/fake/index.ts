import { createDirectoryBrowser } from "@adapters/fs/browse";
import {
  DEFAULT_WEB_SETTINGS,
  webSettingsPatch,
  type WebSettingsStore,
} from "@core/web-settings";
import { createFileTree } from "@adapters/fs/file-tree";
import { createWatcher } from "@adapters/fs/watch";
import { createGit } from "@adapters/git/git";
import type { SlashCommand } from "@core/composer";
import {
  createCustomUiHost,
  createDialogHost,
  type DialogAnswer,
  type DialogSpec,
  type FrameComponent,
} from "@core/extension-ui";
import {
  type PackageInfo,
  packageStatus,
  resourceTotals,
} from "@core/packages";
import type { SkillInfo } from "@core/skills";
import { estimateTokens, streamedText } from "@core/transcript";
import type { ProjectInfo, WorktreeInfo } from "@core/workspaces";
import type {
  AgentRuntime,
  DirectoryBrowser,
  ExtensionWidget,
  Files,
  Git,
  LiveEvent,
  LiveSession,
  LiveSnapshot,
  LiveStatus,
  ModelCatalog,
  ModelOption,
  Packages,
  ProjectResolver,
  ProjectTrust,
  ProjectResources,
  PromptInput,
  PushMessage,
  PushNotifier,
  PushSubscription,
  QueuedMessage,
  RunningTool,
  RuntimeEvent,
  SessionCatalog,
  Skills,
  ThinkingLevel,
  ToolView,
  Watcher,
} from "@core/ports";
import {
  readStars,
  rowMetadata,
  STAR_TYPE,
  editableUserMessage,
  userMessageText,
} from "@core/session-entries";
import type { SessionSummary } from "@core/sessions";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

// In-memory implementations of every outbound port. Tests and the
// `WEB_PI_RUNTIME=fake` demo mode use them; no Pi installation is needed.
// Sessions are entry trees here too, so branching and forking behave as they
// do against Pi.

export const FAKE_MODEL: ModelOption = {
  provider: "fake",
  id: "fake-1",
  name: "Fake 1",
  contextWindow: 100_000,
  reasoning: true,
  thinkingLevels: [
    { level: "off", label: "off" },
    { level: "low", label: "brief" },
    { level: "medium", label: "balanced" },
    { level: "high", label: "thorough" },
  ],
};

/**
 * What a scripted answer does, step by step. Enough to exercise the parts of
 * the transcript a plain text reply never reaches: reasoning, tool cards,
 * diffs, and subagent results.
 */
export type ScriptedStep =
  | { thinking: string }
  | { text: string }
  /** An extension status; omit `statusText` to clear it. */
  | { status: string; statusText?: string }
  /** An extension widget; omit `lines` to remove it. */
  | {
      widget: string;
      lines?: string[];
      placement?: ExtensionWidget["placement"];
    }
  /** An extension dialog; the script waits for the answer. */
  | { dialog: DialogSpec }
  /** A title an extension set for the page. */
  | { title: string }
  /** Text an extension pushed into the composer. */
  | { insert: string }
  /** A custom extension UI; the script waits for the component to finish. */
  | { custom: FrameComponent }
  | {
      tool: string;
      arguments?: unknown;
      /** Lines the tool reports while it runs, one per tick. */
      progress?: string[];
      result?: string;
      isError?: boolean;
      details?: unknown;
    };

export type FakeStoredSession = {
  summary: SessionSummary;
  entries: SessionEntry[];
  leafId?: string | null;
};

export function userEntry(
  id: string,
  parentId: string | null,
  text: string,
  images = 0,
): SessionEntry {
  const content =
    images === 0
      ? text
      : [
          { type: "text" as const, text },
          ...Array.from({ length: images }, () => ({
            type: "image" as const,
            // A 1x1 transparent GIF: enough for a thumbnail to render.
            data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            mimeType: "image/gif",
          })),
        ];
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content, timestamp: Date.now() },
  };
}

export function bashEntry(
  id: string,
  parentId: string | null,
  command: string,
  output: string,
  excludeFromContext: boolean,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "bashExecution",
      command,
      output,
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
      excludeFromContext,
    },
  };
}

export function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  contextTokens: number,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: FAKE_MODEL.provider,
      model: FAKE_MODEL.id,
      usage: {
        input: contextTokens - 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: contextTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

function leafOf(stored: FakeStoredSession): string | null {
  return stored.leafId ?? stored.entries.at(-1)?.id ?? null;
}

/** Root-first path to `leafId`, the way SessionManager.getBranch walks it. */
function branchOf(stored: FakeStoredSession, leafId?: string): SessionEntry[] {
  const byId = new Map(stored.entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  let current = byId.get(leafId ?? leafOf(stored) ?? "");
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function touch(stored: FakeStoredSession): void {
  stored.summary = {
    ...stored.summary,
    modifiedAt: new Date().toISOString(),
    fileSize: stored.entries.length,
  };
}

/** Stars only ever mark an assistant answer, as in the Pi adapter. */
function assertAnswer(stored: FakeStoredSession, targetId: string): void {
  const target = stored.entries.find((entry) => entry.id === targetId);
  if (target?.type !== "message" || target.message.role !== "assistant") {
    throw new Error("Star target must be an assistant answer");
  }
}

function starEntry(
  id: string,
  parentId: string | null,
  targetId: string,
  starred: boolean,
): SessionEntry {
  return {
    type: "custom",
    customType: STAR_TYPE,
    data: { targetId, starred },
    id,
    parentId,
    timestamp: new Date().toISOString(),
  };
}

/** A folder is its own project unless the world says otherwise. */
function fakeProject(cwd: string): ProjectInfo {
  return { root: cwd, branch: null, isWorktree: false, isTopLevel: true };
}

export const FAKE_SKILLS: SkillInfo[] = [
  {
    name: "testing",
    description: "How this repository tests things",
    filePath: "/repo/one/.pi/skills/testing/SKILL.md",
    baseDir: "/repo/one/.pi/skills/testing",
    disableModelInvocation: true,
    scope: "project",
  },
  {
    name: "changelog",
    description: "Draft a changelog entry",
    filePath: "/agent/skills/changelog/SKILL.md",
    baseDir: "/agent/skills/changelog",
    disableModelInvocation: false,
    scope: "global",
    install: {
      package: "acme/skills@changelog",
      scope: "global",
      source: "acme/skills",
      sourceType: "github",
      skillsShUrl: "https://skills.sh/acme/skills/changelog",
      skillPath: "changelog/SKILL.md",
      versionHash: "0123456789abcdef0123456789abcdef01234567",
      canCheckForUpdates: true,
    },
  },
];

export const FAKE_PACKAGES: PackageInfo[] = [
  {
    source: "npm:@acme/pi-plugin@1.2.0",
    scope: "user",
    status: "loaded",
    filtered: false,
    disabled: false,
    installedPath: "/agent/npm/node_modules/@acme/pi-plugin",
    packageName: "@acme/pi-plugin",
    version: "1.2.0",
    configuredVersion: "1.2.0",
    resources: [
      {
        kind: "extensions",
        name: "review",
        relativePath: "extensions/review/index.ts",
        path: "/agent/npm/node_modules/@acme/pi-plugin/extensions/review/index.ts",
      },
    ],
  },
];

export const FAKE_SYSTEM_PROMPT = "You are Pi, a coding agent.\n\nBe concise.";

export const FAKE_TOOLS: ToolView[] = [
  {
    name: "read",
    description: "Read a file from disk",
    active: true,
    parameters: [
      {
        name: "path",
        required: true,
        type: "string",
        description: "Absolute path of the file",
      },
      { name: "limit", required: false, type: "number", default: "200" },
    ],
    promptGuidelines: ["Read before you edit."],
  },
  {
    name: "legacy",
    description: "A tool nothing may call this turn",
    active: false,
    parameters: [],
  },
];

export const FAKE_COMMANDS: SlashCommand[] = [
  { name: "review", description: "Review the diff", source: "extension" },
  { name: "changelog", description: "Draft a changelog", source: "prompt" },
  {
    name: "skill:testing",
    description: "How this repository tests things",
    source: "skill",
    manual: true,
  },
];

type Part = Record<string, unknown> & { type: string };

class FakeLiveSession implements LiveSession {
  readonly id: string;
  private partial: Extract<AgentMessage, { role: "assistant" }> | undefined;
  /** When the message now streaming started, for its tokens-per-second. */
  private partialStart: number | null = null;
  private turnStart: number;
  /** A scripted tool call whose arguments are still streaming in. */
  private partialArguments: Record<string, string> | undefined;
  private running = false;
  private compacting = false;
  private bashRunning = false;
  private bash: { command: string; output: string } | undefined;
  private queue: QueuedMessage[] = [];
  private compaction: LiveStatus["compaction"] = null;
  private compactionError: LiveStatus["compactionError"] = null;
  private tools: RunningTool[] = [];
  private retry: LiveStatus["retry"] = null;
  private notices: LiveStatus["notices"] = [];
  private statuses = new Map<string, string>();
  private widgets = new Map<string, ExtensionWidget>();
  private title: string | null = null;
  private editorText: string[] = [];
  private readonly dialogs = createDialogHost(() => {
    this.emit({ type: "activity" });
  });
  private readonly custom = createCustomUiHost(() => {
    this.emit({ type: "activity" });
  });
  private thinkingLevel: ThinkingLevel = "medium";
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private counter = 0;
  /** Set while a scripted custom UI is on screen, cleared when it finishes. */
  private customResolve: (() => void) | undefined;
  private customDone: (() => void) | undefined;

  private readonly stored: FakeStoredSession;
  private readonly script: (prompt: string) => ScriptedStep[];
  private readonly delayMs: number;
  private readonly onStop: () => void;

  constructor(
    stored: FakeStoredSession,
    script: (prompt: string) => ScriptedStep[],
    delayMs: number,
    onStop: () => void,
  ) {
    this.stored = stored;
    this.script = script;
    this.delayMs = delayMs;
    this.onStop = onStop;
    this.id = stored.summary.id;
    this.turnStart = branchOf(stored).length;
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Everything up to here is now canonical settled history. */
  private endTurn(): void {
    this.turnStart = branchOf(this.stored).length;
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.id}-e${String(this.counter + this.stored.entries.length)}`;
  }

  private append(entry: SessionEntry): void {
    this.stored.entries.push(entry);
    this.stored.leafId = entry.id;
    touch(this.stored);
  }

  /** What Pi would report as the tokens in context: the last answer's total. */
  private contextTokens(): number | null {
    const last = [...branchOf(this.stored)]
      .reverse()
      .find(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      );
    return last?.type === "message" && last.message.role === "assistant"
      ? last.message.usage.totalTokens
      : null;
  }

  snapshot(): LiveSnapshot {
    const branch = branchOf(this.stored);
    const contextTokens = this.contextTokens();
    return {
      summary: { ...this.stored.summary, live: true },
      branch,
      entries: [...this.stored.entries],
      turnStart: this.turnStart,
      ...(this.partialArguments === undefined
        ? {}
        : { partialArguments: this.partialArguments }),
      ...(this.partial ? { partial: this.partial } : {}),
      ...(this.bash ? { bash: { ...this.bash } } : {}),
      status: {
        running: this.running,
        compacting: this.compacting,
        bashRunning: this.bashRunning,
        streaming: this.streamingRate(),
        model: FAKE_MODEL,
        thinkingLevel: this.thinkingLevel,
        thinkingLevels: FAKE_MODEL.thinkingLevels ?? [],
        contextTokens,
        contextTokensEstimated: false,
        queue: [...this.queue],
        compaction: this.compaction,
        compactionError: this.compactionError,
        tools: [...this.tools],
        retry: this.retry,
        hasSystemPrompt: FAKE_SYSTEM_PROMPT.length > 0,
        hasActiveTools: FAKE_TOOLS.some((tool) => tool.active),
        statuses: Object.fromEntries(this.statuses),
        widgets: [...this.widgets.values()],
        dialog: this.dialogs.pending(),
        custom: this.custom.frame(),
        title: this.title,
        editorText: [...this.editorText],
        notices: [...this.notices],
      },
    };
  }

  /** The estimate and rate the real runtime reports while a turn streams. */
  private streamingRate(): LiveStatus["streaming"] {
    if (!this.partial || this.partialStart === null) return null;
    const tokens = Math.round(
      estimateTokens(streamedText(this.partial.content)),
    );
    const elapsed = (Date.now() - this.partialStart) / 1000;
    return {
      tokens,
      tokensPerSecond: elapsed > 0.5 && tokens > 0 ? tokens / elapsed : null,
    };
  }

  private setPartial(content: Part[]): void {
    this.partialStart ??= Date.now();
    this.partial = {
      role: "assistant",
      content: content as never,
      api: "openai-responses",
      provider: FAKE_MODEL.provider,
      model: FAKE_MODEL.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.emit({ type: "activity" });
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  /** Store the message the partial has become, and start the next one. */
  private settle(parentId: string | null, content: Part[]): string {
    const id = this.nextId();
    const previous = this.contextTokens() ?? 1000;
    this.partial = undefined;
    this.stored.entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: content as never,
        api: "openai-responses",
        provider: FAKE_MODEL.provider,
        model: FAKE_MODEL.id,
        usage: {
          input: previous + 490,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: previous + 500,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    this.stored.leafId = id;
    touch(this.stored);
    return id;
  }

  /** Play a scripted answer: reasoning, prose, and tool calls with results. */
  private async play(userId: string, steps: ScriptedStep[]): Promise<void> {
    let parentId = userId;
    let content: Part[] = [];
    await this.wait();
    for (const step of steps) {
      if (!this.running) break;
      if ("status" in step) {
        if (step.statusText === undefined) this.statuses.delete(step.status);
        else this.statuses.set(step.status, step.statusText);
        this.emit({ type: "activity" });
        await this.wait();
        continue;
      }
      if ("widget" in step) {
        if (step.lines === undefined) this.widgets.delete(step.widget);
        else {
          this.widgets.set(step.widget, {
            key: step.widget,
            lines: step.lines,
            placement: step.placement ?? "aboveEditor",
          });
        }
        this.emit({ type: "activity" });
        await this.wait();
        continue;
      }
      if ("title" in step) {
        this.title = step.title;
        this.emit({ type: "activity" });
        await this.wait();
        continue;
      }
      if ("insert" in step) {
        this.editorText.push(step.insert);
        this.emit({ type: "activity" });
        await this.wait();
        continue;
      }
      if ("dialog" in step) {
        const answer = await this.dialogs.ask(step.dialog);
        this.notices.push({
          level: "info",
          message: `Dialog answered: ${JSON.stringify(answer)}`,
        });
        this.emit({ type: "activity" });
        await this.wait();
        continue;
      }
      if ("custom" in step) {
        const id = this.custom.open(step.custom, 92);
        this.customDone = () => {
          this.custom.close(id);
        };
        await new Promise<void>((resolve) => {
          this.customResolve = resolve;
        });
        this.customResolve = undefined;
        this.customDone = undefined;
        continue;
      }
      if ("thinking" in step) {
        content.push({ type: "thinking", thinking: step.thinking });
        this.setPartial(content);
        await this.wait();
        continue;
      }
      if ("text" in step) {
        const words = step.text.split(" ");
        for (let shown = 1; shown <= words.length; shown += 1) {
          this.setPartial([
            ...content,
            { type: "text", text: words.slice(0, shown).join(" ") },
          ]);
          await this.wait();
          if (!this.running) return;
        }
        content.push({ type: "text", text: step.text });
        continue;
      }
      const callId = `call-${this.nextId()}`;
      content.push({
        type: "toolCall",
        id: callId,
        name: step.tool,
        arguments: step.arguments ?? {},
      });
      // Arguments arrive as JSON fragments before the call is complete; the
      // card says so until the last one lands.
      const json = JSON.stringify(step.arguments ?? {});
      this.partialArguments = {
        [String(content.length - 1)]: json.slice(0, Math.ceil(json.length / 2)),
      };
      this.setPartial(content);
      await this.wait();
      this.partialArguments = undefined;
      parentId = this.settle(parentId, content);
      content = [];
      for (const line of step.progress ?? []) {
        this.tools = [{ id: callId, name: step.tool, progress: line }];
        this.emit({ type: "activity" });
        await this.wait();
      }
      this.tools = [];
      const resultId = this.nextId();
      this.stored.entries.push({
        type: "message",
        id: resultId,
        parentId,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: step.tool,
          content: [{ type: "text", text: step.result ?? "ok" }],
          ...(step.details === undefined ? {} : { details: step.details }),
          isError: step.isError === true,
          timestamp: Date.now(),
        },
      });
      this.stored.leafId = resultId;
      touch(this.stored);
      parentId = resultId;
      this.emit({ type: "activity" });
    }
    if (content.length > 0) this.settle(parentId, content);
    this.partial = undefined;
    this.partialStart = null;
    this.partialArguments = undefined;
    this.tools = [];
    this.running = false;
    this.endTurn();
    this.emit({ type: "turn_done" });
    this.emit({ type: "completed" });
  }

  prompt(text: string, input: PromptInput = {}): Promise<void> {
    if (this.running) {
      this.queue.push({
        text,
        behavior: input.behavior ?? "steer",
        ...(input.images && input.images.length > 0
          ? { images: input.images }
          : {}),
      });
      this.emit({ type: "activity" });
      return Promise.resolve();
    }
    this.running = true;
    this.compaction = null;
    this.turnStart = branchOf(this.stored).length;
    const userId = this.nextId();
    this.append(
      userEntry(userId, leafOf(this.stored), text, input.images?.length ?? 0),
    );
    this.emit({ type: "activity" });
    void this.play(userId, this.script(text));
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.running = false;
    this.partial = undefined;
    this.partialStart = null;
    this.partialArguments = undefined;
    this.tools = [];
    this.endTurn();
    this.emit({ type: "turn_done" });
    return Promise.resolve();
  }

  setModel(): Promise<void> {
    return Promise.resolve();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.emit({ type: "activity" });
  }

  setName(name: string): void {
    this.stored.summary = { ...this.stored.summary, name };
    this.emit({ type: "activity" });
  }

  setStar(targetId: string, starred: boolean): void {
    assertAnswer(this.stored, targetId);
    this.append(
      starEntry(this.nextId(), leafOf(this.stored), targetId, starred),
    );
    this.emit({ type: "activity" });
  }

  commands(): SlashCommand[] {
    return FAKE_COMMANDS;
  }

  toolDefinitions(): ToolView[] {
    return FAKE_TOOLS;
  }

  systemPrompt(): string {
    return FAKE_SYSTEM_PROMPT;
  }

  compact(instructions?: string): Promise<void> {
    this.compacting = true;
    this.compaction = null;
    this.compactionError = null;
    this.emit({ type: "activity" });
    setTimeout(() => {
      this.compacting = false;
      // "fail" as the instruction is how a test asks for the error path.
      if (instructions === "fail") {
        this.compactionError = "Compaction failed: the model refused.";
        this.emit({ type: "activity" });
        return;
      }
      this.compaction = {
        tokensBefore: 40_000,
        tokensAfter: 8000,
        reason: instructions ?? "manual",
      };
      this.emit({ type: "activity" });
    }, this.delayMs * 4);
    return Promise.resolve();
  }

  abortCompaction(): void {
    this.compacting = false;
    this.emit({ type: "activity" });
  }

  reload(): Promise<void> {
    this.notices.push({ level: "info", message: "Resources reloaded." });
    this.emit({ type: "activity" });
    return Promise.resolve();
  }

  takePending(): void {
    this.notices = [];
    this.editorText = [];
  }

  answerDialog(requestId: string, answer: DialogAnswer): boolean {
    return this.dialogs.answer(requestId, answer);
  }

  /** The scripted component finishes on Enter; anything else redraws it. */
  customInput(requestId: string, data: string): void {
    this.custom.input(requestId, data);
    if (data === "\r" || data === "\n") {
      this.customDone?.();
      this.customResolve?.();
    }
  }

  clearQueue(): QueuedMessage[] {
    const cleared = this.queue;
    this.queue = [];
    this.emit({ type: "activity" });
    return cleared;
  }

  /** Echoes the command back, one chunk at a time, like a real shell run. */
  runBash(command: string, excludeFromContext: boolean): Promise<void> {
    this.bashRunning = true;
    this.turnStart = branchOf(this.stored).length;
    this.bash = { command, output: "" };
    this.emit({ type: "activity" });
    return new Promise((resolve) => {
      let shown = 0;
      const lines = [`${command}: ok`, "done"];
      const tick = () => {
        const line = lines[shown];
        shown += 1;
        if (this.bash && line !== undefined) this.bash.output += `${line}\n`;
        this.emit({ type: "activity" });
        if (shown < lines.length && this.bashRunning) {
          setTimeout(tick, this.delayMs);
          return;
        }
        const output = this.bash?.output ?? "";
        this.bash = undefined;
        this.bashRunning = false;
        this.append(
          bashEntry(
            this.nextId(),
            leafOf(this.stored),
            command,
            output,
            excludeFromContext,
          ),
        );
        this.endTurn();
        this.emit({ type: "turn_done" });
        resolve();
      };
      setTimeout(tick, this.delayMs);
    });
  }

  abortBash(): void {
    this.bashRunning = false;
    this.emit({ type: "activity" });
  }

  navigateTree(targetId: string): Promise<string | undefined> {
    const entry = this.stored.entries.find((item) => item.id === targetId);
    if (!entry) throw new Error("Select an existing conversation message");
    this.stored.leafId = targetId;
    this.turnStart = branchOf(this.stored).length;
    this.emit({ type: "activity" });
    return Promise.resolve(userMessageText(entry));
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): Promise<void> {
    this.dialogs.cancelAll();
    this.custom.closeAll();
    this.customResolve?.();
    this.onStop();
    this.emit({ type: "stopped" });
    this.listeners.clear();
    return Promise.resolve();
  }
}

export type FakeWorld = {
  sessions: SessionCatalog;
  runtime: AgentRuntime;
  models: ModelCatalog;
  projects: ProjectResolver;
  browser: DirectoryBrowser;
  trust: ProjectTrust;
  skills: Skills;
  packages: Packages;
  resources: ProjectResources;
  files: Files;
  git: Git;
  watcher: Watcher;
  push: PushNotifier & { sent: PushMessage[] };
  webSettings: WebSettingsStore;
  tmpdir: string;
  store: Map<string, FakeStoredSession>;
};

export function createFakeWorld(
  options: {
    sessions?: FakeStoredSession[];
    reply?: (prompt: string) => string;
    /** A scripted answer, for turns with reasoning, tools, or subagents. */
    script?: (prompt: string) => ScriptedStep[];
    delayMs?: number;
    files?: string[];
    tmpdir?: string;
    models?: ModelOption[];
    /** Sibling worktrees the picker offers for a folder. */
    worktrees?: (cwd: string) => WorktreeInfo[];
    /** Which repository a folder belongs to: how sessions group by project. */
    projects?: (cwd: string) => ProjectInfo;
    /** Folders whose project resources are gated behind trust. */
    trustRequired?: string[];
    /** Folders that are no longer on disk: their sessions are read-only. */
    missingFolders?: string[];
    skills?: SkillInfo[];
    packages?: PackageInfo[];
  } = {},
): FakeWorld {
  // Every session has a file, as it would under Pi: the statistics panel
  // shows where a conversation lives.
  const withFile = (session: FakeStoredSession): FakeStoredSession => ({
    ...session,
    summary: {
      filePath: `/agent/sessions/${session.summary.id}.jsonl`,
      ...session.summary,
    },
  });
  const store = new Map(
    (options.sessions ?? []).map((session) => [
      session.summary.id,
      withFile(session),
    ]),
  );
  const live = new Map<string, FakeLiveSession>();
  const watchers = new Set<(event: RuntimeEvent) => void>();
  const reply = options.reply ?? ((prompt) => `You said: ${prompt}`);
  const script =
    options.script ?? ((prompt: string) => [{ text: reply(prompt) }]);
  const delayMs = options.delayMs ?? 5;
  const realFiles = createFileTree();
  const gated = new Set(options.trustRequired ?? []);
  const missing = new Set(options.missingFolders ?? []);
  const trusted = new Set<string>();
  const skills = (options.skills ?? FAKE_SKILLS).map((skill) => ({ ...skill }));
  const plugins = (options.packages ?? FAKE_PACKAGES).map((entry) => ({
    ...entry,
  }));
  let subscriptions: PushSubscription[] = [];
  let settings = { ...DEFAULT_WEB_SETTINGS };
  let modelPatterns: string[] | null = null;
  const sent: PushMessage[] = [];
  let created = 0;

  function announce(event: RuntimeEvent): void {
    for (const watcher of watchers) watcher(event);
  }

  function open(stored: FakeStoredSession): FakeLiveSession {
    const session = new FakeLiveSession(stored, script, delayMs, () => {
      live.delete(stored.summary.id);
      announce({ type: "stopped", sessionId: stored.summary.id });
    });
    let wasBusy = false;
    session.subscribe((event) => {
      const busy = session.snapshot().status.running;
      if (busy && !wasBusy)
        announce({ type: "started", sessionId: stored.summary.id });
      wasBusy = busy;
      if (event.type === "turn_done") {
        announce({ type: "finished", sessionId: stored.summary.id });
      }
      if (event.type === "completed") {
        announce({ type: "completed", sessionId: stored.summary.id });
      }
    });
    live.set(stored.summary.id, session);
    announce({ type: "opened", sessionId: stored.summary.id });
    return session;
  }

  function need(id: string): FakeStoredSession {
    const stored = store.get(id);
    if (!stored) throw new Error("Session not found");
    return stored;
  }

  function copyBranch(id: string, leafId: string): string {
    const stored = need(id);
    created += 1;
    const newId = `copy-${String(created)}`;
    const now = new Date().toISOString();
    const entries = branchOf(stored, leafId);
    store.set(newId, {
      summary: {
        ...stored.summary,
        id: newId,
        filePath: `/agent/sessions/${newId}.jsonl`,
        createdAt: now,
        modifiedAt: now,
        fileSize: entries.length,
      },
      entries: entries.map((entry) => ({ ...entry })),
      leafId,
    });
    return newId;
  }

  return {
    store,
    sessions: {
      list: () => Promise.resolve([...store.values()].map((s) => s.summary)),
      folder: (id) => Promise.resolve(store.get(id)?.summary.cwd),
      read: (id, leafId) => {
        const stored = store.get(id);
        return Promise.resolve(
          stored
            ? {
                summary: stored.summary,
                branch: branchOf(stored, leafId),
                entries: [...stored.entries],
                leafId: leafOf(stored),
              }
            : undefined,
        );
      },
      rowMetadata: (id) => {
        const stored = store.get(id);
        return Promise.resolve(
          stored
            ? {
                summary: stored.summary,
                metadata: rowMetadata(stored.entries, {
                  modifiedAt: stored.summary.modifiedAt,
                  fileSize: stored.summary.fileSize,
                }),
              }
            : undefined,
        );
      },
      // A rough stand-in for Pi's context build: every message on the path
      // from the compaction entry, 4 characters to the token.
      contextTokensAt: (_id, entries, entryId) => {
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        let total = 0;
        for (
          let entry = byId.get(entryId);
          entry;
          entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
        ) {
          total += Math.ceil(JSON.stringify(entry).length / 4);
        }
        return total;
      },
      rename: (id, name) => {
        const stored = need(id);
        stored.summary = { ...stored.summary, name };
        return Promise.resolve();
      },
      remove: (id) => {
        need(id);
        store.delete(id);
        return Promise.resolve();
      },
      setStar: (id, targetId, starred) => {
        const stored = need(id);
        assertAnswer(stored, targetId);
        stored.entries.push(
          starEntry(
            `${id}-star${String(stored.entries.length)}`,
            leafOf(stored),
            targetId,
            starred,
          ),
        );
        touch(stored);
        return Promise.resolve();
      },
      fork: (id, entryId) => {
        const stored = need(id);
        const entry = stored.entries.find((item) => item.id === entryId);
        if (!entry) throw new Error("Select an existing conversation message");
        const draft = editableUserMessage(entry) ?? { text: "", images: [] };
        // The role decides, as in the Pi adapter: a question that is only
        // images is still a question, and editing it reopens the history
        // before it.
        const isUserMessage =
          entry.type === "message" && entry.message.role === "user";
        const leafId = isUserMessage ? entry.parentId : entry.id;
        if (leafId === null) {
          throw new Error(
            "Nothing precedes the first message; use New for an empty session.",
          );
        }
        return Promise.resolve({ id: copyBranch(id, leafId), ...draft });
      },
      clone: (id, leafId) => {
        const stored = need(id);
        const leaf = leafId ?? leafOf(stored);
        if (leaf === null) throw new Error("Cannot clone an empty session");
        return Promise.resolve(copyBranch(id, leaf));
      },
      rewind: (id, entryId) => {
        const stored = need(id);
        const index = stored.entries.findIndex((item) => item.id === entryId);
        const target = stored.entries[index];
        const draft = target && editableUserMessage(target);
        if (!target || !draft) {
          throw new Error("Rewind requires an existing user message");
        }
        stored.entries = stored.entries.slice(0, index);
        stored.leafId = target.parentId;
        touch(stored);
        return Promise.resolve(draft);
      },
      exportHtml: (id) => {
        const stored = need(id);
        const starred = readStars(stored.entries).size;
        return Promise.resolve({
          html: `<!doctype html><title>${id}</title><p>${String(stored.entries.length)} entries, ${String(starred)} starred`,
          filename: `pi-session-${id}.html`,
        });
      },
    },
    runtime: {
      get: (id) => live.get(id),
      live: () => [...live.values()],
      subscribeAll(listener) {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
      open(target) {
        if ("sessionId" in target) {
          const existing = live.get(target.sessionId);
          if (existing) return Promise.resolve(existing);
          const stored = store.get(target.sessionId);
          if (!stored)
            return Promise.reject(
              new Error(`Unknown session ${target.sessionId}`),
            );
          return Promise.resolve(open(stored));
        }
        created += 1;
        const now = new Date().toISOString();
        const stored: FakeStoredSession = withFile({
          summary: {
            id: `new-${String(created)}`,
            cwd: target.cwd,
            createdAt: now,
            modifiedAt: now,
            fileSize: 0,
          },
          entries: [],
          leafId: null,
        });
        const session = open(stored);
        // Pi writes a new session's file with its first assistant message
        // (SessionManager._persist); until then only the runtime knows it.
        session.subscribe(() => {
          if (
            !store.has(stored.summary.id) &&
            stored.entries.some(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            )
          ) {
            store.set(stored.summary.id, stored);
          }
        });
        return Promise.resolve(session);
      },
    },
    models: {
      settings: () =>
        Promise.resolve({
          available: options.models ?? [FAKE_MODEL],
          selected: (options.models ?? [FAKE_MODEL]).filter(
            (model) =>
              !modelPatterns?.length ||
              modelPatterns.includes(`${model.provider}/${model.id}`),
          ),
          patterns: modelPatterns,
          projectPatterns: null,
          unavailable: [],
          warnings: [],
        }),
      saveSettings: (_cwd, edit) => {
        if (edit.selected?.length === 0)
          return Promise.reject(
            new Error(
              "Keep at least one available model selected, or choose Use all models.",
            ),
          );
        modelPatterns =
          edit.selected?.map((model) => `${model.provider}/${model.id}`) ?? [];
        return Promise.resolve();
      },
      listAvailable: () => Promise.resolve(options.models ?? [FAKE_MODEL]),
      list: () =>
        Promise.resolve({
          models: (options.models ?? [FAKE_MODEL]).filter(
            (model) =>
              !modelPatterns?.length ||
              modelPatterns.includes(`${model.provider}/${model.id}`),
          ),
          warnings: [],
        }),
      resolveThinking: (_cwd, model, level, continuing) =>
        Promise.resolve(
          model.reasoning
            ? (level ?? (continuing ? undefined : model.pin) ?? "medium")
            : "off",
        ),
      invalidate: () => undefined,
    },
    projects: {
      resolve: (cwd) =>
        Promise.resolve(options.projects?.(cwd) ?? fakeProject(cwd)),
      available: (cwd) => Promise.resolve(!missing.has(cwd)),
      worktrees: (cwd) =>
        Promise.resolve({
          project: options.projects?.(cwd) ?? fakeProject(cwd),
          isGit: true,
          worktrees: options.worktrees?.(cwd) ?? [
            { path: cwd, branch: "main" },
          ],
        }),
    },
    browser: createDirectoryBrowser(),
    trust: {
      status: (cwd) =>
        Promise.resolve({
          requiresTrust: gated.has(cwd),
          trusted: !gated.has(cwd) || trusted.has(cwd),
        }),
      trust: (cwd) => {
        if (gated.has(cwd)) trusted.add(cwd);
        return Promise.resolve();
      },
    },
    skills: {
      list: (cwd) =>
        Promise.resolve({
          skills: [...skills],
          diagnostics: [],
          projectResourcesLoaded: !gated.has(cwd) || trusted.has(cwd),
        }),
      setDisabled: (filePath, disable) => {
        const skill = skills.find((entry) => entry.filePath === filePath);
        if (!skill) throw new Error("Unknown skill");
        skill.disableModelInvocation = disable;
        return Promise.resolve();
      },
      search: (query) =>
        Promise.resolve(
          query === ""
            ? []
            : [
                {
                  package: `acme/skills@${query}`,
                  installs: "1.2K installs",
                  url: "https://skills.sh/acme/skills",
                },
              ],
        ),
      install: (pkg) => Promise.resolve(`Installed ${pkg}`),
      check: () =>
        Promise.resolve(
          skills
            .filter((skill) => skill.install !== undefined)
            .map((skill) => ({
              package: skill.install?.package ?? "",
              scope: skill.install?.scope ?? "global",
              state: "up-to-date" as const,
              currentVersion: skill.install?.versionHash ?? "",
            })),
        ),
      update: (_cwd, pkg) => Promise.resolve(`Updated ${pkg}`),
    },
    packages: {
      list: (cwd) =>
        Promise.resolve({
          packages: [...plugins],
          totals: resourceTotals(plugins),
          diagnostics: [],
          projectResourcesLoaded: !gated.has(cwd) || trusted.has(cwd),
        }),
      run: (action, request) => {
        const source = request.source ?? "";
        const found = plugins.find((entry) => entry.source === source);
        if (action === "install" && !found) {
          plugins.push({
            source,
            scope: request.scope,
            status: "installed",
            filtered: false,
            disabled: false,
            installedPath: `/tmp/${source}`,
            resources: [],
          });
        }
        if (action === "remove" && found) {
          plugins.splice(plugins.indexOf(found), 1);
        }
        if (found && (action === "enable" || action === "disable")) {
          found.disabled = action === "disable";
          found.status = packageStatus({
            disabled: found.disabled,
            resources: found.resources.length,
            ...(found.installedPath === undefined
              ? {}
              : { installedPath: found.installedPath }),
          });
        }
        return Promise.resolve();
      },
    },
    resources: {
      // A stopped session lists extension commands too: the real loader reads
      // them off disk, gated by project trust, rather than resuming an agent.
      commands: () => Promise.resolve(FAKE_COMMANDS),
    },
    files: {
      index: () =>
        Promise.resolve({
          files: [...(options.files ?? ["src/main.ts", "README.md"])],
          truncated: false,
        }),
      children: (query, cwd) =>
        Promise.resolve(
          (options.files ?? ["src/main.ts", "README.md"])
            .map((file) => ({
              path: `${cwd}/${file}`,
              isDir: false,
            }))
            .filter((entry) => entry.path.includes(query.replace(/^\.\//, ""))),
        ),
      readOutput: () => Promise.resolve("full shell output"),
      // The file system itself is never faked: a viewer or a diff is only
      // worth checking against real bytes in a temporary directory.
      list: (directory) => realFiles.list(directory),
      stat: (path) => realFiles.stat(path),
      realpath: (path) => realFiles.realpath(path),
      readText: (path, maxBytes) => realFiles.readText(path, maxBytes),
      stream: (path, range) => realFiles.stream(path, range),
    },
    git: createGit(),
    watcher: createWatcher(),
    webSettings: {
      get: () => ({ ...settings }),
      update: (patch) =>
        (settings = { ...settings, ...webSettingsPatch(patch) }),
    },
    push: {
      sent,
      // A valid public P-256 point, with no private key or external push sender.
      publicKey: () =>
        "BMXGy05tVdLOgy_ESb48d-bhyRPewByAhqioc-LnQqJzSlFP_1d0wOfKbjc1eDyY3hFN3xv2X2RMOmLlJIfiI5o",
      subscribe: (subscription) => {
        subscriptions = subscriptions.filter(
          (known) => known.endpoint !== subscription.endpoint,
        );
        subscriptions.push(subscription);
      },
      has: (subscription) =>
        subscriptions.some(
          (known) =>
            known.endpoint === subscription.endpoint &&
            known.keys.auth === subscription.keys.auth &&
            known.keys.p256dh === subscription.keys.p256dh,
        ),
      unsubscribe: (subscription) => {
        subscriptions = subscriptions.filter(
          (known) =>
            !(
              known.endpoint === subscription.endpoint &&
              known.keys.auth === subscription.keys.auth &&
              known.keys.p256dh === subscription.keys.p256dh
            ),
        );
      },
      send: (message) => {
        if (subscriptions.length > 0) sent.push(message);
        return Promise.resolve();
      },
    },
    tmpdir: options.tmpdir ?? "/tmp",
  };
}
