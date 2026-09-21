// Transcript pages and fragments: paging, entry sub-resources, stars,
// branching, and the export. The transcript area owns this module.

import { isSessionId, isSubagentSession } from "@core/sessions";
import { InspectionOnlySession } from "@core/workspace";
import { renderMarkdown } from "@web/markdown";
import { EarlierPage, StarButton, ToolBody } from "@web/views/Items";
import { SessionRow } from "@web/views/Sidebar";
import { Partial } from "@web/views/Partial";
import { Rail } from "@web/views/Rail";
import { SavedMessages } from "@web/views/Transcript";
import { turnBusy } from "@web/views/Status";
import type { Context } from "hono";
import { raw } from "hono/html";
import {
  type RouteContext,
  type WebApp,
  currentSessionId,
  errorText,
  field,
} from "./shared.ts";

export function transcriptRoutes(app: WebApp, ctx: RouteContext): void {
  const { deps, page, guard } = ctx;

  for (const action of ["export", "star", "fork", "navigate", "rewind"]) {
    app.use(`/sessions/:id/${action}`, async (c: Context, next) => {
      const id = c.req.param("id");
      if (!id || !isSessionId(id)) return c.notFound();
      return guard(c, async () => {
        await deps.workspace.requireWritableSession(id);
        await next();
        return c.res;
      });
    });
  }

  app.get("/sessions/:id/last-assistant-text", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    c.header("Cache-Control", "no-store");
    return c.text((await deps.workspace.lastAssistantText(id)) ?? "");
  });

  app.get("/sessions/:id/export", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    try {
      const exported = await deps.workspace.exportHtml(id);
      return c.body(exported.html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `inline; filename="${exported.filename}"`,
        "Cache-Control": "no-cache",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
    } catch (error) {
      if (error instanceof InspectionOnlySession)
        return c.text(error.message, 403);
      return c.text(errorText(error), 500);
    }
  });

  /** Observe only the opened saved file; never attach a runtime or enrich models. */
  app.get("/sessions/:id/saved", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    c.header("Cache-Control", "no-store");
    const revision = c.req.query("revision");
    if (revision === undefined) return c.text("revision is required", 400);
    const contentLeaf = c.req.query("contentLeaf");
    if (contentLeaf === undefined)
      return c.text("contentLeaf is required", 400);
    const through = c.req.query("through");
    const leaf = c.req.query("leaf");
    const update = await deps.workspace.observeSavedSession(id, {
      revision,
      leaf: leaf === undefined || leaf === "" ? null : leaf,
      contentLeaf: contentLeaf === "" ? null : contentLeaf,
      ...(through === undefined ? {} : { through }),
    });
    c.header("X-Web-Pi-Saved", update.kind);
    if (update.kind !== "changed") {
      if (update.kind === "unavailable" && update.revision !== undefined)
        c.header("X-Web-Pi-Revision", encodeURIComponent(update.revision));
      return c.body(null, 204);
    }
    const observation = update.view.savedObservation;
    if (observation) {
      c.header("X-Web-Pi-Revision", encodeURIComponent(observation.revision));
      c.header("X-Web-Pi-Leaf", encodeURIComponent(observation.leaf ?? ""));
      c.header(
        "X-Web-Pi-Content-Leaf",
        encodeURIComponent(observation.contentLeaf ?? ""),
      );
    }
    return c.html(
      <>
        <Partial target="#messages" swap="innerMorph">
          <SavedMessages view={update.view} />
        </Partial>
        <Rail view={update.view} oob />
      </>,
    );
  });

  /** The previous page of a long transcript, with its own sentinel on top. */
  app.get("/sessions/:id/earlier", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const leaf = c.req.query("leaf");
    const before = c.req.query("before");
    const through = c.req.query("through");
    if (before === undefined) return c.text("before is required", 400);
    let view;
    try {
      view = await deps.workspace.viewSession(id, {
        before,
        ...(leaf === undefined ? {} : { leaf }),
        ...(through === undefined ? {} : { through }),
      });
    } catch {
      return c.text("Unknown entry for this branch", 400);
    }
    if (!view) return c.notFound();
    return c.html(
      <EarlierPage
        items={view.items}
        actions={{
          sessionId: id,
          cwd: view.summary.cwd,
          starred: view.starred,
          ...(isSubagentSession(view.summary) ? { inspectionOnly: true } : {}),
          ...(view.otherBranch || isSubagentSession(view.summary)
            ? { readOnly: true }
            : {}),
          ...(turnBusy(view.status) ? { busy: true } : {}),
        }}
        hasMore={view.hasMore}
        {...(view.oldestId === undefined ? {} : { oldestId: view.oldestId })}
        {...(view.leaf === undefined ? {} : { leaf: view.leaf })}
      />,
    );
  });

  /** One thinking block, for the ones a long page left out. */
  app.get("/sessions/:id/entries/:entryId/thinking/:index", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return c.notFound();
    const thinking = await deps.workspace.entryThinking(
      id,
      c.req.param("entryId"),
      index,
    );
    if (thinking === undefined) {
      return c.html(<p>Thinking content unavailable</p>);
    }
    // No cwd here: reading the session again to resolve relative file links
    // would cost a full pass over the file for one collapsed block.
    return c.html(
      <div class="markdown-body markdown-assistant-message">
        {raw(renderMarkdown(thinking))}
      </div>,
    );
  });

  app.get("/sessions/:id/entries/:entryId/image/:index", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const index = Number(c.req.param("index"));
    if (!Number.isInteger(index) || index < 0) return c.notFound();
    const image = await deps.workspace.entryImage(
      id,
      c.req.param("entryId"),
      index,
    );
    if (!image) return c.notFound();
    return c.body(Buffer.from(image.data, "base64"), 200, {
      "Content-Type": image.mimeType,
      "Cache-Control": "private, max-age=3600",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.post("/sessions/:id/star", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const form = await c.req.formData();
    const entryId = field(form, "entryId");
    const starred = field(form, "starred") === "true";
    return guard(c, async () => {
      const targetId = await deps.workspace.setStar(id, entryId, starred);
      const [view, found] = await Promise.all([
        deps.workspace.viewSession(id),
        deps.workspace.row(id),
      ]);
      if (!view) return c.notFound();
      return c.html(
        <>
          <StarButton
            entryId={targetId}
            actions={{
              sessionId: id,
              cwd: view.summary.cwd,
              starred: view.starred,
            }}
          />
          {found ? (
            <SessionRow {...found} activeId={currentSessionId(c) ?? ""} oob />
          ) : null}
        </>,
      );
    });
  });

  app.post("/sessions/:id/fork", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const form = await c.req.formData();
    return guard(c, async () => {
      const forked = await deps.workspace.fork(id, field(form, "entryId"));
      return page(c, forked.id, forked.text, forked.images);
    });
  });

  // Both "New branch" on a message and switching to another branch: Pi moves
  // the leaf and hands back the text of a user message to edit again.
  app.post("/sessions/:id/navigate", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const form = await c.req.formData();
    return guard(c, async () => {
      const draft = await deps.workspace.navigateTree(
        id,
        field(form, "entryId"),
      );
      return page(c, id, draft);
    });
  });

  app.post("/sessions/:id/rewind", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const form = await c.req.formData();
    return guard(c, async () => {
      const draft = await deps.workspace.rewind(id, field(form, "entryId"));
      return page(c, id, draft.text, draft.images);
    });
  });

  /** The full body behind a truncated tool result. */
  app.get("/sessions/:id/entries/:entryId/tool-result/:callId", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const call = await deps.workspace.toolCall(
      id,
      c.req.param("entryId"),
      c.req.param("callId"),
    );
    if (!call) return c.notFound();
    const cwd = await deps.workspace.sessionFolder(id);
    return c.html(
      <ToolBody
        call={call}
        actions={{ sessionId: id, cwd: cwd ?? "", starred: new Set() }}
        {...(c.req.query("full") === "1" ? { full: true } : {})}
      />,
    );
  });
}
