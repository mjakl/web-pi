import { COOKIE_MAX_AGE, CWD_COOKIE, SESSION_COOKIE } from "@core/cookies";
import type { ImageAttachment, SkillSelection } from "@core/ports";
import { isSessionId, isSubagentSession } from "@core/sessions";
import { InspectionOnlySession } from "@core/workspace";
import { staticAssets } from "@web/assets";
import { HtmlLayout } from "@web/HtmlLayout";
import { composerRoutes } from "@web/routes/composer";
import { filesRoutes } from "@web/routes/files";
import {
  currentSessionId,
  displayedCwd,
  errorText,
  type RouteContext,
  toastHeader,
  type WebDeps,
} from "@web/routes/shared";
import { shellRoutes } from "@web/routes/shell";
import { sidebarRoutes } from "@web/routes/sidebar";
import { transcriptRoutes } from "@web/routes/transcript";
import { SessionPage } from "@web/views/SessionPage";
import { SessionRow } from "@web/views/Sidebar";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { getCookie, setCookie } from "hono/cookie";

export type { WebDeps };

/**
 * The application: the shared request helpers, then one module per area of the
 * screen. Route order does not matter — Hono matches on the path — so the five
 * modules can be worked on at once without touching each other.
 */
export function createWebApp(deps: WebDeps) {
  const app = new Hono({ strict: false });
  const renderIntervalMs = deps.renderIntervalMs ?? 100;
  const assets = staticAssets(deps.staticRoot);

  const sidebarOf = (selectedId?: string) =>
    deps.workspace.sidebar(selectedId === undefined ? {} : { selectedId });

  function remember(c: Context, name: string, value: string): void {
    if (getCookie(c, name) === value) return;
    setCookie(c, name, value, {
      path: "/",
      sameSite: "Lax",
      maxAge: COOKIE_MAX_AGE,
    });
  }

  /** New-session preference is independent of the displayed session. */
  function newCwd(c: Context): string {
    return c.req.query("cwd") ?? getCookie(c, CWD_COOKIE) ?? deps.defaultCwd;
  }

  /** Contextual controls follow the displayed conversation, not its preference. */
  async function currentCwd(c: Context): Promise<string> {
    const explicit = c.req.query("cwd") ?? displayedCwd(c);
    if (explicit !== undefined) return explicit;
    const id = currentSessionId(c);
    return (
      (id ? await deps.workspace.sessionFolder(id) : undefined) ?? newCwd(c)
    );
  }

  /**
   * A session page with the trust status its top bar shows. Every render of
   * one comes through here: a page drawn without it loses the Restricted
   * mode badge until the next full load. A delegated session has none.
   */
  const sessionPage: RouteContext["sessionPage"] = async (view, props) => {
    const trust = isSubagentSession(view.summary)
      ? undefined
      : await deps.workspace
          .trustStatus(view.summary.cwd)
          .catch(() => undefined);
    return <SessionPage {...props} view={view} trust={trust} />;
  };

  /** The whole session page, swapped into <body> after a history change. */
  async function page(
    c: Context,
    id: string,
    draft?: string,
    images: ImageAttachment[] = [],
    skills?: SkillSelection[],
  ): Promise<Response> {
    const [sidebar, view] = await Promise.all([
      sidebarOf(id),
      deps.workspace.viewSession(id),
    ]);
    if (!view) return c.notFound();
    if (!c.req.header("HX-Request")) {
      remember(c, SESSION_COOKIE, id);
    }
    c.header("HX-Push-Url", `/sessions/${id}`);
    return c.render(
      await sessionPage(view, { sidebar, draft, images, skills }),
    );
  }

  async function row(c: Context, id: string): Promise<Response> {
    const found = await deps.workspace.row(id);
    if (!found) return c.notFound();
    // The open session's row keeps its selected background through a swap.
    const activeId = currentSessionId(c);
    return c.html(<SessionRow {...found} activeId={activeId} />);
  }

  /** Reports the failure as a toast instead of breaking the page. */
  async function guard(
    c: Context,
    action: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      toastHeader(c, errorText(error));
      c.header("HX-Reswap", "none");
      return c.body(null, error instanceof InspectionOnlySession ? 403 : 200);
    }
  }

  // Built assets carry their content hash in ?v=, so the browser may keep
  // them for good; the rest (fonts, icons, versioned vendor files) for a day.
  app.use("/static/*", async (c, next) => {
    await next();
    if (!c.res.ok) return;
    const version = c.req.query("v");
    c.res.headers.set(
      "Cache-Control",
      version !== undefined && version !== "dev"
        ? "public, max-age=31536000, immutable"
        : "public, max-age=86400",
    );
  });
  app.use(
    "/static/*",
    serveStatic({
      root: deps.staticRoot,
      rewriteRequestPath: (p) => p.replace(/^\/static/, ""),
    }),
  );
  app.use(
    "*",
    jsxRenderer(({ children }, c) =>
      c.req.header("HX-Request") === "true" ? (
        <>{children}</>
      ) : (
        <HtmlLayout assets={assets} settings={deps.workspace.webSettings()}>
          {children}
        </HtmlLayout>
      ),
    ),
  );
  // These URLs serve both documents and HTMX fragments. Neither representation
  // may be stored and reused for the other kind of request.
  for (const path of ["/", "/new", "/sessions/:id", "/settings"]) {
    app.get(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
  }
  // An id Pi could not have written names no session, so nothing under it
  // exists; the pattern covers the session page itself as well.
  app.use("/sessions/:id/*", async (c, next) => {
    if (!isSessionId(c.req.param("id"))) return c.notFound();
    await next();
    return c.res;
  });

  const context: RouteContext = {
    deps,
    assets,
    renderIntervalMs,
    sidebarOf,
    remember,
    newCwd,
    currentCwd,
    sessionPage,
    page,
    row,
    guard,
  };
  shellRoutes(app, context);
  sidebarRoutes(app, context);
  transcriptRoutes(app, context);
  composerRoutes(app, context);
  filesRoutes(app, context);

  return app;
}
