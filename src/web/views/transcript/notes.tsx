import { formatCompactCount } from "@core/context-usage";
import type { BashItem, CompactionItem, NoteItem } from "@core/transcript";
import { CardChevronIcon, CompactIcon } from "@web/views/icons";
import {
  CopyButton,
  formatTimestamp,
  Images,
  type ItemActions,
  Markdown,
} from "./shared.tsx";

// The cards between questions and answers: a compaction marker, an
// extension's custom message, and a `!` shell run.

function FileList({ title, files }: { title: string; files: string[] }) {
  if (files.length === 0) return <></>;
  return (
    <div class="compaction-file-section">
      <div class="compaction-file-title">{title}</div>
      <ul class="compaction-file-list">
        {files.map((file) => (
          <li title={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

export function Compaction({
  item,
  actions,
}: {
  item: CompactionItem;
  actions?: ItemActions;
}) {
  const files = item.readFiles.length + item.modifiedFiles.length;
  const before = formatCompactCount(item.tokensBefore);
  // What it cost and what it left behind. The "after" is Pi's own context
  // build re-run at this entry, so it is an estimate and says so.
  const tokens =
    item.tokensAfter === undefined
      ? `${before} tokens before`
      : `${before} → ~${formatCompactCount(item.tokensAfter)} tokens`;
  const time = formatTimestamp(item.timestamp);
  const parts = [
    item.readFiles.length > 0 ? `${String(item.readFiles.length)} read` : "",
    item.modifiedFiles.length > 0
      ? `${String(item.modifiedFiles.length)} modified`
      : "",
  ].filter(Boolean);
  return (
    <details
      class="compaction-marker transcript-details"
      id={`entry-${item.entryId}`}
    >
      <summary
        class="compaction-header"
        aria-label={`Conversation compacted: ${tokens}`}
        title="Expand compaction summary"
      >
        <span class="compaction-rule" aria-hidden="true" />
        <span class="compaction-header-core">
          <CompactIcon />
          <span
            class="compaction-token-count"
            title={
              item.tokensAfter === undefined
                ? undefined
                : "Context usage after compaction is estimated, including retained messages."
            }
          >
            {tokens}
          </span>
          {time === "" ? null : <span aria-hidden="true">·</span>}
          {time === "" ? null : <span class="compaction-time">{time}</span>}
        </span>
        <span class="compaction-rule" aria-hidden="true" />
      </summary>
      <div class="compaction-body">
        <div class="compaction-intro">
          The conversation history before this point was compacted into the
          following summary:
        </div>
        {item.summary === "" ? (
          <span class="compaction-empty">(no summary)</span>
        ) : (
          <Markdown
            source={item.summary}
            actions={actions}
            variant="markdown-compaction-message"
          />
        )}
        {files > 0 ? (
          <details class="compaction-file-details">
            <summary>File context: {parts.join(", ")}</summary>
            <FileList title="Modified files" files={item.modifiedFiles} />
            <FileList title="Read files" files={item.readFiles} />
          </details>
        ) : null}
      </div>
    </details>
  );
}

export function Note({
  item,
  actions,
}: {
  item: NoteItem;
  actions?: ItemActions;
}) {
  const time = formatTimestamp(item.timestamp);
  return (
    <div class="transcript-note" id={`entry-${item.entryId}`}>
      <details class="transcript-details note-card">
        <summary title="Expand" class="note-header">
          <span class="note-type">{item.customType || "extension"}</span>
          <span class="note-preview">
            {item.preview === "" ? "Show extension message" : item.preview}
          </span>
          {time === "" ? null : <span class="note-time">{time}</span>}
          <span class="card-chevron">
            <CardChevronIcon />
          </span>
        </summary>
        <div class="note-body">
          <Images
            entryId={item.entryId}
            indices={item.images}
            actions={actions}
            variant="note"
            separated={item.text !== ""}
          />
          {item.text === "" ? (
            <span class="note-empty">(no message)</span>
          ) : (
            <Markdown
              source={item.text}
              actions={actions}
              variant="markdown-custom-message"
            />
          )}
        </div>
        {item.details === undefined ? (
          <div class="note-footer">
            <CopyButton text={item.text} bare />
          </div>
        ) : (
          /* pi-web keeps the copy button and the details toggle on one row
             (MessageView.tsx L2245-L2289). The row is the disclosure here,
             so the copy button inside it must not open the panel. */
          <details class="transcript-details note-details">
            <summary class="note-footer">
              <CopyButton
                text={item.text === "" ? item.details : item.text}
                bare
              />
              <span class="note-details-label">
                <span class="note-details-closed">Show details</span>
                <span class="note-details-open">Hide details</span>
              </span>
            </summary>
            <pre class="note-details-text">{item.details}</pre>
          </details>
        )}
      </details>
    </div>
  );
}

/** A `!` run: pi-web renders it through the tool card, header and all. */
export function Bash({
  item,
  actions,
}: {
  item: BashItem;
  actions?: ItemActions;
}) {
  const failed =
    item.cancelled || (item.exitCode !== null && item.exitCode !== 0);
  const name = item.excluded ? "bash (local)" : "bash";
  const outputUrl =
    item.truncated && item.outputPath !== undefined && actions
      ? `/sessions/${actions.sessionId}/bash-output?path=${encodeURIComponent(item.outputPath)}`
      : undefined;
  return (
    <div class="transcript-bash" id={`entry-${item.entryId}`}>
      {/* Collapsed like every other tool call, as pi-web leaves it. */}
      <details
        class={`transcript-details tool-card${failed ? " is-error" : ""}`}
      >
        <summary class="tool-header">
          <span class="tool-name">{name}</span>
          <span class="tool-preview">{item.command}</span>
          <span class="card-chevron">
            <CardChevronIcon />
          </span>
        </summary>
        {item.pending && item.output === "" ? null : (
          <div class={`tool-output${failed ? " is-error" : ""}`}>
            <pre class="tool-output-text">{item.output}</pre>
          </div>
        )}
      </details>
      {outputUrl === undefined ? null : (
        <div class="tool-output-actions">
          <a
            target="_blank"
            rel="noreferrer"
            href={outputUrl}
            class="tool-output-link"
          >
            view full output
          </a>
          <a
            href={`${outputUrl}&download=1`}
            class="tool-output-link is-download"
          >
            download full output
          </a>
        </div>
      )}
    </div>
  );
}
