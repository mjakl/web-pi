import { Partial } from "@web/views/Partial";
import { formatContextUsage } from "@core/context-usage";
import type { ContextUsage } from "@core/context-usage";
import type { LiveStatus } from "@core/ports";
import type { SessionStats } from "@core/session-entries";
import { displaySkillPrompt } from "@core/skill-prompt";
import type { SessionView } from "@core/workspace";
import { ModelSelector, ModelScopeWarning, modelPick } from "./Composer.tsx";
import {
  CompactIcon,
  ContextGaugeIcon,
  RecallQueueIcon,
  RefreshIcon,
  SpinnerIcon,
} from "./icons.tsx";

// Everything about a running session that is not the transcript: the banners
// and the queue panel above the composer surface (pi-web keeps them inside
// ChatInput's 820px column), plus the two things elsewhere on the page
// that the same render owns — the model selector in the toolbar and the
// context readout in the top bar, both swapped out of band.

/**
 * The context gauge the top bar shows; red, amber or plain by threshold. It
 * lives here because this render owns it: tokens move while a turn runs, and
 * pi-web has no status row left to show them in, so the stream re-renders it
 * in place (`oob`) wherever the shell put it.
 */
export function ContextReadout({
  usage,
  tokens,
  oob,
}: {
  usage?: ContextUsage;
  /** The session's token totals, which the stats button shows beside it. */
  tokens?: SessionStats["tokens"];
  oob?: boolean;
}) {
  const text = usage ? formatContextUsage(usage) : "";
  const swap = oob === true ? { "hx-swap-oob": "true" } : {};
  if (!usage || text === "") {
    // With nothing to measure, the readout names what the button opens,
    // unless the token totals beside it already say something. Silent, it
    // stays in the page: the stream swaps it by id.
    return tokens !== undefined && tokens.input > 0 ? (
      <span id="context-readout" hidden {...swap} />
    ) : (
      <span id="context-readout" class="shell-context-empty" {...swap}>
        Session info
      </span>
    );
  }
  return (
    <span
      id="context-readout"
      class={`mobile-session-context is-${usage.level}`}
      data-context-readout
      {...swap}
    >
      <ContextGaugeIcon />
      {text}
    </span>
  );
}

/**
 * The compact button of the top bar. It lives beside the readout because it
 * carries the same threshold: pi-web tints it green the moment the context
 * reaches the warning zone, and a turn moves the context, so the stream
 * re-renders it in place too.
 */
export function CompactButton({
  sessionId,
  usage,
  oob,
  disabled,
  compacting = false,
}: {
  sessionId: string;
  usage?: ContextUsage;
  oob?: boolean;
  disabled?: boolean;
  compacting?: boolean;
}) {
  const warn =
    usage !== undefined &&
    (usage.level === "warn" || usage.level === "critical");
  return (
    <button
      type="button"
      id="context-compact"
      class="context-compact-button"
      {...(warn ? { "data-warning": "true" } : {})}
      {...(disabled === true || compacting ? { disabled: true } : {})}
      {...(compacting ? { "aria-busy": "true" } : {})}
      {...(oob === true ? { "hx-swap-oob": "true" } : {})}
      title={compacting ? "Compacting context…" : "Compact context"}
      aria-label={compacting ? "Compacting context…" : "Compact context"}
      hx-post={`/sessions/${sessionId}/compact`}
      hx-swap="none"
    >
      {compacting ? <SpinnerIcon animated={false} /> : <CompactIcon />}
    </button>
  );
}

/**
 * Whether a turn owns the session right now: pi-web's `sessionBusy ||
 * isCompacting` (ChatWindow.tsx), which disables branching and hides rewind.
 */
export function turnBusy(status: LiveStatus | null): boolean {
  return (
    status !== null &&
    (status.running || status.bashRunning || status.compacting)
  );
}

/**
 * Whether compacting is refused right now, as pi-web decides it
 * (ChatWindow.tsx `compactionControl`): a session whose folder is gone is
 * read-only, and any running operation owns the context until it settles.
 */
export function compactDisabled(view: SessionView): boolean {
  if (view.summary.cwdAvailable === false) return true;
  return turnBusy(view.status);
}

/** One queued message: the kind as a pill, then the text. */
function QueuedRow({
  behavior,
  text,
}: {
  behavior: "steer" | "followUp";
  text: string;
}) {
  const steer = behavior === "steer";
  const prompt = displaySkillPrompt(text);
  const readable = [
    prompt.text,
    ...(prompt.skills?.length
      ? [
          `Skills included: ${prompt.skills.map((skill) => skill.name).join(", ")}`,
        ]
      : []),
  ].join("\n\n");
  return (
    <div title={readable} class="composer-queued-row">
      <span class={`composer-queued-kind${steer ? " is-steer" : ""}`}>
        {steer ? "steer" : "follow-up"}
      </span>
      <span class="composer-queued-text">{readable}</span>
    </div>
  );
}

function QueuePanel({
  sessionId,
  queue,
}: {
  sessionId: string;
  queue: LiveStatus["queue"];
}) {
  if (queue.length === 0) return <></>;
  return (
    <div class="composer-queue">
      <div class="composer-queue-header">
        <span class="composer-queue-label">
          Queued · {String(queue.length)}
        </span>
        <button
          type="button"
          class="composer-queue-recall"
          title="Remove all queued messages and put them back into the input box for editing"
          hx-post={`/sessions/${sessionId}/queue/recall`}
          // The button sits inside the composer form. The recall puts the
          // queued text in front of the draft, so it posts the draft's text
          // and skills, never its attachments.
          data-request-fields="text skills"
          hx-target="#composer-text"
          hx-swap="outerHTML"
        >
          <RecallQueueIcon />
          Recall to input
        </button>
      </div>
      {queue.map((message) => (
        <QueuedRow behavior={message.behavior} text={message.text} />
      ))}
    </div>
  );
}

/**
 * Everything that changes while a session runs. `oob` renders it as a stream
 * update: the body as a `#status` partial, with the context readout and the
 * compact button out of band. `model` adds the toolbar's selector, which the
 * stream sends only when the model or the levels actually changed: it is a
 * whole subtree, and a turn re-renders ten times a second.
 */
export function Status({
  view,
  model,
  oob,
}: {
  view: SessionView;
  model?: boolean;
  oob?: boolean;
}) {
  const { status, summary } = view;
  const body = (
    <>
      <ModelScopeWarning warnings={view.modelWarnings} />
      {status ? (
        <QueuePanel sessionId={summary.id} queue={status.queue} />
      ) : null}
      {status?.retry ? (
        <div class="composer-retry">
          <RefreshIcon size={11} width={2} />
          Retrying ({String(status.retry.attempt)}/
          {String(status.retry.maxAttempts)})…
          {status.retry.message ? (
            <span class="composer-retry-message">— {status.retry.message}</span>
          ) : null}
        </div>
      ) : null}
      {status?.compactionError ? (
        <div role="alert" class="composer-compaction-error">
          {status.compactionError}
        </div>
      ) : null}
      {/* No visual: the client mirrors the running state onto the composer,
          and copies an extension's title into the browser tab. */}
      <span
        id="session-state"
        hidden
        {...(status?.running ? { "data-running": "true" } : {})}
        {...(status?.bashRunning ? { "data-bash-running": "true" } : {})}
        {...(status?.compacting ? { "data-compacting": "true" } : {})}
      />
      {status?.title ? (
        <span id="extension-title" hidden data-title={status.title} />
      ) : null}
    </>
  );
  if (oob !== true) return body;
  return (
    <>
      <Partial target="#status">{body}</Partial>
      <ContextReadout usage={view.usage} tokens={view.tokens} oob />
      <CompactButton
        sessionId={summary.id}
        usage={view.usage}
        oob
        disabled={compactDisabled(view)}
        compacting={status?.compacting ?? false}
      />
      {model === true ? <ModelSelector pick={modelPick(view)} oob /> : null}
    </>
  );
}
