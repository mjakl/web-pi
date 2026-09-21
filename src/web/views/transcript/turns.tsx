import type { LiveStatus } from "@core/ports";
import type { TranscriptItem } from "@core/transcript";
import {
  activityLabel,
  groupTurns,
  timestampedEntries,
  type Turn,
} from "@core/turns";
import { ProcessChevronIcon } from "@web/views/icons";
import { AssistantMessage, WrittenFiles } from "./assistant.tsx";
import { Bash, Compaction, Note } from "./notes.tsx";
import { type ItemActions, Markdown } from "./shared.tsx";
import { UserMessage } from "./user.tsx";

// One item of any kind, and the turns a settled transcript groups them
// into: the process disclosure, the answer, the sentinel that pages
// backwards, and the running turn with its activity line.

export function Item({
  item,
  actions,
  starrable,
  written,
}: {
  item: TranscriptItem;
  actions?: ItemActions;
  starrable?: boolean;
  written?: string[];
}) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} actions={actions} />;
    case "assistant":
      return (
        <AssistantMessage
          item={item}
          actions={actions}
          starrable={starrable ?? false}
          {...(written === undefined ? {} : { written })}
        />
      );
    case "compaction":
      return <Compaction item={item} actions={actions} />;
    case "branch_summary":
      return (
        <div id={`entry-${item.entryId}`} class="transcript-branch-summary">
          <div class="transcript-branch-intro">
            The conversation briefly explored another branch and returned with
            this summary:
          </div>
          <Markdown
            source={item.summary}
            actions={actions}
            variant="markdown-assistant-message"
          />
        </div>
      );
    case "note":
      return <Note item={item} actions={actions} />;
    default:
      return <Bash item={item} actions={actions} />;
  }
}

function TurnView({ turn, actions }: { turn: Turn; actions?: ItemActions }) {
  const first =
    turn.boundary ?? turn.process[0] ?? turn.answer ?? turn.trailing[0];
  const key =
    first?.entryId === "partial"
      ? `partial-${String(Date.parse(first.timestamp))}`
      : first?.entryId;
  const count = (value: number, noun: string) =>
    `${String(value)} ${noun}${value === 1 ? "" : "s"}`;
  const label = [
    "Process details",
    count(turn.processMessages, "message"),
    turn.processToolCalls > 0 ? count(turn.processToolCalls, "tool call") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section id={key === undefined ? undefined : `turn-${key}`} class="turn">
      {turn.boundary ? <Item item={turn.boundary} actions={actions} /> : null}
      {turn.process.length > 0 ? (
        <details
          id={key === undefined ? undefined : `process-${key}`}
          class="transcript-details process-details"
          open={turn.expanded}
        >
          <summary title="Expand process details" class="process-summary">
            <span class="process-chevron">
              <ProcessChevronIcon />
            </span>
            <span class="process-label">{label}</span>
          </summary>
          <div class="process-body">
            {turn.process.map((item) => (
              <Item item={item} actions={actions} />
            ))}
          </div>
        </details>
      ) : null}
      {turn.answer ? (
        <Item
          item={turn.answer}
          actions={actions}
          starrable
          written={turn.written}
        />
      ) : (
        <WrittenFiles files={turn.written} actions={actions} />
      )}
      {turn.trailing.map((item) => (
        <Item
          item={item}
          actions={actions}
          starrable={item.entryId === turn.loneAnswerId}
        />
      ))}
    </section>
  );
}

/**
 * The one transcript rendering: a page load, a prepended earlier page, a
 * settled turn appended to the log, and the running turn all come through
 * here. The running turn renders flat, because grouping a moving target
 * hides what just happened.
 */
export function Items({
  items,
  actions,
}: {
  items: TranscriptItem[];
  actions?: ItemActions;
}) {
  const withTimes: ItemActions | undefined = actions
    ? { ...actions, timestamps: timestampedEntries(items) }
    : undefined;
  if (actions?.live) {
    return (
      <>
        {items.map((item) => (
          <Item item={item} actions={actions} />
        ))}
      </>
    );
  }
  return (
    <>
      {groupTurns(items, actions?.cwd ?? "").map((turn) => (
        <TurnView turn={turn} actions={withTimes} />
      ))}
    </>
  );
}

/**
 * The sentinel above the oldest message on the page. Scrolling it into view
 * swaps it for the previous page, which carries the next sentinel.
 */
export function LoadEarlier({
  sessionId,
  before,
  leaf,
}: {
  sessionId: string;
  before: string;
  leaf?: string;
}) {
  const query = new URLSearchParams({ before });
  if (leaf !== undefined) query.set("leaf", leaf);
  return (
    <div
      class="chat-load-earlier load-earlier"
      hx-get={`/sessions/${sessionId}/earlier?${query.toString()}`}
      hx-trigger="intersect once"
      hx-target="this"
      hx-swap="outerHTML"
    >
      Scroll up to load earlier messages
    </div>
  );
}

/** A page of older messages, with the sentinel for the page before it. */
export function EarlierPage({
  items,
  actions,
  hasMore,
  oldestId,
  leaf,
}: {
  items: TranscriptItem[];
  actions: ItemActions;
  hasMore: boolean;
  oldestId?: string;
  leaf?: string;
}) {
  return (
    <>
      {hasMore && oldestId !== undefined ? (
        <LoadEarlier
          sessionId={actions.sessionId}
          before={oldestId}
          {...(leaf === undefined ? {} : { leaf })}
        />
      ) : null}
      <Items items={items} actions={actions} />
    </>
  );
}

/**
 * The running turn: its messages flat, plus the line that says what the
 * session is doing while nothing has streamed yet.
 */
export function TurnFragment({
  items,
  actions,
  status,
}: {
  items: TranscriptItem[];
  actions: ItemActions;
  status: LiveStatus | null;
}) {
  const label = status ? activityLabel(status) : null;
  // Only a turn that is actually working renders flat: grouping a moving
  // target hides what just happened. A finished turn groups like any other.
  const live = status?.running === true || status?.bashRunning === true;
  const progress = Object.fromEntries(
    (status?.tools ?? [])
      .filter((tool) => tool.progress !== undefined)
      .map((tool) => [tool.id, tool.progress ?? ""]),
  );
  return (
    <>
      <Items
        items={items}
        actions={{
          ...actions,
          ...(live ? { live } : {}),
          ...(Object.keys(progress).length > 0 ? { progress } : {}),
          ...(status?.streaming ? { streaming: status.streaming } : {}),
        }}
      />
      {label === null ? null : (
        <div class="chat-activity">
          <span class="chat-activity-label">{label}</span>
        </div>
      )}
    </>
  );
}
