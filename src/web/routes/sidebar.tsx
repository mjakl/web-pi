// The global session list, directory choices and shared lifecycle stream.
import { FileAccessError } from "@core/path-access";
import { type RuntimeEvent } from "@core/ports";
import { isSessionId } from "@core/sessions";
import {
  SessionNav,
  ProjectPicker,
  RenameRow,
  SessionList,
  SessionRows,
} from "@web/views/Sidebar";
import { BrowsePane, DirectoryPicker } from "@web/views/Workspace";
import { streamSSE } from "hono/streaming";
import {
  type RouteContext,
  type WebApp,
  CWD_COOKIE,
  currentSessionId,
  errorText,
  field,
  html,
  hxTrigger,
  sessionLocation,
  toastHeader,
} from "./shared.ts";

export function sidebarRoutes(app: WebApp, ctx: RouteContext): void {
  const { deps, sidebarOf, remember, currentCwd, newCwd, row, guard } = ctx;

  app.get("/sidebar", async (c) => {
    // Bookmarked folder-selection URLs still open that folder's blank
    // composer. A project key alone is no longer a filter or a selection.
    const cwd = c.req.query("cwd");
    if (cwd) return c.redirect(`/new?cwd=${encodeURIComponent(cwd)}`);
    const activeId = currentSessionId(c);
    const view = await deps.workspace.sidebar(
      activeId === undefined ? {} : { selectedId: activeId },
    );
    return c.html(<SessionNav view={view} activeId={activeId} />);
  });

  /** Session-derived options, without reading any transcript metadata. */
  app.get("/sidebar/projects", async (c) =>
    c.html(
      <ProjectPicker
        projects={await deps.workspace.projects()}
        cwd={await currentCwd(c)}
        {...(deps.home === undefined ? {} : { home: deps.home })}
      />,
    ),
  );

  app.get("/sidebar/rows", async (c) => {
    const offset = Number(c.req.query("after") ?? "0");
    if (!Number.isInteger(offset) || offset < 0) return c.notFound();
    const parentId = c.req.query("parent");
    if (parentId !== undefined && !isSessionId(parentId)) return c.notFound();
    const activeId = currentSessionId(c);
    const view = await deps.workspace.sidebar({
      offset,
      ...(parentId === undefined ? {} : { parentId }),
      ...(activeId === undefined ? {} : { selectedId: activeId }),
    });
    return c.html(
      <SessionRows
        view={view}
        {...(activeId === undefined ? {} : { activeId })}
      />,
    );
  });

  app.get("/sessions/:id/row", async (c) => {
    const id = c.req.param("id");
    return isSessionId(id) ? row(c, id) : c.notFound();
  });

  for (const [path, act] of [
    ["stop", (id: string) => deps.workspace.stop(id)],
    ["activate", (id: string) => deps.workspace.activate(id)],
    ["stars/clear", (id: string) => deps.workspace.clearStars(id)],
  ] as const) {
    app.post(`/sessions/:id/${path}`, async (c) => {
      const id = c.req.param("id");
      if (!isSessionId(id)) return c.notFound();
      return guard(c, async () => {
        await act(id);
        return row(c, id);
      });
    });
  }

  app.get("/sessions/:id/rename", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return guard(c, async () => {
      await deps.workspace.requireWritableSession(id);
      const found = await deps.workspace.row(id);
      return found ? c.html(<RenameRow {...found} />) : c.notFound();
    });
  });

  app.post("/sessions/:id/rename", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const form = await c.req.formData();
    return guard(c, async () => {
      await deps.workspace.rename(id, field(form, "name"));
      return row(c, id);
    });
  });

  app.post("/sessions/:id/delete", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return guard(c, async () => {
      await deps.workspace.remove(id);
      const activeId = currentSessionId(c);
      if (activeId === id) {
        if (c.req.header("HX-Request") === "true") {
          sessionLocation(c, `/new?cwd=${encodeURIComponent(newCwd(c))}`);
          // HX-Location skips the response body. Refresh the surviving tree too.
          hxTrigger(c, { "web-pi:sidebar-refresh": {} });
        } else c.header("HX-Redirect", "/new");
        return c.body(null, 200);
      }
      const view = await deps.workspace.sidebar(
        activeId === undefined ? {} : { selectedId: activeId },
      );
      return c.html(
        <SessionList
          view={view}
          {...(activeId === undefined ? {} : { activeId })}
          partial
        />,
      );
    });
  });

  app.post("/sessions/:id/clone", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return guard(c, async () => {
      const cloned = await deps.workspace.clone(id);
      sessionLocation(c, `/sessions/${cloned}`);
      return c.body(null, 200);
    });
  });

  app.get("/workspaces/picker", async (c) => {
    const browse = await deps.workspace
      .browse(await currentCwd(c))
      .catch(() => deps.workspace.browse());
    return c.html(<DirectoryPicker {...browse} />);
  });

  // Browsing exposes names only. Validation, not browsing, grants file access.
  app.get("/workspaces/browse", async (c) => {
    const path = c.req.query("path");
    try {
      const listing = await deps.workspace.browse(
        !path?.trim() ? undefined : path,
      );
      return await c.html(<BrowsePane {...listing} />);
    } catch (error) {
      const listing = await deps.workspace.browse();
      return c.html(<BrowsePane {...listing} error={errorText(error)} />);
    }
  });

  app.post("/workspaces/validate", async (c) => {
    const form = await c.req.formData();
    try {
      const chosen = await deps.workspace.validateFolder(field(form, "cwd"));
      if (c.req.header("HX-Request") !== "true") {
        remember(c, CWD_COOKIE, chosen.cwd);
        return c.json({ ...chosen, projectKey: chosen.projectRoot });
      }
      // Only a winning region navigation commits the browser preference.
      sessionLocation(c, `/new?cwd=${encodeURIComponent(chosen.cwd)}`);
      return c.body(null, 200);
    } catch (error) {
      if (c.req.header("HX-Request") === "true") {
        toastHeader(c, errorText(error));
        c.header("HX-Reswap", "none");
        return c.body(null, 200);
      }
      if (error instanceof FileAccessError)
        return c.json({ error: error.message }, error.status);
      return c.json({ error: "Cannot use that folder" }, 400);
    }
  });

  /**
   * Lifecycle changes can change ordering across every directory. A finished
   * turn also marks its row unread; a completed run, by the run-completion
   * rule, is what rings another tab's tone, and changes nothing in the list.
   */
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (task: () => Promise<void>) => {
        queue = queue.then(task).catch(() => {
          // A closed stream ends rendering; the abort handler cleans up.
        });
      };
      // A render that has not started yet reads the store after every event
      // queued before it, so a burst of events costs one scan of the store.
      let listWaiting = false;
      const send = (event: RuntimeEvent) => {
        if (event.type !== "completed" && !listWaiting) {
          listWaiting = true;
          enqueue(async () => {
            listWaiting = false;
            await stream.writeSSE({
              data: await html(
                <SessionList view={await sidebarOf()} partial />,
              ),
            });
          });
        }
        if (event.type === "finished" || event.type === "completed") {
          enqueue(() =>
            stream.writeSSE({
              event: event.type,
              data: JSON.stringify({ id: event.sessionId }),
            }),
          );
        }
      };
      const unsubscribe = deps.workspace.subscribeSessions(send);
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      await new Promise<void>((resolve) => {
        heartbeat = setInterval(() => {
          queue = queue
            .then(async () => {
              await stream.write(": ping\n\n");
            })
            .catch(() => {
              resolve();
            });
        }, 30_000);
        stream.onAbort(() => {
          resolve();
        });
      });
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    }),
  );
}
