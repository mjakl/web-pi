import { writeFileAtomic } from "@adapters/fs/atomic-write";
import { pathKey } from "@core/path-access";
import type { EditableMessage } from "@core/ports";
import { delegationFold } from "@core/session-delegation";
import { readStars, rewindSelection, STAR_TYPE } from "@core/session-entries";
import {
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readSessionHeader } from "./session-snapshot.ts";

// Direct edits to Pi's session JSONL, with web-pi custom entries for stars
// and rewind markers. Pi's SessionManager does every append; only delete and
// rewind rewrite a file, because the SDK has no way to remove entries.

/** A rewritten session keeps the permissions its owner gave it. */
function rewrite(filePath: string, contents: string): void {
  writeFileAtomic(filePath, contents, statSync(filePath).mode & 0o7777);
}

function jsonl(entries: readonly FileEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/**
 * Re-attach a session's children to its own parent before it is deleted, so a
 * fork chain survives a delete in the middle. Only the header line of each
 * child is rewritten; every entry line is preserved verbatim.
 */
export function reparentChildren(filePath: string): void {
  const newParent = readSessionHeader(filePath)?.header.parentSession;
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
      const header = readSessionHeader(child)?.header;
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
      rewrite(child, JSON.stringify(rewritten) + contents.slice(end));
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

/**
 * Rewind to a user message (see `rewindSelection`). Lines before it are kept
 * verbatim; only what follows is rewritten. Returns the removed message so
 * the composer can offer it again.
 */
export function rewindSessionFile(
  filePath: string,
  entryId: string,
): EditableMessage {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const parsed = lines.map((line) => JSON.parse(line) as FileEntry);
  const { kept, tail, removed } = rewindSelection(
    parsed.slice(1) as SessionEntry[],
    entryId,
    randomUUID(),
  );
  rewrite(filePath, `${lines.slice(0, kept + 1).join("\n")}\n${jsonl(tail)}`);
  return removed;
}

/** Star state the source had, applied to a copy that may already carry some. */
function copyStars(wanted: Set<string>, copy: SessionManager): void {
  const entries = copy.getEntries();
  const current = readStars(entries);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const starred = wanted.has(entry.id);
    if (starred !== current.has(entry.id)) {
      copy.appendCustomEntry(STAR_TYPE, { targetId: entry.id, starred });
    }
  }
}

/**
 * Write the root-to-`leafId` path into a new session file next to the source,
 * with the source as its parent. Used by both fork and clone: the SDK does the
 * copy, and only a path that ends before any answer needs writing by hand.
 * The source's manager is repointed at the copy, so the caller drops it.
 */
export function branchToNewFile(
  source: SessionManager,
  leafId: string,
): { id: string; file: string } {
  const stars = readStars(source.getEntries());
  const file = source.createBranchedSession(leafId);
  if (!file) throw new Error("Session is not stored on disk");
  // Without an answer there is no star to append, so Pi's unflushed manager
  // never writes over this file.
  if (!existsSync(file)) {
    const header = source.getHeader();
    if (!header) throw new Error("Branched session has no header");
    writeFileSync(file, jsonl([header, ...source.getEntries()]), {
      flag: "wx",
    });
  }
  copyStars(stars, source);
  return { id: source.getSessionId(), file };
}
