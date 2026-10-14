import { AT_RESULT_LIMIT, type FileEntry } from "@core/composer";
import { fileKind, languageOf } from "@core/file-types";
import { directoryWithin, FileAccessError, samePath } from "@core/path-access";
import type {
  DirEntry,
  FileStat,
  GitChangeFile,
  GitStatus,
  Watcher,
} from "@core/ports";
import type { Shared } from "./deps.ts";
import type { FileScope, FileView } from "./views.ts";

// The file panel and the `@` menu: listings, the viewer, Git changes, and
// completion. Every path goes through `authorize` before it is touched.

/** Starts watching an authorized file; the result stops it. */
type Watch = (handlers: Parameters<Watcher["watch"]>[1]) => () => void;

export function fileUseCases({ deps, authorize, cwdOf }: Shared) {
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

  /** The folder the `@` menu completes from; there is nothing to list without one. */
  async function completionCwd(scope: FileScope): Promise<string> {
    const cwd = await resolveScopeCwd(scope);
    if (cwd === "") throw new FileAccessError("No folder to list", 404);
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
    /** The `@` index the browser filters, or the matches of a query. */
    async fileIndex(
      scope: FileScope,
      query: string,
    ): Promise<
      { files: string[]; truncated: boolean } | { matches: FileEntry[] }
    > {
      const cwd = await completionCwd(scope);
      if (query === "") return deps.files.index(cwd);
      return { matches: await deps.files.search(cwd, query, AT_RESULT_LIMIT) };
    },

    /** Immediate children for a path-like `@` query, containment enforced. */
    async fileCompletion(
      scope: FileScope,
      query: string,
    ): Promise<FileEntry[]> {
      const cwd = await completionCwd(scope);
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
      let info: FileStat | undefined;
      let missing: FileAccessError | undefined;
      try {
        info = await authorize(path, {
          sessionId,
          sessionCwd: cwd,
          allowMissing: true,
        });
      } catch (error) {
        // A file deleted together with its folder has no parent left to
        // resolve. Git listing it as deleted in the folder this request
        // already authorized is proof enough to show its diff.
        if (!(error instanceof FileAccessError) || error.status !== 404) {
          throw error;
        }
        missing = error;
      }
      const status = cwd === "" ? null : await deps.git.status(cwd);
      const change = status ? changeFor(status, path) : undefined;
      if (missing && change?.status !== "D") throw missing;
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
        const text = await deps.files.readText(path);
        if (text === undefined) view.binary = true;
        else view.text = text;
      }
      if (change) {
        const diff = await deps.git.diff(cwd, change);
        if (diff !== null) view.diff = diff;
      }
      return view;
    },

    /**
     * Raw bytes for an image, an audio file, a PDF, or a download: the size
     * a Range header is checked against, and the bytes, opened only when a
     * response is actually sent, since each stream holds a file descriptor.
     */
    async fileBytes(
      sessionId: string | undefined,
      path: string,
    ): Promise<{
      size: number;
      open(range?: { start: number; end: number }): ReadableStream<Uint8Array>;
    }> {
      const info = await authorize(path, { sessionId });
      if (info === undefined || !info.isFile) {
        throw new FileAccessError("Not a file", 400);
      }
      return {
        size: info.size,
        open: (range) => deps.files.stream(path, range),
      };
    },

    /**
     * Tells the viewer when the file changed under it. Authorized before the
     * caller opens a stream, so a refusal can still be an error status; the
     * function it returns starts the watch.
     */
    async watchFile(
      sessionId: string | undefined,
      path: string,
    ): Promise<Watch> {
      // A watch survives the file being deleted and written again, so a
      // missing path is not an error here.
      await authorize(path, { sessionId, allowMissing: true });
      return (handlers) => deps.watcher.watch(path, handlers);
    },

    /** The explorer's search box: files of the whole listing, ranked. */
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
      const matches = await deps.files.search(cwd, query, limit, "files");
      return { cwd, status, matches };
    },
  };
}
