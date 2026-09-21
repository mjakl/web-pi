import type { Htmx, HtmxRequestCtx } from "htmx.org";
import { requestContext } from "./htmx.ts";
import { setUpRegion } from "./lifecycle.ts";

const INTERVAL_MS = 2000;

function htmx(): Htmx {
  return (globalThis as unknown as { htmx: Htmx }).htmx;
}

/** One visible, mounted saved transcript owns one request and one timer. */
export function setUpSavedSession(): void {
  setUpRegion("main[data-saved-session]", (owner, signal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: AbortController | undefined;
    let resume = false;
    let owned = owner.hasAttribute("hx-sse:connect");
    let suspended = false;
    let handoff = false;
    let deferredHistory: HtmxRequestCtx | undefined;
    const navigations = new Set<HtmxRequestCtx>();
    const history = new Set<HtmxRequestCtx>();
    const available = () =>
      !signal.aborted &&
      owner.isConnected &&
      !document.hidden &&
      !owned &&
      navigations.size === 0 &&
      !suspended;
    const oldest = () =>
      owner
        .querySelector<HTMLElement>("#messages .turn")
        ?.id.slice("turn-".length);
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      pending?.abort();
    };
    const schedule = (delay = INTERVAL_MS) => {
      clearTimeout(timer);
      if (available() && !pending && history.size === 0)
        timer = setTimeout(() => {
          void poll();
        }, delay);
    };
    const loadDeferredHistory = () => {
      const request = deferredHistory;
      deferredHistory = undefined;
      const sentinel = owner.querySelector<HTMLElement>(".load-earlier");
      if (request && sentinel && !signal.aborted) {
        // An intersect-once trigger has already fired. Replay it only after
        // the ownership frame, so it cannot widen a window being replaced.
        void htmx().ajax("GET", request.request.action, {
          source: sentinel,
          target: sentinel,
          swap: "outerHTML",
        });
      }
    };
    const takeOwnership = () => {
      owned = true;
      cancel();
      const events = owner.dataset["liveEvents"];
      if (!events) return;
      handoff = true;
      const url = new URL(events, location.href);
      url.searchParams.set("saved", "1");
      const through = oldest();
      if (through) url.searchParams.set("through", through);
      const stream = document.createElement("div");
      stream.hidden = true;
      stream.setAttribute("hx-sse:connect", url.pathname + url.search);
      stream.setAttribute("hx-sse:close", "web-pi:saved");
      stream.setAttribute("hx-trigger", "web-pi:sse-start");
      stream.setAttribute("hx-swap", "none");
      owner.append(stream);
      htmx().process(stream);
    };
    const poll = async () => {
      if (!available() || pending || history.size > 0) return;
      const controller = new AbortController();
      pending = controller;
      resume = false;
      const through = oldest();
      const url = new URL(owner.dataset["savedSession"] ?? "", location.href);
      url.searchParams.set("revision", owner.dataset["savedRevision"] ?? "");
      url.searchParams.set("leaf", owner.dataset["savedLeaf"] ?? "");
      url.searchParams.set(
        "contentLeaf",
        owner.dataset["savedContentLeaf"] ?? "",
      );
      if (through) url.searchParams.set("through", through);
      const current = () =>
        available() &&
        !controller.signal.aborted &&
        through === oldest() &&
        history.size === 0;
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok || !current()) return;
        const kind = response.headers.get("X-Web-Pi-Saved");
        if (kind === "owned") {
          takeOwnership();
          return;
        }
        if (kind === "changed") {
          const text = await response.text();
          if (!current()) return;
          const log = owner.querySelector("#log");
          log?.dispatchEvent(new Event("web-pi:saved-before"));
          await htmx().swap({
            sourceElement: owner,
            target: owner,
            text,
            swap: "none",
          });
          log?.dispatchEvent(new Event("web-pi:saved-after"));
          if (!available() || controller.signal.aborted) return;
          owner.dataset["savedLeaf"] = decodeURIComponent(
            response.headers.get("X-Web-Pi-Leaf") ?? "",
          );
          owner.dataset["savedContentLeaf"] = decodeURIComponent(
            response.headers.get("X-Web-Pi-Content-Leaf") ?? "",
          );
        }
        // An unavailable stamp acknowledges the check, not a new branch/history.
        if (kind === "changed" || kind === "unavailable") {
          const revision = response.headers.get("X-Web-Pi-Revision");
          if (revision !== null)
            owner.dataset["savedRevision"] = decodeURIComponent(revision);
        }
      } catch {
        // Saved files can briefly disappear or be mid-write. Keep the last good
        // transcript and try the next visible tick, without an error-toast loop.
      } finally {
        pending = undefined;
        schedule(resume ? 0 : INTERVAL_MS);
      }
    };
    owner.addEventListener(
      "web-pi:saved",
      (event) => {
        const data = JSON.parse(
          (event as CustomEvent<{ data: string }>).detail.data,
        ) as {
          revision?: string;
          leaf?: string | null;
          contentLeaf?: string | null;
        };
        if (data.revision !== undefined)
          owner.dataset["savedRevision"] = data.revision;
        if (data.leaf !== undefined)
          owner.dataset["savedLeaf"] = data.leaf ?? "";
        if (data.contentLeaf !== undefined)
          owner.dataset["savedContentLeaf"] = data.contentLeaf ?? "";
        owned = false;
        handoff = false;
        loadDeferredHistory();
        const stream = event.target;
        // hx-sse:close closes this connection after dispatching the named event.
        // The next handoff gets a fresh transport owner and fresh cursor/window.
        queueMicrotask(() => {
          if (stream instanceof Element && stream !== owner) stream.remove();
          else owner.removeAttribute("hx-sse:connect");
        });
        schedule();
      },
      { signal },
    );
    const returning = () => {
      if (document.hidden) cancel();
      else {
        resume = true;
        schedule(0);
      }
    };
    document.addEventListener("visibilitychange", returning, { signal });
    window.addEventListener(
      "pagehide",
      () => {
        suspended = true;
        cancel();
      },
      { signal },
    );
    window.addEventListener(
      "pageshow",
      () => {
        suspended = false;
        returning();
      },
      { signal },
    );
    signal.addEventListener("abort", cancel, { once: true });
    document.addEventListener(
      "htmx:before:request",
      (event) => {
        const ctx = requestContext(event);
        if (
          ctx.target?.matches(".load-earlier") &&
          owner.contains(ctx.target)
        ) {
          // The handoff's first frame reconciles exactly this loaded window.
          if (handoff) {
            deferredHistory = ctx;
            event.preventDefault();
            return;
          }
          history.add(ctx);
          cancel();
        } else if (
          ctx.target?.id === "session-region" ||
          ctx.target === document.body
        ) {
          navigations.add(ctx);
          cancel();
        }
      },
      { signal },
    );
    document.addEventListener(
      "htmx:finally:request",
      (event) => {
        const ctx = requestContext(event);
        if (history.delete(ctx)) schedule();
        const action = new URL(ctx.request.action, location.href).pathname;
        if (
          ctx.response?.raw.ok &&
          action.startsWith(`/sessions/${owner.dataset["sessionId"] ?? ""}/`) &&
          /\/(prompt|activate|commands|compact|model|model-selector|system-prompt|tools)$/.test(
            action,
          )
        ) {
          // A local action may have just acquired the runtime. Do not wait for
          // the next saved tick to expose the running turn and its Stop control.
          resume = true;
          schedule(0);
        }
        if (
          ctx.target?.id === "session-region" ||
          ctx.target === document.body
        ) {
          navigations.delete(ctx);
          schedule();
        }
      },
      { signal },
    );
    owner.addEventListener(
      "htmx:after:settle",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.matches(".chat-body")) {
          handoff = false;
          deferredHistory = undefined;
        } else if (target.id === "messages") {
          handoff = false;
          loadDeferredHistory();
        }
      },
      { signal },
    );
    schedule();
  });
}
