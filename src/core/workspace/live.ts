import {
  BUILTIN_COMMANDS,
  rankCommands,
  type SlashCommand,
} from "@core/composer";
import type { DialogAnswer } from "@core/extension-ui";
import type { StartupChoice } from "@core/models";
import { isBashOutputPath } from "@core/path-access";
import type {
  ImageAttachment,
  LiveEvent,
  LiveSession,
  PromptInput,
  PushSubscription,
  ThinkingLevel,
  ToolView,
} from "@core/ports";
import {
  type ContentPart,
  contentParts,
  projectTranscript,
  type ToolCallView,
} from "@core/transcript";
import { unavailableFolderMessage } from "@core/workspaces";
import { branchTo } from "@core/session-entries";
import { isSubagentSession } from "@core/sessions";
import type { Shared } from "./deps.ts";
import { ForbiddenPath } from "./views.ts";

// The running agent: starting, prompting, stopping and steering a live
// session, and what only its entries can answer (images, thinking, a tool
// call's full result, a shell capture).

/** A name worth showing: a blank one is the same as none. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function liveUseCases({
  deps,
  entriesOf,
  folderAvailable,
  requireFolder,
  requireWritableSession,
  summaryOf,
}: Shared) {
  /**
   * A finished run reaches every subscribed browser, open tab or not. The
   * service worker decides whether to show it: a visible window already heard
   * about it through the session stream.
   */
  deps.runtime.subscribeAll((event) => {
    if (event.type !== "completed") return;
    void summaryOf(event.sessionId)
      .then((summary) =>
        summary && isSubagentSession(summary)
          ? undefined
          : deps.push.send({
              title: nonEmpty(summary?.name) ?? "Session complete",
              body: "Task finished.",
              url: `/sessions/${event.sessionId}`,
              tag: `web-pi:session-complete:${event.sessionId}`,
            }),
      )
      .catch(() => {
        // Push is best effort: a failing subscription must not break a turn.
      });
  });

  async function liveOrOpen(id: string): Promise<LiveSession> {
    return deps.runtime.get(id) ?? deps.runtime.open({ sessionId: id });
  }

  /** The content parts of one entry, whichever kind of message it holds. */
  async function entryContent(
    id: string,
    entryId: string,
  ): Promise<ContentPart[]> {
    const stored = await entriesOf(id);
    if (!stored) return [];
    const targetId = deps.sessions.resolveEntryId(stored.entries, entryId);
    const entry = stored.entries.find((item) => item.id === targetId);
    if (entry?.type === "message") {
      const { message } = entry;
      return "content" in message ? contentParts(message.content) : [];
    }
    if (entry?.type === "custom_message") return contentParts(entry.content);
    return [];
  }

  return {
    /**
     * Create a session in `cwd` without dispatching input. An explicit model
     * or reasoning level starts it there and, when Pi honours the choice,
     * becomes the default for the next session — so the listing is stale
     * afterwards.
     */
    async createSession(
      cwd: string,
      startup: StartupChoice = {},
    ): Promise<string> {
      if (!(await folderAvailable(cwd))) {
        throw new Error(unavailableFolderMessage(cwd));
      }
      const live = await deps.runtime.open({ cwd, ...startup });
      if (startup.model || startup.thinkingLevel) deps.models.invalidate(cwd);
      return live.id;
    },

    async send(id: string, text: string, input?: PromptInput): Promise<void> {
      await requireFolder(id);
      const live = await liveOrOpen(id);
      await live.prompt(text, input);
    },

    /** Stops the turn, or the shell command when that is what runs. */
    async abort(id: string): Promise<void> {
      await requireWritableSession(id);
      const live = deps.runtime.get(id);
      if (!live) return;
      if (live.snapshot().status.bashRunning) live.abortBash();
      else await live.abort();
    },

    /**
     * The slash menu: built-ins plus whatever the session offers. A stopped
     * session lists prompt templates and skills from disk rather than
     * starting an agent just to fill a menu.
     */
    async commands(id: string, query: string): Promise<SlashCommand[]> {
      await requireWritableSession(id);
      const live = deps.runtime.get(id);
      let listed: SlashCommand[] = [];
      if (live) listed = live.commands();
      else {
        const summary = await summaryOf(id);
        if (summary) {
          listed = await deps.resources
            .commands(summary.cwd)
            .catch(() => [] as SlashCommand[]);
        }
      }
      return rankCommands([...BUILTIN_COMMANDS, ...listed], query, {
        running: live?.snapshot().status.running ?? false,
      });
    },

    async compact(id: string, instructions?: string): Promise<void> {
      await requireFolder(id);
      const live = await liveOrOpen(id);
      await live.compact(instructions);
    },

    async abortCompaction(id: string): Promise<void> {
      await requireWritableSession(id);
      deps.runtime.get(id)?.abortCompaction();
    },

    async reload(id: string): Promise<void> {
      await requireFolder(id);
      await (await liveOrOpen(id)).reload();
    },

    /**
     * Answers an extension dialog. Only the tab that gets here resolves it;
     * the others see the dialog disappear on the next render.
     */
    async answerDialog(
      id: string,
      requestId: string,
      answer: DialogAnswer,
    ): Promise<boolean> {
      await requireWritableSession(id);
      return deps.runtime.get(id)?.answerDialog(requestId, answer) ?? false;
    },

    /** One keystroke or paste for an extension's open custom UI. */
    async customInput(
      id: string,
      requestId: string,
      data: string,
    ): Promise<void> {
      await requireWritableSession(id);
      deps.runtime.get(id)?.customInput(requestId, data);
    },

    /** The VAPID public key a browser needs to subscribe to push. */
    pushKey(): string {
      return deps.push.publicKey();
    },

    subscribePush(subscription: PushSubscription): void {
      deps.push.subscribe(subscription);
    },
    hasPush: (subscription: PushSubscription) => deps.push.has(subscription),
    unsubscribePush: (subscription: PushSubscription) => {
      deps.push.unsubscribe(subscription);
    },

    /**
     * Empties the queue and hands it back for the composer: the texts as one
     * draft, and the images of every queued message, so recalling a message
     * that carried a screenshot does not silently drop it.
     */
    async recallQueue(
      id: string,
    ): Promise<{ text: string; images: ImageAttachment[] }> {
      await requireWritableSession(id);
      const queued = deps.runtime.get(id)?.clearQueue() ?? [];
      return {
        text: queued
          .map((message) => message.text)
          .filter((text) => text !== "")
          .join("\n\n"),
        images: queued.flatMap((message) => message.images ?? []),
      };
    },

    async runBash(
      id: string,
      command: string,
      excludeFromContext: boolean,
    ): Promise<void> {
      await requireFolder(id);
      const live = await liveOrOpen(id);
      await live.runBash(command, excludeFromContext);
    },

    /**
     * One image of an entry, straight out of the session file: an attachment
     * of a question, or an image a tool returned. Indexed among the image
     * parts of that entry, which is what the transcript renders links for.
     */
    async entryImage(
      id: string,
      entryId: string,
      index: number,
    ): Promise<ImageAttachment | undefined> {
      const image = (await entryContent(id, entryId)).filter(
        (part) => part.type === "image",
      )[index];
      return typeof image?.data === "string" &&
        typeof image.mimeType === "string"
        ? { data: image.data, mimeType: image.mimeType }
        : undefined;
    },

    /** One thinking block, for the ones the page left out of a long session. */
    async entryThinking(
      id: string,
      entryId: string,
      index: number,
    ): Promise<string | undefined> {
      const block = (await entryContent(id, entryId)).filter(
        (part) => part.type === "thinking",
      )[index];
      return typeof block?.thinking === "string" ? block.thinking : undefined;
    },

    /** A truncated shell run's capture file, if this session produced it. */
    async bashOutput(id: string, path: string): Promise<string> {
      if (!isBashOutputPath(deps.tmpdir, path)) {
        throw new ForbiddenPath("Not a shell output file");
      }
      const stored = await entriesOf(id);
      const referenced = stored?.entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "bashExecution" &&
          entry.message.fullOutputPath === path,
      );
      if (!referenced) {
        throw new ForbiddenPath("This session did not produce that file");
      }
      return deps.files.readOutput(path);
    },

    /** One tool call, for the "show all" behind a truncated result. */
    async toolCall(
      id: string,
      entryId: string,
      callId: string,
    ): Promise<ToolCallView | undefined> {
      const stored = await entriesOf(id);
      if (!stored) return undefined;
      const targetId = deps.sessions.resolveEntryId(stored.entries, entryId);
      // A deferred card can belong to a read-only alternate leaf. Its result
      // entry pins that branch without trusting a branch supplied by the client.
      const branch = stored.branch.some((entry) => entry.id === targetId)
        ? stored.branch
        : branchTo(stored.entries, targetId);
      for (const item of projectTranscript(branch).items) {
        if (item.kind !== "assistant") continue;
        for (const block of item.blocks) {
          if (block.kind !== "tool" || block.call.id !== callId) continue;
          // The link carries whichever entry the truncated body came from:
          // the call's own, or the one the result was written into.
          if (
            item.entryId === targetId ||
            block.call.result?.entryId === targetId
          ) {
            return block.call;
          }
        }
      }
      return undefined;
    },

    // --- Session inspection ----------------------------------------------

    /** Tool definitions of a running session; nothing is started to get them. */
    /**
     * What the session would run with. pi-web resumes a dormant session to
     * answer these two panels — a command that starts no turn and writes no
     * message, but does let the reader see the prompt before sending one
     * (useAgentSession.ts `loadSystemInfo`). A session whose folder is gone
     * cannot be resumed, and says so through the panel's empty state.
     */
    async toolDefinitions(id: string): Promise<ToolView[] | undefined> {
      await requireWritableSession(id);
      const live = deps.runtime.get(id);
      if (live) return live.toolDefinitions();
      await requireFolder(id);
      return (await deps.runtime.open({ sessionId: id })).toolDefinitions();
    },

    async systemPrompt(id: string): Promise<string | undefined> {
      await requireWritableSession(id);
      const live = deps.runtime.get(id);
      if (live) return live.systemPrompt();
      await requireFolder(id);
      return (await deps.runtime.open({ sessionId: id })).systemPrompt();
    },

    async setModel(
      id: string,
      choice: {
        provider: string;
        modelId: string;
        thinkingLevel?: ThinkingLevel;
      },
    ): Promise<void> {
      await requireFolder(id);
      const live =
        deps.runtime.get(id) ?? (await deps.runtime.open({ sessionId: id }));
      await live.setModel(choice.provider, choice.modelId);
      if (choice.thinkingLevel) live.setThinkingLevel(choice.thinkingLevel);
    },

    async activate(id: string): Promise<void> {
      await requireFolder(id);
      await deps.runtime.open({ sessionId: id });
    },

    /** Undefined when the session has no runtime; the page then has nothing to stream. */
    async subscribe(
      id: string,
      listener: (event: LiveEvent) => void,
    ): Promise<(() => void) | undefined> {
      await requireWritableSession(id);
      return deps.runtime.get(id)?.subscribe(listener);
    },
  };
}
