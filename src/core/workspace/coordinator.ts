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
          return {
            id: summary.id,
            name: metadata?.name ?? summary.name ?? "",
            task: (metadata?.firstMessage ?? "No request yet").slice(0, 500),
            cwd: summary.cwd,
            project: summary.projectRoot ?? summary.cwd,
            live: summary.live === true,
            running: summary.running === true,
            available: summary.cwdAvailable !== false,
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
      snapshot?.status.compacting === true;
    return {
      id,
      messages: messages.slice(-12),
      // The identity covers question changes and restarts, not every tool token.
      revision: JSON.stringify([
        live ? incarnations.get(live) : null,
        messages.at(-1)?.id ?? null,
        running,
        blocked,
        dialog,
      ]),
      writable: !!live && !blocked,
      running,
      dialog,
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
      mode: CoordinatorMode,
    ): Promise<void> {
      if (!text.trim() || text.length > 6000)
        throw new Error("Use an instruction of 1–6000 characters.");
      await admit(
        id,
        async () => {
          const live = await current(id);
          const context = verify(live, revision);
          if (!context.writable || context.dialog)
            throw new Error(
              "Answer the pending dialog or wait for the session to become available.",
            );
          if ((mode === "prompt") === context.running)
            throw new Error(
              "Choose steer or follow-up for a busy session, or prompt for an idle one.",
            );
          await live.prompt(text, {
            literal: true,
            ...(mode === "prompt" ? {} : { behavior: mode }),
          });
        },
        true,
      );
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
