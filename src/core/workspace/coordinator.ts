import type { DialogAnswer } from "@core/extension-ui";
import type { LiveSession, LiveSnapshot, SessionRead } from "@core/ports";
import { rowMetadata } from "@core/session-entries";
import { compareSessions, isSubagentSession } from "@core/sessions";
import type { Shared } from "./deps.ts";

export type CoordinatorMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
export type CoordinatorMode = "prompt" | "steer" | "followUp";

export function coordinatorUseCases(shared: Shared) {
  const { deps, inspectionOnly, requireFolder, admit } = shared;
  const incarnations = new WeakMap<LiveSession, number>();
  // A failed post-open check must not become permission on the next request.
  // Do not dispose a writer here: another local caller may share runtime.open.
  const failedResumes = new WeakSet<LiveSession>();
  let incarnation = 0;

  async function coordinatorSessions() {
    const stored = await deps.sessions.list();
    const known = new Set(stored.map((s) => s.id));
    const live = deps.runtime
      .live()
      .filter((s) => !known.has(s.id))
      .map((s) => s.snapshot().summary);
    const summaries = await shared.decorate([...stored, ...live]);
    return Promise.all(
      summaries
        .filter((s) => !isSubagentSession(s))
        .sort(compareSessions)
        .slice(0, 50)
        .map(async (summary) => {
          const snapshot = deps.runtime.get(summary.id)?.snapshot();
          const metadata = snapshot
            ? rowMetadata(snapshot.entries, snapshot.summary)
            : (await deps.sessions.rowMetadata(summary.id))?.metadata;
          const saved = snapshot
            ? undefined
            : await deps.sessions.readSaved(summary.id);
          const read =
            snapshot ??
            (saved?.kind === "changed" ? saved.snapshot : undefined);
          const context = read
            ? contextFrom(
                summary.id,
                deps.runtime.get(summary.id),
                read,
                snapshot,
              )
            : null;
          return {
            id: summary.id,
            name: metadata?.name ?? summary.name ?? "",
            task: (metadata?.firstMessage ?? "No request yet").slice(0, 500),
            cwd: summary.cwd,
            project: summary.projectRoot ?? summary.cwd,
            live: summary.live === true,
            running: summary.running === true,
            available: summary.cwdAvailable !== false && !!context,
            root: true,
            writable:
              summary.cwdAvailable !== false && context?.writable === true,
            revision: context?.revision ?? null,
            currentRequest: context?.currentRequest ?? "",
            latestOutcome: context?.latestOutcome ?? "",
            status: context?.status ?? null,
          };
        }),
    );
  }

  async function coordinatorContext(id: string) {
    if (await inspectionOnly(id))
      throw new Error("Delegated sessions are inspection-only.");
    const live = deps.runtime.get(id);
    const snapshot = live?.snapshot();
    const saved = snapshot ? undefined : await deps.sessions.readSaved(id);
    const read =
      snapshot ?? (saved?.kind === "changed" ? saved.snapshot : undefined);
    if (!read) throw new Error("Unknown session or incomplete saved snapshot.");
    return contextFrom(id, live, read, snapshot);
  }

  function contextFrom(
    id: string,
    live: LiveSession | undefined,
    read: SessionRead | LiveSnapshot,
    snapshot?: LiveSnapshot,
  ) {
    if (live && !incarnations.has(live)) incarnations.set(live, ++incarnation);
    const messages: CoordinatorMessage[] = [];
    // Completed message entries are safe to observe even while later tools run.
    // Streaming partials, thinking, tool logs and bash are deliberately excluded.
    for (const entry of read.branch) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      if (!text.trim()) continue;
      messages.push({
        id: entry.id,
        role: message.role,
        text: text.slice(0, 6000),
      });
    }
    const dialog = snapshot?.status.dialog ?? null;
    const running = snapshot?.status.running === true;
    const blocked =
      snapshot?.status.bashRunning === true ||
      snapshot?.status.compacting === true ||
      !!snapshot?.status.custom;
    const lastMessage = read.branch.findLast(
      (entry) =>
        entry.type === "message" &&
        (entry.message.role === "assistant" || entry.message.role === "user"),
    );
    const assistant =
      lastMessage?.type === "message" &&
      lastMessage.message.role === "assistant"
        ? lastMessage.message
        : null;
    const status = {
      state:
        dialog || snapshot?.status.custom
          ? "waiting"
          : running
            ? "running"
            : assistant?.stopReason === "error"
              ? "error"
              : assistant?.stopReason === "stop"
                ? "completed"
                : "idle",
      queued: snapshot?.status.queue.length ?? 0,
      tools:
        snapshot?.status.tools
          .slice(0, 5)
          .map((tool) => tool.name.slice(0, 100)) ?? [],
      retry: snapshot?.status.retry
        ? {
            attempt: snapshot.status.retry.attempt,
            maxAttempts: snapshot.status.retry.maxAttempts,
          }
        : null,
      notices:
        snapshot?.status.notices.slice(-3).map((notice) => ({
          level: notice.level,
          message: notice.message.slice(0, 500),
        })) ?? [],
      error: (
        snapshot?.status.compactionError ??
        assistant?.errorMessage ??
        ""
      ).slice(0, 500),
      blocked,
    };
    return {
      id,
      messages: messages.slice(-12),
      // A coding turn can emit many assistant messages. Its task must survive
      // moving outside the detailed context window.
      currentRequest:
        messages.findLast((m) => m.role === "user")?.text.slice(0, 1200) ?? "",
      latestOutcome:
        messages.findLast((m) => m.role === "assistant")?.text.slice(0, 1200) ??
        "",
      // The identity covers question changes and restarts, not every tool token.
      revision: JSON.stringify([
        id,
        read.summary.cwd,
        read.summary.filePath,
        live
          ? incarnations.get(live)
          : "revision" in read
            ? read.revision
            : null,
        read.branch.at(-1)?.id ?? null,
        blocked,
        dialog,
      ]),
      writable: !!live && !blocked,
      running,
      dialog,
      status,
    };
  }

  async function current(id: string) {
    await requireFolder(id);
    const live = deps.runtime.get(id);
    if (!live)
      throw new Error(
        "Activate this session in web-pi before sending. Do not attach a second writer to an external session.",
      );
    return live;
  }

  // No await may separate this last identity/question check from dispatch.
  function verify(live: LiveSession, revision: string) {
    const snapshot = live.snapshot();
    const context = contextFrom(live.id, live, snapshot, snapshot);
    if (deps.runtime.get(live.id) !== live || context.revision !== revision)
      throw new Error(
        "The session or question changed. Review a fresh request.",
      );
    return context;
  }

  return {
    coordinatorSessions,
    coordinatorContext,
    async coordinatorWatch(
      id: string,
      listener: (error?: string) => void,
    ): Promise<() => void> {
      if (await inspectionOnly(id))
        throw new Error("Delegated sessions are inspection-only.");
      const stored = await deps.sessions.rowMetadata(id);
      const path =
        deps.runtime.get(id)?.snapshot().summary.filePath ??
        stored?.summary.filePath;
      let offLive: (() => void) | undefined;
      const attach = () => {
        offLive?.();
        offLive = deps.runtime.get(id)?.subscribe(() => {
          listener();
        });
      };
      attach();
      const offGlobal = deps.runtime.subscribeAll((event) => {
        if (event.sessionId !== id) return;
        if (event.type === "opened" || event.type === "stopped") attach();
        listener();
      });
      const offFile = path
        ? deps.watcher.watch(path, {
            change: () => {
              listener();
            },
            error: () => {
              listener(
                "Saved session watching is unavailable. Refresh explicitly to read its latest state.",
              );
            },
          })
        : undefined;
      return () => {
        offLive?.();
        offGlobal();
        offFile?.();
      };
    },
    async coordinatorSend(
      id: string,
      revision: string,
      text: string,
      mode?: CoordinatorMode,
      options: { handoff?: boolean; current?: () => boolean } = {},
    ): Promise<{ mode: CoordinatorMode; queued: number }> {
      if (!text.trim() || text.length > 6000)
        throw new Error("Use an instruction of 1–6000 characters.");
      return admit(
        id,
        async () => {
          const stillCurrent = () => {
            if (options.current && !options.current())
              throw new Error(
                "A later request is unresolved. Nothing was sent.",
              );
          };
          await requireFolder(id);
          let live = deps.runtime.get(id);
          let expected = revision;
          if (!live) {
            const saved = await deps.sessions.readSaved(id);
            if (saved.kind !== "changed" || saved.snapshot.summary.id !== id)
              throw new Error("Unknown session or incomplete saved snapshot.");
            if (
              contextFrom(id, undefined, saved.snapshot).revision !== revision
            )
              throw new Error(
                "The saved session changed. Please make a fresh request.",
              );
            const trust = await deps.trust.status(saved.snapshot.summary.cwd);
            if (trust.requiresTrust && !trust.trusted)
              throw new Error(
                "Project trust needs visible review while safely stopped. Voice cannot grant trust.",
              );
            if (!options.handoff)
              throw new Error(
                "Confirm this session is stopped in other apps before resuming it.",
              );
            // No cross-process lock exists. This is a user handoff, checked
            // against the saved file on both sides of normal runtime opening.
            await requireFolder(id);
            const before = await deps.sessions.readSaved(id);
            if (
              before.kind !== "changed" ||
              before.revision !== saved.revision ||
              deps.runtime.get(id)
            )
              throw new Error(
                "The saved session or writer changed. Please make a fresh request.",
              );
            stillCurrent();
            live = await deps.runtime.open({ sessionId: id });
            const opened = live.snapshot();
            expected = contextFrom(id, live, opened, opened).revision;
            const after = await deps.sessions.readSaved(id);
            if (
              after.kind !== "changed" ||
              after.revision !== saved.revision ||
              live.id !== id ||
              opened.summary.id !== id ||
              opened.summary.cwd !== saved.snapshot.summary.cwd ||
              JSON.stringify(opened.branch) !==
                JSON.stringify(saved.snapshot.branch)
            ) {
              if (live.id === id) failedResumes.add(live);
              throw new Error(
                "The saved session changed during resume. Nothing was sent; stop and review this local writer while safely stopped.",
              );
            }
          }
          await requireFolder(id);
          const context = verify(live, expected);
          stillCurrent();
          if (failedResumes.has(live))
            throw new Error(
              "This writer failed resume validation. Stop and review it while safely stopped before trying again.",
            );
          if (live.id !== id || !context.writable || context.dialog)
            throw new Error(
              "This task is paused for visible review while safely stopped, or is temporarily unavailable. No dialog answer was sent.",
            );
          const delivery = mode ?? (context.running ? "followUp" : "prompt");
          if ((delivery === "prompt") === context.running)
            throw new Error(
              "The requested delivery mode no longer matches the task state. Nothing was sent.",
            );
          await live.prompt(text, {
            literal: true,
            ...(delivery === "prompt" ? {} : { behavior: delivery }),
          });
          return {
            mode: delivery,
            queued: live.snapshot().status.queue.length,
          };
        },
        true,
      );
    },
    async coordinatorAbort(
      id: string,
      revision: string,
      current?: () => boolean,
    ) {
      await shared.requireWritableSession(id);
      const live = deps.runtime.get(id);
      if (!live)
        throw new Error(
          "There is no local turn to stop. Saved or external sessions were not activated.",
        );
      const context = verify(live, revision);
      if (context.status.blocked)
        throw new Error(
          "This operation needs visible review while safely stopped.",
        );
      if (current && !current())
        throw new Error("A later request is unresolved. No turn was stopped.");
      const cleared = live.clearQueue();
      if (context.running) await live.abort();
      const status = live.snapshot().status;
      return {
        aborted: context.running,
        running: status.running,
        queued: status.queue.length,
        cleared,
      };
    },
    async coordinatorAnswer(
      id: string,
      revision: string,
      requestId: string,
      answer: DialogAnswer,
    ): Promise<void> {
      await admit(
        id,
        async () => {
          const live = await current(id);
          const context = verify(live, revision);
          const dialog = context.dialog;
          if (
            !dialog ||
            dialog.id !== requestId ||
            (dialog.expiresAt !== undefined && dialog.expiresAt <= Date.now())
          )
            throw new Error("This question is no longer pending.");
          if (!("cancelled" in answer)) {
            if (
              dialog.method === "confirm"
                ? !("confirmed" in answer)
                : !("value" in answer)
            )
              throw new Error("This answer does not match the question type.");
            if (
              dialog.method === "select" &&
              (!("value" in answer) || !dialog.options?.includes(answer.value))
            )
              throw new Error("Choose one of the offered answers.");
          }
          if (!live.answerDialog(requestId, answer))
            throw new Error("This question was already answered.");
        },
        true,
      );
    },
  };
}
