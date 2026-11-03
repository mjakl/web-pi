import { syncDirectory } from "@adapters/fs/atomic-write";
import { webStatePath } from "@adapters/fs/web-state";
import { attachmentLimitError } from "@core/composer";
import type { UploadStore } from "@core/ports";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function safeName(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) ?? "";
  return leaf.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "file";
}

/** Uploaded files outlive requests, sessions, and worktrees; removal is manual. */
export function createUploadStore(agentDir: string): UploadStore {
  const directory = webStatePath(agentDir, "uploads");
  return {
    async save(files) {
      const problem = attachmentLimitError(
        files.map((file) => ({ bytes: file.data.byteLength })),
      );
      if (problem) throw new Error(problem);
      if (files.length === 0) return [];
      let batch: string | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const root = await realpath(directory);
        batch = await mkdtemp(join(root, "upload-"));
        const paths: string[] = [];
        for (const [index, file] of files.entries()) {
          // Numbering preserves duplicate names; wx never overwrites a file.
          const path = join(
            batch,
            `${String(index + 1)}-${safeName(file.name)}`,
          );
          await writeFile(path, file.data, {
            flag: "wx",
            mode: 0o600,
            flush: true,
          });
          paths.push(path);
        }
        syncDirectory(batch);
        syncDirectory(root);
        syncDirectory(dirname(root));
        syncDirectory(dirname(dirname(root)));
        return paths;
      } catch (cause) {
        // No paths have been published until the complete batch succeeds.
        if (batch) {
          try {
            await rm(batch, { recursive: true, force: true });
          } catch {
            // Preserve the write failure; an incomplete private batch can remain.
          }
        }
        throw new Error(
          "Cannot save attachments. Check server storage and try again.",
          { cause },
        );
      }
    },
  };
}
