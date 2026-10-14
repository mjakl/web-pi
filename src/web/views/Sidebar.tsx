import { baseName } from "@core/file-types";
import {
  isSubagentSession,
  relativeTime,
  type SessionRowMetadata,
  sessionTitle,
  type SessionSummary,
} from "@core/sessions";
import { Partial } from "@web/views/Partial";
import type { SidebarView } from "@core/workspace";
import { ExplorerSection } from "./Files.tsx";
import {
  ActiveDotIcon,
  BranchBadgeIcon,
  CheckIcon,
  MoreDotsIcon,
  PlusIcon,
  RefreshIcon,
  SettingsSectionIcon,
  SpinnerIcon,
  StarIcon,
  StoppedRingIcon,
} from "./icons.tsx";

// The sidebar: pi-web's header block, session rows and the explorer below
// them (components/SessionSidebar.tsx, SessionItem.tsx). The explorer's own
// markup is the files area's (Files.tsx). Presentation lives in
// areas/sidebar.css.

export type Row = { summary: SessionSummary; metadata: SessionRowMetadata };

/**
 * Running, live or stopped. The unread halo is a browser concern —
 * which turns finished while the reader was elsewhere is in localStorage —
 * so `client/sidebar.ts` adds `.session-indicator-unread` and the `--info`
 * tint on top of what is rendered here.
 */
function SessionIndicator({ summary }: { summary: SessionSummary }) {
  const [label, state, icon] = summary.running
    ? (["Agent running…", "running", <SpinnerIcon />] as const)
    : summary.live
      ? (["Session active", "active", <ActiveDotIcon />] as const)
      : (["Session stopped", "stopped", <StoppedRingIcon />] as const);
  return (
    <span
      class={`session-indicator is-${state}`}
      data-status={label}
      title={label}
      aria-label={label}
    >
      {icon}
    </span>
  );
}

function RowMenu({ summary, metadata }: Row) {
  const id = summary.id;
  const target = `#row-${id}`;
  const item = (label: string, path: string, danger?: boolean) => (
    <button
      type="button"
      class={danger === true ? "menu-item menu-item-danger" : "menu-item"}
      hx-post={`/sessions/${id}/${path}`}
      hx-target={target}
      hx-swap="outerHTML"
      hx-confirm={
        danger === true ? "Delete this session and its transcript?" : undefined
      }
    >
      {label}
    </button>
  );
  return (
    <div
      id={`row-menu-${id}`}
      class="session-row-menu menu-surface"
      popover="auto"
      role="group"
      aria-label={`Session actions for ${sessionTitle(summary, metadata)}`}
    >
      {summary.live === true
        ? item("Stop", "stop")
        : item("Activate", "activate")}
      <button
        type="button"
        class="menu-item"
        hx-get={`/sessions/${id}/rename`}
        hx-target={target}
        hx-swap="outerHTML"
      >
        Rename
      </button>
      {metadata.starCount > 0 ? item("Clear all stars", "stars/clear") : null}
      {item("Delete", "delete", true)}
    </div>
  );
}

/** The row while it is being renamed: pi-web swaps the whole row for an input. */
export function RenameRow({ summary, metadata }: Row) {
  const id = summary.id;
  const title = sessionTitle(summary, metadata);
  return (
    <form
      id={`row-${id}`}
      class="session-row is-renaming"
      data-session-id={id}
      hx-post={`/sessions/${id}/rename`}
      hx-target="this"
      hx-swap="outerHTML"
    >
      <input
        name="name"
        value={metadata.name ?? summary.name ?? ""}
        aria-label={`Rename session ${title}`}
        autofocus
        autocomplete="off"
        hx-get={`/sessions/${id}/row`}
        hx-trigger="keyup[key=='Escape']"
        hx-target={`#row-${id}`}
        hx-swap="outerHTML"
        class="session-rename-input"
      />
    </form>
  );
}

/** One complete sidebar row, shared by pages and live updates. */
export function SessionRow({
  summary,
  metadata,
  activeId,
  oob,
}: Row & { activeId?: string; oob?: boolean }) {
  const id = summary.id;
  const title = sessionTitle(summary, metadata);
  const selected = id === activeId;
  const menuId = `row-menu-${id}`;
  const inspectionOnly = isSubagentSession(summary);
  return (
    <div
      id={`row-${id}`}
      class={`session-row${selected ? " is-selected" : ""}${summary.live === true ? " is-live" : ""}${inspectionOnly ? " is-inspection" : ""}`}
      data-session-id={id}
      hx-swap-oob={oob === true ? "true" : undefined}
    >
      <a href={`/sessions/${id}`} class="session-row-link">
        {inspectionOnly ? null : <SessionIndicator summary={summary} />}
        <div
          class={`session-row-location${summary.cwdAvailable === false ? " is-unavailable" : ""}`}
        >
          <span
            class="session-row-folder"
            title={
              summary.cwdAvailable === false
                ? `${summary.cwd} (Working directory unavailable)`
                : summary.cwd
            }
          >
            {baseName(summary.cwd) || summary.cwd}
          </span>
          {summary.branch === undefined ? null : (
            <span
              title={`${summary.isWorktree === true ? "Worktree" : "Branch"}: ${summary.branch}`}
              class="session-row-branch"
            >
              <BranchBadgeIcon />
              <span class="session-branch-name">{summary.branch}</span>
            </span>
          )}
        </div>
        <div title={title} class="session-row-title">
          <span class="session-title-text">{title}</span>
        </div>
        <div class="session-row-meta">
          <span
            title={summary.modifiedAt}
            data-session-modified-at={summary.modifiedAt}
            class="session-row-time"
          >
            {relativeTime(summary.modifiedAt)}
          </span>
          <span class="session-counts">
            {metadata.starCount > 0 ? (
              <span
                class="session-star-count"
                title={`${String(metadata.starCount)} starred answers`}
                aria-label={`${String(metadata.starCount)} starred answers`}
              >
                <span>{metadata.starCount.toLocaleString("en")}</span>
                <StarIcon size={11} filled />
              </span>
            ) : null}
            <span
              class="session-message-count"
              title={`${String(metadata.messageCount)} msgs`}
            >
              {String(metadata.messageCount)} msgs
            </span>
          </span>
        </div>
      </a>
      <div class="session-row-actions">
        {/* ⌘1…⌘0 take the menu trigger's place on the first ten rows while a
            modifier is held. Which row is which is a browser-side count — a
            row re-rendered on its own does not know its position — so
            client/sidebar.ts fills this in and decides what shows. */}
        <kbd class="session-shortcut" aria-hidden="true" hidden />
        {inspectionOnly ? null : (
          <button
            type="button"
            class="session-menu-trigger"
            popovertarget={menuId}
            aria-label={`Session actions for ${title}`}
            aria-controls={menuId}
          >
            <MoreDotsIcon size={16} radius={1.8} />
          </button>
        )}
      </div>
      {inspectionOnly ? null : (
        <RowMenu summary={summary} metadata={metadata} />
      )}
    </div>
  );
}

/** Row actions replace only the body, leaving its disclosure and children intact. */
function SessionNode({
  row,
  activeId,
}: {
  row: SidebarView["rows"][number];
  activeId?: string;
}) {
  const { summary, childCount = 0, children } = row;
  return (
    <div id={`node-${summary.id}`} class="session-node">
      <SessionRow {...row} activeId={activeId} />
      {childCount > 0 ? (
        <details
          class="session-children"
          data-parent-session-id={summary.id}
          open={children !== undefined}
        >
          <summary class="session-children-toggle">
            <span class="session-children-closed" aria-hidden="true">
              ▸
            </span>
            <span class="session-children-open" aria-hidden="true">
              ▾
            </span>
            {`${String(childCount)} ${childCount === 1 ? "sub-session" : "sub-sessions"}`}
          </summary>
          <div class="session-subtree">
            {children === undefined ? (
              <div
                class="session-children-loading"
                hx-get={`/sidebar/rows?parent=${summary.id}`}
                hx-trigger="load[this.closest('details').open], web-pi:children"
                hx-sync="this:drop"
                hx-target="this"
                hx-swap="outerHTML"
              >
                Loading sub-sessions…
              </div>
            ) : (
              <SessionRows view={children} activeId={activeId} />
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** One page of siblings, plus the sentinel that fetches the page after it. */
export function SessionRows({
  view,
  activeId,
}: {
  view: SidebarView;
  activeId?: string;
}) {
  const query = new URLSearchParams({ after: String(view.nextOffset) });
  if (view.parentId !== undefined) query.set("parent", view.parentId);
  return (
    <>
      {view.parentId !== undefined &&
      view.rows.length === 0 &&
      view.nextOffset === undefined ? (
        <div class="session-children-loading">No more sub-sessions</div>
      ) : null}
      {view.rows.map((row) => (
        <SessionNode row={row} activeId={activeId} />
      ))}
      {view.nextOffset !== undefined ? (
        <div
          class="session-rows-loading"
          hx-get={`/sidebar/rows?${query.toString()}`}
          hx-trigger="intersect once"
          hx-target="this"
          hx-swap="outerHTML"
        >
          Loading more sessions…
        </div>
      ) : null}
    </>
  );
}

export function SessionList({
  view,
  activeId,
  partial,
}: {
  view: SidebarView;
  activeId?: string;
  partial?: boolean;
}) {
  const body = (
    <>
      {view.rows.length === 0 && view.nextOffset === undefined ? (
        <div class="session-list-empty">No sessions found</div>
      ) : null}
      <SessionRows view={view} activeId={activeId} />
    </>
  );
  return partial === true ? (
    <Partial target="#session-list">{body}</Partial>
  ) : (
    <div id="session-list" class="session-list" hx-sync="#sidebar:drop">
      {body}
    </div>
  );
}

/** The global list and its stream survive conversation and folder changes. */
export function SessionNav({
  view,
  activeId,
}: {
  view: SidebarView;
  activeId?: string | undefined;
}) {
  return (
    <div id="session-nav" class="sidebar-session-nav">
      <SidebarEvents />
      <SessionList view={view} activeId={activeId} />
    </div>
  );
}

export function SidebarEvents() {
  return (
    <div
      id="sidebar-events"
      hx-sse:connect="/events"
      hx-trigger="web-pi:sse-start"
      hx-swap="none"
    />
  );
}

export function Sidebar({
  view,
  activeId,
  cwd,
}: {
  view: SidebarView;
  activeId?: string;
  cwd?: string;
}) {
  return (
    <div id="sidebar" class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-header-row">
          <span class="sidebar-brand">web-pi</span>
          <div class="sidebar-header-actions">
            <a
              class="sidebar-icon-button"
              href="/new"
              data-session-link
              title="New session"
              aria-label="New session"
              aria-keyshortcuts="Meta+K Control+K"
            >
              <kbd
                class="new-session-shortcut"
                hidden
                data-shortcut="K"
                aria-hidden="true"
              >
                ⌘K
              </kbd>
              <span class="new-session-plus">
                <PlusIcon />
              </span>
            </a>
            {/* Manual refresh stays available alongside automatic discovery. */}
            <button
              type="button"
              id="sidebar-refresh"
              class="sidebar-refresh-button"
              title="Refresh"
              aria-label="Refresh"
              hx-get="/sidebar"
              hx-sync="#sidebar:queue first"
              hx-target="#session-nav"
              hx-swap="outerHTML"
            >
              <span class="sidebar-refresh-done">
                <CheckIcon size={15} width={2.5} />
              </span>
              <span class="sidebar-refresh-idle">
                <RefreshIcon size={15} width={2} />
              </span>
            </button>
            <a
              class="sidebar-icon-button"
              href="/settings"
              title="Settings"
              aria-label="Settings"
            >
              <SettingsSectionIcon section="general" size={15} width={2} />
            </a>
          </div>
        </div>
      </div>
      <SessionNav view={view} activeId={activeId} />
      {/* pi-web shows the explorer for whichever folder is selected, with or
          without a session open (AppShell.tsx L2429). */}
      {cwd === undefined || cwd === "" ? null : (
        <ExplorerSection sessionId={activeId} cwd={cwd} />
      )}
    </div>
  );
}
