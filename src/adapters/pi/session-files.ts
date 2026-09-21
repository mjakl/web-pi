import { pathKey } from "@core/path-access";
import type { EditableMessage } from "@core/ports";
import { delegationFold } from "@core/session-delegation";
import {
  editableUserMessage,
  readStars,
  STAR_TYPE,
} from "@core/session-entries";
import type {
  FileEntry,
  SessionEntry,
  SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Direct edits to Pi's session JSONL, with web-pi custom entries for stars
// and rewind markers. Pi's SessionManager does every append; only delete and
// rewind rewrite a file, because the SDK has no way to remove entries.

function writeAtomic(filePath: string, contents: string): void {
  const temporary = `${filePath}.tmp${String(process.pid)}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, filePath);
}

function jsonl(entries: readonly FileEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

function headerOf(filePath: string): SessionHeader | undefined {
  try {
    const contents = readFileSync(filePath, "utf8");
    const end = contents.indexOf("\n");
    const parsed: unknown = JSON.parse(
      end < 0 ? contents : contents.slice(0, end),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const header = parsed as SessionHeader;
    return header.type === "session" ? header : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-attach a session's children to its own parent before it is deleted, so a
 * fork chain survives a delete in the middle. Only the header line of each
 * child is rewritten; every entry line is preserved verbatim.
 */
export function reparentChildren(filePath: string): void {
  const newParent = headerOf(filePath)?.parentSession;
  const target = pathKey(filePath);
  const directory = dirname(filePath);
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const name of files) {
    const child = join(directory, name);
    if (pathKey(child) === target) continue;
    try {
      const header = headerOf(child);
      if (!header?.parentSession) continue;
      if (pathKey(header.parentSession) !== target) continue;
      const contents = readFileSync(child, "utf8");
      // A parent-seeded child also has a Pi fork header. Deleting its parent
      // must not rewrite that externally owned transcript, even just its header.
      const delegation = delegationFold(header.id);
      for (const line of contents.split("\n")) {
        try {
          delegation.add(JSON.parse(line));
        } catch {
          // An external producer may still be appending its final line.
        }
      }
      if (
        delegation.finish().inspectionOnly ||
        contents.includes('"customType":"web-pi:subagent"')
      )
        continue;
      const end = contents.indexOf("\n");
      if (end < 0) continue;
      const rewritten: SessionHeader = { ...header };
      if (newParent === undefined) delete rewritten.parentSession;
      else rewritten.parentSession = newParent;
      writeFileSync(
        child,
        JSON.stringify(rewritten) + contents.slice(end),
        "utf8",
      );
    } catch {
      // A child that cannot be read or written keeps its stale parent; the
      // delete itself must still go through.
    }
  }
}

export function removeSessionFile(filePath: string): void {
  reparentChildren(filePath);
  unlinkSync(filePath);
}

const KEPT_AFTER_REWIND = new Set([
  "session_info",
  "model_change",
  "thinking_level_change",
]);

/**
 * Remove a user message and everything that followed it, keeping only the
 * preferences (name, model, thinking level, stars on kept entries) recorded
 * later. Returns the removed message so the composer can offer it again.
 */
export function rewindSessionFile(
  filePath: string,
  entryId: string,
): EditableMessage {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line) as FileEntry);
  const entries = parsed.slice(1) as SessionEntry[];
  const index = entries.findIndex((entry) => entry.id === entryId);
  const target = entries[index];
  const removed = target && editableUserMessage(target);
  if (!target || !removed) {
    throw new Error("Rewind requires an existing user message");
  }
  const kept = entries.slice(0, index);
  const keptIds = new Set(kept.map((entry) => entry.id));

  let parentId = target.parentId;
  const tail: SessionEntry[] = [];
  const chain = (entry: SessionEntry) => {
    tail.push({ ...entry, parentId });
    parentId = entry.id;
  };
  const starTarget = (entry: SessionEntry): string | undefined => {
    if (entry.type !== "custom" || entry.customType !== STAR_TYPE) return;
    const targetId = (entry.data as { targetId?: unknown } | undefined)
      ?.targetId;
    return typeof targetId === "string" ? targetId : undefined;
  };
  for (const entry of entries.slice(index + 1)) {
    const starred = starTarget(entry);
    if (KEPT_AFTER_REWIND.has(entry.type)) chain(entry);
    // Both stars and unstars are kept, or an unstar recorded after the cut
    // would leave an earlier star line standing.
    else if (starred !== undefined && keptIds.has(starred)) chain(entry);
  }
  // A marker leaf keeps the reopened session pointing before the removed
  // message without resurrecting anything that came after it.
  tail.push({
    type: "custom",
    customType: "web-pi-rewind",
    data: {},
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
  });

  writeAtomic(
    filePath,
    `${lines.slice(0, index + 1).join("\n")}\n${jsonl(tail)}`,
  );
  return removed;
}

/** Star state the source has, applied to a copy that may already carry some. */
export function copyStars(
  source: readonly SessionEntry[],
  targetFile: string,
): void {
  const wanted = readStars(source);
  const manager = SessionManager.open(targetFile);
  const entries = manager.getEntries();
  const current = readStars(entries);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const starred = wanted.has(entry.id);
    if (starred !== current.has(entry.id)) {
      manager.appendCustomEntry(STAR_TYPE, { targetId: entry.id, starred });
    }
  }
}

/**
 * Write the root-to-`leafId` path into a new session file next to the source,
 * with the source as its parent. Used by both fork and clone: the SDK does the
 * copy, and only a path that ends before any answer needs writing by hand.
 */
export function branchToNewFile(
  sourceFile: string,
  leafId: string,
): { id: string; file: string } {
  // createBranchedSession repoints its manager at the new file, so this one is
  // read for the source entries first and thrown away afterwards.
  const throwaway = SessionManager.open(sourceFile);
  const entries = throwaway.getEntries();
  const file = throwaway.createBranchedSession(leafId);
  if (!file) throw new Error("Session is not stored on disk");
  if (!existsSync(file)) {
    const header = throwaway.getHeader();
    if (!header) throw new Error("Branched session has no header");
    writeFileSync(file, jsonl([header, ...throwaway.getEntries()]), {
      flag: "wx",
    });
  }
  copyStars(entries, file);
  return { id: throwaway.getSessionId(), file };
}
