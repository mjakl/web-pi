import type { DialogAnswer } from "@core/extension-ui";
import type { Workspace } from "@core/workspace";
import type { CoordinatorMode } from "@core/workspace/coordinator";
import type {
  CoordinatorExchange,
  CoordinatorMemory,
  CoordinatorProvider,
  CoordinatorProposal,
  CoordinatorSession,
  CoordinatorState,
  CoordinatorVoice,
  VoiceEvent,
} from "@core/coordinator-types";

export const COORDINATOR_WINDOW_MS = 90 * 60_000;

/** One opt-in conversation. Only resolved user requests may enter Workspace;
 * background data and assistant speech never authorize coding or approvals. */
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
  let waiting:
    | {
        text: string;
        selected: string;
        mode?: CoordinatorMode;
        delegationId?: string;
        done: (() => void)[];
      }
    | undefined;
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
      question: null,
      conversation: [],
      inputCaption: "",
      outputCaption: "",
      voice: "off",
      voiceGeneration: 0,
      muted: false,
      playback: { sequence: 0, stopped: false },
      pending: null,
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
      question: state.question,
      pending: state.pending,
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
        text: `Current target: ${session ? session.label : "none"}.`,
      });
    }
    state.target = session?.handle ?? "";
    state.context = context;
    voice?.context(
      `Current target: ${session ? `${session.handle} (${session.id}) — ${session.label}` : "none"}.`,
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
        "Which single task should receive this request? You can use its name.",
      );
    if (mentioned.length === 1) {
      const target = state.sessions.find((s) => s.handle === mentioned[0]);
      if (!target)
        throw new Error(
          "That session handle is unknown. Which current task did you mean?",
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
      const observed = JSON.stringify([
        context.revision,
        context.running,
        context.status,
      ]);
      if (!baseline && revisions.get(id) === observed) return;
      revisions.set(id, observed);
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
      const previousStatus = session.status;
      session.status = context.status;
      if (
        !baseline &&
        (context.status.error ||
          context.status.notices.length ||
          context.status.retry) &&
        JSON.stringify([
          previousStatus?.error,
          previousStatus?.notices,
          previousStatus?.retry,
        ]) !==
          JSON.stringify([
            context.status.error,
            context.status.notices,
            context.status.retry,
          ])
      )
        updates.set(
          id,
          `${updates.get(id) ?? `${session.label}:`}\nStatus: ${JSON.stringify(context.status)}`.slice(
            -6000,
          ),
        );
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
            state.error = `${session.label}'s update window was exceeded. Omitted text remains available for visible review while safely stopped.`;
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
          `${session.label} — ${context.dialog.title}\n${context.dialog.message ?? ""}\nThis typed dialog is paused for visible review while safely stopped. Speech cannot answer it.`,
          `${session.label} is paused for visible review while safely stopped. It has a typed dialog.`,
          undefined,
          { event: "update", sessionIds: [id] },
        );
      }
      dialogs.set(id, dialog);
      if (state.target === session.handle) {
        state.context = context;
      }
      publish();
      void flushUpdates();
    } catch {
      if (key === token && state.enabled) {
        state.error =
          "A task changed or became unavailable. Ask for its current status again.";
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
    if (
      !state.enabled ||
      state.busy ||
      waiting ||
      voiceInput.trim() ||
      !updates.size
    )
      return;
    const key = token;
    const version = epoch;
    // Coalesce a few session updates without displacing conversational focus.
    const batch = [...updates.entries()].slice(0, 3);
    const versions = new Map(batch.map(([id]) => [id, revisions.get(id)]));
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
        version === epoch &&
        !voiceInput.trim() &&
        [...versions].every(([id, revision]) => revisions.get(id) === revision)
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
        state.error = `${error instanceof Error ? error.message : "Update summary failed."} Unsummarized details remain available for visible review while safely stopped.`;
        publish();
      }
    } finally {
      if (key === token && state.enabled) {
        state.busy = false;
        publish();
        if (waiting) void drain();
        else if (updates.size) void flushUpdates();
      }
    }
  }
  async function request(
    key: string,
    text: string,
    selected: string,
    mode?: CoordinatorMode,
    delegationId?: string,
  ): Promise<void> {
    check(key);
    if (!text.trim() || text.length > 6000)
      throw new Error("Use an instruction of 1–6000 characters.");
    epoch++;
    state.conversation.push({
      role: "user",
      text,
      event: "request",
      sessionIds: [],
    });
    return new Promise<void>((done) => {
      if (waiting) {
        waiting.text += `\n${text}`;
        waiting.selected = selected;
        waiting.mode = mode;
        waiting.delegationId = delegationId;
        waiting.done.push(done);
      } else waiting = { text, selected, mode, delegationId, done: [done] };
      void drain();
    });
  }
  async function drain() {
    if (!state.enabled || state.busy || voiceInput.trim() || !waiting) return;
    const batch = waiting;
    waiting = undefined;
    await resolveRequest(
      token,
      batch.text,
      batch.selected,
      batch.mode,
      batch.delegationId,
    );
    for (const done of batch.done) done();
  }
  async function resolveRequest(
    key: string,
    text: string,
    selected: string,
    mode?: CoordinatorMode,
    delegationId?: string,
  ) {
    const pending = state.pending;
    const intent = state.pending ?? {
      id: newId(),
      text,
      question: null,
      ownership: null,
      mode,
    };
    state.pending = intent;
    state.error = "";
    const version = epoch;
    const currentRequest = () =>
      key === token && state.enabled && version === epoch;
    state.busy = true;
    try {
      await refreshSessions();
      const explicit = explicitTarget(text);
      const current =
        state.sessions.find((s) => s.handle === (selected || state.target)) ??
        null;
      if (selected && !current)
        throw new Error(
          "That session is no longer in the inventory. Which current task did you mean?",
        );
      const currentContext = current
        ? await workspace.coordinatorContext(current.id)
        : null;
      if (key !== token || !state.enabled || version !== epoch) return;
      if (!pending && current?.handle !== state.target)
        focus(current, currentContext);
      else if (current?.handle === state.target) state.context = currentContext;
      const input = {
        ...memory(),
        target: current,
        context: currentContext,
        pending: structuredClone(pending),
        purpose: "request" as const,
        text,
        explicitTargetId: explicit?.id ?? null,
      };
      publish();
      const assent =
        /^(yes|yeah|yep|sure|okay|ok|do it|go ahead|approved?|confirm)[.!\s]*$/i.test(
          text.trim(),
        );
      if (
        assent &&
        (!pending?.question || pending.question !== state.question)
      ) {
        state.pending = null;
        state.question =
          "What ordinary task would you like me to send? Approvals need visible review while safely stopped.";
        say(state.question, state.question, delegationId);
        return;
      }
      const reply = await provider.respond(input, controller.signal);
      if (key !== token || !state.enabled || version !== epoch) return;
      // A control outcome does not own the ordinary request it interrupted.
      if (
        ["stopWork", "stopSpeaking", "resumeSpeaking", "endVoice"].includes(
          reply.kind,
        )
      )
        state.pending = pending;
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
          "The session changed while preparing this reply. What should I send now?",
        );
      if (
        (reply.resolves && reply.resolves !== pending?.id) ||
        (assent && reply.resolves !== pending?.id)
      )
        throw new Error(
          "That answer does not resolve the exact pending ordinary question.",
        );
      if (["stopSpeaking", "resumeSpeaking", "endVoice"].includes(reply.kind)) {
        if (reply.kind === "endVoice") {
          say("Ending voice. Coding continues.", undefined, delegationId);
          await end(key);
        } else {
          state.playback = {
            sequence: state.playback.sequence + 1,
            stopped: reply.kind === "stopSpeaking",
          };
          say(
            reply.kind === "stopSpeaking"
              ? "Speech stopped; microphone and coding continue."
              : "Speech resumed.",
            undefined,
            delegationId,
          );
        }
        return;
      }
      if (reply.kind === "stopWork") {
        if (!target || !context || reply.question)
          throw new Error(
            reply.question ?? "Which task should stop its current turn?",
          );
        const stopped = await workspace.coordinatorAbort(
          target.id,
          context.revision,
          currentRequest,
        );
        if (!currentRequest()) return;
        const result = `${target.label}: ${stopped.aborted ? (stopped.running ? "stop requested; work is still running" : "current turn stopped") : "no current local turn was running"}. Removed ${String(stopped.cleared.length)} queued requests; ${String(stopped.queued)} remain. Changes were not undone.`;
        say(
          result +
            (stopped.cleared.length
              ? `\nRemoved requests:\n${stopped.cleared.map((entry) => entry.text).join("\n")}`
              : ""),
          result,
          delegationId,
          { event: "result", sessionIds: [target.id] },
        );
        return;
      }
      if (pending && current?.handle !== state.target)
        focus(current, currentContext);
      state.question = reply.question;
      if (reply.kind === "handoff") {
        const action = pending?.ownership;
        if (
          !action ||
          reply.resolves !== pending.id ||
          target?.id !== action.target ||
          context?.revision !== action.revision ||
          reply.question
        )
          throw new Error(
            "That answer does not resolve the pending session handoff. Is the requested session stopped in other apps?",
          );
        await submit(action, pending.mode, true, currentRequest, delegationId);
        return;
      }
      if (reply.kind === "prompt") {
        if (!target || reply.question) {
          state.question =
            reply.question ?? "Which session should receive this request?";
          intent.question = state.question;
          say(state.question, state.question, delegationId);
          return;
        }
        const available = (await workspace.coordinatorSessions()).find(
          (s) => s.id === target.id,
        );
        if (key !== token || !state.enabled || version !== epoch) return;
        if (!available?.root || !available.available || !context)
          throw new Error(
            `${target.label} is unavailable. Work is paused until safe visible review while stopped.`,
          );
        if (available.revision !== context.revision)
          throw new Error(
            "The session changed while preparing this reply. What should I send now?",
          );
        if (context.dialog || context.status.blocked)
          throw new Error(
            `${target.label} is paused for visible review while safely stopped. Speech cannot answer typed dialogs or permissions.`,
          );
        if (assent && (reply.resolves !== pending?.id || pending?.ownership))
          throw new Error(
            "That assent is not bound to the pending ordinary question. What should this task do?",
          );
        if (!reply.instruction.trim() || reply.instruction.length > 6000)
          throw new Error("The provider returned an invalid instruction.");
        focus(target, context);
        const action = {
          id: newId(),
          target: target.id,
          label: target.label,
          text: reply.instruction,
          mode:
            mode ??
            (context.running ? ("followUp" as const) : ("prompt" as const)),
          revision: context.revision,
        };
        if (!available.live) {
          const question = `Is the ${target.label} session stopped in other apps? It must stay stopped there while I resume this request.`;
          state.pending = {
            id: newId(),
            text: pending ? `${pending.text}\n${text}` : text,
            ownership: action,
            question,
            mode,
          };
          state.question = question;
          say(
            `${state.question}\nPending instruction: ${action.text}`,
            state.question,
            delegationId,
            { sessionIds: [target.id] },
          );
          return;
        }
        await submit(action, mode, false, currentRequest, delegationId);
      } else {
        if (reply.kind === "clarify" && reply.question) {
          intent.question = reply.question;
        } else {
          state.pending =
            reply.resolves && reply.resolves === pending?.id ? null : pending;
          if (state.pending && !reply.question) state.question = input.question;
        }
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
        // Failure reports the attempt; it does not resolve a pending question.
        say(state.error, state.error, delegationId);
      }
    } finally {
      if (key === token && state.enabled) {
        state.busy = false;
        publish();
        if (waiting) void drain();
        else if (updates.size) void flushUpdates();
      }
    }
  }
  async function submit(
    action: CoordinatorProposal,
    mode: CoordinatorMode | undefined,
    handoff: boolean,
    current: () => boolean,
    delegationId?: string,
  ) {
    const key = token;
    const pending = state.pending;
    state.question = null;
    state.conversation.push({
      role: "assistant",
      event: "submission",
      text: `${action.label} — instruction:\n${action.text}`,
      sessionIds: [action.target],
      proposal: structuredClone(action),
    });
    try {
      const admission = await workspace.coordinatorSend(
        action.target,
        action.revision,
        action.text,
        mode,
        { handoff, current },
      );
      if (key !== token || !state.enabled) return;
      if (state.pending === pending) state.pending = null;
      action.mode = admission.mode;
      const timing =
        admission.mode === "followUp"
          ? admission.queued > 0
            ? `; queued after current work (${String(admission.queued)} queued)`
            : "; no follow-up remains queued"
          : admission.mode === "steer"
            ? "; steering current work"
            : "";
      say(
        `${action.label}: instruction submitted${timing}. This acknowledges admission, not completion.`,
        undefined,
        delegationId,
        {
          event: "result",
          sessionIds: [action.target],
          proposal: structuredClone(action),
        },
      );
    } catch (error) {
      if (key !== token || !state.enabled) return;
      if (current()) state.pending = null;
      state.error = `${action.label}: admission failed. ${error instanceof Error ? error.message : "Nothing was sent."}`;
      say(state.error, state.error, delegationId, {
        event: "result",
        sessionIds: [action.target],
        proposal: structuredClone(action),
      });
    }
  }
  function retireVoiceInput() {
    // Captions survive voice shutdown, but undelegated fragments are not requests.
    voiceInput = "";
    if (waiting) void drain();
    else void flushUpdates();
  }
  function voiceEvent(key: string, event: VoiceEvent) {
    if (key !== token || !state.enabled) return;
    if ("id" in event) {
      if (events.has(event.id)) return;
      events.add(event.id);
    }
    if (event.type === "input") {
      state.inputCaption = (state.inputCaption + event.text).slice(-6000);
      voiceInput += event.text;
      epoch++;
    } else if (event.type === "output") {
      state.outputCaption = (state.outputCaption + event.text).slice(-6000);
      voiceOutput += event.text;
    } else if (event.type === "delegate") {
      // Metadata is only a request to reason about captured context. It never
      // authorizes a tool or marks an utterance complete.
      if (voiceInput.trim()) {
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
                  : "Please clarify the request; nothing was sent.";
              say(state.error, state.error, event.id);
            }
          },
        );
      } else
        voice?.context(
          "No new captured user input is available yet. Do not infer a request from delegation metadata or assistant speech. Ask a brief clarification if needed.",
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
      retireVoiceInput();
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
    for (const done of waiting?.done ?? []) done();
    waiting = undefined;
    const closing = voice;
    voice = undefined;
    state.voice = "off";
    retireVoiceInput();
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
      state.pending = null;
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
          if (waiting) void drain();
          else void flushUpdates();
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
      state.playback = { sequence: 0, stopped: false };
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
        const tasks = state.sessions
          .slice(0, 2)
          .map(
            (s) =>
              `${s.label.slice(0, 40)}: ${s.status?.state === "waiting" ? "waiting for visible review" : s.running ? "running" : s.live ? "idle" : "saved, external activity unknown"}`,
          )
          .join("; ");
        say(
          `Hello. Ordinary requests send work. Approvals wait for visible review while safely stopped. ${tasks || "No tasks are available."}`,
        );
        publish();
        return { answer: connected.answer, generation };
      } catch (error) {
        if (generation === voiceEpoch && key === token) {
          state.voice = "off";
          retireVoiceInput();
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
      retireVoiceInput();
      publish();
      return closing ? closing.close() : true;
    },
    shutdown: () => (token ? end(token) : Promise.resolve(true)),
    end,
  };
}

export type Coordinator = ReturnType<typeof createCoordinator>;
