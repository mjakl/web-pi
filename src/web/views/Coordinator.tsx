import type { CoordinatorState as State } from "@core/coordinator-types";

export function CoordinatorPanel() {
  return (
    <details class="coordinator" id="coordinator">
      <summary>
        Coordinator <span class="coordinator-indicator">off</span>
      </summary>
      <div class="coordinator-panel">
        <header>
          <h2>Talk to web-pi</h2>
          <p>Coordinate tasks across sessions. Coding stays in Pi.</p>
        </header>
        <p class="coordinator-consent">
          Starting sends session labels, bounded conversation text and
          microphone audio to OpenAI. Voice costs $0.05 per connected minute,
          including silence ($4.50 for 90 minutes), plus text and coding usage.
          API billing is separate from subscriptions.
        </p>
        <p class="coordinator-note">
          Nearby audio is sent while unmuted, even with this panel collapsed.
          Clear ordinary requests send work. Approvals wait for visible review
          while safely stopped.
        </p>
        <div class="coordinator-actions">
          <button type="button" data-coordinator="voice">
            Start voice
          </button>
          <button type="button" data-coordinator="mute" disabled hidden>
            Mute microphone
          </button>
          <button type="button" data-coordinator="end" disabled hidden>
            End
          </button>
        </div>
        <p class="coordinator-playback" role="status">
          Microphone off. Speech off.
        </p>
        <p class="coordinator-error" role="alert"></p>
        <p class="coordinator-draft-state coordinator-note" role="status"></p>
        <div class="coordinator-state" data-enabled="false"></div>
        <details class="coordinator-options">
          <summary>Text fallback and voice details</summary>
          <div class="coordinator-actions">
            <button type="button" data-coordinator="begin">
              Start text only
            </button>
            <button type="button" data-coordinator="speech" disabled>
              Stop speaking
            </button>
            <button type="button" data-coordinator="end-voice" disabled>
              Switch to text
            </button>
          </div>
          <form class="coordinator-compose">
            <label for="coordinator-draft">
              Instruction or question <span>(ordinary requests send work)</span>
            </label>
            <textarea
              id="coordinator-draft"
              name="text"
              maxlength={6000}
              rows={3}
              placeholder="List active sessions, or select a target and ask it to review…"
            ></textarea>
            <div class="coordinator-actions">
              <button type="submit" disabled>
                Send request
              </button>
              <button type="button" data-coordinator="captions" disabled>
                Use captured words
              </button>
            </div>
          </form>
          <p class="coordinator-note">
            The first provider voice connection starts a 90-minute window;
            restarting voice does not extend it. Text-only mode ends 90 minutes
            after Start text only. No audio recording is requested; ordinary
            provider abuse monitoring may retain content up to 30 days.
          </p>
          <p class="coordinator-note">
            Screen lock, backgrounding, headset changes or network loss may
            interrupt voice. There is no automatic reconnect. Stop speaking
            mutes playback only; it does not stop coding. Saved sessions require
            a task-bound handoff before resume; external writers must stay
            stopped.
          </p>
        </details>
        <noscript>
          The conversational coordinator needs JavaScript. Ordinary session
          pages and forms remain available.
        </noscript>
      </div>
    </details>
  );
}

export function CoordinatorState({ state }: { state: State }) {
  const context = state.context;
  const dialog = context?.dialog;
  const target = state.sessions.find((s) => s.handle === state.target);
  return (
    <div
      class="coordinator-state"
      data-enabled={String(state.enabled)}
      data-busy={String(state.busy)}
      data-voice={state.voice}
      data-voice-generation={state.voiceGeneration}
      data-muted={String(state.muted)}
      data-playback-sequence={state.playback.sequence}
      data-playback-stopped={String(state.playback.stopped)}
    >
      {state.busy && (
        <p class="coordinator-status" role="status">
          Preparing a reply…
        </p>
      )}
      {state.error && (
        <p class="coordinator-error" role="alert">
          {state.error}
        </p>
      )}
      <label for="coordinator-target">Current target</label>
      <select id="coordinator-target" disabled={!state.enabled || state.busy}>
        <option value="" selected={!state.target}>
          No target — ask when ambiguous
        </option>
        {state.sessions.map((s) => (
          <option value={s.handle} selected={state.target === s.handle}>
            {s.handle} · {s.label} ·{" "}
            {s.running ? "running" : s.live ? "idle" : "saved"}
          </option>
        ))}
      </select>
      {target && <p class="coordinator-task">{target.task}</p>}
      <details class="coordinator-sessions">
        <summary>Known sessions ({state.sessions.length}, up to 50)</summary>
        <ul>
          {state.sessions.map((s) => (
            <li>
              <a href={`/sessions/${s.id}`} target="_blank" rel="noreferrer">
                {s.handle} — {s.label}
              </a>
              <p>{s.task}</p>
              <small>
                {s.cwd} ·{" "}
                {s.available
                  ? s.live
                    ? "Local writer"
                    : "Saved; external activity unknown"
                  : "Folder unavailable"}
              </small>
            </li>
          ))}
        </ul>
      </details>
      <div
        class="coordinator-log"
        role="log"
        aria-label="Coordinator text conversation"
      >
        {state.conversation.map((m) => (
          <p
            class={m.role === "user" ? "coordinator-user" : "coordinator-reply"}
          >
            <strong>{m.role === "user" ? "You" : "Coordinator"}</strong>
            {m.text}
          </p>
        ))}
      </div>
      {state.voice !== "off" && (
        <section class="coordinator-captions" aria-label="Live captions">
          <p class="coordinator-note">
            Live captions are approximate, not final turns.
          </p>
          <h3>You</h3>
          <pre data-coordinator-input>
            {state.inputCaption || "Waiting for speech…"}
          </pre>
          <h3>Voice reply</h3>
          <pre>{state.outputCaption || "No speech yet."}</pre>
        </section>
      )}
      {dialog && context && (
        <form
          class="coordinator-dialog"
          data-revision={context.revision}
          data-request={dialog.id}
        >
          <h3>
            {state.target} asks: {dialog.title}
          </h3>
          {dialog.message && <p>{dialog.message}</p>}
          <p>
            Answer binds only to this exact typed question. Speech and model
            replies cannot approve it.
          </p>
          {dialog.method === "confirm" ? (
            <div class="coordinator-actions">
              <button
                type="submit"
                name="confirmed"
                value="true"
                disabled={state.busy}
              >
                Approve this question
              </button>
              <button
                type="submit"
                name="confirmed"
                value="false"
                disabled={state.busy}
              >
                Decline
              </button>
            </div>
          ) : (
            <>
              <label>
                Answer
                {dialog.method === "select" ? (
                  <select name="value">
                    {dialog.options?.map((option) => (
                      <option value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    name="value"
                    rows={3}
                    maxlength={6000}
                    placeholder={dialog.placeholder}
                  >
                    {dialog.prefill ?? ""}
                  </textarea>
                )}
              </label>
              <button type="submit" disabled={state.busy}>
                Send this answer
              </button>
            </>
          )}
        </form>
      )}
      {context && (
        <details class="coordinator-source">
          <summary>Target context — bounded source text, not a summary</summary>
          {context.messages.slice(-4).map((m) => (
            <section>
              <strong>{m.role}</strong>
              <pre>{m.text}</pre>
            </section>
          ))}
          <p>
            Read the full session for omitted history. Ordinary prose questions
            have no typed answer binding.
          </p>
        </details>
      )}
    </div>
  );
}
