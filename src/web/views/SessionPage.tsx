import {
  formatCompactCount,
  formatContextTooltip,
  formatContextUsage,
} from "@core/context-usage";
import type { ContextUsage } from "@core/context-usage";
import type { ImageAttachment } from "@core/ports";
import { isSubagentSession } from "@core/sessions";
import type { SessionStats } from "@core/session-entries";
import type { NewSessionView, SessionView, SidebarView } from "@core/workspace";
import { Composer, DropZone } from "./Composer.tsx";
import { FilePanelBody } from "./Files.tsx";
import { CustomPanel, ExtensionDialog } from "./Extensions.tsx";
import { Shelf } from "./Shelf.tsx";
import {
  CacheReadIcon,
  CloseIcon,
  HamburgerIcon,
  HistoryIcon,
  MoreDotsIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RefreshIcon,
  StopCompactionIcon,
  SystemPromptIcon,
  TokenArrowIcon,
  WrenchIcon,
} from "./icons.tsx";
import { Transcript } from "./Transcript.tsx";
import { Sidebar, ProjectSelect } from "./Sidebar.tsx";
import {
  compactDisabled,
  CompactButton,
  ContextReadout,
  Status,
} from "./Status.tsx";
import { DialogHost, MissingFolderNotice, TrustBadge } from "./Dialogs.tsx";

// The shell owns the columns and top bar; each area's body keeps its own styles.

/** The cumulative token totals the stats button reads. */
type SessionTokens = SessionStats["tokens"];

/** The panel one of the top-bar buttons opens, one at a time. */
function TopPanelHost() {
  return <div id="top-panel" class="shell-top-panel" hidden />;
}

function TopBar({
  sessionId,
  usage,
  tokens,
  cwd,
  trust,
  panels,
  compactOff,
  compacting,
  inspectionOnly = false,
}: {
  sessionId?: string;
  usage?: ContextUsage;
  /** Cumulative totals of the session, for the in / out / cache groups. */
  tokens?: SessionTokens;
  cwd?: string;
  trust?: { requiresTrust: boolean; trusted: boolean };
  /** What an attached session runs with: the two tabs tint their icons. */
  panels?: { system: boolean; tools: boolean };
  /** A read-only or busy session refuses to compact; the button dims. */
  compactOff?: boolean;
  compacting?: boolean;
  inspectionOnly?: boolean;
}) {
  return (
    <div id="top-bar" class="shell-top-bar">
      <div class="shell-top-bar-row">
        <button
          type="button"
          id="sidebar-toggle"
          class="shell-icon-button is-left-control"
          aria-controls="session-sidebar"
          aria-expanded="true"
          title="Hide sidebar"
          aria-label="Hide sidebar"
        >
          <span data-sidebar-open-icon>
            <PanelLeftIcon />
          </span>
          <span data-sidebar-closed-icon hidden>
            <HamburgerIcon />
          </span>
        </button>
        {trust === undefined || cwd === undefined ? null : (
          <TrustBadge cwd={cwd} status={trust} />
        )}
        {/* Under 480px pi-web keeps the three tabs behind this button and
            slides them in over the bar (AppShell.tsx L1978-L2090); the media
            query in areas/shell.css is what hides it above that width. */}
        {!inspectionOnly && (
          <button
            type="button"
            id="mobile-toolbar-more"
            class="shell-icon-button is-left-control"
            aria-controls="top-bar-tabs"
            aria-expanded="false"
            title="More controls"
            aria-label="More controls"
          >
            <span data-more-closed-icon>
              <MoreDotsIcon size={17} />
            </span>
            <span data-more-open-icon hidden>
              <CloseIcon />
            </span>
          </button>
        )}
        {/* pi-web draws the group whenever the chat area does, so a page
            with no session yet still has it (AppShell.tsx L1224), with
            Full history disabled until there is a history to export. */}
        {!inspectionOnly && (
          <div id="top-bar-tabs" class="shell-top-bar-tabs">
            {sessionId === undefined ? (
              <button
                type="button"
                class="shell-top-bar-tab"
                data-top-bar-tab
                disabled
                title="Full history is available after the session is saved"
                aria-label="Full history"
              >
                <HistoryIcon />
                <span>Full history</span>
              </button>
            ) : (
              <a
                class="shell-top-bar-tab"
                data-top-bar-tab
                href={`/sessions/${sessionId}/export`}
                target="_blank"
                rel="noreferrer"
                title="Full history"
                aria-label="Full history"
              >
                <HistoryIcon />
                <span>Full history</span>
              </a>
            )}
            <button
              type="button"
              class="shell-top-bar-tab"
              data-top-bar-tab
              data-top-panel="system"
              data-panel-loaded={panels?.system === true ? "true" : undefined}
              aria-pressed="false"
              title="System prompt"
              aria-label="System prompt"
              hx-get={
                sessionId === undefined
                  ? "/panels/system"
                  : `/sessions/${sessionId}/system-prompt`
              }
              hx-target="#top-panel"
              hx-swap="innerHTML"
            >
              {/* pi-web tints both icons with the accent once the session has
                told it what they hold, and leaves them dim until then
                (AppShell.tsx L1341, L1406). Only an attached session knows,
                which is why a stored one stays dim in pi-web too. */}
              <span data-panel-icon class="shell-panel-icon">
                <SystemPromptIcon />
              </span>
              <span>System</span>
            </button>
            <button
              type="button"
              class="shell-top-bar-tab"
              data-top-bar-tab
              data-top-panel="tools"
              data-panel-loaded={panels?.tools === true ? "true" : undefined}
              aria-pressed="false"
              title="Tool definitions"
              aria-label="Tool definitions"
              hx-get={
                sessionId === undefined
                  ? "/panels/tools"
                  : `/sessions/${sessionId}/tools`
              }
              hx-target="#top-panel"
              hx-swap="innerHTML"
            >
              <span data-panel-icon class="shell-panel-icon">
                <WrenchIcon />
              </span>
              <span>Tools</span>
            </button>
          </div>
        )}
        {sessionId === undefined || inspectionOnly ? null : (
          <SessionStatsButton
            sessionId={sessionId}
            {...(usage === undefined ? {} : { usage })}
            {...(tokens === undefined ? {} : { tokens })}
          />
        )}
        {sessionId === undefined || inspectionOnly ? null : (
          <>
            <CompactButton
              sessionId={sessionId}
              {...(usage === undefined ? {} : { usage })}
              {...(compactOff === true ? { disabled: true } : {})}
              compacting={compacting ?? false}
            />
            <button
              type="button"
              class="context-compact-button"
              data-compacting="true"
              title="Stop compaction"
              aria-label="Stop compaction"
              hx-post={`/sessions/${sessionId}/compact/abort`}
              hx-swap="none"
              hidden
            >
              <StopCompactionIcon />
            </button>
          </>
        )}
        <button
          type="button"
          class="page-refresh-button"
          id="page-refresh"
          title="Refresh page and reconnect"
          aria-label="Refresh page"
        >
          <RefreshIcon />
        </button>
        {/* pi-web renders the toggle unconditionally (AppShell.tsx L1674);
            with no stats cluster to push it, it takes the free space. */}
        <button
          type="button"
          id="file-panel-toggle"
          class={`shell-icon-button is-right-control${sessionId === undefined ? " is-sessionless" : ""}`}
          aria-controls="file-panel"
          aria-expanded="false"
          title="Show file panel"
          aria-label="Show file panel"
        >
          <PanelRightIcon />
        </button>
        <TopPanelHost />
      </div>
      {/* pi-web gives the phone its own full-width warning row under the bar
          (AppShell.tsx); only one of the two is ever visible. */}
      {trust === undefined || cwd === undefined ? null : (
        <TrustBadge cwd={cwd} status={trust} banner />
      )}
    </div>
  );
}

/**
 * The stats cluster on the right of the bar: cumulative tokens, then the
 * context gauge. pi-web drops a group whose count is zero and puts the exact
 * numbers in the hover text (ui-map 2.3).
 */
function SessionStatsButton({
  sessionId,
  usage,
  tokens,
}: {
  sessionId: string;
  usage?: ContextUsage;
  tokens?: SessionTokens;
}) {
  const parts: string[] = [];
  if (tokens) {
    parts.push(
      `in: ${tokens.input.toLocaleString("en")}`,
      `out: ${tokens.output.toLocaleString("en")}`,
      `cache read: ${tokens.cacheRead.toLocaleString("en")}`,
      `cache write: ${tokens.cacheWrite.toLocaleString("en")}`,
    );
  }
  const context = usage === undefined ? "" : formatContextTooltip(usage);
  if (context !== "") parts.push(context);
  const readout = usage === undefined ? "" : formatContextUsage(usage);
  const empty = readout === "" && (tokens === undefined || tokens.input === 0);
  return (
    <button
      type="button"
      id="stats-trigger"
      class="shell-session-stats mobile-session-stats"
      data-top-panel="stats"
      aria-pressed="false"
      title={parts.length === 0 ? "Session info" : parts.join("  |  ")}
      aria-label="Session info"
      hx-get={`/sessions/${sessionId}/stats`}
      hx-target="#top-panel"
      hx-swap="innerHTML"
    >
      {tokens !== undefined && tokens.input > 0 ? (
        <span class="mobile-session-stat-io">
          <TokenArrowIcon direction="in" />
          {formatCompactCount(tokens.input)}
        </span>
      ) : null}
      {tokens !== undefined && tokens.output > 0 ? (
        <span class="mobile-session-stat-io">
          <TokenArrowIcon direction="out" />
          {formatCompactCount(tokens.output)}
        </span>
      ) : null}
      {tokens !== undefined && tokens.cacheRead > 0 ? (
        <span data-cache-read class="shell-cache-read">
          <CacheReadIcon />
          {formatCompactCount(tokens.cacheRead)}
        </span>
      ) : null}
      <ContextReadout
        {...(usage === undefined ? {} : { usage })}
        empty={empty}
      />
    </button>
  );
}

export function Shell({
  sidebar,
  fragment,
  activeId,
  settledCursor,
  savedObservation,
  cwd,
  cwdAvailable,
  usage,
  tokens,
  trust,
  panels,
  compactOff,
  compacting,
  inspectionOnly = false,
  children,
  overlay,
}: {
  sidebar?: SidebarView | undefined;
  fragment?: boolean | undefined;
  activeId?: string;
  settledCursor?: string;
  savedObservation?: SessionView["savedObservation"];
  /** The folder on screen: the document title is built from it. */
  cwd?: string;
  cwdAvailable?: boolean | undefined;
  /** The reader's home folder: the workspace pill shortens paths with it. */
  home?: string;
  usage?: ContextUsage;
  tokens?: SessionTokens;
  trust?: { requiresTrust: boolean; trusted: boolean };
  panels?: { system: boolean; tools: boolean };
  compactOff?: boolean;
  compacting?: boolean;
  inspectionOnly?: boolean;
  children?: unknown;
  /** An overlay over the whole shell: the settings dialog. */
  overlay?: unknown;
}) {
  const region = (
    <div
      id="session-region"
      hx-history-elt
      hx-sync="this:replace"
      class="shell-session-region"
    >
      <TopBar
        {...(activeId === undefined ? {} : { sessionId: activeId })}
        {...(usage === undefined ? {} : { usage })}
        {...(tokens === undefined ? {} : { tokens })}
        {...(cwd === undefined ? {} : { cwd })}
        {...(trust === undefined ? {} : { trust })}
        {...(panels === undefined ? {} : { panels })}
        {...(compactOff === true ? { compactOff } : {})}
        compacting={compacting ?? false}
        inspectionOnly={inspectionOnly}
      />
      <main
        class="shell-main"
        data-session-id={activeId}
        data-cwd={cwd}
        data-cwd-available={cwdAvailable === false ? "false" : undefined}
        data-saved-session={
          activeId ? `/sessions/${activeId}/saved` : undefined
        }
        data-saved-revision={savedObservation?.revision}
        data-saved-leaf={savedObservation?.leaf ?? settledCursor}
        data-saved-content-leaf={
          savedObservation ? (savedObservation.contentLeaf ?? "") : undefined
        }
        data-live-events={
          activeId && !inspectionOnly
            ? `/sessions/${activeId}/events`
            : undefined
        }
        hx-sse:close="web-pi:saved"
        hx-sse:connect={
          activeId && !inspectionOnly && !savedObservation
            ? `/sessions/${activeId}/events?after=${encodeURIComponent(settledCursor ?? "")}`
            : undefined
        }
        hx-trigger="web-pi:sse-start"
        hx-swap="none"
      >
        {children}
        <div class="chat-notices">
          <div id="toasts" hx-preserve />
        </div>
        <DialogHost />
      </main>
    </div>
  );
  if (fragment) return region;
  return (
    <div class="shell-layout">
      <div class="sidebar-overlay-backdrop sidebar-mobile-pending" />
      <div
        id="session-sidebar"
        class="sidebar-container sidebar-open sidebar-mobile-pending"
      >
        {sidebar && (
          <Sidebar
            view={sidebar}
            {...(activeId === undefined ? {} : { activeId })}
            {...(cwd === undefined ? {} : { cwd })}
          />
        )}
      </div>
      <div
        class="panel-resize-handle sidebar-resize-handle"
        role="separator"
        tabindex={0}
        aria-orientation="vertical"
        aria-controls="session-sidebar"
        aria-valuemin={180}
        aria-valuemax={480}
        data-resize-handle="sidebar"
        title="Resize the sidebar"
        aria-label="Resize the sidebar"
      />
      {region}
      <div class="right-panel-overlay-backdrop" aria-hidden="true" />
      <div
        class="panel-resize-handle right-panel-resize-handle"
        role="separator"
        tabindex={0}
        aria-orientation="vertical"
        aria-controls="file-panel"
        aria-valuemin={300}
        aria-valuemax={1200}
        data-resize-handle="right-panel"
        title="Resize the file panel"
        aria-label="Resize the file panel"
      />
      <FilePanel
        {...(activeId === undefined ? {} : { sessionId: activeId })}
        {...(cwd === undefined ? {} : { cwd })}
      />
      {overlay}
    </div>
  );
}

/**
 * The right panel: pi-web's container, with the files area's body inside.
 * pi-web keeps it mounted (collapsed) on every route, so the files it lists
 * come from the open session's folder, else from the folder that is picked.
 */
function FilePanel({ sessionId, cwd }: { sessionId?: string; cwd?: string }) {
  return (
    <div
      id="file-panel"
      class="right-panel-container right-panel-closed"
      data-session={sessionId ?? ""}
      data-cwd={cwd ?? ""}
    >
      <div class="shell-file-panel-header">
        <div class="shell-file-tabs-host">
          <div id="file-tabs" class="file-tabs" role="tablist" hidden />
        </div>
        <button
          type="button"
          id="file-panel-close"
          class="shell-icon-button is-right-control is-selected"
          title="Hide file panel"
          aria-label="Hide file panel"
        >
          <PanelRightIcon />
        </button>
      </div>
      <div class="shell-file-panel-body">
        <FilePanelBody />
      </div>
    </div>
  );
}

export function NewSessionPage({
  sidebar,
  fragment,
  view,
  draft,
  home,
  overlay,
}: {
  sidebar?: SidebarView | undefined;
  fragment?: boolean | undefined;
  view: NewSessionView;
  draft?: string;
  home?: string;
  overlay?: unknown;
}) {
  return (
    <Shell
      sidebar={sidebar}
      fragment={fragment}
      cwd={view.cwd}
      cwdAvailable={view.available}
      trust={view.trust}
      {...(home === undefined ? {} : { home })}
      {...(overlay === undefined ? {} : { overlay })}
    >
      <section class="chat-window is-empty" aria-label="Messages">
        <DropZone />
        <div class="chat-body">
          <div class="chat-scroll">
            <div class="chat-scroll-content">
              <div class="chat-transcript">
                <header class="chat-empty">
                  <h1>
                    <span aria-hidden="true">π</span>
                    <span>web-pi</span>
                  </h1>
                  <div class="new-session-directory">
                    <span class="new-session-directory-label">
                      Working directory
                    </span>
                    <ProjectSelect
                      cwd={view.cwd}
                      {...(home === undefined ? {} : { home })}
                    />
                  </div>
                </header>
              </div>
            </div>
          </div>
        </div>
        <footer class="chat-composer">
          {view.available ? (
            <Composer cwd={view.cwd} draft={draft} start={view} />
          ) : (
            <div class="project-folder-message is-new-session" role="status">
              That folder is gone. Pick another one to start a session.
            </div>
          )}
        </footer>
      </section>
    </Shell>
  );
}

export function SessionPage({
  sidebar,
  fragment,
  view,
  draft,
  images,
  trust,
  home,
  overlay,
}: {
  sidebar?: SidebarView | undefined;
  fragment?: boolean | undefined;
  view: SessionView;
  draft?: string;
  images?: ImageAttachment[];
  trust?: { requiresTrust: boolean; trusted: boolean };
  home?: string;
  overlay?: unknown;
}) {
  const { summary } = view;
  const inspectionOnly = isSubagentSession(summary);
  // A session whose folder is gone stays readable: only the actions that
  // would run the agent in it disappear.
  const missingFolder = summary.cwdAvailable === false;
  return (
    <Shell
      sidebar={sidebar}
      fragment={fragment}
      activeId={summary.id}
      inspectionOnly={inspectionOnly}
      cwdAvailable={summary.cwdAvailable}
      settledCursor={view.settledCursor}
      savedObservation={view.savedObservation}
      cwd={summary.cwd}
      usage={view.usage}
      {...(home === undefined ? {} : { home })}
      tokens={view.tokens}
      {...(view.status === null
        ? {}
        : {
            panels: {
              system: view.status.hasSystemPrompt,
              tools: view.status.hasActiveTools,
            },
          })}
      {...(compactDisabled(view) ? { compactOff: true } : {})}
      compacting={view.status?.compacting ?? false}
      {...(trust === undefined || inspectionOnly ? {} : { trust })}
      {...(overlay === undefined ? {} : { overlay })}
    >
      <section class="chat-window" aria-label="Messages">
        {!inspectionOnly && <DropZone />}
        <Transcript view={view} />
        {inspectionOnly && (
          <div class="branch-sync-notice" role="status">
            Delegated session — saved transcript, inspection only. Saved updates
            appear automatically while this page is visible.
          </div>
        )}
        {!inspectionOnly && (
          <footer class="chat-composer">
            {missingFolder ? (
              <MissingFolderNotice />
            ) : view.otherBranch ? null : (
              <Composer
                sessionId={summary.id}
                cwd={summary.cwd}
                draft={draft}
                images={images}
                view={view}
                status={<Status view={view} />}
              />
            )}
            <Shelf status={view.status} />
          </footer>
        )}
      </section>
      {!inspectionOnly && (
        <>
          <CustomPanel
            sessionId={summary.id}
            frame={view.status?.custom ?? null}
          />
          <ExtensionDialog
            sessionId={summary.id}
            dialog={view.status?.dialog ?? null}
          />
          {/* Text an extension asked to put in the composer arrives here. */}
          <div id="editor-insert" hidden />
        </>
      )}
    </Shell>
  );
}
