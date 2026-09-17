import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  type WebSettingsStore,
} from "@core/web-settings";
import { mergeQueue, type SlashCommand } from "@core/composer";
import type {
  AgentRuntime,
  ToolView,
  ExtensionWidget,
  ImageAttachment,
  LiveEvent,
  LiveSession,
  LiveSnapshot,
  LiveStatus,
  ModelOption,
  PromptInput,
  QueuedMessage,
  RunningTool,
  RuntimeEvent,
  ThinkingChoice,
  ThinkingLevel,
} from "@core/ports";
import type { DialogAnswer } from "@core/extension-ui";
import {
  initialModel,
  initialThinking,
  startupWrites,
  type StartupChoice,
} from "@core/models";
import { createCompletionTracker } from "@core/turn-completion";
import { toolParameters } from "@core/tools";
import { estimateTokens, streamedText, toolProgress } from "@core/transcript";
import { STAR_TYPE } from "@core/session-entries";
import type { SessionSummary } from "@core/sessions";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionEvent,
  type BashOperations,
  createAgentSessionFromServices,
  createAgentSessionServices,
  estimateTokens as estimateMessageTokens,
  type InlineExtension,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, writeFileSync } from "node:fs";
import {
  createProjectBashExtension,
  createProjectBashOperations,
  preferUserBashExtension,
} from "./bash-env.ts";
import { createExtensionUi } from "./extension-ui.ts";
import { projectTrustReloadOptions } from "./project-trust.ts";
import { resolveModelListing } from "./model-catalog.ts";
import { defaultSessionDir, type PiSessionCatalog } from "./session-catalog.ts";

/** Streaming tool arguments kept for the card; the entry holds the rest. */
const PARTIAL_ARGUMENT_CHARS = 4096;

type Partial = Extract<AgentMessage, { role: "assistant" }>;

/** Below this much of a message, a rate says more about the first chunk. */
const MIN_RATE_SECONDS = 0.5;

/** Pi defers the first file until an assistant reply; shell-only turns need it too. */
function persistShellSession(manager: SessionManager): void {
  const file = manager.getSessionFile();
  if (!file || existsSync(file)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Session header is missing");
  writeFileSync(
    file,
    `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  // Match pi-web's flush: subsequent SDK appends must not recreate the file.
  (manager as unknown as { flushed: boolean }).flushed = true;
}

class PiLiveSession implements LiveSession {
  readonly id: string;
  private partial: Partial | undefined;
  /** When the message now streaming started, for its tokens-per-second. */
  private partialStart: number | null = null;
  private readonly partialArguments = new Map<string, string>();
  /** Attachments of messages waiting in the SDK's queue, keyed by their text. */
  private readonly queuedImages = new Map<string, ImageAttachment[]>();
  private turnStart: number;
  private compacting = false;
  private queue: QueuedMessage[] = [];
  private compaction: LiveStatus["compaction"] = null;
  private compactionError: LiveStatus["compactionError"] = null;
  private bash: { command: string; output: string } | undefined;
  private bashTask: Promise<void> | undefined;
  private pendingPrompts = 0;
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, ExtensionWidget>();
  private readonly tools = new Map<string, RunningTool>();
  private retry: LiveStatus["retry"] = null;
  private notices: LiveStatus["notices"] = [];
  private readonly listeners = new Set<(event: LiveEvent) => void>();
  private readonly unsubscribe: () => void;

  private readonly run = createCompletionTracker();
  private title: string | null = null;
  private editorText: string[] = [];

  private readonly inner: AgentSession;
  private readonly agentDir: string;
  private readonly shellPath: string | undefined;
  private readonly bashOperations: BashOperations | undefined;
  private readonly onStop: () => void;

  constructor(
    inner: AgentSession,
    options: {
      agentDir: string;
      shellPath?: string;
      bashOperations?: BashOperations;
    },
    onStop: () => void,
  ) {
    this.inner = inner;
    this.agentDir = options.agentDir;
    this.shellPath = options.shellPath;
    this.bashOperations = options.bashOperations;
    this.onStop = onStop;
    this.id = inner.sessionId;
    this.turnStart = inner.sessionManager.getBranch().length;
    this.unsubscribe = inner.subscribe((event) => {
      this.handle(event);
    });
  }

  readonly ui = createExtensionUi({
    notify: (level, message) => {
      this.notices.push({ level, message });
      this.emit({ type: "activity" });
    },
    setStatus: (key, text) => {
      if (text === undefined) this.statuses.delete(key);
      else this.statuses.set(key, text);
      this.emit({ type: "activity" });
    },
    setWidget: (key, lines, placement) => {
      if (lines === undefined) this.widgets.delete(key);
      else this.widgets.set(key, { key, lines, placement });
      this.emit({ type: "activity" });
    },
    setTitle: (title) => {
      this.title = title;
      this.emit({ type: "activity" });
    },
    insertEditorText: (text) => {
      this.editorText.push(text);
      this.emit({ type: "activity" });
    },
    changed: () => {
      this.emit({ type: "activity" });
    },
  });

  private handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        this.partialArguments.clear();
        this.partialStart = Date.now();
        if (event.message.role === "assistant") this.partial = event.message;
        this.emit({ type: "activity" });
        break;
      case "message_update":
        if (event.message.role === "assistant") this.partial = event.message;
        this.collectArguments(event.assistantMessageEvent);
        this.emit({ type: "activity" });
        break;
      case "message_end":
        this.partial = undefined;
        this.partialStart = null;
        this.partialArguments.clear();
        this.emit({ type: "activity" });
        break;
      case "tool_execution_start":
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
        });
        this.emit({ type: "activity" });
        break;
      case "tool_execution_update": {
        const progress = toolProgress(event.partialResult);
        this.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          ...(progress === undefined ? {} : { progress }),
        });
        this.emit({ type: "activity" });
        break;
      }
      case "tool_execution_end":
        this.tools.delete(event.toolCallId);
        this.emit({ type: "activity" });
        break;
      case "auto_retry_start":
        this.retry = {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          message: event.errorMessage,
        };
        this.emit({ type: "activity" });
        break;
      case "auto_retry_end":
        this.retry = null;
        this.emit({ type: "activity" });
        break;
      case "compaction_start":
        this.compacting = true;
        this.compactionError = null;
        this.emit({ type: "activity" });
        break;
      case "compaction_end":
        this.compacting = false;
        if (event.errorMessage) {
          this.compactionError = event.errorMessage;
        } else if (event.result && !event.aborted) {
          this.compaction = {
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.estimatedTokensAfter ?? null,
            reason: event.reason,
          };
        }
        this.emit({ type: "activity" });
        break;
      case "queue_update": {
        // The SDK reports the queue as texts; the attachments that came with
        // them are this wrapper's to remember, or a recall loses them.
        const queued = (
          behavior: "steer" | "followUp",
          texts: readonly string[],
        ) =>
          texts.map((text): QueuedMessage => {
            const images = this.queuedImages.get(text);
            return {
              text,
              behavior,
              ...(images === undefined ? {} : { images }),
            };
          });
        this.queue = [
          ...queued("steer", event.steering),
          ...queued("followUp", event.followUp),
        ];
        const live = new Set(this.queue.map((message) => message.text));
        for (const text of this.queuedImages.keys()) {
          if (!live.has(text)) this.queuedImages.delete(text);
        }
        this.emit({ type: "activity" });
        break;
      }
      case "bash_execution_update":
        if (this.bash) this.bash.output += event.delta;
        this.emit({ type: "activity" });
        break;
      case "agent_settled":
        this.partial = undefined;
        this.partialArguments.clear();
        this.tools.clear();
        this.retry = null;
        this.endTurn();
        this.emit({ type: "turn_done" });
        if (this.run.settled(this.busy)) this.emit({ type: "completed" });
        break;
      case "agent_start":
        this.run.start();
        this.emit({ type: "activity" });
        break;
      case "agent_end":
      case "entry_appended":
      case "session_info_changed":
      case "thinking_level_changed":
        this.emit({ type: "activity" });
        break;
      default:
        break;
    }
  }

  /**
   * A tool call's arguments arrive as JSON fragments before the call is
   * complete. Keeping the first few kilobytes is enough for the card to show
   * what is being generated; the whole thing lands in the entry anyway.
   */
  private collectArguments(event: {
    type: string;
    contentIndex?: number;
    delta?: string;
  }): void {
    if (typeof event.contentIndex !== "number") return;
    const key = String(event.contentIndex);
    if (event.type === "toolcall_start") this.partialArguments.set(key, "");
    else if (event.type === "toolcall_delta") {
      const collected = this.partialArguments.get(key) ?? "";
      if (collected.length < PARTIAL_ARGUMENT_CHARS) {
        this.partialArguments.set(key, collected + (event.delta ?? ""));
      }
    } else if (event.type === "toolcall_end") {
      this.partialArguments.delete(key);
    }
  }

  /** Everything up to here is now canonical settled history. */
  private endTurn(): void {
    this.turnStart = this.inner.sessionManager.getBranch().length;
  }

  private emit(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private summary(): SessionSummary {
    const manager = this.inner.sessionManager;
    const file = manager.getSessionFile();
    let modifiedAt = new Date().toISOString();
    let fileSize = 0;
    if (file) {
      try {
        const info = statSync(file);
        modifiedAt = info.mtime.toISOString();
        fileSize = info.size;
      } catch {
        // A brand-new session has no file until Pi flushes it.
      }
    }
    const header = manager.getHeader();
    const name = this.inner.sessionName;
    return {
      id: this.id,
      cwd: manager.getCwd(),
      ...(name ? { name } : {}),
      createdAt: header?.timestamp ?? modifiedAt,
      modifiedAt,
      fileSize,
      ...(file === undefined ? {} : { filePath: file }),
      live: true,
    };
  }

  /**
   * What the message being streamed has produced. pi-web runs a 300 ms timer
   * in the browser for this; here the turn's own re-render is the timer, so
   * the numbers are simply read off the partial message when it is rendered.
   */
  private streamingRate(): LiveStatus["streaming"] {
    if (!this.partial || this.partialStart === null) return null;
    const tokens = Math.round(
      estimateTokens(streamedText(this.partial.content)),
    );
    const elapsed = (Date.now() - this.partialStart) / 1000;
    return {
      tokens,
      tokensPerSecond:
        elapsed > MIN_RATE_SECONDS && tokens > 0 ? tokens / elapsed : null,
    };
  }

  private status(): LiveStatus {
    const model = this.inner.model;
    const option: ModelOption | null = model
      ? {
          provider: model.provider,
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          reasoning: model.reasoning,
        }
      : null;
    const labels = model?.thinkingLevelMap;
    const context = this.inner.getContextUsage();
    // Pi withholds usage after compaction because retained assistants still
    // report the old context. Estimate the rebuilt messages, not their usage.
    const contextTokensEstimated = context?.tokens === null;
    const contextTokens = contextTokensEstimated
      ? this.inner.messages.reduce(
          (sum, message) => sum + estimateMessageTokens(message),
          0,
        )
      : (context?.tokens ?? null);
    return {
      running: this.inner.isStreaming,
      compacting: this.compacting,
      bashRunning: this.bash !== undefined || this.inner.isBashRunning,
      streaming: this.streamingRate(),
      model: option,
      thinkingLevel: this.inner.thinkingLevel,
      thinkingLevels: this.inner
        .getAvailableThinkingLevels()
        .map((level): ThinkingChoice => ({
          level,
          label: labels?.[level] ?? level,
        })),
      contextTokens,
      contextTokensEstimated,
      queue: this.queue,
      compaction: this.compaction,
      compactionError: this.compactionError,
      tools: [...this.tools.values()],
      retry: this.retry,
      hasSystemPrompt: this.inner.systemPrompt !== "",
      hasActiveTools: this.inner.getActiveToolNames().length > 0,
      statuses: Object.fromEntries(this.statuses),
      widgets: [...this.widgets.values()],
      dialog: this.ui.dialog(),
      custom: this.ui.frame(),
      title: this.title,
      editorText: [...this.editorText],
      notices: [...this.notices],
    };
  }

  snapshot(): LiveSnapshot {
    return {
      summary: this.summary(),
      branch: this.inner.sessionManager.getBranch(),
      entries: this.inner.sessionManager.getEntries(),
      turnStart: this.turnStart,
      ...(this.partialArguments.size > 0
        ? { partialArguments: Object.fromEntries(this.partialArguments) }
        : {}),
      ...(this.partial ? { partial: this.partial } : {}),
      ...(this.bash ? { bash: { ...this.bash } } : {}),
      status: this.status(),
    };
  }

  prompt(text: string, input: PromptInput = {}): Promise<void> {
    if (this.bash || this.inner.isBashRunning) {
      return Promise.reject(
        new Error(
          "Cannot send a prompt while a shell command is running. Stop it first.",
        ),
      );
    }
    if (this.inner.isStreaming) {
      if (input.images && input.images.length > 0) {
        this.queuedImages.set(text, input.images);
      }
    } else {
      this.turnStart = this.inner.sessionManager.getBranch().length;
      this.compaction = null;
    }
    // The SDK's prompt() resolves when the whole run ends; the caller only
    // needs to know the prompt was accepted, so settle on preflight instead.
    this.pendingPrompts += 1;
    return new Promise((resolve, reject) => {
      this.inner
        .prompt(text, {
          streamingBehavior: input.behavior ?? "steer",
          ...(input.images && input.images.length > 0
            ? {
                images: input.images.map((image) => ({
                  type: "image" as const,
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              }
            : {}),
          preflightResult: (ok) => {
            if (ok) resolve();
          },
        })
        .then(
          () => {
            this.pendingPrompts -= 1;
            resolve();
          },
          (error: unknown) => {
            this.pendingPrompts -= 1;
            this.notices.push({
              level: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            this.emit({ type: "turn_done" });
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
    });
  }

  /**
   * Stopping a turn on a session Pi never wrote to disk is the reader saying
   * they are done with it: pi-web's `forceShutdownOnIdle`. It shuts down as
   * soon as the turn really stops, instead of idling for ten minutes.
   */
  async abort(): Promise<void> {
    const draft = !this.hasTranscript();
    await this.inner.abort();
    if (draft && !this.busy && !this.hasTranscript()) await this.stop();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const model = this.inner.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
    await this.inner.setModel(model);
    this.emit({ type: "activity" });
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.inner.setThinkingLevel(level);
    this.emit({ type: "activity" });
  }

  setName(name: string): void {
    this.inner.setSessionName(name);
    this.emit({ type: "activity" });
  }

  setStar(targetId: string, starred: boolean): void {
    const manager = this.inner.sessionManager;
    const target = manager.getEntry(targetId);
    if (target?.type !== "message" || target.message.role !== "assistant") {
      throw new Error("Star target must be an assistant answer");
    }
    manager.appendCustomEntry(STAR_TYPE, { targetId, starred });
    this.emit({ type: "activity" });
  }

  /** Moves the leaf inside the same file; extensions see `session_before_tree`. */
  async navigateTree(targetId: string): Promise<string | undefined> {
    const result = await this.navigate(targetId);
    return result.cancelled ? undefined : result.editorText;
  }

  /**
   * The same move, with the result an extension's command context expects.
   * Both paths go through here so the turn boundary is never left behind.
   */
  async navigate(
    targetId: string,
    summarize?: boolean,
  ): Promise<{ cancelled: boolean; editorText?: string }> {
    const result = await this.inner.navigateTree(targetId, {
      ...(summarize === undefined ? {} : { summarize }),
    });
    this.turnStart = this.inner.sessionManager.getBranch().length;
    this.emit({ type: "activity" });
    return result;
  }

  /**
   * Extension commands, prompt templates, and skills, as the SDK reports them
   * for this session. Skills Pi may not invoke on its own are marked so the
   * menu can say who may run them.
   */
  commands(): SlashCommand[] {
    return [
      ...this.inner.extensionRunner
        .getRegisteredCommands()
        .map((command): SlashCommand => ({
          name: command.invocationName,
          description: command.description ?? "",
          source: "extension",
        })),
      ...this.inner.promptTemplates.map((prompt): SlashCommand => ({
        name: prompt.name,
        description: prompt.description,
        source: "prompt",
      })),
      ...this.inner.resourceLoader
        .getSkills()
        .skills.map((skill): SlashCommand => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          ...(skill.disableModelInvocation ? { manual: true } : {}),
        })),
    ];
  }

  /** Every configured tool; the active ones are what this turn may call. */
  toolDefinitions(): ToolView[] {
    const active = new Set(this.inner.getActiveToolNames());
    return this.inner.getAllTools().map((tool): ToolView => ({
      name: tool.name,
      description: tool.description,
      active: active.has(tool.name),
      parameters: toolParameters(tool.parameters),
      ...(tool.promptGuidelines && tool.promptGuidelines.length > 0
        ? { promptGuidelines: tool.promptGuidelines }
        : {}),
    }));
  }

  systemPrompt(): string {
    return this.inner.systemPrompt;
  }

  async compact(instructions?: string): Promise<void> {
    this.compaction = null;
    this.compactionError = null;
    await this.inner.compact(instructions);
  }

  abortCompaction(): void {
    this.inner.abortCompaction();
    this.emit({ type: "activity" });
  }

  /** Rebuilds the extensions; their statuses and widgets go with them. */
  async reload(): Promise<void> {
    this.ui.resetForReload();
    this.statuses.clear();
    this.widgets.clear();
    await this.inner.reload({
      beforeSessionStart: () => {
        this.inner.extensionRunner.setUIContext(this.ui.context, "rpc");
      },
    });
    this.emit({ type: "activity" });
  }

  takePending(): void {
    this.notices = [];
    this.editorText = [];
  }

  answerDialog(requestId: string, answer: DialogAnswer): boolean {
    return this.ui.answerDialog(requestId, answer);
  }

  customInput(requestId: string, data: string): void {
    this.ui.customInput(requestId, data);
  }

  clearQueue(): QueuedMessage[] {
    const mirrored = this.queue;
    // Copied first: the SDK's clearQueue emits `queue_update` synchronously,
    // and that handler forgets the attachments of every message not queued.
    const images = new Map(this.queuedImages);
    const dropped = this.inner.clearQueue();
    this.queue = [];
    this.queuedImages.clear();
    this.emit({ type: "activity" });
    // Both halves can hold something: the SDK's own queue and the mirror this
    // wrapper keeps from `queue_update`. Recall must not silently drop either,
    // so they are merged and the duplicates the mirror carries are dropped.
    const restore = (
      behavior: "steer" | "followUp",
      texts: readonly string[],
    ) =>
      texts.map((text): QueuedMessage => {
        const attached = images.get(text);
        return {
          text,
          behavior,
          ...(attached === undefined ? {} : { images: attached }),
        };
      });
    const fromSdk: QueuedMessage[] = [
      ...restore("steer", dropped.steering),
      ...restore("followUp", dropped.followUp),
    ];
    return mergeQueue(fromSdk, mirrored);
  }

  /** Resolves on admission, like prompt(); this session owns the whole shell run. */
  runBash(command: string, excludeFromContext: boolean): Promise<void> {
    if (this.busy || this.compacting || this.pendingPrompts > 0) {
      return Promise.reject(
        new Error(
          "Cannot run a shell command while the session is busy. Stop the current run first.",
        ),
      );
    }
    if (!command.trim())
      return Promise.reject(new Error("Type a shell command first."));
    const operations =
      this.bashOperations ??
      createProjectBashOperations({
        agentDir: this.agentDir,
        ...(this.shellPath === undefined ? {} : { shellPath: this.shellPath }),
      });
    this.turnStart = this.inner.sessionManager.getBranch().length;
    this.bash = { command, output: "" };
    // executeBash has no SDK preflight callback. Validation and reserving the
    // session above are admission; executor/persistence failures are later
    // failures, reported on the now-navigable session, never automatic retries.
    this.bashTask = this.inner
      .executeBash(command, undefined, { excludeFromContext, operations })
      .then(() => {
        try {
          persistShellSession(this.inner.sessionManager);
        } catch (error) {
          throw new Error(
            `Could not save shell result: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      })
      .catch((error: unknown) => {
        this.notices.push({
          level: "error",
          message: `Shell command failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      })
      .finally(() => {
        this.bash = undefined;
        this.bashTask = undefined;
        this.endTurn();
        this.emit({ type: "turn_done" });
      });
    this.emit({ type: "activity" });
    return Promise.resolve();
  }

  abortBash(): void {
    this.inner.abortBash();
    this.emit({ type: "activity" });
  }

  /** A session Pi never wrote to disk: an abandoned draft, safe to drop. */
  hasTranscript(): boolean {
    const file = this.inner.sessionManager.getSessionFile();
    return file !== undefined && existsSync(file);
  }

  get busy(): boolean {
    return (
      this.bash !== undefined ||
      this.inner.isStreaming ||
      this.inner.isBashRunning
    );
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.inner.abortBash();
    await this.bashTask;
    this.unsubscribe();
    this.run.cancel();
    this.ui.dispose();
    await this.inner.abort();
    this.inner.dispose();
    this.onStop();
    this.emit({ type: "stopped" });
    this.listeners.clear();
  }
}

/**
 * A model or reasoning level the reader picked for a new session becomes Pi's
 * default for the next one — but only when the session really started on it.
 * `setModel`/`setThinkingLevel` are deliberately not called again: the
 * constructor already recorded them, and repeating the call would append a
 * duplicate session entry and a duplicate extension event.
 */
async function persistStartup(
  settings: SettingsManager,
  explicit: StartupChoice,
  session: AgentSession,
): Promise<void> {
  const model = session.model;
  if (!model) return;
  const writes = startupWrites(explicit, {
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel: session.thinkingLevel,
    supportsThinking: model.reasoning,
  });
  if (writes.model) {
    settings.setDefaultModelAndProvider(
      writes.model.provider,
      writes.model.modelId,
    );
  }
  if (writes.thinkingLevel !== undefined) {
    settings.setDefaultThinkingLevel(writes.thinkingLevel);
  }
  if (!writes.model && writes.thinkingLevel === undefined) return;
  await settings.flush();
}

/** Abandoned drafts are shut down; a session with a file on disk is not. */
const DRAFT_IDLE_MS = 10 * 60 * 1000;

export function createPiAgentRuntime(options: {
  agentDir: string;
  catalog: PiSessionCatalog;
  webSettings: WebSettingsStore;
  /** Loaded into every session besides the user's own; tests script a provider through one. */
  extensions?: InlineExtension[];
  /** Inject the shell backend for offline hosts and tests. */
  bashOperations?: BashOperations;
  draftIdleMs?: number;
}): AgentRuntime {
  const draftIdleMs = options.draftIdleMs ?? DRAFT_IDLE_MS;
  const live = new Map<string, PiLiveSession>();
  const starting = new Map<string, Promise<PiLiveSession>>();
  const watchers = new Set<(event: RuntimeEvent) => void>();

  function announce(event: RuntimeEvent): void {
    for (const watcher of watchers) watcher(event);
  }

  async function start(
    manager: SessionManager,
    startup: StartupChoice = {},
  ): Promise<PiLiveSession> {
    // Capture once: even resource reloads keep this runtime's addition stable.
    const addition =
      options.webSettings.get().systemPromptAddition ??
      DEFAULT_SYSTEM_PROMPT_ADDITION;
    const cwd = manager.getCwd();
    const settingsManager = SettingsManager.create(cwd, options.agentDir);
    const trust = projectTrustReloadOptions(cwd, options.agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        appendSystemPromptOverride: (base) =>
          addition === "" ? base : [...base, addition],
        extensionFactories: [
          createProjectBashExtension({
            cwd,
            agentDir: options.agentDir,
            settings: settingsManager,
            ...(options.bashOperations
              ? { operations: options.bashOperations }
              : {}),
          }),
          ...(options.extensions ?? []),
        ],
        extensionsOverride: preferUserBashExtension,
      },
      ...(trust ? { resourceLoaderReloadOptions: trust } : {}),
    });
    // Pi's cycling scope supplies defaults and reasoning pins, not an allowlist
    // for deliberate web choices. Existing transcripts retain SDK restoration.
    let effective: StartupChoice = {};
    if (manager.buildSessionContext().messages.length === 0) {
      const listing = await resolveModelListing(
        services.modelRuntime,
        settingsManager,
      );
      const requested = startup.model;
      const selected = requested
        ? (
            await resolveModelListing(
              services.modelRuntime,
              settingsManager,
              true,
            )
          ).models.find(
            (model) =>
              model.provider === requested.provider &&
              model.id === requested.modelId,
          )
        : initialModel(listing.models, listing.preferred);
      if (requested && !selected) {
        throw new Error(
          `Model is not available: ${requested.provider}/${requested.modelId}`,
        );
      }
      const scoped = listing.models.find(
        (model) =>
          model.provider === selected?.provider && model.id === selected.id,
      );
      const thinkingLevel =
        startup.thinkingLevel ?? initialThinking(scoped ?? selected);
      effective = {
        ...(selected
          ? { model: { provider: selected.provider, modelId: selected.id } }
          : {}),
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      };
    }
    const wanted = effective.model
      ? services.modelRuntime.getModel(
          effective.model.provider,
          effective.model.modelId,
        )
      : undefined;
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      ...(wanted ? { model: wanted } : {}),
      ...(effective.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: effective.thinkingLevel }),
    });
    await persistStartup(settingsManager, startup, session);
    const id = session.sessionId;
    const shellPath = settingsManager.getShellPath();
    const wrapper = new PiLiveSession(
      session,
      {
        agentDir: options.agentDir,
        ...(shellPath === undefined ? {} : { shellPath }),
        ...(options.bashOperations
          ? { bashOperations: options.bashOperations }
          : {}),
      },
      () => {
        live.delete(id);
        announce({ type: "stopped", sessionId: id });
      },
    );
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        if (!wrapper.hasTranscript() && !wrapper.busy) void wrapper.stop();
        else resetIdle();
      }, draftIdleMs).unref();
    };
    let wasBusy = wrapper.busy;
    wrapper.subscribe((event) => {
      const busy = wrapper.busy;
      if (busy && !wasBusy) announce({ type: "started", sessionId: id });
      wasBusy = busy;
      if (event.type === "turn_done") {
        announce({ type: "finished", sessionId: id });
      }
      if (event.type === "completed") {
        announce({ type: "completed", sessionId: id });
      }
      if (event.type === "stopped") {
        if (idle) clearTimeout(idle);
      } else resetIdle();
    });
    resetIdle();
    await session.bindExtensions({
      uiContext: wrapper.ui.context,
      mode: "rpc",
      // What an extension-registered command may do to the session it runs
      // in. Everything that would replace the session is refused: web-pi owns
      // navigation, and an extension swapping the page's session underneath
      // the reader is not something the browser could follow.
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: () => Promise.resolve({ cancelled: true }),
        fork: () => Promise.resolve({ cancelled: true }),
        switchSession: () => Promise.resolve({ cancelled: true }),
        navigateTree: (targetId, navigate) =>
          wrapper.navigate(targetId, navigate?.summarize),
        reload: () => wrapper.reload(),
      },
      shutdownHandler: () => {
        wrapper.ui.context.notify(
          "An extension asked to shut this session down.",
          "warning",
        );
        void wrapper.stop();
      },
      onError: (error) => {
        wrapper.ui.context.notify(
          `${error.extensionPath}: ${error.error}`,
          "error",
        );
      },
    });
    const file = manager.getSessionFile();
    if (file) options.catalog.remember(id, file);
    live.set(id, wrapper);
    announce({ type: "opened", sessionId: id });
    return wrapper;
  }

  return {
    get: (sessionId) => live.get(sessionId),
    live: () => [...live.values()],
    subscribeAll(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    async open(target) {
      if ("cwd" in target) {
        return start(
          SessionManager.create(
            target.cwd,
            defaultSessionDir(options.agentDir, target.cwd),
          ),
          {
            ...(target.model === undefined ? {} : { model: target.model }),
            ...(target.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: target.thinkingLevel }),
          },
        );
      }
      const existing = live.get(target.sessionId);
      if (existing) return existing;
      const inflight = starting.get(target.sessionId);
      if (inflight) return inflight;
      // The lock has to be in place before the first await, or two opens that
      // arrive together both pass this point and start two sessions on one file.
      const promise = (async () => {
        const filePath = await options.catalog.pathOf(target.sessionId);
        if (!filePath) throw new Error(`Unknown session ${target.sessionId}`);
        return start(SessionManager.open(filePath));
      })().finally(() => {
        starting.delete(target.sessionId);
      });
      starting.set(target.sessionId, promise);
      return promise;
    },
  };
}
