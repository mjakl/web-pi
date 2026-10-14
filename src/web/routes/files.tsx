// The file explorer, the viewer, the watch stream, and Git changes. The
// files area owns this module.

import { mimeOf } from "@core/file-types";
import { FileAccessError } from "@core/path-access";
import { type GitStatus } from "@core/ports";
import { isSessionId } from "@core/sessions";
import { type FileScope } from "@core/workspace";
import {
  Explorer,
  ExplorerError,
  SearchResults,
  type TreeContext,
  TreeNodes,
  type ViewMode,
  Viewer,
  defaultMode,
} from "@web/views/Files";
import { type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type RouteContext,
  type WebApp,
  disposition,
  fileFailure,
} from "./shared.ts";

export function filesRoutes(app: WebApp, ctx: RouteContext): void {
  const { deps } = ctx;

  // --- Files, Git, and the viewer ----------------------------------------
  //
  // Every route here goes through the workspace's one containment policy and
  // maps `FileAccessError` onto the status it carries. `session` is optional:
  // it names the folder the panel is rooted in, and it is what lets a file a
  // transcript mentioned be read from outside the allowed roots.

  function sessionParameter(c: Context): string | undefined {
    const id = c.req.query("session");
    return id !== undefined && isSessionId(id) ? id : undefined;
  }

  /**
   * Which folder this request is about: the open session's, or the one the
   * page named. pi-web's explorer works from a picked folder before any
   * session exists, and so does this one.
   */
  function scopeParameter(c: Context): FileScope {
    const sessionId = sessionParameter(c);
    if (sessionId !== undefined) return { sessionId };
    const cwd = c.req.query("cwd") ?? "";
    return cwd === "" ? {} : { cwd };
  }

  function treeContext(
    scope: FileScope,
    found: { cwd: string; status: GitStatus },
  ): TreeContext {
    return {
      ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
      cwd: found.cwd,
      changes: new Map(found.status.files.map((file) => [file.path, file])),
    };
  }

  app.get("/files/explorer", async (c) => {
    const scope = scopeParameter(c);
    try {
      const found = await deps.workspace.fileTree(scope, {
        changes: c.req.query("changes") === "1",
      });
      if (!found) return await c.notFound();
      return await c.html(
        <Explorer
          context={treeContext(scope, found)}
          status={found.status}
          entries={found.entries}
          changes={found.changes}
        />,
      );
    } catch (error) {
      // The explorer is a fragment htmx swaps in, and it swaps nothing on an
      // error status, so the reason has to arrive as content.
      if (error instanceof FileAccessError) {
        return await c.html(<ExplorerError message={error.message} />);
      }
      return fileFailure(c, error);
    }
  });

  app.get("/files/tree", async (c) => {
    const scope = scopeParameter(c);
    const path = c.req.query("path") ?? "";
    const depth = Number(c.req.query("depth") ?? "1");
    if (!Number.isInteger(depth) || depth < 0) return c.notFound();
    try {
      const found = await deps.workspace.fileTree(scope, { path });
      if (!found) return await c.notFound();
      return await c.html(
        <TreeNodes
          context={treeContext(scope, found)}
          directory={path}
          entries={found.entries}
          depth={depth}
        />,
      );
    } catch (error) {
      return fileFailure(c, error);
    }
  });

  /** An empty query puts the tree back; that is what closing search means. */
  app.get("/files/search", async (c) => {
    const scope = scopeParameter(c);
    const query = (c.req.query("q") ?? "").slice(0, 500).trim();
    try {
      if (query === "") {
        const found = await deps.workspace.fileTree(scope);
        if (!found) return await c.notFound();
        return await c.html(
          <Explorer
            context={treeContext(scope, found)}
            status={found.status}
            entries={found.entries}
            changes={false}
          />,
        );
      }
      const found = await deps.workspace.searchFiles(scope, query);
      if (!found) return await c.notFound();
      return await c.html(
        <SearchResults
          context={treeContext(scope, found)}
          matches={found.matches.map((entry) => entry.path)}
        />,
      );
    } catch (error) {
      return fileFailure(c, error);
    }
  });

  app.get("/files/view", async (c) => {
    const scope = scopeParameter(c);
    const path = c.req.query("path") ?? "";
    try {
      const view = await deps.workspace.fileView(scope, path);
      const asked = c.req.query("mode");
      const mode: ViewMode =
        asked === "source" || asked === "preview" || asked === "diff"
          ? asked
          : defaultMode(view, c.req.query("hint"));
      // A mode the file does not offer falls back rather than showing an
      // empty pane: a diff can disappear between two requests.
      const shown: ViewMode =
        mode === "diff" && view.diff === undefined ? "source" : mode;
      return await c.html(
        <Viewer view={view} mode={shown} sessionId={scope.sessionId ?? ""} />,
      );
    } catch (error) {
      return fileFailure(c, error);
    }
  });

  const RANGE = /^bytes=(\d*)-(\d*)$/;

  app.get("/files/raw", async (c) => {
    const sessionId = sessionParameter(c);
    const path = c.req.query("path") ?? "";
    const download = c.req.query("download") === "1";
    try {
      const header = c.req.header("Range");
      const file = await deps.workspace.fileBytes(sessionId, path);
      const { size } = file;
      const mime = download ? "application/octet-stream" : mimeOf(path);
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": disposition(path, download),
      };
      // An SVG opened directly would run its own script in this origin.
      if (mime === "image/svg+xml") {
        headers["Content-Security-Policy"] =
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
      }
      if (header === undefined) {
        return c.body(file.open(), 200, {
          ...headers,
          "Content-Length": String(size),
        });
      }
      const match = RANGE.exec(header);
      const unsatisfiable = () =>
        c.body(null, 416, {
          ...headers,
          "Content-Range": `bytes */${String(size)}`,
        });
      if (!match) return unsatisfiable();
      const [, first = "", last = ""] = match;
      let start: number;
      let end: number;
      if (first === "") {
        // Suffix form: the last N bytes.
        const length = Number(last);
        if (last === "" || !Number.isFinite(length) || length <= 0) {
          return unsatisfiable();
        }
        start = Math.max(0, size - length);
        end = size - 1;
      } else {
        start = Number(first);
        end = last === "" ? size - 1 : Number(last);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return unsatisfiable();
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return unsatisfiable();
      return c.body(file.open({ start, end }), 206, {
        ...headers,
        "Content-Range": `bytes ${String(start)}-${String(end)}/${String(size)}`,
        "Content-Length": String(end - start + 1),
      });
    } catch (error) {
      return fileFailure(c, error);
    }
  });

  /** One stream per open tab: the viewer re-reads whenever the file moves. */
  app.get("/files/watch", async (c) => {
    const path = c.req.query("path") ?? "";
    let start: Awaited<ReturnType<typeof deps.workspace.watchFile>>;
    try {
      // Refused before the stream opens: EventSource reconnects to a stream
      // that ends, but never retries an error status.
      start = await deps.workspace.watchFile(sessionParameter(c), path);
    } catch (error) {
      return fileFailure(c, error);
    }
    return streamSSE(c, async (stream) => {
      const ended = Promise.withResolvers<undefined>();
      stream.onAbort(() => {
        ended.resolve(undefined);
      });
      let queue: Promise<void> = Promise.resolve();
      const send = (event: string, data: string) => {
        queue = queue
          .then(async () => {
            await stream.writeSSE({ event, data });
          })
          .catch(() => {
            // A closed stream ends the watch; the abort handler cleans up.
          });
      };
      let failed = false;
      const stop = start({
        change(info) {
          send("change", JSON.stringify(info));
        },
        // Not `error`: EventSource fires that itself while it reconnects.
        error() {
          failed = true;
          send(
            "watch-error",
            JSON.stringify({ message: "Failed to watch file" }),
          );
          ended.resolve(undefined);
        },
      });
      if (!failed) send("connected", JSON.stringify({ path }));
      await ended.promise;
      stop();
      await queue;
    });
  });
}
