import type { HtmxEventMap, HtmxRequestCtx } from "htmx.org";

export function requestContext(event: Event): HtmxRequestCtx {
  return (event as CustomEvent<{ ctx: HtmxRequestCtx }>).detail.ctx;
}

/**
 * Only explicitly marked controls filter the collected form fields: they
 * name the fields they send, or "none".
 */
export function setUpRequestFields(): void {
  document.body.addEventListener("htmx:config:request", (event) => {
    const ctx = requestContext(event);
    const fields = ctx.sourceElement.getAttribute("data-request-fields");
    if (fields === null) return;
    const body = ctx.request.body;
    if (!(body instanceof FormData)) return;
    const allowed = new Set(fields === "none" ? [] : fields.split(" "));
    // HTMX has already merged these explicit values into FormData. Preserve
    // those entries, including repeated values, rather than rebuilding it.
    const vals = ctx.sourceElement.getAttribute("hx-vals");
    if (vals) {
      try {
        const values: unknown = JSON.parse(vals);
        if (typeof values === "object" && values !== null) {
          for (const name of Object.keys(values)) allowed.add(name);
        }
      } catch {
        // Application controls use JSON hx-vals, never evaluated expressions.
      }
    }
    for (const name of new Set(body.keys())) {
      if (!allowed.has(name)) body.delete(name);
    }
  });
}

/** Outer swaps can insert several siblings; the event target is only the first. */
export function settledContent(event: Event): Element[] {
  const detail = (event as CustomEvent<HtmxEventMap["htmx:after:settle"]>)
    .detail;
  return detail.newContent.filter((node) => node instanceof Element);
}

export function swapTasks(
  event: Event,
): HtmxEventMap["htmx:before:swap"]["tasks"] {
  return (event as CustomEvent<HtmxEventMap["htmx:before:swap"]>).detail.tasks;
}
