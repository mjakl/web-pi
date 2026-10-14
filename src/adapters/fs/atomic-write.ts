import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces a file so readers see either the old contents or the new, never a
 * truncated mix: a uniquely named temporary file is flushed, given exactly
 * `mode` (the umask aside), renamed over the target, and the rename synced. A
 * failure leaves the target as it was and removes the temporary file.
 */
export function writeFileAtomic(
  path: string,
  contents: string,
  mode: number,
): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode, flush: true });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Renamed away, or never created; the original error, if any, stands.
    }
  }
}
