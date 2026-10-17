import { baseName } from "@core/file-types";
import type { AssistantBlock, AssistantItem } from "@core/transcript";
import { CardChevronIcon, FileIcon } from "@web/views/icons";
import {
  CopyButton,
  HistoryActionFrame,
  Images,
  type ItemActions,
  itemKey,
  Markdown,
  StarButton,
  Time,
} from "./shared.tsx";
import { ToolCard } from "./tools.tsx";

// The assistant message: model, blocks (text, thinking, images, tool cards),
// errors, files the turn wrote, and completed usage.

function ThinkingBlock({
  item,
  block,
  actions,
}: {
  item: AssistantItem;
  block: Extract<AssistantBlock, { kind: "thinking" }>;
  actions?: ItemActions;
}) {
  if (!block.deferred && block.text.trim() === "") {
    return item.entryId === "partial" && actions?.streaming ? (
      <div class="chat-activity">
        <span class="chat-activity-label">Thinking</span>
      </div>
    ) : null;
  }
  const fetchUrl =
    block.deferred && actions
      ? `/sessions/${actions.sessionId}/entries/${item.entryId}/thinking/${String(block.index)}`
      : undefined;
  return (
    <details
      id={`thinking-${itemKey(item)}-${String(block.index)}`}
      class="transcript-details thinking-card"
    >
      <summary class="thinking-heading">
        <span class="thinking-label">Thinking</span>
        {block.seconds === undefined ? null : (
          <span class="thinking-duration">{String(block.seconds)}s</span>
        )}
        <span class="card-chevron">
          <CardChevronIcon />
        </span>
      </summary>
      <div
        id={`thinking-body-${itemKey(item)}-${String(block.index)}`}
        class="thinking-body"
        hx-morph-skip={item.entryId !== "partial" ? "" : undefined}
        hx-get={fetchUrl}
        hx-trigger={
          fetchUrl
            ? "toggle[this.closest('details').open] once from:<closest details/>"
            : undefined
        }
        hx-swap={fetchUrl ? "innerHTML" : undefined}
      >
        {fetchUrl === undefined ? (
          <Markdown
            source={block.text}
            actions={actions}
            variant="markdown-assistant-message"
          />
        ) : (
          "Loading thinking..."
        )}
      </div>
    </details>
  );
}

function Blocks({
  item,
  actions,
}: {
  item: AssistantItem;
  actions?: ItemActions;
}) {
  return (
    <div class="assistant-blocks">
      {item.blocks.map((block) => {
        switch (block.kind) {
          case "text":
            return (
              <Markdown
                source={block.text}
                actions={actions}
                variant="markdown-assistant-message"
              />
            );
          case "thinking":
            return (
              <ThinkingBlock item={item} block={block} actions={actions} />
            );
          case "image":
            return (
              <Images
                entryId={item.entryId}
                indices={[block.index]}
                actions={actions}
                variant="assistant"
              />
            );
          default:
            return <ToolCard call={block.call} actions={actions} />;
        }
      })}
    </div>
  );
}

function usageLine(item: AssistantItem): string {
  const { usage } = item;
  if (!usage) return "";
  const number = (value: number) => value.toLocaleString("en");
  return [
    usage.input > 0 ? `${number(usage.input)} in` : "",
    usage.output > 0 ? `${number(usage.output)} out` : "",
    usage.cacheRead > 0 ? `${number(usage.cacheRead)} cache R` : "",
    usage.cacheWrite > 0 ? `${number(usage.cacheWrite)} cache W` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function answerText(item: AssistantItem): string {
  return item.blocks
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
}

export function AssistantMessage({
  item,
  actions,
  starrable,
  written,
}: {
  item: AssistantItem;
  actions?: ItemActions;
  starrable?: boolean;
  /** Files this turn wrote: pi-web lists them above the answer's footer. */
  written?: string[];
}) {
  if (
    item.blocks.length === 0 &&
    item.errorMessage === undefined &&
    item.stopReason !== "aborted"
  ) {
    return <></>;
  }
  const userFacing = item.blocks.some(
    (block) =>
      block.kind === "image" ||
      (block.kind === "text" && block.text.trim() !== ""),
  );
  const editable = actions && !actions.readOnly && !actions.live;
  const usage = usageLine(item);
  const streaming = item.entryId === "partial" ? actions?.streaming : undefined;
  const star =
    editable === true &&
    actions !== undefined &&
    starrable !== false &&
    (starrable === true || actions.starred.has(item.entryId));
  return (
    <HistoryActionFrame
      entryId={item.entryId}
      actions={userFacing ? actions : undefined}
      copyText={streaming ? undefined : answerText(item)}
    >
      <div
        class="message-row assistant-message"
        id={`entry-${itemKey(item)}${item.processHalf ? "-process" : ""}`}
        data-role="assistant"
      >
        <div class="assistant-message-header">
          {star && actions ? (
            <StarButton
              sessionId={actions.sessionId}
              entryId={item.entryId}
              starred={actions.starred.has(item.entryId)}
            />
          ) : null}
          <span title={item.model} class="assistant-model-name">
            {item.model}
          </span>
        </div>
        <Blocks item={item} actions={actions} />
        {item.errorMessage === undefined &&
        item.stopReason !== "error" ? null : (
          <div
            role="alert"
            class={`assistant-error${item.blocks.length > 0 ? " has-preceding-blocks" : ""}`}
          >
            Error: {item.errorMessage ?? "Unknown provider error"}
          </div>
        )}
        {item.stopReason !== "aborted" ? null : (
          <div class="assistant-stopped">Stopped</div>
        )}
        <WrittenFiles files={written ?? []} actions={actions} />
        <div class="assistant-message-footer">
          {usage === "" || streaming ? null : (
            <div class="assistant-usage">{usage}</div>
          )}
          {streaming || editable ? null : (
            <CopyButton
              text={answerText(item)}
              class="message-actions message-copy"
            />
          )}
          {streaming ||
          item.processHalf === true ||
          actions?.timestamps?.has(item.entryId) !== true ? null : (
            <Time value={item.timestamp} />
          )}
        </div>
      </div>
    </HistoryActionFrame>
  );
}

/** The files a turn wrote, under its answer. Clicking one opens the viewer. */
export function WrittenFiles({
  files,
  actions,
}: {
  files: string[];
  actions?: ItemActions;
}) {
  if (files.length === 0 || actions?.live) return <></>;
  return (
    <div aria-label="Files changed" class="written-files">
      {files.map((path) => {
        const name = baseName(path);
        return (
          <button
            type="button"
            class="written-file"
            data-file-path={path}
            title={path}
            aria-label={`Open ${name}`}
          >
            <FileIcon name={name} />
            <span>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
