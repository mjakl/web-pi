import {
  baseName,
  extensionOf,
  formatBytes,
  hasPreview,
} from "@core/file-types";
import { frontmatterCard, parseFrontmatter } from "@core/frontmatter";
import { type GitFileStatus, statusLabel } from "@core/git-status";
import { type UnifiedRow, unifiedRows } from "@core/patch";
import type { GitChangeFile, GitStatus } from "@core/ports";
import { directoryWithin } from "@core/path-access";
import type { FileView } from "@core/workspace";
import { escapeHtml, rawFileUrl, renderMarkdown } from "@web/markdown";
import { highlightLines } from "@web/syntax";
import {
  DirectoryLoadingIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  MentionIcon,
  SmallChevronIcon,
  WrapLinesIcon,
} from "@web/views/icons";
import { raw } from "hono/html";

// The explorer tree, the working tree's changes, and one viewer per open tab,
// with presentation owned by areas/files.css.
// Everything here is server-rendered; the browser only keeps which tabs are
// open and how each is scrolled.

/** Paths are joined POSIX-style; the policy compares them segment by segment. */
function childPath(directory: string, name: string): string {
  return `${directory.replace(/[\\/]+$/, "")}/${name}`;
}

function relativeTo(cwd: string, path: string): string {
  if (cwd !== "" && path.length > cwd.length && directoryWithin(cwd, path)) {
    return path.slice(cwd.length).replace(/^[\\/]/, "");
  }
  return path;
}

function GitStatusBadge({ status }: { status: GitFileStatus }) {
  const label = statusLabel(status);
  return (
    <span
      class={`file-tree-badge is-${status}`}
      title={label}
      aria-label={label}
    >
      {status}
    </span>
  );
}

export type TreeContext = {
  /** Absent until a session is open: the folder alone roots the requests. */
  sessionId?: string;
  cwd: string;
  /** Absolute paths Git reports as changed, with their letter. */
  changes: Map<string, GitChangeFile>;
};

/** How a files request names its folder: by session, else by path. */
export function scopeQuery(context: TreeContext): string {
  return context.sessionId === undefined
    ? `cwd=${encodeURIComponent(context.cwd)}`
    : `session=${encodeURIComponent(context.sessionId)}`;
}

function changedUnder(context: TreeContext, directory: string): boolean {
  for (const path of context.changes.keys()) {
    if (directoryWithin(directory, path)) return true;
  }
  return false;
}

/** Put the path into the composer, or download the file: hover only. */
function RowActions({
  sessionId,
  cwd,
  path,
  isDir,
}: {
  sessionId?: string;
  cwd: string;
  path: string;
  isDir: boolean;
}) {
  const relative = relativeTo(cwd, path);
  return (
    <>
      <button
        type="button"
        class={`file-tree-action is-mention${isDir ? " is-directory" : ""}`}
        title="Insert path into chat"
        aria-label="Insert path into chat"
        data-mention={relative}
        {...(isDir ? { "data-mention-dir": "1" } : {})}
      >
        <MentionIcon size={11} />
        mention
      </button>
      {isDir ? null : (
        <a
          class="file-tree-action is-download"
          title="Download file"
          aria-label="Download file"
          href={`${rawFileUrl(path, sessionId)}&download=1`}
          download
        >
          <DownloadIcon size={11} />
        </a>
      )}
    </>
  );
}

/**
 * One row of the tree, with the subtree it opens. A directory fetches its
 * children the first time it is expanded, which is what `hx-trigger="expand"`
 * on the node waits for; pi-web fetches them from the same click.
 */
function TreeNode({
  context,
  path,
  name,
  isDir,
  depth,
  nodes,
  open,
}: {
  context: TreeContext;
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  /** Already-known children (search results arrive expanded). */
  nodes?: SearchNode[];
  open?: boolean;
}) {
  const change = context.changes.get(path);
  const marked = isDir && (change !== undefined || changedUnder(context, path));
  const query = `path=${encodeURIComponent(path)}&${scopeQuery(context)}&depth=${String(depth + 1)}`;
  return (
    <div
      class="file-tree-node"
      role="treeitem"
      tabindex={-1}
      data-path={path}
      data-name={name}
      {...(isDir
        ? {
            "data-dir": "1",
            "aria-expanded": open === true ? "true" : "false",
            ...(nodes === undefined
              ? {
                  "hx-get": `/files/tree?${query}`,
                  "hx-trigger": "expand once",
                  "hx-target": "find [data-children]",
                  "hx-swap": "innerHTML",
                }
              : {}),
          }
        : {})}
    >
      <div
        class="file-tree-row"
        style={`padding-left:${String(8 + depth * 14)}px`}
      >
        {isDir ? (
          <span class="file-tree-chevron">
            <SmallChevronIcon size={10} />
          </span>
        ) : (
          <span class="file-tree-spacer" />
        )}
        <span class="file-tree-icon">
          {isDir ? (
            <FolderIcon open={open === true} />
          ) : (
            <FileIcon name={name} />
          )}
        </span>
        <span class="file-tree-name" title={path}>
          {name}
        </span>
        {!isDir && change ? <GitStatusBadge status={change.status} /> : null}
        {marked ? (
          <span
            class="file-tree-badge"
            title="Contains changed files"
            aria-label="Contains changed files"
          >
            <span class="file-tree-changed-dot" />
          </span>
        ) : null}
        {isDir && nodes === undefined ? (
          <span class="file-tree-loading">
            <DirectoryLoadingIcon size={10} />
          </span>
        ) : null}
        <RowActions
          {...(context.sessionId === undefined
            ? {}
            : { sessionId: context.sessionId })}
          cwd={context.cwd}
          path={path}
          isDir={isDir}
        />
      </div>
      {isDir ? (
        <div
          role="group"
          data-children
          {...(open === true ? {} : { hidden: true })}
        >
          {nodes === undefined ? null : (
            <SearchNodes context={context} nodes={nodes} depth={depth + 1} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One directory's children. Fetched again for each node that is opened. */
export function TreeNodes({
  context,
  directory,
  entries,
  depth,
}: {
  context: TreeContext;
  directory: string;
  entries: { name: string; isDir: boolean }[];
  depth: number;
}) {
  if (entries.length === 0) {
    return (
      <div
        class="file-tree-empty"
        style={`padding-left:${String(8 + depth * 14)}px`}
      >
        empty
      </div>
    );
  }
  return (
    <>
      {entries.map((entry) => (
        <TreeNode
          context={context}
          path={childPath(directory, entry.name)}
          name={entry.name}
          isDir={entry.isDir}
          depth={depth}
        />
      ))}
    </>
  );
}

/** The header line above the changed files: "N files  +N  -N". */
function ChangesHeader({ status }: { status: GitStatus }) {
  return (
    <div
      aria-label={`${String(status.files.length)} changed files, ${String(status.additions)} lines added, ${String(status.deletions)} lines deleted`}
      class="file-changes-header"
    >
      <span class="file-changes-count">
        {String(status.files.length)} files
      </span>
      <span class="file-changes-added">+{String(status.additions)}</span>
      <span class="file-changes-removed">-{String(status.deletions)}</span>
    </div>
  );
}

function ChangeRow({
  context,
  file,
}: {
  context: TreeContext;
  file: GitChangeFile;
}) {
  return (
    <div
      class="file-explorer-change-row"
      role="treeitem"
      tabindex={-1}
      title={file.path}
      data-file-path={file.path}
      data-file-mode="diff"
    >
      <GitStatusBadge status={file.status} />
      <span class="file-tree-icon is-change">
        <FileIcon name={baseName(file.path)} />
      </span>
      <span class="file-tree-name">{relativeTo(context.cwd, file.path)}</span>
    </div>
  );
}

/**
 * What the sidebar's explorer body holds. pi-web shows either the changes or
 * the tree, never both (`changesCollapsed` in FileExplorer.tsx), and the
 * search results take the same place while a query is open. All three keep the
 * id so the next swap lands in the same spot.
 */
/**
 * What pi-web shows in the explorer body when the folder cannot be read
 * (FileExplorer.tsx `error`): the reason, in the danger colour. A session
 * whose working folder is gone is the usual one.
 */
export function ExplorerError({ message }: { message: string }) {
  // The 2px/4px box is the tree's own; pi-web keeps it around every state of
  // the explorer body, so the text lands where the first row would.
  return (
    <div class="file-tree-body">
      <div class="file-tree-message is-error">{message}</div>
    </div>
  );
}

export function Explorer({
  context,
  status,
  entries,
  changes,
}: {
  context: TreeContext;
  status: GitStatus;
  entries: { name: string; isDir: boolean }[];
  changes: boolean;
}) {
  const count = status.isRepository ? status.files.length : 0;
  if (changes && count > 0) {
    return (
      <div
        id="file-tree"
        role="tree"
        aria-label="Changed files"
        data-changes={String(count)}
        class="file-tree-body is-changes"
      >
        <ChangesHeader status={status} />
        {status.files.map((file) => (
          <ChangeRow context={context} file={file} />
        ))}
      </div>
    );
  }
  return (
    <div
      id="file-tree"
      role="tree"
      aria-label="Files"
      data-changes={String(count)}
      class="file-tree-body"
    >
      {entries.length === 0 ? (
        <div class="file-tree-message">No files found</div>
      ) : (
        <TreeNodes
          context={context}
          directory={context.cwd}
          entries={entries}
          depth={0}
        />
      )}
    </div>
  );
}

type SearchNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: SearchNode[];
};

/** Matches, folded back into the folders they came from (pi-web's tree). */
function searchTree(cwd: string, matches: string[]): SearchNode[] {
  const roots: SearchNode[] = [];
  for (const relative of matches) {
    const parts = relative.split("/").filter((part) => part !== "");
    let siblings = roots;
    let prefix = "";
    parts.forEach((part, index) => {
      prefix = prefix === "" ? part : `${prefix}/${part}`;
      const isDir = index < parts.length - 1;
      let node = siblings.find(
        (candidate) => candidate.name === part && candidate.isDir === isDir,
      );
      if (!node) {
        node = {
          name: part,
          path: childPath(cwd, prefix),
          isDir,
          children: [],
        };
        siblings.push(node);
      }
      siblings = node.children;
    });
  }
  return roots;
}

function SearchNodes({
  context,
  nodes,
  depth,
}: {
  context: TreeContext;
  nodes: SearchNode[];
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) => (
        <TreeNode
          context={context}
          path={node.path}
          name={node.name}
          isDir={node.isDir}
          depth={depth}
          open={node.isDir}
          nodes={node.isDir ? node.children : undefined}
        />
      ))}
    </>
  );
}

/** Search hits, as a tree with every directory that holds one expanded. */
export function SearchResults({
  context,
  matches,
}: {
  context: TreeContext;
  matches: string[];
}) {
  return (
    <div
      id="file-tree"
      role="tree"
      aria-label="Search results"
      class="file-tree-search"
    >
      {matches.length === 0 ? (
        <div class="file-tree-search-empty">No matching files</div>
      ) : (
        <SearchNodes
          context={context}
          nodes={searchTree(context.cwd, matches)}
          depth={0}
        />
      )}
    </div>
  );
}

export type ViewMode = "source" | "preview" | "diff";

export function defaultMode(view: FileView, hint?: string): ViewMode {
  if (view.deleted) return "diff";
  if (hint === "diff" && view.diff !== undefined) return "diff";
  if (hint === "source") return "source";
  return hasPreview(view.path) && view.text !== undefined
    ? "preview"
    : "source";
}

function SourceView({ view }: { view: FileView }) {
  const text = view.text ?? "";
  // pi-web counts the newline that ends the file as starting another line,
  // both in the gutter and in the toolbar's "N lines".
  const lines = text.split("\n");
  // Above a thousand lines the colouring costs more than it is worth, so the
  // text is printed plain, exactly as pi-web does. A file whose grammar is
  // not registered is escaped the same way, but it is not the big-file path.
  const lightweight = lines.length > 1000;
  const coloured = lightweight ? null : highlightLines(text, view.language);
  const rows = lines
    .map((line, index) => {
      const body = coloured?.[index] ?? escapeHtml(line);
      const number = String(index + 1);
      return `<span class="file-source-line" data-line-number="${number}"><span aria-hidden="true" class="file-line-number">${number}</span><span class="file-source-line-content">${body}</span></span>`;
    })
    .join("");
  return (
    <div class={`file-source-view${lightweight ? " is-lightweight" : ""}`}>
      {raw(rows)}
    </div>
  );
}

function FrontmatterCard({ source }: { source: string }) {
  const card = frontmatterCard(parseFrontmatter(source).fields);
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

function DiffView({ rows }: { rows: UnifiedRow[] }) {
  // pi-web drops the @@ headers: the collapsed spans say what was skipped.
  const lines = rows.filter((row) => row.type !== "hunk");
  if (!lines.some((row) => row.type === "line" && row.kind !== "context")) {
    return <div class="file-diff-empty">No changes</div>;
  }
  return (
    <div class="file-diff-view">
      {lines.map((row) => {
        if (row.type === "collapsed") {
          return (
            <div class="file-diff-collapsed">
              ... {String(row.count)} unchanged lines ...
            </div>
          );
        }
        const sign =
          row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " ";
        return (
          <div class={`file-diff-line is-${row.kind}`}>
            <span class="file-line-number">
              {row.lineNo === null ? "" : String(row.lineNo)}
            </span>
            <span class="file-diff-sign">{sign}</span>
            <span class="file-diff-line-content">
              {row.text === "" ? " " : row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The toolbar every media viewer shares (FileViewer.tsx §7.4). */
function MediaToolbar({
  view,
  sessionId,
  label,
}: {
  view: FileView;
  sessionId: string;
  label: string;
}) {
  return (
    <div class="file-viewer-toolbar is-media">
      <span class="file-viewer-path" title={view.path}>
        {relativeTo(view.cwd, view.path)}
      </span>
      <span class="file-viewer-media-label">{label}</span>
      <span class="file-viewer-measured" />
      <span>{formatBytes(view.size)}</span>
      <span class="file-viewer-live" title="Not watching">
        <span class="file-viewer-live-indicator" />
        <span class="file-viewer-live-label">static</span>
      </span>
      <DownloadLink path={view.path} sessionId={sessionId} />
    </div>
  );
}

function DownloadLink({
  path,
  sessionId,
}: {
  path: string;
  sessionId: string;
}) {
  return (
    <a
      class="file-viewer-icon-button"
      href={`${rawFileUrl(path, sessionId)}&download=1`}
      download={baseName(path)}
      title="Download file"
      aria-label="Download file"
    >
      <DownloadIcon size={14} />
    </a>
  );
}

function MediaViewer({
  view,
  sessionId,
}: {
  view: FileView;
  sessionId: string;
}) {
  const source = rawFileUrl(view.path, sessionId);
  const extension = extensionOf(view.path);
  if (view.kind === "image") {
    return (
      <>
        <MediaToolbar
          view={view}
          sessionId={sessionId}
          label={extension === "" ? "image" : extension}
        />
        <div class="file-viewer-media-body">
          <img src={source} alt={view.path} class="file-viewer-image" />
        </div>
      </>
    );
  }
  if (view.kind === "audio") {
    return (
      <>
        <MediaToolbar
          view={view}
          sessionId={sessionId}
          label={extension === "" ? "audio" : extension}
        />
        <div class="file-viewer-audio-body">
          <div class="file-viewer-audio-player">
            {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls preload="metadata" src={source} />
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      <MediaToolbar view={view} sessionId={sessionId} label="pdf" />
      <div class="file-viewer-pdf-body">
        <iframe
          src={source}
          title={`Preview ${baseName(view.path)}`}
          class="file-viewer-frame"
        />
      </div>
    </>
  );
}

function ViewerContent({
  view,
  mode,
  sessionId,
}: {
  view: FileView;
  mode: ViewMode;
  sessionId: string;
}) {
  if (mode === "diff") {
    return <DiffView rows={unifiedRows(view.diff ?? "")} />;
  }
  const text = view.text ?? "";
  if (mode === "preview" && view.language === "html") {
    return (
      <iframe
        srcdoc={text}
        sandbox="allow-scripts"
        class="file-viewer-frame"
        title="HTML preview"
      />
    );
  }
  if (mode === "preview") {
    const parsed = parseFrontmatter(text);
    return (
      <div class="markdown-file-preview-shell">
        <FrontmatterCard source={text} />
        <div class="markdown-body markdown-file-preview">
          {raw(
            renderMarkdown(parsed.body, {
              cwd: view.cwd,
              sessionId,
              filePreview: true,
            }),
          )}
        </div>
      </div>
    );
  }
  return <SourceView view={view} />;
}

/** The whole viewer: toolbar plus content, swapped as one fragment per mode. */
export function Viewer({
  view,
  mode,
  sessionId,
}: {
  view: FileView;
  mode: ViewMode;
  sessionId: string;
}) {
  const relative = relativeTo(view.cwd, view.path);
  const deleted = view.deleted === true;
  const shell = (children: unknown) => (
    <div
      class="file-viewer-shell"
      data-path={view.path}
      data-relative={relative}
      data-mode={mode}
      data-kind={view.kind}
    >
      {children}
    </div>
  );
  if (view.kind !== "text") {
    return shell(<MediaViewer view={view} sessionId={sessionId} />);
  }
  const lines = view.text === undefined ? null : view.text.split("\n").length;
  const meta = deleted
    ? "Deleted"
    : `${view.language} · ${String(lines ?? 0)} lines · ${formatBytes(view.size)}`;
  // Without a session the panel works from the picked folder, and the mode
  // buttons have to keep naming it or the diff disappears on the first switch.
  const scope =
    sessionId === ""
      ? `cwd=${encodeURIComponent(view.cwd)}`
      : `session=${encodeURIComponent(sessionId)}`;
  const url = (next: ViewMode) =>
    `/files/view?path=${encodeURIComponent(view.path)}&${scope}&mode=${next}`;
  const modes: ViewMode[] = deleted
    ? ["diff"]
    : [
        "source",
        ...(hasPreview(view.path) && view.text !== undefined
          ? (["preview"] as ViewMode[])
          : []),
        ...(view.diff === undefined ? [] : (["diff"] as ViewMode[])),
      ];
  const label: Record<ViewMode, string> = {
    source: "Source",
    preview: "Preview",
    diff: "Diff",
  };
  return shell(
    <>
      <div class="file-viewer-toolbar">
        <span class="file-viewer-path" title={view.path}>
          {relative}
        </span>
        <span class="file-viewer-meta" title={meta}>
          {meta}
        </span>
        {deleted ? null : (
          <span
            class="file-viewer-live-indicator"
            title="Not watching"
            aria-label="Not watching"
          />
        )}
        <div class="file-viewer-controls">
          {modes.length < 2 ? null : (
            <div
              class="file-viewer-mode-switch"
              role="group"
              aria-label="File view mode"
            >
              {modes.map((option) => (
                <button
                  type="button"
                  class="file-viewer-mode-button"
                  aria-pressed={option === mode ? "true" : "false"}
                  {...(option === "diff"
                    ? { title: "Compare working tree with HEAD" }
                    : {})}
                  hx-get={url(option)}
                  hx-target="#file-view"
                  hx-swap="innerHTML"
                >
                  {label[option]}
                </button>
              ))}
            </div>
          )}
          <div class="file-viewer-actions">
            <button
              type="button"
              class="file-viewer-icon-button"
              data-mention-file
              title="Insert path into chat"
              aria-label="mention"
            >
              <MentionIcon size={14} />
            </button>
            {mode === "source" ? (
              <button
                type="button"
                class="file-viewer-icon-button"
                data-wrap-toggle
                aria-pressed="false"
                title="Enable word wrap"
                aria-label="Enable word wrap"
              >
                <WrapLinesIcon size={14} />
              </button>
            ) : null}
          </div>
          {deleted ? null : (
            <DownloadLink path={view.path} sessionId={sessionId} />
          )}
        </div>
      </div>
      <div class="file-viewer-content">
        <ViewerContent view={view} mode={mode} sessionId={sessionId} />
      </div>
    </>,
  );
}

/**
 * What the right panel holds below its tab bar. The panel container, its tab
 * bar and the hide button are pi-web's shell (src/web/views/SessionPage.tsx),
 * and the file tree now lives in the sidebar's explorer section, so this is
 * the viewer alone.
 */
export function FilePanelBody() {
  return (
    <div id="file-view" class="file-view">
      <div class="file-viewer-empty">No file open</div>
    </div>
  );
}
