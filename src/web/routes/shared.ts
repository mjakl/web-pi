// What every route module needs: the dependencies and the few request helpers
// that answer in more than one area. Each area's routes live in its own module
// beside this one; createWebApp in src/web/app.tsx builds the context and
// composes them.

import { imageLimitError } from "@core/composer";
import { SESSION_COOKIE } from "@core/cookies";
import { baseName } from "@core/file-types";
import { FileAccessError } from "@core/path-access";
import type { ImageAttachment, SkillSelection } from "@core/ports";
import { skillSelections } from "@core/skill-prompt";
import { isSessionId } from "@core/sessions";
import type { SessionView, SidebarView, Workspace } from "@core/workspace";
import type { StaticAssets } from "@web/assets";
import type { SessionPage } from "@web/views/SessionPage";
import type { Context, Env, Hono } from "hono";
import { getCookie } from "hono/cookie";

export type WebApp = Hono;

export type WebDeps = {
  workspace: Workspace;
  /** Directory served under /static. */
  staticRoot: string;
  /** Suggested working folder for new sessions. */
  defaultCwd: string;
  /** The reader's home folder, for shortening paths on screen. */
  home?: string;
  /** Streaming re-render interval. */
  renderIntervalMs?: number;
};

/**
 * The request helpers that are the same in every area: which project the
 * sidebar shows, which folder is current, how a failure becomes a toast, and
 * how a whole page or a single row is re-rendered.
 */
export type RouteContext = {
  deps: WebDeps;
  assets: StaticAssets;
  renderIntervalMs: number;
  sidebarOf: (selectedId?: string) => Promise<SidebarView>;
  remember: (c: Context, name: string, value: string) => void;
  newCwd: (c: Context) => string;
  currentCwd: (c: Context) => Promise<string>;
  /** A session page, with the trust status its top bar shows. */
  sessionPage: (
    view: SessionView,
    props: Omit<Parameters<typeof SessionPage>[0], "view" | "trust">,
  ) => Promise<ReturnType<typeof SessionPage>>;
  page: (
    c: Context,
    id: string,
    draft?: string,
    images?: ImageAttachment[],
    skills?: SkillSelection[],
  ) => Promise<Response>;
  row: (c: Context, id: string) => Promise<Response>;
  guard: (c: Context, action: () => Promise<Response>) => Promise<Response>;
};

/**
 * Refuses an inspection-only session before any of these actions runs, with
 * the one 403 and toast `guard` gives it. Some handlers, such as the model
 * selector, have no other check.
 */
export function requireWritable(
  app: WebApp,
  { deps, guard }: RouteContext,
  actions: readonly string[],
): void {
  for (const action of actions) {
    app.use(
      `/sessions/:id/${action}`,
      (c: Context<Env, `/sessions/:id/${string}`>, next) =>
        guard(c, async () => {
          await deps.workspace.requireWritableSession(c.req.param("id"));
          await next();
          return c.res;
        }),
    );
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function html(node: {
  toString(): string | Promise<string>;
}): Promise<string> {
  return Promise.resolve(node.toString());
}

/** Navigate without discarding the surrounding shell or in-memory drafts. */
export function sessionLocation(c: Context, path: string): void {
  c.header(
    "HX-Location",
    JSON.stringify({
      path,
      source: "#session-region",
      target: "#session-region",
      swap: "outerHTML",
    }),
  );
}

/**
 * The folder the page shows. The browser percent-encodes it, because a header
 * cannot carry characters above U+00FF; a tab loaded before that sends the
 * path itself, which is used as it is when it does not decode.
 */
export function displayedCwd(c: Context): string | undefined {
  const value = c.req.header("X-Web-Pi-Cwd");
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The session the page shows. Every htmx request names it in a header,
 * including none open; a full page load has only its referrer and cookie.
 */
export function currentSessionId(c: Context): string | undefined {
  const displayed = c.req.header("X-Web-Pi-Session");
  if (displayed !== undefined)
    return isSessionId(displayed) ? displayed : undefined;
  const url = c.req.header("Referer") ?? "";
  const id = /\/sessions\/([^/?#]+)/.exec(url)?.[1];
  if (id !== undefined && isSessionId(id)) return id;
  // Typed, bookmarked or opened in a new tab: no referrer names the session,
  // so the last one opened does. `/` and `/new` clear it, which is what
  // closing the session means here.
  const remembered = getCookie(c, SESSION_COOKIE);
  return remembered !== undefined && isSessionId(remembered)
    ? remembered
    : undefined;
}

/** A text field without surrounding whitespace; a missing one is empty. */
export function field(form: FormData, name: string): string {
  return rawField(form, name).trim();
}

/** The field as it was sent: whitespace is content in an editor dialog. */
export function rawField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Adds events to the response's HX-Trigger header, beside any set already.
 * A header cannot carry characters above U+00FF, and the action has run by
 * the time it is written, so everything outside ASCII is escaped as `\uXXXX`;
 * htmx reads the header with JSON.parse, which restores the text.
 */
export function hxTrigger(c: Context, events: Record<string, unknown>): void {
  const set = c.res.headers.get("HX-Trigger");
  const merged = {
    ...(set ? (JSON.parse(set) as Record<string, unknown>) : {}),
    ...events,
  };
  c.header(
    "HX-Trigger",
    JSON.stringify(merged).replaceAll(
      /[^\x20-\x7E]/g,
      // UTF-16 code units, so an emoji becomes its escaped surrogate pair.
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
}

/** Errors reach the reader as a toast, wherever the request came from. */
export function toastHeader(
  c: Context,
  message: string,
  level: "info" | "warning" | "error" = "error",
): void {
  hxTrigger(c, { "web-pi:toast": { level, message } });
}

export type Submission = {
  text: string;
  images: ImageAttachment[];
  skills: SkillSelection[];
  behavior: "steer" | "followUp";
};

/** The composer's multipart body: text, attachments, and how to deliver it. */
export async function readSubmission(
  form: FormData,
): Promise<Submission | { error: string }> {
  const selection = rawField(form, "skills");
  const skills = selection ? skillSelections(selection) : [];
  if (!skills) {
    return {
      error: "Invalid skill selection. Reload the Skills menu and try again.",
    };
  }
  const files = form
    .getAll("images[]")
    .filter((value): value is File => value instanceof File && value.size > 0);
  const limit = imageLimitError(
    files.map((file) => ({ mimeType: file.type, bytes: file.size })),
  );
  if (limit) return { error: limit };
  const images = await Promise.all(
    files.map(async (file) => ({
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      mimeType: file.type,
    })),
  );
  return {
    // Multipart uses CRLF; textareas expose LF. Keep the original editor text.
    text:
      skills.length > 0
        ? rawField(form, "text").replaceAll("\r\n", "\n")
        : field(form, "text"),
    images,
    skills,
    behavior: field(form, "behavior") === "followUp" ? "followUp" : "steer",
  };
}

/** A file request that failed, answered with the status the error carries. */
export function fileFailure(c: Context, error: unknown): Response {
  if (error instanceof FileAccessError) {
    return c.text(error.message, error.status);
  }
  return c.text("Cannot read that file", 500);
}

/** A file name safe in a header, plus the encoded form for everyone else. */
export function disposition(path: string, attachment: boolean): string {
  const name = baseName(path);
  const ascii = name.replaceAll(/[^\x20-\x7E]/g, "_").replaceAll('"', "");
  const kind = attachment ? "attachment" : "inline";
  return `${kind}; filename="${ascii === "" ? "download" : ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
