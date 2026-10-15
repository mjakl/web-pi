import type { WebSettingsStore } from "@core/web-settings";
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
  ModelCatalog,
  ProjectResources,
  PromptInput,
  QueuedMessage,
  RunningTool,
  RuntimeEvent,
  ThinkingChoice,
  ThinkingLevel,
} from "@core/ports";
import type { DialogAnswer } from "@core/extension-ui";
import { startupWrites, type StartupChoice } from "@core/models";
import { createCompletionTracker } from "@core/turn-completion";
import { toolParameters } from "@core/tools";
import { toolProgress } from "@core/transcript";
import { isBusy, STAR_TYPE, starTarget } from "@core/session-entries";
import { selectedSkillPrompt } from "./selected-skills.ts";
import { stopsInTime, type SessionSummary } from "@core/sessions";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionServices,
  type AgentSessionEvent,
  type BashOperations,
  createAgentSessionFromServices,
  estimateTokens as estimateMessageTokens,
  type InlineExtension,
  SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { createProjectBashOperations } from "./bash-env.ts";
import { createExtensionUi } from "./extension-ui.ts";
import { createPiModelCatalog, startupModel } from "./model-catalog.ts";
import {
  createPiServicePreparations,
  slashCommands,
} from "./session-services.ts";
import { defaultSessionDir, type PiSessionCatalog } from "./session-catalog.ts";
import { resolveSnapshotEntryId } from "./session-snapshot.ts";
import { checkSettingsErrors } from "./settings-errors.ts";

/** Streaming tool arguments kept for the card; the entry holds the rest. */
const PARTIAL_ARGUMENT_CHARS = 4096;

type Partial = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Pi writes a new session's file once it holds a user or assistant message,
 * so a session that has only run shell commands is written here.
 */
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
  private readonly partialArguments = new Map<string, string>();
  /** Attachments of messages waiting in the SDK's queue, keyed by their text. */
  private readonly queuedImages: Map<string, ImageAttachment[]>;
  private turnStart: number;
  private compacting = false;
  private queue: QueuedMessage[] = [];
  private compaction: LiveStatus["compaction"] = null;
  private compactionError: LiveStatus["compactionError"] = null;
  private bash: { command: string; output: string } | undefined;
  private bashTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private lifecycleTask: Promise<void> = Promise.resolve();
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

  readonly services: AgentSessionServices;
  private readonly invalidatePreparation: () => void;
  private readonly inner: AgentSession;
  private readonly shellOperations: () => BashOperations;
  private readonly onStop: () => void;

  constructor(
    inner: AgentSession,
    options: {
      /** Asked for each command, so it can follow the current settings. */
      shellOperations: () => BashOperations;
      queuedImages: Map<string, ImageAttachment[]>;
      services: AgentSessionServices;
      invalidatePreparation: () => void;
    },
    onStop: () => void,
  ) {
    this.inner = inner;
    this.services = options.services;
    this.invalidatePreparation = options.invalidatePreparation;
    this.queuedImages = options.queuedImages;
    this.shellOperations = options.shellOperations;
    this.onStop = onStop;
    this.id = inner.sessionId;
    this.turnStart = inner.sessionManager.getBranch().length;
    this.unsubscribe = inner.subscribe((event) => {
      this.handle(event);
    });
  }

  /** Initial binding, runner replacement, and final shutdown have one owner. */
  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const task = this.lifecycleTask.catch(() => {}).then(operation);
    this.lifecycleTask = task;
    return task;
  }

  start(): Promise<void> {
    return this.enqueueLifecycle(() =>
      this.inner.bindExtensions({
        uiContext: this.ui.context,
        mode: "rpc",
        // web-pi owns navigation; extensions cannot replace the page's session.
        commandContextActions: {
          waitForIdle: () => this.inner.agent.waitForIdle(),
          newSession: () => Promise.resolve({ cancelled: true }),
          fork: () => Promise.resolve({ cancelled: true }),
          switchSession: () => Promise.resolve({ cancelled: true }),
          navigateTree: (targetId, navigate) =>
            this.navigate(targetId, navigate?.summarize),
          reload: () => this.reload(),
        },
        shutdownHandler: () => {
          this.ui.context.notify(
            "An extension asked to shut this session down.",
            "warning",
          );
          void this.stop();
        },
        onError: (error) => {
          this.ui.context.notify(
            `${error.extensionPath}: ${error.error}`,
            "error",
          );
        },
      }),
    );
  }

  get stopping(): boolean {
    return this.stopTask !== undefined;
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
    if (this.stopping) {
      return Promise.reject(
        new Error("Cannot prompt a stopping or stopped session."),
      );
    }
    if (this.bash || this.inner.isBashRunning) {
      return Promise.reject(
        new Error(
          "Cannot send a prompt while a shell command is running. Stop it first.",
        ),
      );
    }
    const hasSkills = (input.skills?.length ?? 0) > 0;
    let promptText = text;
    if (hasSkills) {
      try {
        promptText = selectedSkillPrompt(
          text,
          input.skills ?? [],
          this.inner.resourceLoader.getSkills().skills,
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (!this.inner.isStreaming) {
      this.turnStart = this.inner.sessionManager.getBranch().length;
      this.compaction = null;
    }
    // The SDK's prompt() resolves when the whole run ends; the caller only
    // needs to know the prompt was accepted, so settle on preflight instead.
    this.pendingPrompts += 1;
    return new Promise((resolve, reject) => {
      this.inner
        .prompt(promptText, {
          ...(hasSkills ? { expandPromptTemplates: false } : {}),
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
          // Pi calls this only for an accepted prompt: started, queued or
          // handled by an extension.
          preflightResult: () => {
            resolve();
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
   * Stop on a session Pi never wrote to disk is the reader saying they are
   * done with it: pi-web's `forceShutdownOnIdle`. It shuts down instead of
   * idling for ten minutes. Pi writes the file with the first prompt, so this
   * is a session that opened with `/name` or `/reload`, or whose first prompt
   * Pi refused, and whose page still offers Stop and Escape.
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

  setStar(targetId: string, starred: boolean): string {
    const manager = this.inner.sessionManager;
    const target = starTarget(
      manager.getEntry(resolveSnapshotEntryId(manager.getEntries(), targetId)),
    );
    manager.appendCustomEntry(STAR_TYPE, { targetId: target.id, starred });
    this.emit({ type: "activity" });
    return target.id;
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
    if (this.stopping) {
      throw new Error("Cannot navigate a stopping or stopped session.");
    }
    const target = resolveSnapshotEntryId(
      this.inner.sessionManager.getEntries(),
      targetId,
    );
    const result = await this.inner.navigateTree(target, {
      ...(summarize === undefined ? {} : { summarize }),
    });
    this.turnStart = this.inner.sessionManager.getBranch().length;
    this.emit({ type: "activity" });
    return result;
  }

  commands(): SlashCommand[] {
    return slashCommands(this.inner.extensionRunner, this.inner.resourceLoader);
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
    if (this.stopping) {
      throw new Error("Cannot compact a stopping or stopped session.");
    }
    this.compaction = null;
    this.compactionError = null;
    await this.inner.compact(instructions);
  }

  abortCompaction(): void {
    this.inner.abortCompaction();
    this.emit({ type: "activity" });
  }

  /** Rebuilds the extensions; their statuses and widgets go with them. */
  reload(): Promise<void> {
    if (this.stopTask) {
      return Promise.reject(
        new Error("Cannot reload a stopping or stopped session."),
      );
    }
    return this.enqueueLifecycle(() => this.reloadResources());
  }

  private async reloadResources(): Promise<void> {
    this.invalidatePreparation();
    this.services.diagnostics = [];
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
    if (this.stopping) {
      return Promise.reject(
        new Error(
          "Cannot run a shell command in a stopping or stopped session.",
        ),
      );
    }
    if (this.busy || this.compacting || this.pendingPrompts > 0) {
      return Promise.reject(
        new Error(
          "Cannot run a shell command while the session is busy. Stop the current run first.",
        ),
      );
    }
    if (!command.trim())
      return Promise.reject(new Error("Type a shell command first."));
    const operations = this.shellOperations();
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
    return isBusy({
      running: this.inner.isStreaming,
      bashRunning: this.bash !== undefined || this.inner.isBashRunning,
    });
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    // Latch admission before UI cleanup or abort can call back into this owner.
    this.stopTask = this.enqueueLifecycle(() => this.stopSession(work));
    this.run.cancel();
    this.ui.dispose();
    this.inner.abortBash();
    const work = Promise.all([this.inner.abort(), this.bashTask]);
    // Abort is signalled now, but its result is collected after lifecycle work.
    void work.catch(() => {});
    return this.stopTask;
  }

  private async stopSession(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } finally {
      try {
        // dispose() alone does not close extension-owned resources.
        await this.inner.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        this.unsubscribe();
        this.inner.dispose();
        this.onStop();
        this.emit({ type: "stopped" });
        this.listeners.clear();
      }
    }
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
    model,
    thinkingLevel: session.thinkingLevel,
    supportsThinking: model.reasoning,
  });
  if (writes.model) {
    settings.setDefaultModelAndProvider(writes.model.provider, writes.model.id);
  }
  if (writes.thinkingLevel !== undefined) {
    settings.setDefaultThinkingLevel(writes.thinkingLevel);
  }
  if (!writes.model && writes.thinkingLevel === undefined) return;
  await settings.flush();
  checkSettingsErrors(settings, "global");
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
}): AgentRuntime & { models: ModelCatalog; resources: ProjectResources } {
  const preparations = createPiServicePreparations(options);
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
    const cwd = manager.getCwd();
    const { services, queuedImages } = await preparations.claim(cwd);
    const settingsManager = services.settingsManager;
    await settingsManager.reload();
    // An existing transcript keeps the SDK's own restoration.
    const choice =
      manager.buildSessionContext().messages.length === 0
        ? await startupModel(services.modelRuntime, settingsManager, startup)
        : {};
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      ...choice,
    });
    // The session runs on the choice either way; only the default is lost.
    const unsaved = await persistStartup(
      settingsManager,
      startup,
      session,
    ).then(
      () => undefined,
      (error: unknown) =>
        `Could not save this choice as Pi's default: ${error instanceof Error ? error.message : String(error)}`,
    );
    const id = session.sessionId;
    const wrapper = new PiLiveSession(
      session,
      {
        services,
        invalidatePreparation: () => {
          preparations.invalidate(cwd);
        },
        queuedImages,
        // `/reload` re-reads the settings, and the agent's bash tool with
        // them; `!cmd` reads the shell path when it runs, so both agree.
        shellOperations: () =>
          options.bashOperations ??
          createProjectBashOperations({
            agentDir: options.agentDir,
            shellPath: settingsManager.getShellPath(),
          }),
      },
      () => {
        live.delete(id);
        announce({ type: "stopped", sessionId: id });
      },
    );
    if (unsaved) wrapper.ui.context.notify(unsaved, "warning");
    // Armed only while the session has no file: once Pi wrote one, activity
    // stops re-arming it.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = wrapper.hasTranscript()
        ? undefined
        : setTimeout(() => {
            if (wrapper.busy || wrapper.hasTranscript()) resetIdle();
            else void wrapper.stop();
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
      if (event.type === "stopped") clearTimeout(idle);
      else if (idle) resetIdle();
    });
    resetIdle();
    try {
      await wrapper.start();
    } catch (error) {
      await wrapper.stop();
      throw error;
    }
    if (wrapper.stopping) {
      await wrapper.stop();
      throw new Error("Session stopped during startup.");
    }
    const file = manager.getSessionFile();
    if (file) options.catalog.remember(id, file);
    live.set(id, wrapper);
    announce({ type: "opened", sessionId: id });
    return wrapper;
  }

  return {
    models: createPiModelCatalog({
      agentDir: options.agentDir,
      preparations,
      sessionServices: (id) => live.get(id)?.services,
    }),
    // The preparation a session started there would claim, so the menu
    // matches before and after the start.
    resources: { commands: (cwd) => preparations.commands(cwd) },
    get(sessionId) {
      const session = live.get(sessionId);
      // A stopping session takes no new work; open() may resume its transcript.
      return session?.stopping ? undefined : session;
    },
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
      if (existing && !existing.stopping) return existing;
      const inflight = starting.get(target.sessionId);
      if (inflight) return inflight;
      // The lock has to be in place before the first await, or two opens that
      // arrive together both pass this point and start two sessions on one file.
      const promise = (async () => {
        // A stopping runtime still writes its last entries; its successor
        // opens the file only once it is done.
        if (existing && !(await stopsInTime(existing.stop())))
          throw new Error("Cannot reopen a session that is still stopping.");
        const filePath = await options.catalog.pathOf(target.sessionId);
        if (!filePath) throw new Error(`Unknown session ${target.sessionId}`);
        // Pi opens a missing path as a new session in the server's cwd. A
        // draft's prospective path is not a transcript we can resume.
        if (!existsSync(filePath))
          throw new Error(
            `Cannot reopen session ${target.sessionId}: no saved transcript.`,
          );
        const manager = SessionManager.open(filePath);
        if (manager.getSessionId() !== target.sessionId)
          throw new Error(
            `Cannot reopen session ${target.sessionId}: transcript ID does not match.`,
          );
        return start(manager);
      })().finally(() => {
        starting.delete(target.sessionId);
      });
      starting.set(target.sessionId, promise);
      return promise;
    },
  };
}
