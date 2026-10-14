import type { Htmx, HtmxRequestCtx } from "htmx.org";
import { requestContext } from "./htmx.ts";
import { setUpRegion } from "./lifecycle.ts";
import { closeMobileSidebar } from "./shell.ts";
import {
  cancelSessionInputFocus,
  requestSessionInputFocus,
} from "./session-input-focus.ts";
import { showToast } from "./toasts.ts";

function htmx(): Htmx {
  return (globalThis as unknown as { htmx: Htmx }).htmx;
}
function displayedUrl(): string {
  const main = document.querySelector<HTMLElement>("main");
  const id = main?.dataset["sessionId"];
  return id
    ? `/sessions/${id}`
    : `/new?cwd=${encodeURIComponent(main?.dataset["cwd"] ?? "")}`;
}
function sessionTarget(ctx: HtmxRequestCtx): boolean {
  return ctx.target?.id === "session-region";
}

let intent = 0;

/** Plain-fetch effects use the same admission generation as HTMX requests. */
export function navigationIntent(): number {
  return intent;
}

export function setUpNavigation(): void {
  let latest: HtmxRequestCtx | undefined;
  let cancel: (() => void) | undefined;
  let focusRedirect: string | undefined;
  const admitted = new WeakMap<HtmxRequestCtx, number>();
  const navigations = new WeakSet<HtmxRequestCtx>();
  // Qualify the initial new-chat history entry by folder, before leaving it.
  if (
    ["/", "/new"].includes(location.pathname) &&
    !location.search &&
    !document.querySelector("main[data-session-id]")
  )
    history.replaceState(history.state, "", displayedUrl());

  document.addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>(
            ".session-row a[href], a[data-session-link]",
          )
        : null;
    if (
      !link ||
      !document.getElementById("session-region") ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self")
    )
      return;
    const url = new URL(link.href);
    if (
      url.origin !== location.origin ||
      !/^\/(?:sessions\/[^/]+|new)$/.test(url.pathname)
    )
      return;
    event.preventDefault();
    closeMobileSidebar();
    const main = document.querySelector<HTMLElement>("main");
    intent += 1;
    cancelSessionInputFocus();
    focusRedirect = undefined;
    const canceledHistory =
      latest?.request.headers["HX-History-Restore-Request"] === "true";
    cancel?.();
    cancel = undefined;
    latest = undefined;
    if (
      url.pathname === `/sessions/${main?.dataset["sessionId"] ?? ""}` &&
      !url.search
    ) {
      // Back/Forward changes the address before its replacement view arrives.
      if (canceledHistory && location.pathname !== url.pathname)
        history.replaceState(history.state, "", displayedUrl());
      return;
    }
    void htmx().ajax("GET", url.pathname + url.search, {
      source: "#session-region",
      target: "#session-region",
      swap: "outerHTML",
      push: url.pathname + url.search,
    });
  });

  document.addEventListener("htmx:config:request", (event) => {
    const ctx = requestContext(event);
    const main = document.querySelector<HTMLElement>("main");
    if (sessionTarget(ctx))
      ctx.request.headers["HX-Target"] = "div#session-region";
    ctx.request.headers["X-Web-Pi-Session"] = main?.dataset["sessionId"] ?? "";
    // A header cannot carry characters above U+00FF; the server decodes it.
    ctx.request.headers["X-Web-Pi-Cwd"] = encodeURIComponent(
      main?.dataset["cwd"] ?? "",
    );
    const url = new URL(ctx.request.action, location.href);
    if (
      url.pathname.startsWith("/files/") &&
      (url.searchParams.has("session") || url.searchParams.has("cwd"))
    ) {
      url.searchParams.delete("session");
      url.searchParams.delete("cwd");
      if (main?.dataset["sessionId"])
        url.searchParams.set("session", main.dataset["sessionId"]);
      else url.searchParams.set("cwd", main?.dataset["cwd"] ?? "");
      ctx.request.action = url.pathname + url.search;
    }
  });
  document.addEventListener("htmx:before:request", (event) => {
    const ctx = requestContext(event);
    if (ctx.request.signal.aborted) {
      event.preventDefault();
      return;
    }
    const url = new URL(ctx.request.action, location.href);
    const body = ctx.request.body;
    const text = body instanceof FormData ? body.get("text") : null;
    const cloneCommand =
      /^\/sessions\/[^/]+\/prompt$/.test(url.pathname) &&
      body instanceof FormData &&
      typeof text === "string" &&
      /^\/clone(?:\s|$)/.test(text.trim()) &&
      !body
        .getAll("images[]")
        .some((file) => file instanceof File && file.size > 0);
    const createsSession =
      url.pathname === "/sessions" ||
      /^\/sessions\/[^/]+\/(fork|clone)$/.test(url.pathname) ||
      cloneCommand;
    if (
      sessionTarget(ctx) ||
      createsSession ||
      (url.pathname === "/sidebar" &&
        (url.searchParams.has("cwd") || url.searchParams.has("project"))) ||
      url.pathname === "/workspaces/validate" ||
      url.pathname ===
        `/sessions/${document.querySelector<HTMLElement>("main[data-session-id]")?.dataset["sessionId"] ?? ""}/delete` ||
      /^\/sessions\/[^/]+\/(fork|rewind|navigate|clone)$/.test(url.pathname)
    ) {
      // HX-Location continues the same opening operation, including any
      // interaction that canceled focus while session creation was loading.
      if (url.href !== focusRedirect) {
        cancelSessionInputFocus();
        if (sessionTarget(ctx) || createsSession) requestSessionInputFocus();
      }
      focusRedirect = undefined;
      if (sessionTarget(ctx)) closeMobileSidebar();
      cancel?.();
      // Native history uses an external signal, not the normal request's
      // abort method. A navigation owns cancellation for either request shape.
      const controller = new AbortController();
      ctx.request.signal = AbortSignal.any([
        ctx.request.signal,
        controller.signal,
      ]);
      cancel = () => {
        controller.abort();
      };
      latest = ctx;
      intent += 1;
      navigations.add(ctx);
    }
    admitted.set(ctx, intent);
  });
  const rejectObsolete = (event: Event) => {
    // HTMX exposes parsed HX headers on its event context, but omits them
    // from the 4.0 declaration. Canceling alone still runs its finally trigger.
    const ctx = requestContext(event) as
      | (HtmxRequestCtx & { hx: Record<string, string> })
      | undefined;
    if (!ctx) return false;
    const oldMain = ctx.sourceElement?.closest("main");
    const staleIntent =
      oldMain &&
      !navigations.has(ctx) &&
      !ctx.sourceElement.hasAttribute("hx-sse:connect") &&
      (admitted.get(ctx) ?? intent) < intent;
    if (
      (navigations.has(ctx) && ctx !== latest) ||
      ctx.request?.signal?.aborted ||
      staleIntent ||
      (oldMain && !oldMain.isConnected)
    ) {
      event.preventDefault();
      // HTMX processes HX-Trigger even in its finally block after cancellation.
      ctx.hx = {};
      return true;
    }
    return false;
  };
  for (const name of [
    "htmx:before:response",
    "htmx:after:request",
    "htmx:before:swap",
  ])
    document.addEventListener(name, rejectObsolete);
  document.addEventListener("htmx:before:response", (event) => {
    const ctx = requestContext(event);
    if (event.defaultPrevented || ctx !== latest) return;
    const locationHeader = ctx.response?.headers.get("HX-Location");
    if (!locationHeader) return;
    // Our sessionLocation route helper sends the JSON form of HX-Location.
    const destination = JSON.parse(locationHeader) as { path: string };
    focusRedirect = new URL(destination.path, location.href).href;
  });
  // A canceled body read skips after:request. Clear its already-read HX
  // headers before HTMX's finally trigger, and suppress stale form errors.
  document.addEventListener(
    "htmx:error",
    (event) => {
      if (rejectObsolete(event)) event.stopImmediatePropagation();
    },
    true,
  );
  document.addEventListener("htmx:error", (event) => {
    const ctx = requestContext(event);
    if (ctx !== latest || ctx.request.signal.aborted) return;
    cancelSessionInputFocus();
    history.replaceState(history.state, "", displayedUrl());
    showToast(
      "Could not open that conversation. Your current conversation is still here.",
    );
  });
  document.addEventListener("htmx:after:request", (event) => {
    const ctx = requestContext(event);
    if (ctx === latest && ctx.response && ctx.response.status >= 400) {
      cancelSessionInputFocus();
      event.preventDefault();
      ctx.push = false;
      ctx.replace = false;
      history.replaceState(history.state, "", displayedUrl());
      showToast(
        "Could not open that conversation. Your current conversation is still here.",
      );
    }
  });
  setUpRegion("main[data-cwd]", (main) => {
    // Commit browser preferences only after a winning response is displayed.
    // A canceled GET therefore cannot change them through Set-Cookie headers.
    const id = main.dataset["sessionId"] ?? "";
    document.cookie = `web-pi-session=${encodeURIComponent(id)}; path=/; samesite=lax; max-age=${id ? "31536000" : "0"}`;
    if (!id && main.dataset["cwdAvailable"] !== "false" && main.dataset["cwd"])
      document.cookie = `web-pi-cwd=${encodeURIComponent(main.dataset["cwd"])}; path=/; samesite=lax; max-age=31536000`;
    const panel = document.getElementById("file-panel");
    if (panel) {
      panel.dataset["session"] = id;
      panel.dataset["cwd"] = main.dataset["cwd"] ?? "";
    }
  });
}
