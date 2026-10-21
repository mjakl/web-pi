import {
  frontmatterCard,
  type FrontmatterValue,
  parseFrontmatter,
} from "@core/frontmatter";
import { renderMarkdown } from "@web/markdown";
import {
  CheckIcon,
  CopyIcon,
  ForkIcon,
  PlusIcon,
  StarIcon,
} from "@web/views/icons";
import { raw } from "hono/html";

// Shared transcript presentation and actions. Native disclosures and
// areas/transcript.css own layout and visual state.

/** What the transcript may do to the session it belongs to. */
export type ItemActions = {
  sessionId: string;
  /** Resolves relative file links in Markdown. */
  cwd: string;
  starred: Set<string>;
  /** History edits are unavailable on alternate branches or missing folders. */
  readOnly?: boolean;
  /** Delegated transcripts also refuse metadata edits such as stars. */
  inspectionOnly?: boolean;
  /** Entry ids whose message shows a time. */
  timestamps?: Set<string>;
  /** Inside the running turn: no history actions. */
  live?: boolean;
  /**
   * A turn is in flight. pi-web keeps the history row rendered and disables
   * only what the turn owns: branching waits, rewind is gone
   * (ChatWindow.tsx `branchDisabledReason` and `onRewind`).
   */
  busy?: boolean;
  /** The last line each running tool reported, by tool-call id. */
  progress?: Record<string, string>;
  /** A message is streaming: keep thinking activity and hide completed controls. */
  streaming?: boolean;
};

/**
 * An item's id in markup. The streaming message has no entry yet, so its
 * start time names it; the turn, the message and its thinking all derive
 * their ids from this one key, which is what lets a morph match them up.
 */
export function itemKey(item: { entryId: string; timestamp: string }): string {
  return item.entryId === "partial"
    ? `partial-${String(Date.parse(item.timestamp))}`
    : item.entryId;
}

/** pi-web's `formatTimestamp`: 24h, and the date once it is not today. */
export function formatTimestamp(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (today) return time;
  const day = date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day} ${time}`;
}

/** pi-web's `formatDuration`, used by the subagent card. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours.toLocaleString("en")}h ${String(minutes)}m ${String(rest)}s`;
  }
  if (minutes > 0) return `${String(minutes)}m ${String(rest)}s`;
  return `${String(rest)}s`;
}

type MarkdownVariant =
  | "markdown-user-message"
  | "markdown-assistant-message"
  | "markdown-custom-message"
  | "markdown-compaction-message";

/** The key/value card a Markdown document's YAML front matter shows as. */
export function FrontmatterCard({
  fields,
}: {
  fields: [string, FrontmatterValue][];
}) {
  const card = frontmatterCard(fields);
  if (
    card.title === undefined &&
    card.chips.length === 0 &&
    card.rest.length === 0
  ) {
    return <></>;
  }
  return (
    <div class="markdown-frontmatter">
      {card.title === undefined ? null : (
        <div class="markdown-frontmatter-title">{card.title}</div>
      )}
      {card.chips.length === 0 ? null : (
        <div class="markdown-frontmatter-tags">
          {card.chips.map((chip) => (
            <span class="markdown-frontmatter-tag">{chip}</span>
          ))}
        </div>
      )}
      {card.rest.length === 0 ? null : (
        <dl class="markdown-frontmatter-rows">
          {card.rest.map(([key, value]) => (
            <div class="markdown-frontmatter-row">
              <dt>{key}</dt>
              <dd>
                {/^(https?:\/\/|mailto:)/i.test(value) ? (
                  <a href={value} target="_blank" rel="noopener noreferrer">
                    {value}
                  </a>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * A message's Markdown. One that opens with YAML front matter shows it as
 * the file preview's card, but only when the card shows every line of it;
 * any other `---` block is ordinary Markdown, so nothing is hidden.
 */
export function Markdown({
  source,
  actions,
  variant,
}: {
  source: string;
  actions?: ItemActions;
  variant?: MarkdownVariant;
}) {
  const front = parseFrontmatter(source);
  const card = front.complete && front.fields.length > 0;
  return (
    <div class={variant ? `markdown-body ${variant}` : "markdown-body"}>
      {card ? <FrontmatterCard fields={front.fields} /> : null}
      {raw(
        renderMarkdown(card ? front.body : source, {
          ...(actions
            ? { cwd: actions.cwd, sessionId: actions.sessionId }
            : {}),
        }),
      )}
    </div>
  );
}

/**
 * pi-web's copy button: 11px icon plus label, `--text-dim` until hover.
 * The text it copies rides in a hidden sibling, because a message can be
 * larger than an attribute should be.
 */
export function CopyButton({
  text,
  class: className = "message-copy",
  bare,
}: {
  text: string;
  class?: string;
  /** The extension card's footer copies with a word, not an icon. */
  bare?: boolean;
}) {
  if (text === "") return <></>;
  return (
    <>
      <span hidden data-copy-source>
        {text}
      </span>
      <button
        type="button"
        class={`${className}${bare === true ? " is-bare" : ""}`}
        data-copy
        title="Copy message"
      >
        {bare === true ? (
          "Copy"
        ) : (
          <>
            <span data-copy-idle>
              <CopyIcon size={11} width={1.8} />
              Copy
            </span>
            <span data-copy-done>
              <CheckIcon size={11} width={1.8} />
              Copied
            </span>
          </>
        )}
      </button>
    </>
  );
}

export function Time({ value }: { value: string }) {
  const text = formatTimestamp(value);
  if (text === "") return <></>;
  return <span class="transcript-time">{text}</span>;
}

function imageUrl(
  actions: ItemActions,
  entryId: string,
  index: number,
): string {
  return `/sessions/${actions.sessionId}/entries/${entryId}/image/${String(index)}`;
}

export function Images({
  entryId,
  indices,
  actions,
  variant,
  separated = false,
}: {
  entryId: string;
  indices: number[];
  actions?: ItemActions;
  variant: "user" | "note" | "assistant" | "tool";
  separated?: boolean;
}) {
  if (!actions || indices.length === 0) return <></>;
  return (
    <div
      class={`transcript-images is-${variant}${separated ? " has-following-text" : ""}`}
    >
      {indices.map((index) => (
        // pi-web opens a transcript image in a modal over the app, never in a
        // tab of its own (components/ImagePreview.tsx).
        <button
          type="button"
          data-image-preview={imageUrl(actions, entryId, index)}
          aria-haspopup="dialog"
          aria-expanded="false"
          title="Preview image"
          aria-label="Preview image"
          class="transcript-image-trigger"
        >
          <img
            class="transcript-image"
            alt=""
            loading="lazy"
            src={imageUrl(actions, entryId, index)}
          />
        </button>
      ))}
    </div>
  );
}

/** pi-web's two history actions: continue here, or copy the history away. */
export function HistoryActionButtons({
  entryId,
  actions,
}: {
  entryId: string;
  actions: ItemActions;
}) {
  const post = (path: string) => `/sessions/${actions.sessionId}/${path}`;
  const swap = {
    "hx-vals": JSON.stringify({ entryId }),
    "hx-target": "body",
    "hx-swap": "innerHTML",
  };
  const idleTitle =
    "New branch — continue from this point within the current session";
  const busyTitle = "Wait for the current operation to finish before branching";
  const branchTitle = actions.busy === true ? busyTitle : idleTitle;
  return (
    <>
      <span title={branchTitle}>
        <button
          type="button"
          class="history-action"
          aria-label="New branch"
          data-history-action="branch"
          data-idle-title={idleTitle}
          data-busy-title={busyTitle}
          title={branchTitle}
          hx-post={post("navigate")}
          {...swap}
          disabled={actions.busy === true}
        >
          <ForkIcon />
          Branch
        </button>
      </span>
      <button
        type="button"
        class="history-action"
        title="New session — copy history to this point into a separate session"
        hx-post={post("fork")}
        {...swap}
      >
        <PlusIcon size={11} width={1.2} />
        Clone
      </button>
    </>
  );
}

/** pi-web's `HistoryActionFrame`: the actions appear on hovering the host. */
export function HistoryActionFrame({
  entryId,
  actions,
  children,
  copyText,
}: {
  entryId: string;
  actions?: ItemActions;
  children?: unknown;
  copyText?: string;
}) {
  if (!actions || actions.readOnly || actions.live) return <>{children}</>;
  return (
    <div class="history-action-host">
      {children}
      <div class="history-actions">
        {copyText === undefined ? null : <CopyButton text={copyText} />}
        <HistoryActionButtons entryId={entryId} actions={actions} />
      </div>
    </div>
  );
}

/**
 * Swaps itself for the toggled button the star route answers with. Only the
 * caller knows whether the reader may star, so it decides whether to draw it.
 */
export function StarButton({
  sessionId,
  entryId,
  starred,
}: {
  sessionId: string;
  entryId: string;
  starred: boolean;
}) {
  const label = starred ? "Unstar answer" : "Star answer";
  return (
    <button
      type="button"
      class="answer-star-toggle"
      aria-pressed={starred ? "true" : "false"}
      aria-label={label}
      title={label}
      hx-post={`/sessions/${sessionId}/star`}
      hx-vals={JSON.stringify({ entryId, starred: !starred })}
      hx-target="this"
      hx-swap="outerHTML"
    >
      <StarIcon filled={starred} />
    </button>
  );
}
