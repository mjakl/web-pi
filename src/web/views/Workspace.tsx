import type { ProjectEntry } from "@core/sessions";
import { shortPath } from "@core/workspaces";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ParentFolderIcon,
  PickerFolderIcon,
  ProjectFolderIcon,
  SmallPlusIcon,
  SpinnerIcon,
} from "./icons.tsx";
import { ConfigButton } from "./ConfigControls.tsx";

// Choosing the working folder of a new session, on the blank composer: the
// folder picker, a menu of the store's projects and their folders
// (components/ProjectFolderGroup.tsx), and the "Custom path…" dialog it
// opens, pi-web's DirectoryPicker (components/DirectoryPicker.tsx). The dialog
// lists directory names, walks into them, and commits the folder it is
// standing in. Validating that folder is what grants access to it.

const PANEL = "#directory-picker-panel";

/** The panel: header, path form, listing and footer. Navigation swaps it whole. */
export function BrowsePane({
  path,
  parentPath,
  directories,
  error,
}: {
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
  error?: string;
}) {
  const go = (target: string) =>
    `/workspaces/browse?path=${encodeURIComponent(target)}`;
  return (
    <div id="directory-picker-panel" class="directory-picker-panel">
      <div class="directory-picker-header">
        <div class="directory-picker-heading">
          <div class="directory-picker-title">Select directory</div>
        </div>
        {/* A dialog form keeps Close working without script. */}
        <form method="dialog" class="directory-picker-close-form">
          <button
            type="submit"
            title="Close"
            aria-label="Close"
            class="directory-picker-close"
          >
            ×
          </button>
        </form>
      </div>

      <form
        hx-get="/workspaces/browse"
        hx-include="#directory-path"
        hx-target={PANEL}
        hx-swap="outerHTML"
        class="directory-picker-navigation"
      >
        <button
          class="directory-picker-back"
          type="button"
          title="Go to parent directory"
          aria-label="Go to parent directory"
          disabled={parentPath === null}
          {...(parentPath === null
            ? {}
            : {
                "hx-get": go(parentPath),
                "hx-target": PANEL,
                "hx-swap": "outerHTML",
              })}
        >
          <ParentFolderIcon />
        </button>
        <label for="directory-path" class="sr-only">
          Directory path
        </label>
        <input
          class="directory-picker-path"
          id="directory-path"
          name="path"
          type="text"
          value={path}
          placeholder="/path/to/project or ~/project"
          autofocus
          autocomplete="off"
          spellcheck={false}
        />
        <button
          class="directory-picker-action directory-picker-go"
          type="submit"
          title="Go to directory"
        >
          Go
        </button>
      </form>

      <div class="directory-picker-list">
        {directories.length === 0 ? (
          <div class="directory-picker-empty">No subdirectories</div>
        ) : null}
        {directories.map((entry) => (
          <button
            class="directory-picker-entry"
            type="button"
            title={entry.path}
            hx-get={go(entry.path)}
            hx-target={PANEL}
            hx-swap="outerHTML"
          >
            <PickerFolderIcon />
            <span class="directory-picker-entry-name">{entry.name}</span>
          </button>
        ))}
        {error === undefined ? null : (
          <div role="alert" class="directory-picker-error">
            {error}
          </div>
        )}
      </div>

      <div class="directory-picker-footer">
        <form method="dialog">
          <ConfigButton class="directory-picker-action" type="submit">
            Cancel
          </ConfigButton>
        </form>
        <ConfigButton
          class="directory-picker-action"
          variant="primary"
          type="button"
          title="Select current directory"
          hx-post="/workspaces/validate"
          hx-vals={JSON.stringify({ cwd: path })}
          hx-swap="none"
        >
          Select this folder
        </ConfigButton>
      </div>
    </div>
  );
}

/** The dialog the panel lives in. `client/dialogs.ts` makes it a real modal. */
export function DirectoryPicker(props: {
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
  error?: string;
}) {
  return (
    <dialog
      id="directory-picker"
      class="directory-picker-dialog"
      aria-label="Select directory"
      data-modal
      open
    >
      <BrowsePane {...props} />
    </dialog>
  );
}

/** The last path segment, which is what pi-web labels a project with. */
export function baseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path
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
        <div class="menu-filter-row">
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
  const chosen = selected ? cwd : undefined;
  return (
    <div class="project-folder-group" data-project-key={project.key}>
      {only === undefined ? (
        <details open={selected}>
          <summary class="menu-item project-folder-row">
            <ChevronRightIcon />
            <FolderLabel
              name={baseName(project.key)}
              path={project.key}
              {...(home === undefined ? {} : { home })}
            />
            <ProjectActivity running={project.running} />
          </summary>
          {project.folders.map((folder) => (
            <ProjectFolderRow
              path={folder.path}
              name={baseName(folder.path)}
              current={folder.path === chosen}
              child
              {...(home === undefined ? {} : { home })}
            />
          ))}
        </details>
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
