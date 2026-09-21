import type { RailMark } from "@core/conversation-rail";
import type { ContextUsage } from "@core/context-usage";
import type { FileKind } from "@core/file-types";
import type { GitFileStatus } from "@core/git-status";
import type { LiveStatus, ModelOption, ThinkingLevel } from "@core/ports";
import type { BranchLeaf, SessionStats } from "@core/session-entries";
import type { SessionSummary, SessionRowMetadata } from "@core/sessions";
import type { TranscriptItem } from "@core/transcript";
import type { ProjectInfo, WorktreeInfo } from "@core/workspaces";

// What the workspace hands a page to render, and the one error a route maps
// to a status. Pure data: the web layer renders it and never touches Pi or
// the file system.

/**
 * Where a files request is rooted: the open session's folder, or the folder
 * the page has picked when no session is open yet.
 */
export type FileScope = { sessionId?: string; cwd?: string };

/** Which slice of which branch a page shows. */
export type ViewOptions = {
  /** Only deliveries that render notices and editor insertions consume them (SSE). */
  consumePending?: boolean;
  /** Branch tip to view; the session's own leaf by default. */
  leaf?: string;
  /** How many settled items the page holds. */
  tail?: number;
  /** Reconcile entries after the last rendered settled entry; empty is root. */
  after?: string;
  /** Page backwards from an entry already on screen. */
  before?: string;
  /** Widen the page until this entry is part of it. */
  through?: string;
  /** The reader's context-warning threshold, in tokens. */
  warnTokens?: number;
};

export type SessionView = {
  summary: SessionSummary;
  /** Settled conversation, before the current turn. */
  items: TranscriptItem[];
  /** Older entries exist before the first item on the page. */
  hasMore: boolean;
  /** The oldest item on the page: the cursor for the previous page. */
  oldestId?: string;
  /** The branch being viewed, so paging requests stay on it. */
  leaf?: string;
  /** The current turn, re-rendered while streaming. */
  turn: TranscriptItem[];
  /** Last settled raw entry, including invisible entries; empty is root. */
  settledCursor: string;
  /** The delivered cursor left the canonical branch; replace, do not append. */
  resetTranscript: boolean;
  status: LiveStatus | null;
  usage: ContextUsage;
  /** Cumulative token totals of the whole session, for the top-bar readout. */
  tokens: SessionStats["tokens"];
  models: ModelOption[];
  /**
   * The model this session last answered with, for the composer's selector
   * before a runtime exists. A live session reports its own in `status`.
   */
  model?: ModelOption;
  /**
   * Reasoning level the branch last switched to, beside that model. A live
   * session reports its own in `status`.
   */
  thinking?: ThinkingLevel;
  /** `enabledModels` patterns that matched nothing, shown once per page. */
  modelWarnings: string[];
  /** Entry ids of starred answers. */
  starred: Set<string>;
  /** Tips of every branch in the session; one entry when nothing branched. */
  leaves: BranchLeaf[];
  /** True while viewing a branch other than the session's own leaf. */
  otherBranch: boolean;
  /** Marks for the conversation rail: prompts, stars, and compactions. */
  rail: RailMark[];
  /** The session forked at least once, so the rail can expand into a graph. */
  branched: boolean;
};

/** The global session list, bounded to one page of metadata. */
export type SidebarView = {
  /** This page's readable rows, with metadata ready to render. */
  rows: {
    summary: SessionSummary;
    metadata: SessionRowMetadata;
    childCount?: number;
    /** Only the selected ancestor path is preloaded. */
    children?: SidebarView;
  }[];
  /** Direct children of this node; absent for a root page. */
  parentId?: string;
  /** Sibling offset, including unreadable and already-pinned rows. */
  nextOffset?: number;
};

/** One project row of the folder picker, once its worktrees are known. */
export type FolderChoice = {
  cwd: string;
  available: boolean;
  project: ProjectInfo;
  /** False when git could not answer at all: a plain folder. */
  isGit: boolean;
  worktrees: WorktreeInfo[];
  /** The listed worktree the reader is in right now, if any. */
  current: string | null;
};

/** What the new-session page needs before there is a session. */
export type NewSessionView = {
  cwd: string;
  available: boolean;
  /** The folder passed validation, so completion and models are offered. */
  usable: boolean;
  models: ModelOption[];
  modelWarnings: string[];
  model: ModelOption | undefined;
  /** Unset means "auto": Pi picks the level the model runs at. */
  thinkingLevel?: ThinkingLevel;
  trust: { requiresTrust: boolean; trusted: boolean };
};

/** Everything the file viewer renders, in one read. */
export type FileView = {
  path: string;
  /** The folder the panel shows paths relative to. */
  cwd: string;
  kind: FileKind;
  language: string;
  size: number;
  /** Complete text for a text file. */
  text?: string;
  /** The file is gone from disk; only the diff is left. */
  deleted?: boolean;
  status?: GitFileStatus;
  /** The unified patch against HEAD, when Git has one. */
  diff?: string;
};

/** Where a file request may point: the session's own working folder. */
export class ForbiddenPath extends Error {}

/** Saved delegated runs must never be resumed or modified by this workspace. */
export class InspectionOnlySession extends Error {
  constructor() {
    super(
      "Subagent sessions are inspection only. View the saved transcript; continue work in the parent session.",
    );
    this.name = "InspectionOnlySession";
  }
}
