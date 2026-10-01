import type { DialogAnswer } from "@core/extension-ui";
import type { Workspace } from "@core/workspace";
import type { CoordinatorMode } from "@core/workspace/coordinator";
import type {
  CoordinatorExchange,
  CoordinatorMemory,
  CoordinatorProvider,
  CoordinatorSession,
  CoordinatorState,
  CoordinatorVoice,
  VoiceEvent,
} from "@core/coordinator-types";

export const COORDINATOR_WINDOW_MS = 90 * 60_000;

/** One opt-in conversation per server. It proposes; only a visible confirmation
 * can enter the Workspace's existing writer. No provider tools can mutate it. */
export function createCoordinator(
  workspace: Workspace,
  provider: CoordinatorProvider,
  newId: () => string,
) {
  let token = "";
  let ending: Promise<boolean> | undefined;
  let epoch = 0;
  let controller = new AbortController();
  let voice: CoordinatorVoice | undefined;
  let voiceEpoch = 0;
  let voiceWindowStarted = false;
  let voiceInput = "";
  let voiceOutput = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopGlobal: (() => void) | undefined;
  const observers = new Map<string, () => void>();
  const cursors = new Map<string, string>();
  const revisions = new Map<string, string>();
  const dialogs = new Map<string, string>();
  const reading = new Set<string>();
  const reread = new Set<string>();
  const updates = new Map<string, string>();
  const events = new Set<string>();
  const listeners = new Set<(state: CoordinatorState) => void>();
  const handles = new Map<string, string>();
  let state: CoordinatorState = empty();

  function empty(): CoordinatorState {
    return {
      enabled: false,
      busy: false,
      sessions: [],
      target: "",
      context: null,
      proposal: null,
      question: null,
      conversation: [],
      inputCaption: "",
      outputCaption: "",
      voice: "off",
      voiceGeneration: 0,
      muted: false,
      error: "",
    };
  }
  function check(key: string) {
    if (!token || key !== token || !state.enabled)
      throw new Error("Coordinator ended. Start a new conversation.");
  }
  function publish() {
    for (const listener of listeners) listener(structuredClone(state));
  }
  function memory(): CoordinatorMemory {
    // Keep every local record; only repetitive background summaries are selected
    // for model context. They never establish conversational focus.
    const recentUpdates = new Set(
      state.conversation.filter((m) => m.event === "update").slice(-3),
    );
    return structuredClone({
      sessions: state.sessions,
      target: state.sessions.find((s) => s.handle === state.target) ?? null,
      context: state.context,
      proposal: state.proposal,
      question: state.question,
      conversation: state.conversation.filter(
        (m) => m.event !== "update" || recentUpdates.has(m),
      ),
    });
  }
  function say(
    text: string,
    speech = text,
    delegationId?: string,
    record: Partial<CoordinatorExchange> = {},
  ) {
    state.conversation.push({
      role: "assistant",
      text,
      event: "reply",
      ...record,
    });
    voice?.context(speech, true, delegationId);
    publish();
  }
  function focus(
    session: CoordinatorSession | null,
    context: CoordinatorState["context"],
  ) {
    if (state.target !== (session?.handle ?? "")) {
      state.conversation.push({
        role: "assistant",
        event: "focus",
        sessionIds: session ? [session.id] : [],
        text: `Current target: ${session ? `${session.handle} — ${session.label}` : "none"}. Previous proposals are invalid.`,
      });
    }
    state.target = session?.handle ?? "";
    state.context = context;
    voice?.context(
      `Current target: ${session ? `${session.handle} (${session.id}) — ${session.label}` : "none"}. Previous proposals are invalid.`,
      false,
    );
  }
  async function refreshSessions() {
    const key = token;
    const sessions = await workspace.coordinatorSessions();
    check(key);
    state.sessions = sessions.map((session) => {
      const handle = handles.get(session.id) ?? `S${String(handles.size + 1)}`;
      handles.set(session.id, handle);
      return {
        ...session,
        handle,
        label: (session.name || session.task)
          .replaceAll(/\s+/g, " ")
          .trim()
          .slice(0, 64),
      };
    });
    const visible = new Set(state.sessions.map((session) => session.id));
    for (const [id, off] of observers)
      if (!visible.has(id)) {
        off();
        observers.delete(id);
      }
    await Promise.all(state.sessions.map(attach));
  }
  function explicitTarget(text: string): CoordinatorSession | null {
    const mentioned = [...new Set(text.toUpperCase().match(/\bS\d+\b/g) ?? [])];
    if (mentioned.length > 1)
      throw new Error(
        "Which one session should receive this request? Select its handle.",
      );
    if (mentioned.length === 1) {
      const target = state.sessions.find((s) => s.handle === mentioned[0]);
      if (!target)
        throw new Error(
          "That session handle is unknown. Select a current target.",
        );
      return target;
    }
    return null;
  }
  async function observe(id: string, baseline = false) {
    if (!state.enabled) return;
    if (reading.has(id)) {
      reread.add(id);
      return;
    }
    reading.add(id);
    const key = token;
    try {
      const context = await workspace.coordinatorContext(id);
      if (key !== token || !state.enabled) return;
      if (!baseline && revisions.get(id) === context.revision) return;
      revisions.set(id, context.revision);
      const previous = cursors.get(id);
      const index = context.messages.findIndex((m) => m.id === previous);
      const latest = context.messages.at(-1)?.id ?? "";
      cursors.set(id, latest);
      const session = state.sessions.find((s) => s.id === id);
      if (!session) return;
      session.revision = context.revision;
      session.running = context.running;
      session.writable = session.available && context.writable;
      session.currentRequest = context.currentRequest;
      session.latestOutcome = context.latestOutcome;
      if (baseline || (previous !== "" && index === -1)) updates.delete(id);
      // Missing cursor means a branch changed or the bounded window moved;
      // establish a baseline instead of replaying unrelated history.
      if (
        !baseline &&
        previous !== undefined &&
        (previous === "" || index !== -1)
      ) {
        const fresh = context.messages
          .slice(previous === "" ? 0 : index + 1)
          .filter((m) => m.role === "assistant");
        if (fresh.length) {
          const header = `${session.handle} (${session.label}):\n`;
          const combined = `${updates.get(id) ?? header}\n${fresh.map((m) => m.text).join("\n")}`;
          const overflow = `${header}[Earlier new text exceeded the update window. Inspect this session for omitted details.]\n`;
          if (combined.length > 6000)
            state.error = `${session.handle}'s update window was exceeded. Open that session for omitted new text.`;
          updates.set(
            id,
            combined.length <= 6000
              ? combined
              : overflow + combined.slice(-(6000 - overflow.length)),
          );
        }
      }
      const dialog = JSON.stringify(context.dialog);
      if (!baseline && context.dialog && dialogs.get(id) !== dialog) {
        say(
          `${session.handle} — ${context.dialog.title}\n${context.dialog.message ?? ""}\nThis is a typed dialog. Select this session and answer the exact question below.`,
          `${session.handle} has a pending question. Select it to see the exact question and answer.`,
          undefined,
          { event: "update", sessionIds: [id] },
        );
      }
      dialogs.set(id, dialog);
      if (state.target === session.handle) {
        if (state.context?.revision !== context.revision) state.proposal = null;
        state.context = context;
      }
      publish();
      void flushUpdates();
    } catch {
      if (key === token && state.enabled) {
        state.error =
          "A session changed or became unavailable. Refresh the session list.";
        publish();
      }
    } finally {
      if (key === token) {
        reading.delete(id);
        if (reread.delete(id) && state.enabled) void observe(id);
      }
    }
  }
  async function attach(session: CoordinatorSession) {
    if (observers.has(session.id)) return;
    const key = token;
    observers.set(session.id, () => {});
    await observe(session.id, true);
    try {
      const off = await workspace.coordinatorWatch(session.id, (error) => {
        if (key !== token || !state.enabled) return;
        if (error) {
          state.error = error;
          publish();
        } else void observe(session.id);
      });
      if (key !== token || !state.enabled) off();
      else observers.set(session.id, off);
    } catch {
      if (key === token) observers.delete(session.id);
    }
  }
  async function flushUpdates() {
    if (!state.enabled || state.busy || !updates.size) return;
    const key = token;
    // Coalesce a few session updates without displacing conversational focus.
    const batch = [...updates.entries()].slice(0, 3);
    const versions = new Map(batch.map(([id]) => [id, cursors.get(id)]));
    state.busy = true;
    publish();
    try {
      const reply = await provider.respond(
        {
          purpose: "updates",
          text: batch.map(([, text]) => text).join("\n\n"),
          ...memory(),
          explicitTargetId: null,
        },
        controller.signal,
      );
      if (
        key === token &&
        state.enabled &&
        [...versions].every(([id, cursor]) => cursors.get(id) === cursor)
      ) {
        for (const [id, text] of batch)
          if (updates.get(id) === text) updates.delete(id);
        say(reply.text, reply.speech, undefined, {
          event: "update",
          sessionIds: batch.map(([id]) => id),
        });
      }
    } catch (error) {
      if (key === token && state.enabled) {
        // Failed requests are not retried. The canonical sessions retain their text.
        for (const [id] of batch) updates.delete(id);
        state.error = `${error instanceof Error ? error.message : "Update summary failed."} Read the affected sessions for unsummarized updates.`;
        publish();
      }
    } finally {
      if (key === token && state.enabled) {
        state.busy = false;
        publish();
        if (updates.size) void flushUpdates();
      }
    }
  }
  async function request(
    key: string,
    text: string,
    selected: string,
    mode?: CoordinatorMode,
    delegationId?: string,
  ) {
    check(key);
    if (state.busy)
      throw new Error(
        "The coordinator is preparing a reply. Wait before reviewing another instruction.",
      );
    if (!text.trim() || text.length > 6000)
      throw new Error("Use an instruction of 1–6000 characters.");
    const pending = state.proposal;
    state.proposal = null;
    state.error = "";
    const exchange: CoordinatorExchange = {
      role: "user",
      text,
      event: "request",
      sessionIds: [],
    };
    state.conversation.push(exchange);
    const version = ++epoch;
    state.busy = true;
    try {
      await refreshSessions();
      const explicit = explicitTarget(text);
      const current =
        state.sessions.find((s) => s.handle === (selected || state.target)) ??
        null;
      if (selected && !current)
        throw new Error(
          "That session is no longer in the inventory. Select a current target.",
        );
      const currentContext = current
        ? await workspace.coordinatorContext(current.id)
        : null;
      if (key !== token || !state.enabled || version !== epoch) return;
      if (current?.handle !== state.target) focus(current, currentContext);
      else state.context = currentContext;
      exchange.sessionIds = explicit ? [explicit.id] : [];
      const input = {
        ...memory(),
        proposal: pending,
        purpose: "request" as const,
        text,
        explicitTargetId: explicit?.id ?? null,
      };
      publish();
      const reply = await provider.respond(input, controller.signal);
      if (key !== token || !state.enabled || version !== epoch) return;
      const target = reply.targetId
        ? input.sessions.find((s) => s.id === reply.targetId)
        : null;
      if (reply.targetId && !target)
        throw new Error(
          "The proposed session is not in the authorized inventory. Which session did you mean?",
        );
      if (explicit && target && explicit.id !== target.id)
        throw new Error(
          "The proposed target conflicts with your explicit handle. Which session should receive the request?",
        );
      const context = target
        ? await workspace.coordinatorContext(target.id)
        : null;
      if (key !== token || !state.enabled || version !== epoch) return;
      if (target && context?.revision !== target.revision)
        throw new Error(
          "The session changed while preparing this reply. Review a fresh request.",
        );
      exchange.sessionIds = target ? [target.id] : [];
      state.question = reply.question;
      if (reply.kind === "prompt") {
        if (!target || reply.question) {
          state.question =
            reply.question ?? "Which session should receive this request?";
          say(state.question, state.question, delegationId);
          return;
        }
        const available = (await workspace.coordinatorSessions()).find(
          (s) => s.id === target.id,
        );
        if (key !== token || !state.enabled || version !== epoch) return;
        if (
          !available?.root ||
          !available.available ||
          !available.writable ||
          !context?.writable
        ) {
          say(
            `${target.handle} is not an available local writer. Open and activate it in web-pi first; stop any external writer before doing so.`,
          );
          return;
        }
        if (available.revision !== context.revision)
          throw new Error(
            "The session changed while preparing this reply. Review a fresh request.",
          );
        if (context.dialog) {
          say(
            `${target.handle} has a typed dialog. Answer the exact question using the visible controls; spoken assent cannot approve it.`,
          );
          return;
        }
        if (!reply.instruction.trim() || reply.instruction.length > 6000)
          throw new Error("The provider returned an invalid instruction.");
        focus(target, context);
        state.question = null;
        state.proposal = {
          id: newId(),
          target: target.id,
          label: `${target.handle} — ${target.label}`,
          text: reply.instruction,
          mode: mode ?? (context.running ? "followUp" : "prompt"),
          revision: context.revision,
        };
        say(
          `${reply.text}\nProposed for ${target.handle}; not sent.`,
          `${target.handle}: an instruction is ready for your review. It has not been sent.`,
          delegationId,
          {
            event: "proposal",
            sessionIds: [target.id],
            proposal: structuredClone(state.proposal),
          },
        );
      } else {
        if (target && !reply.question) focus(target, context);
        say(
          reply.question ?? reply.text,
          reply.question ?? reply.speech,
          delegationId,
          { sessionIds: target ? [target.id] : [] },
        );
      }
    } catch (error) {
      if (key === token && state.enabled && version === epoch) {
        state.error =
          error instanceof Error
            ? error.message
            : "The coordinator request failed.";
        state.question = state.error;
        say(state.error, state.error, delegationId);
      }
    } finally {
      if (key === token && state.enabled) {
        state.busy = false;
        publish();
        if (updates.size) void flushUpdates();
      }
    }
  }
  function voiceEvent(key: string, event: VoiceEvent) {
    if (key !== token || !state.enabled) return;
    if ("id" in event) {
      if (events.has(event.id)) return;
      events.add(event.id);
      const oldest = events.values().next().value;
      if (events.size > 1024 && oldest) events.delete(oldest);
    }
    if (event.type === "input") {
      state.inputCaption = (state.inputCaption + event.text).slice(-6000);
      voiceInput += event.text;
      state.proposal = null;
      epoch++;
    } else if (event.type === "output") {
      state.outputCaption = (state.outputCaption + event.text).slice(-6000);
      voiceOutput += event.text;
    } else if (event.type === "delegate") {
      // Metadata is only a request to reason about captured context. It never
      // authorizes a tool or marks an utterance complete.
      if (!state.busy && voiceInput.trim()) {
        const text = voiceInput;
        voiceInput = "";
        if (voiceOutput.trim())
          state.conversation.push({
            role: "assistant",
            text: voiceOutput,
            event: "speech",
          });
        voiceOutput = "";
        void request(key, text, state.target, undefined, event.id).catch(
          (error: unknown) => {
            if (key === token && state.enabled) {
              state.error =
                error instanceof Error
                  ? error.message
                  : "Review the captured words before trying again.";
              say(state.error, state.error, event.id);
            }
          },
        );
      } else
        voice?.context(
          "Ask the user to review the captured words in the coordinator panel before preparing an instruction.",
          true,
          event.id,
        );
    } else if (event.type === "error") state.error = event.message;
    else if (event.type === "closed") {
      voice = undefined;
      state.voice = "off";
      state.error = event.confirmed
        ? "Voice ended. Text is still available."
        : "Voice disconnected. Provider finalization is unconfirmed; text is still available.";
    }
    publish();
  }
  function startDeadline(key: string) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (key !== token) return;
      state.error = voiceWindowStarted
        ? "The 90-minute voice window ended. Enable again explicitly to continue."
        : "The 90-minute text-only window ended. Enable again explicitly to continue.";
      void end(key);
    }, COORDINATOR_WINDOW_MS);
    timer.unref?.();
  }
  async function end(key: string) {
    if (!token) return ending ?? true;
    check(key);
    state.enabled = false;
    epoch++;
    voiceEpoch++;
    controller.abort();
    clearTimeout(timer);
    stopGlobal?.();
    stopGlobal = undefined;
    for (const off of observers.values()) off();
    observers.clear();
    updates.clear();
    reading.clear();
    reread.clear();
    token = "";
    const closing = voice;
    voice = undefined;
    state.voice = "off";
    state.proposal = null;
    ending = closing ? closing.close() : Promise.resolve(true);
    publish();
    listeners.clear();
    return ending;
  }
  return {
    ready: () => provider.ready(),
    async begin() {
      if (!provider.ready())
        throw new Error(
          "OpenAI is not configured. Set OPENAI_API_KEY on the web-pi server, then restart. API billing is separate from subscriptions.",
        );
      if (token)
        throw new Error(
          "A coordinator is already enabled in another tab. End it there or wait for its 90-minute text or voice window to end.",
        );
      token = newId();
      ending = undefined;
      const key = token;
      state = { ...empty(), enabled: true };
      controller = new AbortController();
      voiceWindowStarted = false;
      handles.clear();
      cursors.clear();
      revisions.clear();
      dialogs.clear();
      events.clear();
      try {
        await refreshSessions();
        await Promise.all(state.sessions.map(attach));
        stopGlobal = workspace.subscribeSessions((event) => {
          if (event.type === "opened") {
            void refreshSessions()
              .then(async () => {
                const session = state.sessions.find(
                  (s) => s.id === event.sessionId,
                );
                if (session && key === token) await attach(session);
                publish();
              })
              .catch(() => {});
          } else {
            if (event.type === "stopped")
              void refreshSessions().catch(() => {});
            void observe(event.sessionId);
          }
        });
        startDeadline(key);
        publish();
        return key;
      } catch (error) {
        await end(key);
        throw error;
      }
    },
    state(key: string) {
      check(key);
      return structuredClone(state);
    },
    subscribe(key: string, listener: (state: CoordinatorState) => void) {
      check(key);
      listeners.add(listener);
      listener(structuredClone(state));
      return () => listeners.delete(listener);
    },
    async select(key: string, handle: string) {
      check(key);
      if (state.busy)
        throw new Error("Wait for the current coordinator request.");
      epoch++;
      state.proposal = null;
      state.busy = true;
      publish();
      try {
        await refreshSessions();
        const session = state.sessions.find((s) => s.handle === handle);
        const context = session
          ? await workspace.coordinatorContext(session.id)
          : null;
        check(key);
        focus(session ?? null, context);
        state.question = null;
        state.inputCaption = "";
      } finally {
        if (key === token) {
          state.busy = false;
          publish();
          if (updates.size) void flushUpdates();
        }
      }
    },
    request,
    async confirm(key: string, id: string) {
      check(key);
      const proposal = state.proposal;
      if (state.busy || !proposal || proposal.id !== id)
        throw new Error("The proposal expired or changed. Review it again.");
      state.proposal = null;
      state.busy = true;
      state.conversation.push({
        role: "user",
        event: "submission",
        text: `Confirmed instruction for ${proposal.label}.`,
        sessionIds: [proposal.target],
        proposal: structuredClone(proposal),
      });
      publish();
      try {
        await workspace.coordinatorSend(
          proposal.target,
          proposal.revision,
          proposal.text,
          proposal.mode,
        );
        if (key === token) state.inputCaption = "";
        if (key === token) {
          const timing =
            proposal.mode === "followUp"
              ? "; will run after current work"
              : proposal.mode === "steer"
                ? "; will interrupt current work"
                : "";
          say(
            `${proposal.label}: instruction submitted${timing}. This acknowledges admission, not completion.`,
            undefined,
            undefined,
            {
              event: "result",
              sessionIds: [proposal.target],
              proposal: structuredClone(proposal),
            },
          );
        }
      } catch (error) {
        if (key === token)
          say(
            `${proposal.label}: admission failed. ${error instanceof Error ? error.message : "Review a fresh request."}`,
            undefined,
            undefined,
            {
              event: "result",
              sessionIds: [proposal.target],
              proposal: structuredClone(proposal),
            },
          );
        throw error;
      } finally {
        if (key === token) {
          state.busy = false;
          publish();
        }
      }
    },
    async answer(
      key: string,
      revision: string,
      requestId: string,
      answer: DialogAnswer,
    ) {
      check(key);
      const session = state.sessions.find((s) => s.handle === state.target);
      if (state.busy || !session)
        throw new Error("Select an available session first.");
      state.busy = true;
      state.proposal = null;
      publish();
      try {
        await workspace.coordinatorAnswer(
          session.id,
          revision,
          requestId,
          answer,
        );
        if (key === token)
          say(
            `${session.handle}: dialog answer accepted for ${requestId}: ${JSON.stringify(answer)}.`,
            undefined,
            undefined,
            { event: "result", sessionIds: [session.id] },
          );
      } finally {
        if (key === token) {
          state.busy = false;
          publish();
        }
      }
    },
    async connect(key: string, offer: string) {
      check(key);
      if (state.voice !== "off")
        throw new Error("Voice is already connected or connecting.");
      const generation = ++voiceEpoch;
      state.voiceGeneration = generation;
      state.voice = "connecting";
      state.inputCaption = "";
      state.outputCaption = "";
      voiceInput = "";
      voiceOutput = "";
      publish();
      try {
        const connected = await provider.connect(
          offer,
          (event) => {
            if (generation === voiceEpoch) voiceEvent(key, event);
          },
          controller.signal,
          memory(),
        );
        if (key !== token || !state.enabled || generation !== voiceEpoch) {
          await connected.close();
          throw new Error("Coordinator ended.");
        }
        voice = connected;
        state.voice = "connected";
        if (!voiceWindowStarted) {
          voiceWindowStarted = true;
          startDeadline(key);
        }
        voice.context(
          `Selected target: ${state.target || "none"}. Never claim an instruction was submitted before the application confirms admission.`,
          false,
        );
        publish();
        return { answer: connected.answer, generation };
      } catch (error) {
        if (generation === voiceEpoch && key === token) {
          state.voice = "off";
          publish();
        }
        throw error;
      }
    },
    mute(key: string, muted: boolean) {
      check(key);
      state.muted = muted;
      voice?.mute(muted);
      publish();
    },
    async endVoice(key: string) {
      check(key);
      voiceEpoch++;
      const closing = voice;
      voice = undefined;
      state.voice = "off";
      state.muted = false;
      publish();
      return closing ? closing.close() : true;
    },
    shutdown: () => (token ? end(token) : Promise.resolve(true)),
    end,
  };
}

export type Coordinator = ReturnType<typeof createCoordinator>;
