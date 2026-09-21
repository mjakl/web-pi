import { isSubagentSession } from "@core/sessions";
import type { SessionView } from "@core/workspace";
import {
  type ItemActions,
  Items,
  LoadEarlier,
  TurnFragment,
} from "./Items.tsx";
import { turnBusy } from "./Status.tsx";
import { Rail } from "./Rail.tsx";
import { JumpToLatestIcon } from "./icons.tsx";

/** The stored name, else the opening request, else the id. */
function pageTitle(view: SessionView): string {
  const name = view.summary.name?.trim();
  if (name) return name;
  const first = [...view.items, ...view.turn].find(
    (item) => item.kind === "user",
  );
  const opening = first?.text.replaceAll(/\s+/g, " ").trim().slice(0, 60);
  return opening === undefined || opening === "" ? view.summary.id : opening;
}

function itemActions(view: SessionView): ItemActions {
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

/** The full loaded saved window, shared with observation and ownership handoff. */
export function SavedMessages({ view }: { view: SessionView }) {
  const leaf = view.savedObservation?.leaf ?? view.leaf;
  return (
    <>
      {view.hasMore && view.oldestId !== undefined ? (
        <LoadEarlier
          sessionId={view.summary.id}
          before={view.oldestId}
          {...(leaf === undefined ? {} : { leaf })}
        />
      ) : null}
      <Items items={view.items} actions={itemActions(view)} />
    </>
  );
}

/** Initial pages and canonical rewrites share the transcript and rail owner. */
export function Transcript({ view }: { view: SessionView }) {
  const { summary } = view;
  const inspectionOnly = isSubagentSession(summary);
  const leafId = view.leaves.find((leaf) => leaf.current)?.id;
  const actions = itemActions(view);
  return (
    <div class="chat-body">
      <div id="log" class="chat-scroll">
        <div class="chat-scroll-content">
          <div class="chat-transcript">
            <span hidden data-page-title>
              {pageTitle(view)}
            </span>
            {view.otherBranch && !inspectionOnly ? (
              <div class="branch-sync-notice" role="status">
                <span>Viewing another branch of this session, read only.</span>
                <button
                  type="button"
                  class="history-action"
                  hx-post={`/sessions/${summary.id}/navigate`}
                  hx-vals={JSON.stringify({ entryId: leafId })}
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
              />
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
