import { isSubagentSession } from "@core/sessions";
import type { RailMark } from "@core/conversation-rail";
import type { SessionView } from "@core/workspace";
import { StarIcon } from "./icons.tsx";

// pi-web's ChatMinimap (§5), rendered on the server. pi-web measures the
// rail's pixel height and places row `r` at `12 + r * gap` with
// `gap = min(50, (height - 30 - 24) / rows)`; the same value falls out of a
// calc() against the rail's own height, so nothing here needs a measurement.
// src/web/client/rail.ts only tracks the reading position and the popover.

/** pi-web's MINIMAP_WIDTH and BRANCH_LANE_GAP. */
const WIDTH = 36;
const LANE = 36;
/** MINIMAP_PADDING, MINIMAP_FOOTER (room for the jump-to-latest button). */
const PADDING = 12;
const FOOTER = 30;
/** MAX_NODE_GAP, and the cap on a mark's own height. */
const MAX_GAP = 50;
const MAX_MARK = 32;

/** `gap` as CSS: the rail's height is only known to the browser. */
function gap(rows: number): string {
  return `min(${String(MAX_GAP)}px, (100% - ${String(FOOTER + PADDING * 2)}px) / ${String(Math.max(1, rows))})`;
}

/** pi-web's `graphY(row)`, as a length against the rail's own height. */
function rowTop(row: number, rows: number): string {
  return `calc(${String(PADDING)}px + ${String(row)} * ${gap(rows)})`;
}

function markHeight(rows: number): string {
  return `min(${String(MAX_MARK)}px, ${gap(rows)})`;
}

function Node({
  mark,
  rows,
  sessionId,
  readOnly,
}: {
  mark: RailMark;
  rows: number;
  sessionId: string;
  readOnly: boolean;
}) {
  const top = rowTop(mark.row, rows);
  const left = `${String(WIDTH / 2 + mark.lane * LANE)}px`;
  // Off the branch being read: a button that moves the session to its tip.
  if (!mark.active) {
    if (readOnly) return null;
    const label =
      mark.kind === "star"
        ? "Switch branch to starred answer"
        : mark.preview === undefined
          ? "Switch branch"
          : `Switch branch: ${mark.preview}`;
    return (
      <button
        type="button"
        class={`minimap-branch${mark.kind === "star" ? " minimap-star" : ""}`}
        data-rail-entry-id={mark.id}
        data-entry-id={mark.id}
        data-branch="true"
        aria-label={label}
        /* pi-web previews the branch this mark leads to while the pointer
           rests on it, anywhere in the expanded rail. */
        data-preview={label}
        style={`left:${left}; top:${top}; height:max(1px, ${markHeight(rows)})`}
        hx-post={`/sessions/${sessionId}/navigate`}
        hx-vals={JSON.stringify({ entryId: mark.targetLeafId })}
        hx-target="body"
        hx-swap="innerHTML"
        hx-indicator="#branch-sync"
      >
        {mark.kind === "star" ? <StarIcon filled /> : <span />}
      </button>
    );
  }
  // On the branch and structural: pi-web draws the bare square, with no row
  // of its own, because the transcript has nothing to scroll to here.
  if (mark.kind === "junction") {
    return (
      <span
        class="minimap-junction"
        data-rail-entry-id={mark.id}
        style={`left:${left}; top:${top}`}
      />
    );
  }
  // On the branch, but not an anchor the transcript scrolls to.
  if (mark.kind === "compaction") {
    return (
      <div
        class="minimap-row"
        data-minimap-entry-id={mark.id}
        style={`top:${top}; height:max(1px, ${gap(rows)})`}
      >
        <div
          role="separator"
          aria-label="Conversation compacted"
          class="minimap-compaction"
        />
      </div>
    );
  }
  return (
    <div
      class="minimap-row"
      data-minimap-entry-id={mark.id}
      style={`top:${top}; height:max(1px, ${gap(rows)})`}
    >
      <button
        type="button"
        tabindex={-1}
        class={mark.kind === "star" ? "minimap-star" : "minimap-message"}
        data-entry-id={mark.id}
        {...(mark.preview === undefined
          ? {}
          : { "data-preview": mark.preview })}
        aria-label={
          mark.kind === "star"
            ? "Jump to starred answer"
            : "Jump to human message"
        }
        title={mark.kind === "star" ? "Jump to starred answer" : undefined}
      >
        {mark.kind === "star" ? (
          <StarIcon filled />
        ) : (
          <div class="minimap-dot" />
        )}
      </button>
    </div>
  );
}

/** pi-web's GRAPH_NODE_CLEARANCE: the space it keeps around every node. */
const CLEARANCE = 5;

/**
 * One of pi-web's bezier connectors. The clearance is in pixels and the gap is
 * only known to the browser, so each edge gets a box of its own and the curve
 * is normalised into it: one viewBox unit is the whole edge, and
 * `preserveAspectRatio="none"` stretches pi-web's control points on one axis,
 * which is the same curve. An edge shorter than the clearance collapses to no
 * height, which is pi-web dropping it — why a crowded rail shows no spine.
 */
function Edge({
  mark,
  parent,
  rows,
  width,
}: {
  mark: RailMark;
  parent: RailMark;
  rows: number;
  width: number;
}) {
  const x = WIDTH / 2 + mark.lane * LANE;
  const px = WIDTH / 2 + parent.lane * LANE;
  const span = mark.row - parent.row;
  return (
    <svg
      class="minimap-graph"
      aria-hidden="true"
      viewBox={`0 0 ${String(width)} 1`}
      preserveAspectRatio="none"
      style={
        `width:${String(width)}px;` +
        ` top:calc(${String(PADDING + CLEARANCE)}px + ${String(parent.row)} * ${gap(rows)});` +
        ` height:max(0px, calc(${String(span)} * ${gap(rows)} - ${String(CLEARANCE * 2)}px))`
      }
    >
      <path
        class={mark.active && parent.active ? "is-active" : ""}
        d={`M ${String(px)} 0 C ${String(px)} 1, ${String(x)} 0, ${String(x)} 1`}
        fill="none"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

function Graph({ marks, rows }: { marks: RailMark[]; rows: number }) {
  const byId = new Map(marks.map((mark) => [mark.id, mark]));
  const lanes = Math.max(...marks.map((mark) => mark.lane), 0);
  const width = lanes * LANE + WIDTH;
  return (
    <>
      {marks.map((mark) => {
        const parent =
          mark.parentId === null ? undefined : byId.get(mark.parentId);
        if (!parent) return null;
        return <Edge mark={mark} parent={parent} rows={rows} width={width} />;
      })}
    </>
  );
}

/**
 * Re-rendered from the server whenever the rail changes: the marks come from
 * the session's entries, so nothing about them depends on which page of the
 * transcript the browser currently holds.
 */
export function Rail({ view, oob }: { view: SessionView; oob?: boolean }) {
  const marks = view.rail;
  const rows = Math.max(...marks.map((mark) => mark.row), 0);
  const lanes = Math.max(...marks.map((mark) => mark.lane), 0);
  // pi-web's `hasSessionBranches`: a fork anywhere in the session widens the
  // rail on hover, whether or not the marks themselves sit in two lanes.
  const branched = view.branched;
  return (
    <div
      id="rail"
      class="minimap-layer"
      data-branched={branched ? "true" : "false"}
      data-graph-width={String(lanes * LANE + WIDTH)}
      {...(oob ? { "hx-swap-oob": "true" } : {})}
    >
      {/* pi-web chains the anchors into a parent/child path even with no
          fork in the session, so a linear rail carries the spine too. */}
      <Graph marks={marks} rows={rows} />
      {marks.map((mark) => (
        <Node
          mark={mark}
          rows={rows}
          sessionId={view.summary.id}
          readOnly={isSubagentSession(view.summary)}
        />
      ))}
    </div>
  );
}
