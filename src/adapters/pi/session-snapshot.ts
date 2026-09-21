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

/** Raw reads never invoke Pi's file repair, migration writes, or initialization. */
export async function readSessionSnapshot(filePath: string, leafId?: string) {
  const file = await open(filePath, "r");
  try {
    const info = await file.stat();
    const parsed = parseSessionEntries(await file.readFile("utf8"));
    const header = sessionHeader(parsed[0]);
    if (!header) return undefined;
    const entries = parsed.filter(
      (entry) =>
        entry && typeof entry === "object" && typeof entry.type === "string",
    );
    migrateSnapshot(entries, header);
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
    };
  } finally {
    await file.close();
  }
}
