// What every route module needs: the dependencies, the few request helpers
// that answer in more than one area, and the cookie names the server keeps its
// own state in. Each area's routes live in its own module beside this one;
// createWebApp in src/web/app.tsx builds the context and composes them.

import { imageLimitError } from "@core/composer";
import { FileAccessError } from "@core/path-access";
import type { ImageAttachment } from "@core/ports";
import { isSessionId } from "@core/sessions";
import type { SidebarView, Workspace } from "@core/workspace";
import type { StaticAssets } from "@web/assets";
import type { honoFactory } from "@web/hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";

export type WebApp = ReturnType<typeof honoFactory.createApp>;

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
  warnTokens: (c: Context) => { warnTokens: number };
  page: (
    c: Context,
    id: string,
    draft?: string,
    images?: ImageAttachment[],
  ) => Promise<Response>;
  row: (c: Context, id: string) => Promise<Response>;
  guard: (c: Context, action: () => Promise<Response>) => Promise<Response>;
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function html(node: {
  toString(): string | Promise<string>;
}): Promise<string> {
  return Promise.resolve(node.toString());
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** The working folder the picker last committed: where `/new` starts. */
export const CWD_COOKIE = "web-pi-cwd";

/**
 * The session the reader has open. pi-web keeps settings and the top-bar
 * panels over the workspace it was opened from, which a page reached by its
 * own URL cannot tell from the referrer alone.
 */
export const SESSION_COOKIE = "web-pi-session";

/** Which settings section was open last. */
export const SETTINGS_COOKIE = "web-pi-settings";

/** The skill last opened, and the folder it belongs to. */
export const SKILL_COOKIE = "web-pi-skill";

export const YEAR = 60 * 60 * 24 * 365;

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

/** An explicit displayed identity wins, including no open session. */
export function currentSessionId(c: Context): string | undefined {
  const displayed = c.req.header("X-Web-Pi-Session");
  if (displayed !== undefined)
    return isSessionId(displayed) ? displayed : undefined;
  const url = c.req.header("HX-Current-URL") ?? c.req.header("Referer") ?? "";
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

/** Only an https endpoint with both keys can receive an encrypted payload. */
export function field(form: FormData, name: string): string {
  return rawField(form, name).trim();
}

/** The field as it was sent: whitespace is content in an editor dialog. */
export function rawField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Errors reach the reader as a toast, wherever the request came from. */
export function toastHeader(
  c: Context,
  message: string,
  level: "info" | "warning" | "error" = "error",
): void {
  c.header(
    "HX-Trigger",
    JSON.stringify({ "web-pi:toast": { level, message } }),
  );
}

export type Submission = {
  text: string;
  images: ImageAttachment[];
  behavior: "steer" | "followUp";
};

/** The composer's multipart body: text, attachments, and how to deliver it. */
export async function readSubmission(
  form: FormData,
): Promise<Submission | { error: string }> {
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
    text: field(form, "text"),
    images,
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
  const name = path.split(/[\\/]/).pop() ?? "download";
  const ascii = name.replaceAll(/[^\x20-\x7E]/g, "_").replaceAll('"', "");
  const kind = attachment ? "attachment" : "inline";
  return `${kind}; filename="${ascii === "" ? "download" : ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
