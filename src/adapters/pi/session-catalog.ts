import { pathKey } from "@core/path-access";
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
  readSessionSnapshot,
  resolveSnapshotEntryId,
  sessionHeader,
} from "./session-snapshot.ts";
import {
  branchToNewFile,
  removeSessionFile,
  rewindSessionFile,
} from "./session-files.ts";

// Listing reads each header and streams delegation metadata on a changed
// stamp, before the workspace paginates. Neither discovery nor row metadata
// retains transcripts; only a requested session snapshot loads all entries.

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

function fileStamp(info: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}): string {
  return [info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino].join("\0");
}

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

async function streamDelegation(
  filePath: string,
  header: Header,
): Promise<SessionDelegation | undefined> {
  const fold = delegationFold(header.id);
  const valid = await streamEntries(filePath, header.id, (entry) => {
    fold.add(entry);
  });
  return valid ? fold.finish() : undefined;
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

  async function scan(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    // parentSession is a path; the sidebar needs the id it belongs to, and
    // only this scan knows both.
    const idByPath = new Map<string, string>();
    const parents = new Map<string, string>();
    let folders: string[] = [];
    try {
      folders = await readdir(sessionsDir);
    } catch {
      return summaries;
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
        const cached = delegations.get(filePath);
        const classification =
          cached?.stamp === header.stamp
            ? cached.value
            : await streamDelegation(filePath, header);
        if (!classification) continue;
        cacheFile(delegations, filePath, {
          stamp: header.stamp,
          value: classification,
        });
        paths.set(header.id, filePath);
        idByPath.set(pathKey(filePath), header.id);
        if (header.parentSession !== undefined) {
          parents.set(header.id, pathKey(header.parentSession));
        }
        summaries.push({
          id: header.id,
          cwd: header.cwd,
          createdAt: header.timestamp,
          modifiedAt: header.modifiedAt,
          fileSize: header.fileSize,
          filePath,
          ...classification,
        });
      } catch {
        // Unreadable or concurrently removed files are left out.
      }
    }
    return summaries.map((summary) => {
      const parentId = idByPath.get(parents.get(summary.id) ?? "");
      return parentId === undefined ? summary : { ...summary, parentId };
    });
  }

  async function pathOf(id: string): Promise<string | undefined> {
    if (!isSessionId(id)) return undefined;
    if (!paths.has(id)) await scan();
    return paths.get(id);
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

  return {
    list: scan,
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
      const { header, name, entries } = snapshot;
      const delegation = delegationFold(id);
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
        modifiedAt: info.mtime.toISOString(),
        fileSize: info.size,
      };
      const streamed = await streamRowMetadata(filePath, header).catch(
        (error: unknown) => {
          if (isFileReadError(error)) return undefined;
          throw error;
        },
      );
      if (!streamed) return undefined;
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
      cacheFile(rows, filePath, { stamp, row });
      cacheFile(delegations, filePath, { stamp, value: classification });
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
