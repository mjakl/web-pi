import { contextUsage } from "@core/context-usage";
import { isSubagentSession } from "@core/sessions";
import type { SessionView } from "@core/workspace";
import {
  type ItemActions,
  Items,
  LoadEarlier,
  TurnFragment,
} from "./Items.tsx";
import { Status, turnBusy } from "./Status.tsx";
import { ShelfBody } from "./Shelf.tsx";
import { CustomPanelBody, ExtensionDialogBody } from "./Extensions.tsx";
import { Partial } from "./Partial.tsx";
import { Rail } from "./Rail.tsx";
import { JumpToLatestIcon } from "./icons.tsx";

/**
 * What every transcript fragment of this view may do: a delegated session is
 * inspection only, and another branch or a missing folder makes it read-only.
 */
export function itemActions(view: SessionView): ItemActions {
  const { summary } = view;
  const inspectionOnly = isSubagentSession(summary);
  return {
    sessionId: summary.id,
    cwd: summary.cwd,
    starred: view.starred,
    ...(inspectionOnly ? { inspectionOnly: true } : {}),
    ...(inspectionOnly || view.otherBranch || summary.cwdAvailable === false
      ? { readOnly: true }
      : {}),
    ...(turnBusy(view.status) ? { busy: true } : {}),
  };
}

/**
 * A window of settled history under the sentinel for the page before it: the
 * page itself, each earlier page, saved observation and ownership handoff.
 */
export function SavedMessages({ view }: { view: SessionView }) {
  const leaf = view.savedObservation?.leaf ?? view.leaf;
  return (
    <>
      {view.hasMore && view.oldestId !== undefined ? (
        <LoadEarlier
          sessionId={view.summary.id}
          before={view.oldestId}
          leaf={leaf}
        />
      ) : null}
      <Items items={view.items} actions={itemActions(view)} />
    </>
  );
}

/** A missed stop can clear owned UI even when its saved history is unreadable. */
export function LiveRecovery({ view }: { view: SessionView }) {
  if (!view.liveRecovery) return null;
  const stopped = {
    ...view,
    status: null,
    usage: contextUsage({ tokens: null, contextWindow: null }),
  };
  return (
    <template
      data-live-recovery
      data-leaf={view.liveRecovery.leaf ?? ""}
      data-content-leaf={view.liveRecovery.contentLeaf ?? ""}
    >
      <Status view={stopped} oob />
      <Partial target="#shelf" swap="outerHTML">
        <ShelfBody status={null} />
      </Partial>
      <Partial target="#extension-dialog">
        <ExtensionDialogBody sessionId={view.summary.id} dialog={null} />
      </Partial>
      <Partial target="#custom-ui">
        <CustomPanelBody sessionId={view.summary.id} frame={null} />
      </Partial>
    </template>
  );
}

/** Initial pages and canonical rewrites share the transcript and rail owner. */
export function Transcript({ view }: { view: SessionView }) {
  const { summary } = view;
  const inspectionOnly = isSubagentSession(summary);
  const actions = itemActions(view);
  return (
    <div class="chat-body">
      <div id="log" class="chat-scroll">
        <div class="chat-scroll-content">
          <div class="chat-transcript">
            {view.otherBranch && !inspectionOnly ? (
              <div class="branch-sync-notice" role="status">
                <span>Viewing another branch of this session, read only.</span>
                <button
                  type="button"
                  class="history-action"
                  hx-post={`/sessions/${summary.id}/navigate`}
                  hx-vals={JSON.stringify({ entryId: view.leaf })}
                  hx-target="body"
                  hx-swap="innerHTML"
                >
                  Continue from here
                </button>
              </div>
            ) : null}
            <div id="messages">
              <SavedMessages view={view} />
            </div>
            <div id="turn">
              <TurnFragment
                items={view.turn}
                actions={actions}
                status={inspectionOnly ? null : view.status}
              >
                <LiveRecovery view={view} />
              </TurnFragment>
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        id="jump-to-latest"
        class="chat-jump-to-latest"
        aria-label="Jump to latest"
        title="Jump to latest"
        hidden
      >
        <span data-new-messages hidden>
          New messages
        </span>
        <JumpToLatestIcon />
      </button>
      <div
        id="rail-column"
        class="chat-minimap"
        role="navigation"
        aria-label="Conversation paths"
      >
        <Rail view={view} />
      </div>
    </div>
  );
}
