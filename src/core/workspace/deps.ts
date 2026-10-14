import {
  BUILTIN_COMMANDS,
  rankCommands,
  type SlashCommand,
} from "@core/composer";
import {
  FileAccessError,
  isAbsolutePath,
  parentPath,
  referencesPath,
  withinAny,
} from "@core/path-access";
import type {
  AgentRuntime,
  DirectoryBrowser,
  Files,
  FileStat,
  Git,
  ModelCatalog,
  ModelListing,
  LiveSession,
  LiveSnapshot,
  Packages,
  ProjectResolver,
  ProjectResources,
  ProjectTrust,
  PushNotifier,
  SessionCatalog,
  SessionRead,
  Skills,
  Watcher,
} from "@core/ports";
import { isSubagentSession, type SessionSummary } from "@core/sessions";
import { InspectionOnlySession } from "./views.ts";
import { type ProjectInfo, unavailableFolderMessage } from "@core/workspaces";

// The ports the workspace is built over, and the internals more than one
// use-case family needs: session lookup and decoration, folder availability,
// and the one containment policy. Private to the workspace package.

export type WorkspaceDeps = {
  sessions: SessionCatalog;
  runtime: AgentRuntime;
  models: ModelCatalog;
  projects: ProjectResolver;
  browser: DirectoryBrowser;
  trust: ProjectTrust;
  skills: Skills;
  packages: Packages;
  resources: ProjectResources;
  files: Files;
  git: Git;
  watcher: Watcher;
  push: PushNotifier;
  webSettings: import("@core/web-settings").WebSettingsStore;
  /** os.tmpdir(); shell captures may live nowhere else. */
  tmpdir: string;
};

export type Shared = ReturnType<typeof createShared>;

export function createShared(deps: WorkspaceDeps) {
  // Folders a reader explicitly validated, as pi-web does: in memory, gone on
  // restart, never written to Pi's store.
  const validatedRoots = new Set<string>();

  async function modelsFor(
    cwd: string,
    sessionId?: string,
  ): Promise<ModelListing> {
    try {
      return await deps.models.list(cwd, sessionId);
    } catch (error) {
      return {
        models: [],
        warnings: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /** Runtime state plus the project a session's folder belongs to. */
  async function decorate(
    sessions: readonly SessionSummary[],
    snapshots?: ReadonlyMap<string, LiveSnapshot>,
    savedOnly = false,
  ): Promise<SessionSummary[]> {
    const roots = new Map<string, ProjectInfo>();
    const present = new Map<string, boolean>();
    await Promise.all(
      [...new Set(sessions.map((session) => session.cwd))].map(async (cwd) => {
        const [project, available] = await Promise.all([
          deps.projects.resolve(cwd),
          deps.projects.available(cwd),
        ]);
        roots.set(cwd, project);
        present.set(cwd, available);
      }),
    );
    return sessions.map((session) => {
      const inspectionOnly = isSubagentSession(session);
      const live =
        inspectionOnly ||
        savedOnly ||
        (snapshots !== undefined && !snapshots.has(session.id))
          ? undefined
          : deps.runtime.get(session.id);
      const project = roots.get(session.cwd);
      return {
        ...session,
        ...(inspectionOnly
          ? { inspectionOnly: true, live: false, running: false }
          : {}),
        ...(live
          ? {
              live: true,
              running:
                snapshots?.get(session.id)?.status.running ??
                live.snapshot().status.running,
            }
          : {}),
        ...(project ? { projectRoot: project.root } : {}),
        ...(project?.branch ? { branch: project.branch } : {}),
        ...(project?.isWorktree ? { isWorktree: true } : {}),
        ...(present.get(session.cwd) === false ? { cwdAvailable: false } : {}),
      };
    });
  }

  /** Classify from persisted origin, never from a possibly unrelated runtime. */
  async function inspectionOnly(id: string): Promise<boolean> {
    if (id.startsWith("subagent.")) return true;
    const stored = await deps.sessions.classification(id);
    if (stored.kind === "classified") return isSubagentSession(stored.summary);
    // Missing persisted history is safe only for a runtime we already own.
    // An unreadable or unstable file must never admit an ordinary writer.
    if (stored.kind === "unavailable") return true;
    // Existing runtimes passed writable admission or were created fresh. Their
    // snapshot is conversation state, not the authority for source ownership.
    return deps.runtime.get(id) === undefined;
  }

  /**
   * The runtime of a session this workspace may drive. Without one there is
   * nothing to classify, so a stopped session costs no file read here; with
   * one, the persisted origin decides, never the runtime's own snapshot.
   */
  async function ownedRuntime(id: string): Promise<LiveSession | undefined> {
    if (!deps.runtime.live().some((live) => live.id === id)) return undefined;
    return (await inspectionOnly(id)) ? undefined : deps.runtime.get(id);
  }

  async function requireWritableSession(id: string): Promise<void> {
    if (await inspectionOnly(id)) throw new InspectionOnlySession();
  }

  /**
   * Reading, exporting and stopping stay open when a session's folder is
   * gone; everything that would run the agent in it is refused with the one
   * message the page also shows.
   */
  async function requireFolder(id: string): Promise<void> {
    await requireWritableSession(id);
    const cwd = await cwdOf(id);
    if (cwd !== "" && !(await deps.projects.available(cwd))) {
      throw new Error(unavailableFolderMessage(cwd));
    }
  }

  function folderAvailable(cwd: string): Promise<boolean> {
    return deps.projects.available(cwd);
  }

  /**
   * The slash menu: built-ins, then what the live session offers, or else
   * what a session started in `cwd` would.
   */
  async function slashMenu(
    query: string,
    cwd: string | undefined,
    live?: LiveSession,
  ): Promise<SlashCommand[]> {
    const listed = live
      ? live.commands()
      : cwd === undefined
        ? []
        : await deps.resources.commands(cwd).catch(() => []);
    return rankCommands([...BUILTIN_COMMANDS, ...listed], query, {
      running: live?.snapshot().status.running ?? false,
    });
  }

  /** Whichever of the two writers owns this session right now. */
  async function entriesOf(id: string): Promise<SessionRead | undefined> {
    const live = await ownedRuntime(id);
    if (live) {
      const snapshot = live.snapshot();
      return {
        summary: snapshot.summary,
        branch: snapshot.branch,
        entries: snapshot.entries,
        leafId: snapshot.branch.at(-1)?.id ?? null,
      };
    }
    return (await savedRead(id))?.read;
  }

  // A page's images, thinking blocks, tool bodies and shell captures each
  // need a stopped session's entries. The last read of each session is kept,
  // and every use first asks the catalog's stat-based readSaved whether the
  // file still matches it; uses of one session queue behind each other, so
  // requests that arrive together share one parse. Bound: the kept reads
  // come from at most 32 MiB of session files, about as much heap once
  // parsed and twice that with the JSON a reference check keeps; a larger
  // file is not kept.
  const SAVED_READ_BYTES = 32 * 1024 * 1024;
  type SavedRead = { read: SessionRead; json?: string };
  type Kept = { read: Promise<SavedRead | undefined>; bytes?: number };
  const savedReads = new Map<string, Kept>();

  async function savedRead(id: string): Promise<SavedRead | undefined> {
    const previous = savedReads.get(id)?.read.catch(() => undefined);
    const kept: Kept = {
      read: (async () => {
        const last = await previous;
        // Only strict, stable reads come back "changed": a file that changed
        // while it was read, or does not parse strictly, is "unavailable".
        const check = await deps.sessions.readSaved(id, last?.read.revision);
        if (check.kind === "unchanged") return last;
        return check.kind === "changed" ? { read: check.snapshot } : undefined;
      })(),
    };
    savedReads.delete(id);
    savedReads.set(id, kept);
    let saved: SavedRead | undefined;
    try {
      saved = await kept.read;
    } finally {
      if (savedReads.get(id) === kept) {
        if (saved) fit(kept, saved.read.summary.fileSize);
        else savedReads.delete(id);
      }
    }
    if (saved) return saved;
    const tolerant = await deps.sessions.read(id);
    return tolerant && { read: tolerant };
  }

  /** Drops the oldest settled reads until the kept files fit the bound. */
  function fit(kept: Kept, bytes: number): void {
    kept.bytes = bytes;
    let total = 0;
    for (const other of savedReads.values()) total += other.bytes ?? 0;
    for (const [id, other] of savedReads) {
      if (total <= SAVED_READ_BYTES) return;
      if (other.bytes === undefined) continue;
      savedReads.delete(id);
      total -= other.bytes;
    }
  }

  async function cwdOf(sessionId: string | undefined): Promise<string> {
    if (sessionId === undefined) return "";
    const live = await ownedRuntime(sessionId);
    return live
      ? live.snapshot().summary.cwd
      : ((await deps.sessions.folder(sessionId)) ?? "");
  }

  // --- File access -------------------------------------------------------
  //
  // One policy for every file route: lexical containment against the roots
  // this request may reach, then the same check on the resolved path. The
  // cheap roots (the open session's folder and its repository) are tried
  // first; the full set costs a pass over every session header.

  async function projectRootOf(cwd: string): Promise<string | undefined> {
    return deps.projects.resolve(cwd).then(
      (project) => project.root,
      () => undefined,
    );
  }

  async function nearRoots(
    sessionId: string | undefined,
    sessionCwd?: string,
  ): Promise<string[]> {
    const roots = [...validatedRoots];
    if (sessionId === undefined) return roots;
    const cwd = sessionCwd ?? (await cwdOf(sessionId));
    if (cwd === "") return roots;
    roots.push(cwd);
    // A linked worktree may reach the repository it belongs to.
    const root = await projectRootOf(cwd);
    if (root !== undefined) roots.push(root);
    return roots;
  }

  /** Every session's working folder, and the repository each sits in. */
  async function everyRoot(): Promise<string[]> {
    const cwds = [
      ...new Set((await deps.sessions.list()).map((session) => session.cwd)),
    ];
    const roots = await Promise.all(cwds.map(projectRootOf));
    return [...cwds, ...roots.filter((root) => root !== undefined)];
  }

  async function sessionReferences(id: string, path: string): Promise<boolean> {
    const live = await ownedRuntime(id);
    if (live) {
      return referencesPath(JSON.stringify(live.snapshot().entries), path);
    }
    const saved = await savedRead(id);
    if (!saved) return false;
    saved.json ??= JSON.stringify(saved.read.entries);
    return referencesPath(saved.json, path);
  }

  /**
   * Answers with the file's stat, or throws with the status the route should
   * send. `listing` requests are never granted by a transcript reference:
   * naming a file does not open its folder.
   */
  async function authorize(
    path: string,
    options: {
      sessionId?: string | undefined;
      /** Already resolved by this use case, never a caller-supplied folder. */
      sessionCwd?: string;
      listing?: boolean;
      allowMissing?: boolean;
    } = {},
  ): Promise<FileStat | undefined> {
    if (!isAbsolutePath(path)) {
      throw new FileAccessError("Path must be absolute", 400);
    }
    const roots = await nearRoots(options.sessionId, options.sessionCwd);
    if (!withinAny(roots, path)) roots.push(...(await everyRoot()));
    let referenced = false;
    if (!withinAny(roots, path)) {
      if (options.listing === true || options.sessionId === undefined) {
        throw new FileAccessError("Access denied", 403);
      }
      referenced = await sessionReferences(options.sessionId, path);
      if (!referenced) throw new FileAccessError("Access denied", 403);
    }
    const info = await deps.files.stat(path);
    if (info === undefined && options.allowMissing !== true) {
      throw new FileAccessError("Not found", 404);
    }
    if (options.listing === true && info !== undefined && !info.isDirectory) {
      throw new FileAccessError("Not a directory", 400);
    }
    if (!referenced) {
      // The lexical check proved the spelling; this proves the file.
      const real = await deps.files.realpath(
        info === undefined ? parentPath(path) : path,
      );
      if (real === undefined) throw new FileAccessError("Not found", 404);
      const resolved = await Promise.all(
        roots.map((root) => deps.files.realpath(root)),
      );
      const known = resolved.filter((root) => root !== undefined);
      if (!withinAny(known, real)) {
        throw new FileAccessError("Access denied", 403);
      }
    }
    return info;
  }

  return {
    deps,
    validatedRoots,
    modelsFor,
    decorate,
    requireFolder,
    inspectionOnly,
    ownedRuntime,
    requireWritableSession,
    folderAvailable,
    slashMenu,
    entriesOf,
    cwdOf,
    projectRootOf,
    authorize,
  };
}
