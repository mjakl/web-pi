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
import { type ItemActions, itemKey, Markdown } from "./shared.tsx";
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
  const key = first === undefined ? undefined : itemKey(first);
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

/**
 * The leading items of a running turn that will not change again, which a
 * session stream sends only once: everything before the first item still in
 * flight (the partial message, a running shell command, or a message waiting
 * for tool results). A message that failed or was stopped waits for nothing:
 * Pi runs none of its tool calls. None while the turn is not running: it
 * renders grouped.
 */
export function finishedItems(
  items: TranscriptItem[],
  status: LiveStatus | null,
): TranscriptItem[] | undefined {
  if (status?.running !== true && status?.bashRunning !== true) return;
  const inFlight = items.findIndex(
    (item) =>
      item.entryId === "partial" ||
      (item.kind === "bash" && item.pending) ||
      (item.kind === "assistant" &&
        item.stopReason !== "error" &&
        item.stopReason !== "aborted" &&
        item.blocks.some(
          (block) => block.kind === "tool" && block.call.result === undefined,
        )),
  );
  return inFlight === -1 ? items : items.slice(0, inFlight);
}

/**
 * The running turn: its messages flat, plus the line that says what the
 * session is doing while nothing has streamed yet. While it runs, the
 * finished messages come first and everything that can still change sits in
 * `#turn-live`, after `children`, so a stream can send the finished ones once
 * and morph only that element. `from` leaves out the finished messages a
 * stream already sent.
 */
export function TurnFragment({
  items,
  actions,
  status,
  from = 0,
  children,
}: {
  items: TranscriptItem[];
  actions: ItemActions;
  status: LiveStatus | null;
  from?: number;
  children?: unknown;
}) {
  const onlyTool = status?.tools.length === 1 ? status.tools[0] : undefined;
  // A pending subagent's header already shows its activity, even collapsed.
  // Keep the footer when other work is running or no matching card is visible.
  const cardCoversActivity =
    status?.running === true &&
    !status.bashRunning &&
    actions.inspectionOnly !== true &&
    onlyTool?.name === "subagent" &&
    items.some(
      (item) =>
        item.kind === "assistant" &&
        item.blocks.some(
          (block) =>
            block.kind === "tool" &&
            block.call.id === onlyTool.id &&
            block.call.subagent !== undefined &&
            block.call.result === undefined,
        ),
    );
  const label = status && !cardCoversActivity ? activityLabel(status) : null;
  // Only a turn that is actually working renders flat: grouping a moving
  // target hides what just happened. A turn that stopped groups like any
  // other.
  const finished = finishedItems(items, status);
  const progress = Object.fromEntries(
    (status?.tools ?? [])
      .filter((tool) => tool.progress !== undefined)
      .map((tool) => [tool.id, tool.progress ?? ""]),
  );
  const turnActions: ItemActions = {
    ...actions,
    ...(finished ? { live: true } : {}),
    ...(Object.keys(progress).length > 0 ? { progress } : {}),
    ...(status?.running === true ? { streaming: true } : {}),
  };
  const activity =
    label === null ? null : (
      <div class="chat-activity">
        <span class="chat-activity-label">{label}</span>
      </div>
    );
  if (!finished)
    return (
      <>
        {children}
        <Items items={items} actions={turnActions} />
        {activity}
      </>
    );
  // The finished messages get an element of their own: htmx's morph processes
  // the ones it moves out of #turn-live only inside a new element, and a tool
  // card that just completed needs that to fetch its body.
  return (
    <>
      {from < finished.length ? (
        <div>
          <Items items={finished.slice(from)} actions={turnActions} />
        </div>
      ) : null}
      <div id="turn-live">
        {children}
        <Items items={items.slice(finished.length)} actions={turnActions} />
        {activity}
      </div>
    </>
  );
}
