import { isSessionId } from "@core/sessions";
import {
  migrateSessionEntries,
  parseSessionEntries,
  SessionManager,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export function fileStamp(info: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}): string {
  return [info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino].join("\0");
}

export function snapshotRevision(
  info: Parameters<typeof fileStamp>[0],
): string {
  return createHash("sha256").update(fileStamp(info)).digest("hex");
}

export function sessionHeader(value: unknown): SessionHeader | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const header = value as Partial<SessionHeader>;
  if (
    header.type !== "session" ||
    !isSessionId(header.id) ||
    typeof header.cwd !== "string" ||
    !isAbsolute(header.cwd) ||
    typeof header.timestamp !== "string" ||
    Number.isNaN(Date.parse(header.timestamp))
  ) {
    return undefined;
  }
  return header as SessionHeader;
}

function legacyEntryId(entry: SessionEntry, index: number): string {
  const content = { ...entry } as Record<string, unknown>;
  delete content["id"];
  delete content["parentId"];
  // Pi's v1 migration assigns this reference a random ID as well.
  if (entry.type === "compaction") delete content["firstKeptEntryId"];
  const digest = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  return `legacy-${String(index)}-${digest}`;
}

/** Keep old snapshot links usable after a writer migrates the source to v3. */
export function resolveSnapshotEntryId(
  entries: readonly SessionEntry[],
  entryId: string,
): string {
  const match = /^legacy-(\d+)-[a-f0-9]{64}$/.exec(entryId);
  if (!match || entries.some((entry) => entry.id === entryId)) return entryId;
  const index = Number(match[1]);
  const entry = entries[index - 1];
  // Position alone is unsafe after rewind: a new message may occupy that slot.
  return entry && legacyEntryId(entry, index) === entryId ? entry.id : entryId;
}

function migrateSnapshot(entries: FileEntry[], header: SessionHeader): void {
  const linear = (header.version ?? 1) < 2;
  migrateSessionEntries(entries);
  if (!linear) return;
  // Pi assigns random IDs when migrating v1. A non-writing reader needs stable
  // IDs across requests so a branch link can resolve without saving a migration.
  const ids = new Map<string, string>();
  entries.forEach((entry, index) => {
    if (entry.type !== "session")
      ids.set(entry.id, legacyEntryId(entry, index));
  });
  for (const entry of entries) {
    if (entry.type === "session") continue;
    entry.id = ids.get(entry.id) ?? entry.id;
    if (entry.parentId)
      entry.parentId = ids.get(entry.parentId) ?? entry.parentId;
    if (entry.type === "compaction") {
      entry.firstKeptEntryId =
        ids.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId;
    }
  }
}

/** Observation must not publish a partial append or a broken parent chain. */
function strictEntries(content: string): FileEntry[] | undefined {
  try {
    const entries: FileEntry[] = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line: string) => JSON.parse(line) as FileEntry);
    if (!sessionHeader(entries[0])) return undefined;
    if (
      entries
        .slice(1)
        .some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            typeof entry.type !== "string" ||
            entry.type === "session",
        )
    )
      return undefined;
    return entries;
  } catch {
    return undefined;
  }
}

function validSavedTree(entries: readonly FileEntry[]): boolean {
  const seen = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (
      entry.type === "session" ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      seen.has(entry.id) ||
      (entry.parentId !== null && !seen.has(entry.parentId))
    )
      return false;
    seen.add(entry.id);
  }
  return true;
}

/** Raw reads never invoke Pi's file repair, migration writes, or initialization. */
export async function readSessionSnapshot(
  filePath: string,
  leafId?: string,
  strict = false,
) {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    const content = await file.readFile("utf8");
    const after = await file.stat();
    const stable = fileStamp(info) === fileStamp(after);
    if (strict && !stable) return undefined;
    const parsed = strict
      ? strictEntries(content)
      : parseSessionEntries(content);
    if (!parsed) return undefined;
    const header = sessionHeader(parsed[0]);
    if (!header) return undefined;
    const entries = parsed.filter(
      (entry) =>
        entry && typeof entry === "object" && typeof entry.type === "string",
    );
    migrateSnapshot(entries, header);
    if (strict && !validSavedTree(entries)) return undefined;
    // inMemory(cwd, options, entries) loads and indexes the saved entries with
    // persist=false and no sessionFile; it cannot repair or rewrite the source.
    const manager = SessionManager.inMemory(header.cwd, undefined, entries);
    return {
      header,
      name: manager.getSessionName(),
      entries: manager.getEntries(),
      branch: manager.getBranch(
        leafId === undefined
          ? undefined
          : resolveSnapshotEntryId(manager.getEntries(), leafId),
      ),
      leafId: manager.getLeafId(),
      modifiedAt: info.mtime.toISOString(),
      fileSize: info.size,
      // An unstable initial read stays tolerant, but must be checked next time.
      revision: stable ? snapshotRevision(info) : "unstable",
    };
  } finally {
    await file.close();
  }
}
