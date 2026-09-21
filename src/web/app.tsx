import type { ImageAttachment } from "@core/ports";
import { InspectionOnlySession } from "@core/workspace";
import { staticAssets } from "@web/assets";
import { honoFactory } from "@web/hono";
import { HtmlLayout } from "@web/HtmlLayout";
import { composerRoutes } from "@web/routes/composer";
import { filesRoutes } from "@web/routes/files";
import {
  currentSessionId,
  CWD_COOKIE,
  errorText,
  type RouteContext,
  SESSION_COOKIE,
  toastHeader,
  type WebDeps,
  YEAR,
} from "@web/routes/shared";
import { shellRoutes } from "@web/routes/shell";
import { sidebarRoutes } from "@web/routes/sidebar";
import { transcriptRoutes } from "@web/routes/transcript";
import { SessionPage } from "@web/views/SessionPage";
import { SessionRow } from "@web/views/Sidebar";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import { getCookie, setCookie } from "hono/cookie";

export type { WebDeps };

/**
 * The application: the shared request helpers, then one module per area of the
 * screen. Route order does not matter — Hono matches on the path — so the five
 * modules can be worked on at once without touching each other.
 */
export function createWebApp(deps: WebDeps) {
  const app = honoFactory.createApp();
  const renderIntervalMs = deps.renderIntervalMs ?? 100;
  const assets = staticAssets(deps.staticRoot);

  const sidebarOf = (selectedId?: string) =>
    deps.workspace.sidebar(selectedId === undefined ? {} : { selectedId });

  function remember(c: Context, name: string, value: string): void {
    if (getCookie(c, name) === value) return;
    setCookie(c, name, value, {
      path: "/",
      sameSite: "Lax",
      maxAge: YEAR,
    });
  }

  /** New-session preference is independent of the displayed session. */
  function newCwd(c: Context): string {
    return c.req.query("cwd") ?? getCookie(c, CWD_COOKIE) ?? deps.defaultCwd;
  }

  /** Contextual controls follow the displayed conversation, not its preference. */
  async function currentCwd(c: Context): Promise<string> {
    const explicit = c.req.query("cwd") ?? c.req.header("X-Web-Pi-Cwd");
    if (explicit !== undefined) return explicit;
    const id = currentSessionId(c);
    return (
      (id ? await deps.workspace.sessionFolder(id) : undefined) ?? newCwd(c)
    );
  }

  function warnTokens(): { warnTokens: number } {
    return { warnTokens: deps.workspace.webSettings().warnTokens };
  }

  /** The whole session page, swapped into <body> after a history change. */
  async function page(
    c: Context,
    id: string,
    draft?: string,
    images: ImageAttachment[] = [],
  ): Promise<Response> {
    const [sidebar, view] = await Promise.all([
      sidebarOf(id),
      deps.workspace.viewSession(id, warnTokens()),
    ]);
    if (!view) return c.notFound();
    if (!c.req.header("HX-Request")) {
      remember(c, SESSION_COOKIE, id);
    }
    c.header("HX-Push-Url", `/sessions/${id}`);
    return c.render(
      <SessionPage
        sidebar={sidebar}
        view={view}
        draft={draft}
        images={images}
        {...(deps.home === undefined ? {} : { home: deps.home })}
      />,
    );
  }

  async function row(c: Context, id: string): Promise<Response> {
    const found = await deps.workspace.row(id);
    if (!found) return c.notFound();
    // The open session's row keeps its selected background through a swap.
    // The page says which that is when its own URL cannot: settings opens
    // over a session without becoming one.
    const activeId =
      c.req.header("X-Web-Pi-Session") === undefined
        ? (c.req.query("active") ?? currentSessionId(c))
        : currentSessionId(c);
    return c.html(
      <SessionRow
        {...found}
        {...(activeId === undefined ? {} : { activeId })}
      />,
    );
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

  app.use("*", (c, next) => {
    c.set("workspace", deps.workspace);
    c.set("assets", assets);
    return next();
  });
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
  app.use("*", jsxRenderer(HtmlLayout));

  const context: RouteContext = {
    deps,
    assets,
    renderIntervalMs,
    sidebarOf,
    remember,
    newCwd,
    currentCwd,
    warnTokens,
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
