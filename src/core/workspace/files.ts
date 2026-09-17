import {
  buildEntriesFromFiles,
  type FileEntry,
  filterFileEntries,
} from "@core/composer";
import { type FileKind, fileKind, languageOf } from "@core/file-types";
import { directoryWithin, FileAccessError, samePath } from "@core/path-access";
import type { DirEntry, GitChangeFile, GitStatus } from "@core/ports";
import type { Shared } from "./deps.ts";
import { type FileScope, type FileView, ForbiddenPath } from "./views.ts";

// The file panel and the `@` menu: listings, the viewer, Git changes, and
// completion. Every path goes through `authorize` before it is touched.

export function fileUseCases({ deps, authorize, cwdOf }: Shared) {
  /**
   * The folder a completion request may list. Defaults to the session's own,
   * and anything else goes through the same containment policy as the file
   * panel, so there is one answer to "may this be listed".
   */
  async function authorizedCwd(
    id: string,
    directory: string | undefined,
  ): Promise<string> {
    const cwd = await cwdOf(id);
    if (cwd === "") throw new ForbiddenPath("Unknown session");
    if (directory === undefined || directory === "") return cwd;
    await authorize(directory, {
      sessionId: id,
      sessionCwd: cwd,
      listing: true,
    });
    return directory;
  }

  /**
   * The folder a files request is rooted in. A session names its own; without
   * one the folder comes from the page, so it goes through the same
   * containment check every other path does before it is listed.
   */
  async function resolveScopeCwd(scope: FileScope): Promise<string> {
    if (scope.sessionId !== undefined) return cwdOf(scope.sessionId);
    const cwd = scope.cwd ?? "";
    if (cwd !== "") await authorize(cwd, { listing: true });
    return cwd;
  }

  /**
   * The folder a viewed file is read against: it decides the relative path in
   * the toolbar and whether there is a diff to offer. A folder the reader may
   * not list just leaves the file without that context; the file itself is
   * authorized on its own.
   */
  async function viewCwd(scope: FileScope): Promise<string> {
    try {
      return await resolveScopeCwd(scope);
    } catch {
      return "";
    }
  }

  function changeFor(
    status: GitStatus,
    path: string,
  ): GitChangeFile | undefined {
    return status.files.find((file) => samePath(file.path, path));
  }

  return {
    /** The `@` index for a folder inside the session's own working folder. */
    async fileIndex(
      id: string,
      directory: string | undefined,
      query: string,
    ): Promise<
      { files: string[]; truncated: boolean } | { matches: FileEntry[] }
    > {
      const cwd = await authorizedCwd(id, directory);
      const index = await deps.files.index(cwd);
      if (query === "") return index;
      return {
        matches: filterFileEntries(buildEntriesFromFiles(index.files), query),
      };
    },

    /** Immediate children for a path-like `@` query, containment enforced. */
    async fileCompletion(
      id: string,
      query: string,
      directory: string | undefined,
    ): Promise<FileEntry[]> {
      const cwd = await authorizedCwd(id, directory);
      const children = await deps.files.children(query, cwd);
      return children.filter((entry) => directoryWithin(cwd, entry.path));
    },

    /** Resolve the explorer's folder once for Git and directory authorization. */
    async fileTree(
      scope: FileScope,
      options: { path?: string; changes?: boolean } = {},
    ): Promise<
      | {
          cwd: string;
          status: GitStatus;
          entries: DirEntry[];
          changes: boolean;
        }
      | undefined
    > {
      const cwd = await resolveScopeCwd(scope);
      if (cwd === "") return undefined;
      const status = await deps.git.status(cwd);
      const changes = options.changes === true && status.files.length > 0;
      if (changes) return { cwd, status, entries: [], changes };
      const path = options.path ?? cwd;
      await authorize(path, {
        sessionId: scope.sessionId,
        sessionCwd: cwd,
        listing: true,
      });
      return { cwd, status, entries: await deps.files.list(path), changes };
    },

    /**
     * One file as the viewer needs it: its kind, its text when it has any,
     * and its diff against HEAD. A deleted file has no content left, so it
     * opens with the diff alone.
     */
    async fileView(scope: FileScope, path: string): Promise<FileView> {
      const { sessionId } = scope;
      const cwd = await viewCwd(scope);
      const info = await authorize(path, {
        sessionId,
        sessionCwd: cwd,
        allowMissing: true,
      });
      const status = cwd === "" ? null : await deps.git.status(cwd);
      const change = status ? changeFor(status, path) : undefined;
      if (info === undefined) {
        if (!change) throw new FileAccessError("Not found", 404);
        const diff = await deps.git.diff(cwd, change);
        return {
          path,
          cwd,
          kind: "text",
          language: languageOf(path),
          size: 0,
          deleted: true,
          status: change.status,
          ...(diff === null ? {} : { diff }),
        };
      }
      if (!info.isFile) throw new FileAccessError("Not a file", 400);
      const kind = fileKind(path);
      const view: FileView = {
        path,
        cwd,
        kind,
        language: languageOf(path),
        size: info.size,
        ...(change ? { status: change.status } : {}),
      };
      if (kind === "text") {
        view.text = await deps.files.readText(path);
      }
      if (change) {
        const diff = await deps.git.diff(cwd, change);
        if (diff !== null) view.diff = diff;
      }
      return view;
    },

    /** Size, language, and kind alone: what a media viewer re-reads. */
    async fileMeta(
      sessionId: string | undefined,
      path: string,
    ): Promise<{ size: number; language: string; kind: FileKind }> {
      const info = await authorize(path, { sessionId });
      if (info === undefined || !info.isFile) {
        throw new FileAccessError("Not a file", 400);
      }
      return {
        size: info.size,
        language: languageOf(path),
        kind: fileKind(path),
      };
    },

    /** Raw bytes for an image, an audio file, a PDF, or a download. */
    async fileBytes(
      sessionId: string | undefined,
      path: string,
      range?: { start: number; end: number },
    ): Promise<{ size: number; stream: ReadableStream<Uint8Array> }> {
      const info = await authorize(path, { sessionId });
      if (info === undefined || !info.isFile) {
        throw new FileAccessError("Not a file", 400);
      }
      return { size: info.size, stream: deps.files.stream(path, range) };
    },

    /** Tells the viewer when the file changed under it. */
    async watchFile(
      sessionId: string | undefined,
      path: string,
      handlers: {
        change(info: { mtime: number; size: number }): void;
        error(): void;
      },
    ): Promise<() => void> {
      // A watch survives the file being deleted and written again, so a
      // missing path is not an error here.
      await authorize(path, { sessionId, allowMissing: true });
      return deps.watcher.watch(path, handlers);
    },

    /** The explorer's search box: files of the index, ranked. */
    async searchFiles(
      scope: FileScope,
      query: string,
      limit = 50,
    ): Promise<
      { cwd: string; status: GitStatus; matches: FileEntry[] } | undefined
    > {
      const cwd = await resolveScopeCwd(scope);
      if (cwd === "") return undefined;
      const status = await deps.git.status(cwd);
      const index = await deps.files.index(cwd);
      const entries = index.files.map((path) => ({ path, isDir: false }));
      return { cwd, status, matches: filterFileEntries(entries, query, limit) };
    },

    /** `@` completion before a session exists, containment enforced. */
    async folderFiles(
      cwd: string,
      query: string,
      path: boolean,
    ): Promise<
      { files: string[]; truncated: boolean } | { matches: FileEntry[] }
    > {
      await authorize(cwd, { listing: true });
      if (path) {
        const children = await deps.files.children(query, cwd);
        return {
          matches: children.filter((entry) => directoryWithin(cwd, entry.path)),
        };
      }
      const index = await deps.files.index(cwd);
      if (query === "") return index;
      return {
        matches: filterFileEntries(buildEntriesFromFiles(index.files), query),
      };
    },
  };
}
