import { pathKey } from "@core/path-access";
import { discoverSessionRoots } from "@core/session-discovery";
import type { SessionCatalog, SessionRead } from "@core/ports";
import {
  delegationFold,
  type SessionDelegation,
} from "@core/session-delegation";
import {
  rowMetadataFold,
  STAR_TYPE,
  editableUserMessage,
} from "@core/session-entries";
import {
  isSessionId,
  isSubagentSession,
  type SessionRowMetadata,
  type SessionSummary,
} from "@core/sessions";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  estimateTokens,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { exportSessionHtml } from "./session-export.ts";
import {
  fileStamp,
  readSessionSnapshot,
  resolveSnapshotEntryId,
  sessionHeader,
  snapshotRevision,
} from "./session-snapshot.ts";
import {
  branchToNewFile,
  removeSessionFile,
  rewindSessionFile,
} from "./session-files.ts";

// All identities come from headers. Adaptive root discovery classifies only
// the prefix and ancestry needed for a priority certificate. Explicit child
// expansion classifies the parent's creation window and concrete ancestry.
// Neither retains transcript bodies.

const HEADER_MAX_BYTES = 8192;
const METADATA_CACHE_MAX = 4096;
/** readHeader is synchronous, so one buffer serves every file of a scan. */
const headerBuffer = Buffer.alloc(HEADER_MAX_BYTES);

type Header = {
  id: string;
  cwd: string;
  timestamp: string;
  /** Absolute path of the session this one was forked or branched from. */
  parentSession?: string;
  modifiedAt: string;
  fileSize: number;
  stamp: string;
};

function cacheFile<T>(cache: Map<string, T>, filePath: string, value: T): void {
  if (!cache.has(filePath) && cache.size >= METADATA_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(filePath, value);
}

function readHeader(filePath: string): Header | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const info = fstatSync(fd);
    const bytes = readSync(fd, headerBuffer, 0, HEADER_MAX_BYTES, 0);
    const buffer = headerBuffer.subarray(0, bytes);
    const newline = buffer.indexOf(10);
    if (newline < 0 && info.size > bytes) return undefined;
    const header = sessionHeader(
      JSON.parse(buffer.subarray(0, newline < 0 ? bytes : newline).toString()),
    );
    if (!header) return undefined;
    return {
      id: header.id,
      cwd: header.cwd,
      timestamp: header.timestamp,
      ...(typeof header.parentSession === "string" &&
      isAbsolute(header.parentSession)
        ? { parentSession: header.parentSession }
        : {}),
      modifiedAt: info.mtime.toISOString(),
      fileSize: info.size,
      stamp: fileStamp(info),
    };
  } catch (error) {
    if (error instanceof SyntaxError || isFileReadError(error))
      return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isFileReadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "syscall" in error &&
    (error.syscall === "open" ||
      error.syscall === "read" ||
      error.syscall === "stat" ||
      error.syscall === "fstat")
  );
}

/**
 * Row metadata by streaming: the same fold `rowMetadata()` applies in the
 * core, fed one line at a time so a hundred-megabyte session never lands in
 * memory just to show a sidebar row.
 */
async function streamRowMetadata(
  filePath: string,
  header: Header,
): Promise<
  | { metadata: SessionRowMetadata; classification: SessionDelegation }
  | undefined
> {
  const fold = rowMetadataFold();
  const delegation = delegationFold(header.id);
  const valid = await streamEntries(filePath, header.id, (entry) => {
    delegation.add(entry);
    fold.add(entry as SessionEntry);
  });
  if (!valid) return undefined;
  return {
    metadata: fold.finish({
      modifiedAt: header.modifiedAt,
      fileSize: header.fileSize,
    }),
    classification: delegation.finish(),
  };
}

async function streamEntries(
  filePath: string,
  sessionId: string,
  add: (entry: unknown) => void,
): Promise<boolean> {
  const lines = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let first = true;
  for await (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (first) {
        if (sessionHeader(entry)?.id !== sessionId) return false;
        first = false;
      } else {
        add(entry);
      }
    } catch {
      if (first) return false;
      // A producer may still be appending the last JSONL entry.
    }
  }
  return !first;
}

/**
 * What the context holds right after a compaction: Pi's own context build at
 * that entry, estimated the way Pi estimates it. Entries before a compaction
 * never change, so one answer per entry is cached for the life of the process.
 */
const compactionTokens = new Map<string, number>();

function contextTokensAt(
  sessionId: string,
  entries: readonly SessionEntry[],
  entryId: string,
): number | undefined {
  const key = `${sessionId}\0${entryId}`;
  const cached = compactionTokens.get(key);
  if (cached !== undefined) return cached;
  try {
    const context = buildSessionContext(
      [...entries],
      resolveSnapshotEntryId(entries, entryId),
    );
    const total = context.messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      0,
    );
    compactionTokens.set(key, total);
    return total;
  } catch {
    // A branch the entry no longer belongs to: no estimate, no card number.
    return undefined;
  }
}

export type PiSessionCatalog = SessionCatalog & {
  /** File path for a known id; scans the store when the id is not cached. */
  pathOf(id: string): Promise<string | undefined>;
  /** Remember a file this process created so it is readable before the next scan. */
  remember(id: string, filePath: string): void;
};

/**
 * Where Pi's own `SessionManager.create(cwd)` would store a new session for
 * this agent directory. The SDK derives that from `PI_CODING_AGENT_DIR` and
 * does not export the encoding, so it is mirrored here and checked against the
 * host Pi in session-files.test.ts; the runtime passes it so the agent
 * directory it was given, not the environment, decides where sessions land.
 */
export function defaultSessionDir(agentDir: string, cwd: string): string {
  const encoded = resolve(cwd)
    .replace(/^[/\\]/, "")
    .replace(/[/\\:]/g, "-");
  return join(resolve(agentDir), "sessions", `--${encoded}--`);
}

export function createPiSessionCatalog(options: {
  agentDir: string;
}): PiSessionCatalog {
  const sessionsDir = join(options.agentDir, "sessions");
  const paths = new Map<string, string>();
  const delegations = new Map<
    string,
    { stamp: string; value: SessionDelegation }
  >();
  // One entry per file: a re-read replaces the stamp instead of leaving the
  // superseded key behind, so the cap never evicts a hot session for a stale
  // copy of itself.
  const rows = new Map<
    string,
    {
      stamp: string;
      row: { summary: SessionSummary; metadata: SessionRowMetadata };
    }
  >();

  const pendingRows = new Map<string, ReturnType<typeof streamRowMetadata>>();

  function readMetadata(filePath: string, header: Header) {
    // A direct page loads its sidebar and exact admission check concurrently.
    // They can share this one revision's EOF pass without retaining its body.
    const key = `${filePath}\0${header.stamp}`;
    const pending = pendingRows.get(key);
    if (pending) return pending;
    const read = streamRowMetadata(filePath, header)
      .then(async (streamed) => {
        if (!streamed || fileStamp(await stat(filePath)) !== header.stamp)
          return undefined;
        cacheFile(delegations, filePath, {
          stamp: header.stamp,
          value: streamed.classification,
        });
        cacheFile(rows, filePath, {
          stamp: header.stamp,
          row: {
            summary: {
              id: header.id,
              cwd: header.cwd,
              createdAt: header.timestamp,
              modifiedAt: header.modifiedAt,
              fileSize: header.fileSize,
              filePath,
              ...streamed.classification,
              ...(streamed.metadata.name
                ? { name: streamed.metadata.name }
                : {}),
            },
            metadata: streamed.metadata,
          },
        });
        return streamed;
      })
      .finally(() => pendingRows.delete(key));
    pendingRows.set(key, read);
    return read;
  }

  async function inventory(): Promise<
    { header: Header; summary: SessionSummary }[]
  > {
    const files: { header: Header; summary: SessionSummary }[] = [];
    // parentSession is a path; the sidebar needs the id it belongs to, and
    // only this scan knows both.
    const idByPath = new Map<string, string>();
    const parents = new Map<string, string>();
    let folders: string[] = [];
    try {
      folders = await readdir(sessionsDir);
    } catch {
      return files;
    }
    const listed = await Promise.all(
      folders.map(async (folder) => {
        const dir = join(sessionsDir, folder);
        try {
          return (await readdir(dir))
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(dir, name));
        } catch {
          return [];
        }
      }),
    );
    for (const filePath of listed.flat()) {
      try {
        const header = readHeader(filePath);
        if (!header) continue;
        paths.set(header.id, filePath);
        idByPath.set(pathKey(filePath), header.id);
        if (header.parentSession !== undefined) {
          parents.set(header.id, pathKey(header.parentSession));
        }
        files.push({
          header,
          summary: {
            id: header.id,
            cwd: header.cwd,
            createdAt: header.timestamp,
            modifiedAt: header.modifiedAt,
            fileSize: header.fileSize,
            filePath,
          },
        });
      } catch {
        // Unreadable or concurrently removed files are left out.
      }
    }
    return files.map(({ header, summary }) => {
      const parentId = idByPath.get(parents.get(summary.id) ?? "");
      return {
        header,
        summary: parentId === undefined ? summary : { ...summary, parentId },
      };
    });
  }

  async function classifyFile(
    header: Header,
    summary: SessionSummary,
    scanCache: ReadonlyMap<
      string,
      { stamp: string; value: SessionDelegation }
    > = delegations,
  ): Promise<SessionSummary | undefined> {
    const filePath = summary.filePath;
    if (!filePath) return undefined;
    try {
      const atStart = scanCache.get(filePath);
      const cached =
        atStart?.stamp === header.stamp ? atStart : delegations.get(filePath);
      if (cached?.stamp === header.stamp) {
        return fileStamp(await stat(filePath)) === header.stamp
          ? { ...summary, ...cached.value }
          : undefined;
      }
      // A candidate will often become a visible row. Share its concrete EOF
      // read with row metadata rather than streaming the same revision twice.
      const streamed = await readMetadata(filePath, header);
      return streamed ? { ...summary, ...streamed.classification } : undefined;
    } catch {
      return undefined;
    }
  }

  async function scan(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    // Freeze at most the existing cache capacity. Early misses must not evict
    // later hits from the same scan when the inventory exceeds that capacity.
    const scanCache = new Map(delegations);
    for (const { header, summary } of await inventory()) {
      const classified = await classifyFile(header, summary, scanCache);
      if (classified) summaries.push(classified);
    }
    return summaries;
  }

  async function pathOf(id: string): Promise<string | undefined> {
    if (!isSessionId(id)) return undefined;
    if (!paths.has(id)) await inventory();
    return paths.get(id);
  }

  async function classification(
    id: string,
  ): ReturnType<SessionCatalog["classification"]> {
    const filePath = await pathOf(id);
    if (!filePath) return { kind: "missing" };
    try {
      await stat(filePath);
    } catch (error) {
      return error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
        ? { kind: "missing" }
        : { kind: "unavailable" };
    }
    const header = readHeader(filePath);
    if (!header || header.id !== id) return { kind: "unavailable" };
    const summary = await classifyFile(header, {
      id,
      cwd: header.cwd,
      createdAt: header.timestamp,
      modifiedAt: header.modifiedAt,
      fileSize: header.fileSize,
      filePath,
    });
    return summary ? { kind: "classified", summary } : { kind: "unavailable" };
  }

  /** The file behind an id, or a "Session not found" error for callers that write. */
  async function fileOf(id: string): Promise<string> {
    const filePath = await pathOf(id);
    if (!filePath) throw new Error("Session not found");
    return filePath;
  }

  async function openManager(id: string): Promise<SessionManager> {
    return SessionManager.open(await fileOf(id));
  }

  async function openSelection(id: string, entryId?: string) {
    const filePath = await fileOf(id);
    const manager = SessionManager.open(filePath);
    const selectedId =
      entryId === undefined
        ? undefined
        : resolveSnapshotEntryId(manager.getEntries(), entryId);
    return { filePath, manager, selectedId };
  }

  function savedRead(
    filePath: string,
    snapshot: NonNullable<Awaited<ReturnType<typeof readSessionSnapshot>>>,
  ): SessionRead {
    const { header, name, entries } = snapshot;
    const delegation = delegationFold(header.id);
    for (const entry of entries) delegation.add(entry);
    return {
      summary: {
        id: header.id,
        cwd: header.cwd,
        ...(name ? { name } : {}),
        createdAt: header.timestamp,
        modifiedAt: snapshot.modifiedAt,
        fileSize: snapshot.fileSize,
        filePath,
        ...delegation.finish(),
      },
      branch: snapshot.branch,
      entries,
      leafId: snapshot.leafId,
      revision: snapshot.revision,
    };
  }

  return {
    list: scan,
    classification,
    async discover(options) {
      const scanCache = new Map(delegations);
      const files = await inventory();
      const bySummary = new Map(
        files.map((file) => [file.summary, file.header]),
      );
      const runtime = new Map(
        options.runtime.map((summary) => [summary.id, summary]),
      );
      const unflushed: SessionSummary[] = [];
      const known = new Set(files.map((file) => file.summary.id));
      for (const summary of options.runtime) {
        if (
          !known.has(summary.id) &&
          (await classification(summary.id)).kind === "missing"
        ) {
          unflushed.push(
            isSubagentSession(summary)
              ? { ...summary, live: false, running: false }
              : summary,
          );
        }
      }
      return discoverSessionRoots(
        files.map((file) => file.summary),
        async (summary) => {
          const header = bySummary.get(summary);
          if (!header) return undefined;
          const classified = await classifyFile(header, summary, scanCache);
          if (!classified) return undefined;
          const live = runtime.get(summary.id);
          return live && !isSubagentSession(classified)
            ? { ...classified, live: true, running: live.running ?? false }
            : classified;
        },
        options,
        unflushed,
      );
    },
    pathOf,
    contextTokensAt,
    resolveEntryId: resolveSnapshotEntryId,
    remember(id, filePath) {
      paths.set(id, filePath);
    },

    async folder(id) {
      const filePath = await pathOf(id);
      if (!filePath) return undefined;
      const header = readHeader(filePath);
      return header?.id === id ? header.cwd : undefined;
    },

    async read(id, leafId): Promise<SessionRead | undefined> {
      const filePath = await pathOf(id);
      if (!filePath) return undefined;
      const snapshot = await readSessionSnapshot(filePath, leafId).catch(
        (error: unknown) => {
          if (isFileReadError(error)) return undefined;
          throw error;
        },
      );
      if (!snapshot || snapshot.header.id !== id) return undefined;
      return savedRead(filePath, snapshot);
    },

    async readSaved(id, revision) {
      const filePath = await pathOf(id);
      if (!filePath) return { kind: "unavailable" };
      const info = await stat(filePath).catch((error: unknown) => {
        if (isFileReadError(error)) return undefined;
        throw error;
      });
      if (!info) return { kind: "unavailable" };
      const checked = snapshotRevision(info);
      if (checked === revision) return { kind: "unchanged" };
      // The observation path rejects malformed files rather than repairing or
      // publishing the tolerant reader's potentially truncated transcript.
      const snapshot = await readSessionSnapshot(
        filePath,
        undefined,
        true,
      ).catch(() => undefined);
      if (!snapshot || snapshot.header.id !== id)
        return { kind: "unavailable", revision: checked };
      return {
        kind: "changed",
        revision: snapshot.revision,
        snapshot: savedRead(filePath, snapshot),
      };
    },

    async rowMetadata(id) {
      const filePath = await pathOf(id);
      if (!filePath) return undefined;
      // Pi remembers the path of a session it has not flushed yet; the row is
      // simply not on disk, which is not an error.
      const info = await stat(filePath).catch((error: unknown) => {
        if (isFileReadError(error)) return undefined;
        throw error;
      });
      if (!info) return undefined;
      const stamp = fileStamp(info);
      const cached = rows.get(filePath);
      if (cached?.stamp === stamp && cached.row.summary.id === id)
        return cached.row;
      const header = readHeader(filePath);
      if (!header || header.id !== id) return undefined;
      const file = {
        modifiedAt: header.modifiedAt,
        fileSize: header.fileSize,
      };
      const streamed = await readMetadata(filePath, header).catch(
        (error: unknown) => {
          if (isFileReadError(error)) return undefined;
          throw error;
        },
      );
      if (!streamed || fileStamp(await stat(filePath)) !== header.stamp)
        return undefined;
      const { metadata, classification } = streamed;
      const row = {
        summary: {
          id: header.id,
          cwd: header.cwd,
          ...(metadata.name ? { name: metadata.name } : {}),
          createdAt: header.timestamp,
          ...file,
          ...classification,
        },
        metadata,
      };
      cacheFile(rows, filePath, { stamp: header.stamp, row });
      cacheFile(delegations, filePath, {
        stamp: header.stamp,
        value: classification,
      });
      return row;
    },

    async rename(id, name) {
      (await openManager(id)).appendSessionInfo(name);
    },

    async remove(id) {
      removeSessionFile(await fileOf(id));
      paths.delete(id);
    },

    async setStar(id, targetId, starred) {
      const { manager, selectedId } = await openSelection(id, targetId);
      const target = manager.getEntry(selectedId ?? targetId);
      if (target?.type !== "message" || target.message.role !== "assistant") {
        throw new Error("Star target must be an assistant answer");
      }
      manager.appendCustomEntry(STAR_TYPE, { targetId: target.id, starred });
      return target.id;
    },

    async fork(id, entryId) {
      const { filePath, manager, selectedId } = await openSelection(
        id,
        entryId,
      );
      const entry = manager.getEntry(selectedId ?? entryId);
      if (!entry) throw new Error("Select an existing conversation message");
      const draft = editableUserMessage(entry) ?? { text: "", images: [] };
      // Editing a user message reopens the history *before* it; anything else
      // is copied up to and including itself. The role decides, not the text:
      // a question that is only images is still a question.
      const isUserMessage =
        entry.type === "message" && entry.message.role === "user";
      const leafId = isUserMessage ? entry.parentId : entry.id;
      if (leafId === null) {
        throw new Error(
          "Nothing precedes the first message; use New for an empty session.",
        );
      }
      const forked = branchToNewFile(filePath, leafId);
      paths.set(forked.id, forked.file);
      return { id: forked.id, ...draft };
    },

    async clone(id, leafId) {
      const { filePath, manager, selectedId } = await openSelection(id, leafId);
      const leaf = selectedId ?? manager.getLeafId();
      if (leaf === null) throw new Error("Cannot clone an empty session");
      const cloned = branchToNewFile(filePath, leaf);
      paths.set(cloned.id, cloned.file);
      return cloned.id;
    },

    async rewind(id, entryId) {
      const { filePath, selectedId } = await openSelection(id, entryId);
      return rewindSessionFile(filePath, selectedId ?? entryId);
    },

    async exportHtml(id) {
      const filePath = await pathOf(id);
      if (!filePath) throw new Error("Session not found");
      const snapshot = await readSessionSnapshot(filePath);
      if (!snapshot || snapshot.header.id !== id)
        throw new Error("Session not found");
      // The CLI exporter opens a writable SessionManager. Give it a temporary
      // snapshot so inspection cannot repair or migrate the producer's file.
      const directory = await mkdtemp(join(tmpdir(), "web-pi-export-source-"));
      try {
        const input = join(directory, basename(filePath));
        const content = [snapshot.header, ...snapshot.entries]
          .map((entry) => JSON.stringify(entry))
          .join("\n");
        await writeFile(input, `${content}\n`);
        return await exportSessionHtml(input);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
