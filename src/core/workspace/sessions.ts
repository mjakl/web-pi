import { conversationRail, hasBranches } from "@core/conversation-rail";
import { contextUsage, type ContextUsage } from "@core/context-usage";
import { isThinkingLevel } from "@core/models";
import type {
  EditableMessage,
  LiveSnapshot,
  ModelListing,
  RuntimeEvent,
  SessionRead,
} from "@core/ports";
import {
  branchLeaves,
  branchTo,
  lastAssistantText,
  readStars,
  rowMetadata,
  sessionStats,
  type SessionStats,
} from "@core/session-entries";
import {
  isSubagentSession,
  recentProjects,
  type SessionRowMetadata,
  type SessionSummary,
} from "@core/sessions";
import {
  sessionTree,
  sessionTreePage,
  type SessionTreePageOptions,
} from "@core/session-tree";
import {
  assistantItem,
  deferThinking,
  projectTranscript,
  type TranscriptItem,
} from "@core/transcript";
import { pageItems } from "@core/turns";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Shared } from "./deps.ts";
import type {
  SavedObservationOptions,
  SavedSessionUpdate,
  SessionView,
  SidebarView,
  ViewOptions,
} from "./views.ts";

// Persisted sessions: the sidebar, one session's page, and the edits Pi's
// SessionManager writes for us (rename, star, fork, clone, rewind).

export function sessionUseCases({
  deps,
  decorate,
  entriesOf,
  modelsFor,
  requireFolder,
  requireWritableSession,
  inspectionOnly,
  cwdOf,
}: Shared) {
  function liveView(
    snapshot: LiveSnapshot,
    summary: SessionSummary,
    models: ModelListing,
    options: ViewOptions,
  ): SessionView {
    // Settlement moves the boundary, so canonical history and the live tail
    // always come from the same snapshot and never overlap.
    const settledBranch = snapshot.branch.slice(0, snapshot.turnStart);
    const settled = projectTranscript(settledBranch);
    const page = pageItems(settled.items, {
      ...options,
      entryIds: settledBranch.map((entry) => entry.id),
    });
    deferThinking(page.items);
    const turn = projectTranscript(snapshot.branch.slice(snapshot.turnStart));
    if (snapshot.partial) {
      turn.items.push(
        assistantItem("partial", snapshot.partial, {
          ...(snapshot.partialArguments === undefined
            ? {}
            : { partialArguments: snapshot.partialArguments }),
        }),
      );
    }
    if (snapshot.bash) {
      turn.items.push({
        kind: "bash",
        entryId: "bash-pending",
        command: snapshot.bash.command,
        output: snapshot.bash.output,
        exitCode: null,
        cancelled: false,
        truncated: false,
        excluded: false,
        pending: true,
        timestamp: new Date().toISOString(),
      });
    }
    const { status } = snapshot;
    const starred = readStars(snapshot.entries);
    const leafId = snapshot.branch.at(-1)?.id ?? null;
    const reported = status.contextTokens;
    const fallback = turn.lastContextTokens ?? settled.lastContextTokens;
    fillCompactions(summary.id, snapshot.entries, [
      ...page.items,
      ...turn.items,
    ]);
    return {
      summary,
      items: page.items,
      hasMore: page.hasMore,
      ...(page.oldestId === undefined ? {} : { oldestId: page.oldestId }),
      ...(options.leaf === undefined ? {} : { leaf: options.leaf }),
      turn: turn.items,
      settledCursor: settledBranch.at(-1)?.id ?? "",
      resetTranscript: page.reset,
      status,
      tokens: sessionStats(snapshot.entries).tokens,
      usage: contextUsage({
        tokens: reported ?? fallback,
        contextWindow: status.model?.contextWindow,
        estimated:
          reported === null ? fallback !== null : status.contextTokensEstimated,
        ...(options.warnTokens === undefined
          ? {}
          : { warnTokens: options.warnTokens }),
      }),
      models: models.models,
      modelWarnings: models.warnings,
      starred,
      leaves: branchLeaves(snapshot.entries, leafId),
      otherBranch:
        options.leaf !== undefined && options.leaf !== (leafId ?? undefined),
      rail: conversationRail(snapshot.entries, leafId, starred),
      branched: hasBranches(snapshot.entries),
    };
  }

  /** The post-compaction estimate every compaction card on the page shows. */
  function fillCompactions(
    id: string,
    entries: readonly SessionEntry[],
    items: readonly TranscriptItem[],
  ): void {
    for (const item of items) {
      if (item.kind !== "compaction") continue;
      const after = deps.sessions.contextTokensAt(id, entries, item.entryId);
      if (after !== undefined) item.tokensAfter = after;
    }
  }

  async function storedView(
    stored: SessionRead,
    summary: SessionSummary,
    options: ViewOptions,
    enrichModels = true,
  ): Promise<SessionView> {
    const transcript = projectTranscript(stored.branch);
    const starred = readStars(stored.entries);
    const leafId = stored.branch.at(-1)?.id ?? null;
    const page = pageItems(transcript.items, {
      ...options,
      entryIds: stored.branch.map((entry) => entry.id),
    });
    deferThinking(page.items);
    fillCompactions(stored.summary.id, stored.entries, page.items);
    const readOnly = isSubagentSession(summary) || !enrichModels;
    const listing = readOnly
      ? { models: [], warnings: [] }
      : await modelsFor(stored.summary.cwd);
    const model =
      !readOnly && transcript.lastModel
        ? (
            await deps.models
              .listAvailable(stored.summary.cwd)
              .catch(() => listing.models)
          ).find(
            (option) =>
              option.provider === transcript.lastModel?.provider &&
              option.id === transcript.lastModel.id,
          )
        : undefined;
    return {
      summary,
      ...(stored.revision === undefined || summary.live
        ? {}
        : {
            savedObservation: {
              revision: stored.revision,
              leaf: leafId,
              contentLeaf: transcript.contentLeaf,
            },
          }),
      items: page.items,
      hasMore: page.hasMore,
      ...(page.oldestId === undefined ? {} : { oldestId: page.oldestId }),
      ...(options.leaf === undefined ? {} : { leaf: options.leaf }),
      turn: [],
      settledCursor: stored.branch.at(-1)?.id ?? "",
      resetTranscript: page.reset,
      status: null,
      tokens: sessionStats(stored.entries).tokens,
      // pi-web reads context usage off the running agent, so a session
      // nothing is attached to shows no gauge, no warning tint on the
      // compact button, and no context rows in the stats popover. Without a
      // window there is nothing to measure against, which says exactly that.
      usage: contextUsage({ tokens: null, contextWindow: null }),
      models: listing.models,
      ...(model === undefined ? {} : { model }),
      ...(model
        ? {
            thinking: await deps.models.resolveThinking(
              stored.summary.cwd,
              model,
              transcript.lastThinking !== null &&
                isThinkingLevel(transcript.lastThinking)
                ? transcript.lastThinking
                : undefined,
              true,
            ),
          }
        : {}),
      modelWarnings: listing.warnings,
      starred,
      leaves: branchLeaves(stored.entries, leafId),
      otherBranch: options.leaf !== undefined && options.leaf !== stored.leafId,
      rail: conversationRail(stored.entries, leafId, starred),
      branched: hasBranches(stored.entries),
    };
  }

  function resolveViewOptions(
    entries: readonly SessionEntry[],
    options: ViewOptions,
  ): ViewOptions {
    const resolved = { ...options };
    for (const key of ["leaf", "before", "through"] as const) {
      const entryId = options[key];
      if (entryId !== undefined)
        resolved[key] = deps.sessions.resolveEntryId(entries, entryId);
    }
    // `after` is also a DOM reconciliation cursor. Migrated IDs must trigger
    // the existing whole-transcript reset, not leave old element IDs mounted.
    return resolved;
  }

  async function viewSession(
    id: string,
    options: ViewOptions = {},
  ): Promise<SessionView | undefined> {
    // A running session owns its file, so even another branch of it is read
    // from the runtime: the file on disk may be a flush behind.
    const live = (await inspectionOnly(id)) ? undefined : deps.runtime.get(id);
    if (live) {
      const snapshot = live.snapshot();
      const resolved = resolveViewOptions(snapshot.entries, options);
      const leafId = snapshot.branch.at(-1)?.id ?? null;
      const requestedLeaf = resolved.leaf;
      const alternate = requestedLeaf !== undefined && requestedLeaf !== leafId;
      // Only delivery views own the captured batch; selector/metadata reads
      // must leave it for a renderer that includes notices and composer text.
      // Consume before enrichment can await a newer batch.
      if (!alternate && options.consumePending) live.takePending();
      const [summary] = await decorate(
        [snapshot.summary],
        new Map([[id, snapshot]]),
      );
      if (!summary) return undefined;
      if (alternate) {
        // Another branch of a running session: read-only, but still from the
        // runtime's entries rather than from a file it has yet to flush.
        return storedView(
          {
            summary: snapshot.summary,
            branch: branchTo(snapshot.entries, requestedLeaf),
            entries: snapshot.entries,
            leafId,
          },
          summary,
          resolved,
        );
      }
      return liveView(
        snapshot,
        summary,
        await modelsFor(summary.cwd),
        resolved,
      );
    }
    const stored = await deps.sessions.read(id, options.leaf);
    if (!stored) return undefined;
    const [summary] = await decorate([stored.summary]);
    if (!summary) return undefined;
    return storedView(
      stored,
      summary,
      resolveViewOptions(stored.entries, options),
    );
  }

  async function savedOwned(id: string): Promise<boolean> {
    // Only a potential handoff needs the persisted authority check. On the
    // ordinary unchanged polling path, readSaved must be the first file read.
    return (
      !id.startsWith("subagent.") &&
      deps.runtime.get(id) !== undefined &&
      !(await inspectionOnly(id))
    );
  }

  async function observeSavedSession(
    id: string,
    observation: SavedObservationOptions,
  ): Promise<SavedSessionUpdate> {
    if (await savedOwned(id)) return { kind: "owned" };
    const read = await deps.sessions.readSaved(id, observation.revision);
    if (read.kind !== "changed") return read;
    const stored = read.snapshot;
    let leaf =
      observation.leaf === null
        ? null
        : deps.sessions.resolveEntryId(stored.entries, observation.leaf);
    if (leaf !== null && !stored.entries.some((entry) => entry.id === leaf))
      return { kind: "unavailable", revision: read.revision };
    const children = new Map<string | null, string[]>();
    for (const entry of stored.entries) {
      const siblings = children.get(entry.parentId) ?? [];
      siblings.push(entry.id);
      children.set(entry.parentId, siblings);
    }
    const visited = new Set<string>();
    for (;;) {
      const next = children.get(leaf) ?? [];
      // File order cannot identify the intended continuation at a fork.
      // Publish the shared path, but never guess between competing children.
      if (next.length !== 1) break;
      const child = next[0];
      if (child === undefined || visited.has(child))
        return { kind: "unavailable", revision: read.revision };
      visited.add(child);
      leaf = child;
    }
    const branch = branchTo(stored.entries, leaf);
    if (observation.contentLeaf !== null) {
      const contentLeaf = deps.sessions.resolveEntryId(
        stored.entries,
        observation.contentLeaf,
      );
      // Rewind preserves and reparents preferences, so a surviving metadata tip
      // does not prove that the content already displayed is still on this path.
      if (!branch.some((entry) => entry.id === contentLeaf))
        return { kind: "unavailable", revision: read.revision };
    }
    const options = resolveViewOptions(stored.entries, {
      ...(leaf === null ? {} : { leaf }),
      ...(observation.through === undefined
        ? {}
        : { through: observation.through }),
    });
    const [summary] = await decorate([stored.summary], undefined, true);
    if (!summary) return { kind: "unavailable", revision: read.revision };
    if (!isSubagentSession(summary) && (await savedOwned(id)))
      return { kind: "owned" };
    try {
      const view = await storedView(
        { ...stored, branch },
        summary,
        options,
        false,
      );
      return { kind: "changed", view };
    } catch {
      // A transient rewrite must not replace the reader's loaded history with
      // a partial projection, including when its oldest loaded item vanished.
      return { kind: "unavailable", revision: read.revision };
    }
  }

  async function stop(id: string): Promise<void> {
    await requireWritableSession(id);
    await deps.runtime.get(id)?.stop();
  }

  /** A live session owns its file; only a stopped one is edited on disk. */
  async function setStar(
    id: string,
    targetId: string,
    starred: boolean,
  ): Promise<string> {
    await requireWritableSession(id);
    const live = deps.runtime.get(id);
    return live
      ? live.setStar(targetId, starred)
      : deps.sessions.setStar(id, targetId, starred);
  }

  /**
   * Runtime entries for a live session, which owns its file and may be a
   * flush ahead of it; disk metadata for everything else. Streaming the file
   * of a running session would re-read the whole thing after every turn.
   */
  async function row(
    id: string,
  ): Promise<
    { summary: SessionSummary; metadata: SessionRowMetadata } | undefined
  > {
    return readRow(id, await inspectionOnly(id));
  }

  async function readRow(id: string, readOnly: boolean) {
    const snapshot = readOnly ? undefined : deps.runtime.get(id)?.snapshot();
    const found = snapshot
      ? {
          summary: snapshot.summary,
          metadata: rowMetadata(snapshot.entries, snapshot.summary),
        }
      : await deps.sessions.rowMetadata(id);
    if (!found) return undefined;
    const [summary] = await decorate([found.summary]);
    if (!summary) return undefined;
    return { summary, metadata: found.metadata };
  }

  async function listedSessions(): Promise<SessionSummary[]> {
    const stored = await deps.sessions.list();
    const known = new Set(stored.map((session) => session.id));
    // Pi may not have flushed a new runtime's first reply yet.
    const unflushed = deps.runtime
      .live()
      .filter((live) => !known.has(live.id))
      .map((live) => live.snapshot().summary);
    return decorate([...stored, ...unflushed]);
  }

  return {
    viewSession,
    observeSavedSession,
    row,
    stop,
    setStar,

    async lastAssistantText(id: string): Promise<string | undefined> {
      // Read the complete active branch, not a page or the streaming partial.
      const read = await entriesOf(id);
      return read && lastAssistantText(read.branch);
    },

    /** Existing session-derived directory choices, fetched only on opening. */
    async projects() {
      return recentProjects(await listedSessions());
    },

    /** Build the global tree before paging roots or any parent's children. */
    async sidebar(options: SessionTreePageOptions = {}): Promise<SidebarView> {
      const tree = sessionTree(await listedSessions());
      async function pageOf(
        pageOptions: SessionTreePageOptions,
      ): Promise<SidebarView> {
        const page = sessionTreePage(tree, pageOptions);
        const rows = await Promise.all(
          page.nodes.map(async (node) => {
            const { summary, children } = node;
            const found = await readRow(summary.id, isSubagentSession(summary));
            if (!found) return undefined;
            const preload =
              children.length > 0 &&
              page.selectedPath.has(summary.id) &&
              summary.id !== options.selectedId;
            return {
              ...found,
              summary: { ...summary, ...found.summary },
              ...(children.length > 0 ? { childCount: children.length } : {}),
              ...(preload
                ? {
                    children: await pageOf({
                      parentId: summary.id,
                      ...(options.selectedId === undefined
                        ? {}
                        : { selectedId: options.selectedId }),
                    }),
                  }
                : {}),
            };
          }),
        );
        return {
          rows: rows.filter((row) => row !== undefined),
          ...(pageOptions.parentId === undefined
            ? {}
            : { parentId: pageOptions.parentId }),
          ...(page.nextOffset === undefined
            ? {}
            : { nextOffset: page.nextOffset }),
        };
      }
      return pageOf(options);
    },

    async sessionStats(
      id: string,
      options: { warnTokens?: number } = {},
    ): Promise<
      | {
          summary: SessionSummary;
          stats: SessionStats;
          usage: ContextUsage;
        }
      | undefined
    > {
      // Two reads at most: the entries to aggregate, and the view that owns
      // the one context-usage number the whole page shows.
      const [stored, view] = await Promise.all([
        entriesOf(id),
        viewSession(id, options),
      ]);
      if (!stored || !view) return undefined;
      return {
        summary: view.summary,
        stats: sessionStats(stored.entries),
        usage: view.usage,
      };
    },

    /** The working folder of a session, for the file panel's root. */
    async sessionFolder(id: string): Promise<string | undefined> {
      const cwd = await cwdOf(id);
      return cwd === "" ? undefined : cwd;
    },

    /** A live session owns its file; only a stopped one is edited on disk. */
    async rename(id: string, name: string): Promise<void> {
      await requireWritableSession(id);
      const live = deps.runtime.get(id);
      if (live) live.setName(name);
      else await deps.sessions.rename(id, name);
    },

    async clearStars(id: string): Promise<void> {
      await requireWritableSession(id);
      const stored = await entriesOf(id);
      if (!stored) return;
      for (const targetId of readStars(stored.entries)) {
        await setStar(id, targetId, false);
      }
    },

    async remove(id: string): Promise<void> {
      await stop(id);
      await deps.sessions.remove(id);
    },

    async fork(
      id: string,
      entryId: string,
    ): Promise<{ id: string } & EditableMessage> {
      await requireFolder(id);
      return deps.sessions.fork(id, entryId);
    },

    async clone(id: string, leafId?: string): Promise<string> {
      await requireFolder(id);
      return deps.sessions.clone(id, leafId);
    },

    /** Shuts the runtime down first: nothing may append during the rewrite. */
    async rewind(id: string, entryId: string): Promise<EditableMessage> {
      await requireFolder(id);
      await stop(id);
      const draft = await deps.sessions.rewind(id, entryId);
      // Resume from the rewritten file, without submitting the recalled draft.
      await deps.runtime.open({ sessionId: id });
      return draft;
    },

    /** Moves the session's leaf, opening a runtime when there is none. */
    async navigateTree(id: string, targetId: string): Promise<string> {
      await requireFolder(id);
      const live =
        deps.runtime.get(id) ?? (await deps.runtime.open({ sessionId: id }));
      return (await live.navigateTree(targetId)) ?? "";
    },

    async exportHtml(id: string): Promise<{ html: string; filename: string }> {
      await requireWritableSession(id);
      return deps.sessions.exportHtml(id);
    },

    /** Every session's lifecycle, for the sidebar's one shared stream. */
    subscribeSessions(listener: (event: RuntimeEvent) => void): () => void {
      return deps.runtime.subscribeAll(listener);
    },
  };
}
