import {
  type ProjectEntry,
  isSubagentSession,
  relativeTime,
  type SessionRowMetadata,
  sessionTitle,
  type SessionSummary,
} from "@core/sessions";
import { Partial } from "@web/views/Partial";
import type { SidebarView } from "@core/workspace";
import { shortPath } from "@core/workspaces";
import {
  ActiveDotIcon,
  BranchBadgeIcon,
  ChangedFilesIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  MoreDotsIcon,
  PlusIcon,
  ProjectFolderIcon,
  RefreshIcon,
  SearchIcon,
  SettingsSectionIcon,
  SmallChevronIcon,
  SmallPlusIcon,
  SpinnerIcon,
  StarIcon,
  StoppedRingIcon,
} from "./icons.tsx";

// The sidebar: pi-web's header block, workspace pill, session rows and
// explorer section (components/SessionSidebar.tsx §3.1, SessionItem.tsx §3.4,
// ProjectFolderGroup.tsx §3.3). Presentation lives in areas/sidebar.css.

export type Row = { summary: SessionSummary; metadata: SessionRowMetadata };

/** The last path segment, which is what pi-web labels a project with. */
function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
  );
}

/**
 * Running, live or stopped (§3.4). The unread halo is a browser concern —
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
      {...(danger === true
        ? { "hx-confirm": "Delete this session and its transcript?" }
        : {})}
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
      {metadata !== undefined && metadata.starCount > 0
        ? item("Clear all stars", "stars/clear")
        : null}
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
        value={metadata?.name ?? summary.name ?? ""}
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
      data-title={title.toLowerCase()}
      {...(oob === true ? { "hx-swap-oob": "true" } : {})}
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
        <div title={title} data-session-title class="session-row-title">
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
  const query = new URLSearchParams({ parent: summary.id });
  if (activeId !== undefined) query.set("selected", activeId);
  return (
    <div id={`node-${summary.id}`} class="session-node">
      <SessionRow {...row} {...(activeId === undefined ? {} : { activeId })} />
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
            {String(childCount)}{" "}
            {childCount === 1 ? "sub-session" : "sub-sessions"}
          </summary>
          <div class="session-subtree">
            {children === undefined ? (
              <div
                class="session-children-loading"
                hx-get={`/sidebar/rows?${query.toString()}`}
                hx-trigger="load[this.closest('details').open], web-pi:children"
                hx-sync="this:drop"
                hx-target="this"
                hx-swap="outerHTML"
              >
                Loading sub-sessions…
              </div>
            ) : (
              <SessionRows
                view={children}
                {...(activeId === undefined ? {} : { activeId })}
              />
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
  if (activeId !== undefined) query.set("selected", activeId);
  return (
    <>
      {view.rows.map((row) => (
        <SessionNode
          row={row}
          {...(activeId === undefined ? {} : { activeId })}
        />
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
  oob,
  partial,
}: {
  view: SidebarView;
  activeId?: string;
  oob?: boolean;
  partial?: boolean;
}) {
  const body = (
    <>
      {view.rows.length === 0 && view.nextOffset === undefined ? (
        <div class="session-list-empty">No sessions found</div>
      ) : null}
      <SessionRows
        view={view}
        {...(activeId === undefined ? {} : { activeId })}
      />
    </>
  );
  return partial === true ? (
    <Partial target="#session-list">{body}</Partial>
  ) : (
    <div
      id="session-list"
      class="session-list"
      {...(oob === true ? { "hx-swap-oob": "innerHTML" } : {})}
    >
      {body}
    </div>
  );
}

/** How many projects it takes before the selector needs a filter box. */
const FILTER_FROM = 8;

/**
 * The workspace pill and the menu it anchors: a native popover positioned by
 * CSS anchor positioning (§3.1, §1.9). The list is fetched when the popover
 * opens — a real store holds hundreds of projects.
 */
export function ProjectSelect({ cwd, home }: { cwd: string; home?: string }) {
  const folder = cwd;
  const chosen = folder !== "";
  return (
    <div id="project-picker" class="sidebar-project-picker">
      <button
        type="button"
        id="project-select"
        class={`sidebar-project-select anchor-sidebar-project${chosen ? " is-chosen" : ""}`}
        popovertarget="sidebar-project-menu"
        aria-label="Working directory for new session"
        data-cwd={folder}
        title={folder}
      >
        {chosen ? (
          <PathLabel text={shortPath(folder, home)} />
        ) : (
          <span class="sidebar-project-placeholder">Select project…</span>
        )}
        <ChevronDownIcon />
      </button>
      <div
        id="sidebar-project-menu"
        class="anchored-menu menu-surface opens-down menu-sidebar-project"
        popover="auto"
        hx-get="/sidebar/projects"
        hx-trigger="toggle once"
        hx-swap="innerHTML"
      >
        <div class="sidebar-project-message" role="status">
          Loading...
        </div>
      </div>
    </div>
  );
}

/**
 * pi-web's PathLabel: right-to-left text so a long path keeps its tail and
 * loses its head to the ellipsis.
 */
function PathLabel({ text }: { text: string }) {
  return (
    <span class="sidebar-project-path">
      <span>{text}</span>
    </span>
  );
}

/** The menu's contents: every project, with a filter box once there are many. */
export function ProjectPicker({
  projects,
  cwd,
  home,
}: {
  projects: ProjectEntry[];
  cwd?: string;
  home?: string;
}) {
  return (
    <>
      {projects.length > FILTER_FROM ? (
        <div class="sidebar-project-filter">
          {/* No autofocus: pi-web renders this field with the sidebar, long
              before the popover opens, so React's autoFocus never fires and
              the box opens unfocused, with no ring and no caret. */}
          <input
            id="project-filter"
            class="menu-filter"
            placeholder="Filter projects…"
            aria-label="Filter projects"
          />
        </div>
      ) : null}
      <div class="sidebar-project-list">
        {projects.map((project) => (
          <ProjectFolderGroup
            project={project}
            selected={project.folders.some((folder) => folder.path === cwd)}
            {...(cwd === undefined ? {} : { cwd })}
            {...(home === undefined ? {} : { home })}
          />
        ))}
        <div id="project-empty" class="sidebar-project-message" hidden>
          No matching projects
        </div>
      </div>
      <button
        type="button"
        class="menu-item"
        hx-get="/workspaces/picker"
        hx-target="#dialogs"
        hx-swap="innerHTML"
      >
        <SmallPlusIcon />
        <span>Custom path…</span>
      </button>
    </>
  );
}

/** Running counts when the directory menu is opened. */
function ProjectActivity({ running }: { running: number }) {
  return (
    <span class="project-activity" hidden={running === 0}>
      {running > 0 ? (
        <span
          class="project-running"
          title="Agent running…"
          aria-label={`Agent running… (${String(running)})`}
        >
          <SpinnerIcon size={10} />
          {String(running)}
        </span>
      ) : null}
    </span>
  );
}

/** One project row, and the working folders under it when there are several. */
function ProjectFolderGroup({
  project,
  selected,
  cwd,
  home,
}: {
  project: ProjectEntry;
  selected: boolean;
  cwd?: string;
  home?: string;
}) {
  const only = project.folders.length === 1 ? project.folders[0] : undefined;
  const foldersId = `folders-${encodeURIComponent(project.key)}`;
  const chosen = selected ? cwd : undefined;
  return (
    <div class="project-folder-group" data-project-key={project.key}>
      {only === undefined ? (
        <>
          <button
            type="button"
            class="menu-item project-folder-row"
            aria-expanded={selected ? "true" : "false"}
            aria-controls={foldersId}
          >
            <ChevronRightIcon />
            <FolderLabel
              name={baseName(project.key)}
              path={project.key}
              {...(home === undefined ? {} : { home })}
            />
            <ProjectActivity running={project.running} />
          </button>
          <div id={foldersId} hidden={!selected}>
            {project.folders.map((folder) => (
              <ProjectFolderRow
                path={folder.path}
                name={baseName(folder.path)}
                current={folder.path === chosen}
                child
                {...(home === undefined ? {} : { home })}
              />
            ))}
          </div>
        </>
      ) : (
        <ProjectFolderRow
          path={only.path}
          name={baseName(project.key)}
          current={only.path === chosen}
          activity={<ProjectActivity running={project.running} />}
          {...(home === undefined ? {} : { home })}
        />
      )}
    </div>
  );
}

function FolderLabel({
  name,
  path,
  home,
}: {
  name: string;
  path: string;
  home?: string;
}) {
  return (
    <span class="project-folder-label">
      <span>{name}</span>
      {/* pi-web's ProjectFolderGroup shortens only paths *under* home
          (`startsWith(homeDir + "/")`), so the home folder itself keeps its
          full spelling here where the workspace pill would write "~". */}
      <span class="project-folder-path">
        {path === home ? path : shortPath(path, home)}
      </span>
    </span>
  );
}

function ProjectFolderRow({
  path,
  name,
  current,
  child,
  activity,
  home,
}: {
  path: string;
  name: string;
  current: boolean;
  child?: boolean;
  activity?: unknown;
  home?: string;
}) {
  const query = new URLSearchParams({ cwd: path });
  return (
    <button
      type="button"
      class={
        child === true
          ? "menu-item project-folder-row project-folder-child"
          : "menu-item project-folder-row"
      }
      {...(current ? { "aria-current": "true" } : {})}
      title={path}
      hx-get={`/new?${query.toString()}`}
      hx-target="#session-region"
      hx-swap="outerHTML"
      hx-push-url="true"
    >
      <ProjectFolderIcon />
      <FolderLabel
        name={name}
        path={path}
        {...(home === undefined ? {} : { home })}
      />
      {activity}
      {current ? <span aria-hidden="true">✓</span> : null}
    </button>
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
      <SessionList
        view={view}
        {...(activeId === undefined ? {} : { activeId })}
      />
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

/** The explorer's tree is fetched separately into #file-explorer. */
export function ExplorerSection({
  sessionId,
  cwd,
}: {
  /** Absent before a session is open: the folder alone roots the tree. */
  sessionId?: string;
  cwd: string;
}) {
  const scope =
    sessionId === undefined
      ? `cwd=${encodeURIComponent(cwd)}`
      : `session=${encodeURIComponent(sessionId)}`;
  const explorerUrl = `/files/explorer?${scope}`;
  // The section's flex, the toggle's min-height and the chevron's rotation
  // are pi-web's per-state inline values; areas/sidebar.css writes them from
  // aria-expanded, which client/sidebar.ts flips and remembers.
  return (
    <div id="explorer-section" class="sidebar-explorer">
      <div class="sidebar-explorer-header">
        <button
          type="button"
          id="explorer-toggle"
          aria-expanded="true"
          aria-controls="explorer-body"
          class="sidebar-explorer-toggle"
        >
          <span data-explorer-chevron class="sidebar-explorer-chevron">
            <SmallChevronIcon />
          </span>
          Explorer
        </button>
        {/* Swaps the changes list in for the tree; the files area fills it in
            and hides this button while nothing is changed. */}
        <button
          type="button"
          class="sidebar-toolbar-button"
          id="explorer-changes-toggle"
          aria-pressed="false"
          title="Changed files"
          aria-label="Changed files"
          hidden
        >
          <ChangedFilesIcon />
        </button>
        <button
          type="button"
          class="sidebar-toolbar-button"
          id="explorer-search-toggle"
          aria-pressed="false"
          title="Search files"
          aria-label="Search files"
        >
          <SearchIcon />
        </button>
        <button
          type="button"
          class="sidebar-toolbar-button is-refresh"
          title="Refresh explorer"
          aria-label="Refresh explorer"
          hx-get={explorerUrl}
          hx-target="#file-explorer"
          hx-swap="innerHTML"
        >
          <RefreshIcon size={13} width={2} />
        </button>
      </div>
      <div id="explorer-body" class="sidebar-explorer-body">
        {/* pi-web keeps the field out of the tree until the magnifier in the
            header opens it (FileExplorer.tsx, `fileSearchOpen`). */}
        <div id="file-search-field" class="sidebar-file-search" hidden>
          <div class="sidebar-file-search-field">
            <span class="sidebar-file-search-icon">
              <SearchIcon size={12} />
            </span>
            <input
              id="file-search"
              type="search"
              name="q"
              placeholder="Search files…"
              aria-label="Search files"
              autocomplete="off"
              class="sidebar-file-search-input"
              hx-get={`/files/search?${scope}`}
              hx-trigger="input changed delay:150ms, search"
              hx-target="#file-tree"
              hx-swap="outerHTML"
            />
          </div>
        </div>
        <div
          id="file-explorer"
          class="explorer"
          data-cwd={cwd}
          hx-get={explorerUrl}
          hx-trigger="revealed, settled from:body"
          hx-swap="innerHTML"
        />
      </div>
    </div>
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
            {/* The list is pushed by the shared stream; this is for a session
                started in the terminal, which nothing here can hear about. */}
            <button
              type="button"
              id="sidebar-refresh"
              class="sidebar-refresh-button"
              title="Refresh"
              aria-label="Refresh"
              hx-get="/sidebar"
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
      <SessionNav
        view={view}
        {...(activeId === undefined ? {} : { activeId })}
      />
      {/* pi-web shows the explorer for whichever folder is selected, with or
          without a session open (AppShell.tsx L2429). */}
      {cwd === undefined || cwd === "" ? null : (
        <ExplorerSection
          {...(activeId === undefined ? {} : { sessionId: activeId })}
          cwd={cwd}
        />
      )}
    </div>
  );
}
