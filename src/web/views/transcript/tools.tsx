import {
  type DiffCell,
  type DiffFile,
  parseUnifiedPatch,
  patchLines,
} from "@core/patch";
import type { ToolCallView } from "@core/transcript";
import { isEditToolName, toolFilePath } from "@core/turns";
import { CardChevronIcon } from "@web/views/icons";
import { Images, type ItemActions } from "./shared.tsx";
import { Subagent, SubagentContent } from "./subagent.tsx";
import { DeferredToolBody, toolResultUrl } from "./deferred-tool.tsx";

// pi-web's tool card and its body: arguments, output, and the split diff
// of an edit, cut to a budget with a button that fetches the whole.

function DiffCellView({ cell }: { cell: DiffCell }) {
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  return (
    <div class={`tool-diff-cell is-${cell.type}`}>
      <span class="tool-diff-number">
        {cell.lineNo === null ? "" : String(cell.lineNo)}
      </span>
      <span class="tool-diff-marker">{marker}</span>
      <span class="tool-diff-text">
        {cell.type === "empty" && cell.text === "" ? " " : cell.text}
      </span>
    </div>
  );
}

/** pi-web's `SplitPatchView`: two gutters, one row per changed line. */
function SplitDiff({ files }: { files: DiffFile[] }) {
  return (
    <div class="tool-split-diff">
      {files.map((file) => (
        <div class="tool-diff-file">
          {files.length > 1 ? (
            <div class="tool-diff-header">
              <div title={file.oldPath ?? "Before"} class="tool-diff-path">
                {file.oldPath ?? "Before"}
              </div>
              <div title={file.newPath ?? "After"} class="tool-diff-path">
                {file.newPath ?? "After"}
              </div>
            </div>
          ) : null}
          <div class="tool-diff-lines">
            {file.rows.map((row) =>
              row.type === "hunk" ? null : (
                <div class="tool-diff-row">
                  <DiffCellView cell={row.left} />
                  <DiffCellView cell={row.right} />
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Fallback when the patch does not parse: the text, lightly classified. */
function PatchText({ patch }: { patch: string }) {
  return (
    <div class="tool-patch">
      {patchLines(patch).map((line) => (
        <div class={`tool-patch-line is-${line.type}`}>
          <span class="tool-patch-number">{String(line.lineNo)}</span>
          <span class="tool-patch-text">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Past this a tool result is cut, with a button that fetches the whole. */
const MAX_RESULT_CHARS = 16 * 1024;

const MAX_DIFF_ROWS = 200;

function ShowAll({ url }: { url: string }) {
  return (
    <div class="tool-output-actions">
      <button
        type="button"
        class="tool-output-link"
        hx-get={url}
        hx-target="closest .tool-result"
        hx-swap="outerHTML"
      >
        view full output
      </button>
    </div>
  );
}

/** Keeps whole files, up to the row budget: half a file reads as a bug. */
function trimDiff(
  files: DiffFile[],
  budget: number,
): { files: DiffFile[]; cut: number } {
  const kept: DiffFile[] = [];
  let rows = 0;
  let cut = 0;
  for (const file of files) {
    const lines = file.rows.filter((row) => row.type === "line").length;
    if (rows > 0 && rows + lines > budget) {
      cut += lines;
      continue;
    }
    if (rows + lines > budget) {
      const partial: typeof file.rows = [];
      let taken = 0;
      for (const row of file.rows) {
        if (row.type === "line" && taken >= budget) break;
        if (row.type === "line") taken += 1;
        partial.push(row);
      }
      kept.push({ ...file, rows: partial });
      cut += lines - taken;
      rows = budget;
      continue;
    }
    kept.push(file);
    rows += lines;
  }
  return { files: kept, cut };
}

/** The diff rows of a patch, capped; `cut` counts what did not fit. */
function trimmedDiff(
  patch: string,
  budget: number,
): { node: unknown; cut: number } {
  const files = parseUnifiedPatch(patch);
  if (files === null) return { node: <PatchText patch={patch} />, cut: 0 };
  const trimmed = trimDiff(files, budget);
  return { node: <SplitDiff files={trimmed.files} />, cut: trimmed.cut };
}

/**
 * The body fetched by a completed card, whether stored or in the live turn.
 * Ordinary output is budgeted with a button for the rest; subagents retain
 * their structured results, nested disclosures and raw payloads.
 */
export function ToolBody({
  call,
  actions,
  full,
}: {
  call: ToolCallView;
  actions?: ItemActions;
  full?: boolean;
}) {
  if (call.subagent)
    return (
      <SubagentContent view={call.subagent} call={call} actions={actions} />
    );
  const result = call.result;
  const budgeted = actions !== undefined && full !== true;
  const more =
    result && budgeted
      ? `/sessions/${actions.sessionId}/entries/${result.entryId}/tool-result/${encodeURIComponent(call.id)}?full=1`
      : undefined;
  const failed = result?.isError === true;
  const showInput =
    call.partialArguments !== undefined || !isEditToolName(call.name);
  const input = showInput
    ? (call.partialArguments ?? JSON.stringify(call.arguments, null, 2))
    : "";
  const inputCut = budgeted && input.length > MAX_RESULT_CHARS;
  const text = result?.text ?? "";
  const empty = text.trim() === "" || text.trim() === "(no output)";
  const textCut =
    result !== undefined &&
    result.patch === undefined &&
    budgeted &&
    text.length > MAX_RESULT_CHARS;
  const diff =
    result?.patch === undefined
      ? null
      : trimmedDiff(result.patch, budgeted ? MAX_DIFF_ROWS : Infinity);
  return (
    <div class="tool-result" hx-morph-skip={result ? true : undefined}>
      {/* A completed result is immutable. Keep fetched full output and its DOM
          resources when the enclosing live message morphs. */}
      {showInput ? (
        <pre class={`tool-input${failed ? " is-error" : ""}`}>
          {inputCut ? input.slice(0, MAX_RESULT_CHARS) : input}
        </pre>
      ) : null}
      {result === undefined ? null : diff !== null ? (
        <div class="tool-patch-output">{diff.node}</div>
      ) : (
        <div class={`tool-output${failed ? " is-error" : ""}`}>
          {result.images.length === 0 ? null : (
            <div class="tool-output-images">
              <Images
                entryId={result.entryId}
                indices={result.images}
                actions={actions}
                variant="tool"
              />
            </div>
          )}
          {empty && result.images.length > 0 ? null : (
            <pre class={`tool-output-text${empty ? " is-empty" : ""}`}>
              {empty
                ? "(no output)"
                : textCut
                  ? text.slice(0, MAX_RESULT_CHARS)
                  : text}
            </pre>
          )}
        </div>
      )}
      {more !== undefined && (inputCut || textCut || (diff?.cut ?? 0) > 0) ? (
        <ShowAll url={more} />
      ) : null}
    </div>
  );
}

export function ToolCard({
  call,
  actions,
}: {
  call: ToolCallView;
  actions?: ItemActions;
}) {
  if (call.subagent) {
    return <Subagent view={call.subagent} call={call} actions={actions} />;
  }
  const failed = call.result?.isError === true;
  const filePath = toolFilePath(call, actions?.cwd ?? "");
  const deferred = toolResultUrl(call, actions);
  return (
    <details
      id={`tool-${encodeURIComponent(call.id)}`}
      class={`transcript-details tool-card${failed ? " is-error" : ""}`}
      data-tool={call.name}
    >
      <summary class="tool-header">
        <span class="tool-name">{call.name}</span>
        {/* pi-web's preview is plain text: a click anywhere on the header
            opens the card, so a link inside it would fire both. The files a
            turn wrote are the chips under the answer instead. */}
        <span title={filePath} class="tool-preview">
          {call.partialArguments === undefined
            ? call.preview
            : "Generating parameters..."}
        </span>
        {call.result?.seconds === undefined ? null : (
          <span class="tool-duration">{String(call.result.seconds)}s</span>
        )}
        <span class="card-chevron">
          <CardChevronIcon />
        </span>
      </summary>
      {deferred === undefined ? (
        <ToolBody call={call} actions={actions} />
      ) : (
        <DeferredToolBody url={deferred} failed={failed} />
      )}
    </details>
  );
}
