import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { Window } from "happy-dom";
import { onTestFinished, vi } from "vitest";
import { escapeHtml } from "@core/html";
import { HTMX_CONFIG, HTMX_SRC, HTMX_SSE_SRC } from "@web/HtmlLayout";

const client = buildSync({
  stdin: {
    contents: `import './src/web/client/main.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
})
  .outputFiles.map((file) => file.text)
  .join("\n");

export type Transport = (request: Request) => Promise<Response> | Response;

/**
 * Separate JS realm: no tests/client/setup.ts and no fake HTMX object. The
 * page closes itself when the test finishes, after any afterEach hook.
 */
export async function htmxBrowser(
  markup: string,
  transport: Transport,
  options: {
    clientAfterHtmx?: boolean;
    clock?: boolean;
    /** Reconnect a dropped stream at once, not after htmx's 350–650 ms. */
    instantReconnect?: boolean;
    afterMarkup?: (window: Window) => void;
  } = {},
) {
  if (options.clock && vi.isFakeTimers())
    throw new Error("A browser clock is already active");
  const window = new Window({
    url: "http://htmx.test/sessions/s1",
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  if (options.clock) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Own the worker's timeout clock until close(), and bridge the browser
    // realm: happy-dom captured native timers before Vitest installed it.
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
  }
  window.console = console;
  const requests: Request[] = [];
  const controllers: AbortController[] = [];
  window.fetch = async (input, init) => {
    const controller = new AbortController();
    controllers.push(controller);
    init?.signal?.addEventListener("abort", () => {
      controller.abort();
    });
    let body: BodyInit | undefined;
    if (init?.body instanceof window.FormData) {
      const data = new FormData();
      for (const [key, value] of init.body) {
        if (typeof value === "string") data.append(key, value);
        else
          data.append(
            key,
            new Blob([await value.arrayBuffer()], { type: value.type }),
            value.name,
          );
      }
      body = data;
    } else if (init?.body instanceof window.URLSearchParams)
      body = new URLSearchParams(init.body.toString());
    else if (typeof init?.body === "string") body = init.body;
    const url =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : input.href;
    const request = new Request(new URL(url, window.location.href), {
      method: init?.method ?? "GET",
      headers: init?.headers as HeadersInit,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });
    if (window.document.cookie)
      request.headers.set("Cookie", window.document.cookie);
    requests.push(request.clone());
    return (await transport(request)) as unknown as Awaited<
      ReturnType<typeof window.fetch>
    >;
  };
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      try {
        await window.eval(
          `globalThis.htmx?.swap({target:document.body,sourceElement:document.body,text:'',swap:'innerHTML'})`,
        );
      } finally {
        controllers.forEach((controller) => {
          controller.abort();
        });
        try {
          await window.happyDOM.close();
        } finally {
          if (options.clock) {
            vi.clearAllTimers();
            vi.useRealTimers();
          }
        }
      }
    })());
  onTestFinished(close);
  // Fetch streams are native Node streams, so their decoder must be available in the realm.
  Object.assign(window, { TextDecoder, TextEncoder });
  // happy-dom has no XPath. HTMX only uses it to find hx-on attributes;
  // provide that DOM query, not a replacement for processing or event dispatch.
  window.eval(`window.XPathEvaluator = class {
  createExpression() {
    return { evaluate(root) {
      const matches = [...root.querySelectorAll('*')].filter(element =>
        [...element.attributes].some(attr => attr.name.startsWith('hx-on') || attr.name.startsWith('data-hx-on')));
      let index = 0;
      return { iterateNext() { return matches[index++] || null; } };
    } };
  }
  };`);
  window.document.write(markup);
  // Detached realms have no OS window focus. Presence tests supply it explicitly.
  window.document.hasFocus = () => false;
  options.afterMarkup?.(window);
  // happy-dom's ID cache uses insertion order for duplicate IDs. Native
  // hx-preserve temporarily puts the old ID in a pantry after body; browsers
  // return the replacement in body first, as querySelector does here.
  window.eval(
    `document.getElementById = id => id ? document.querySelector('#' + CSS.escape(id)) : null`,
  );
  // HTMX initializes by processing the body once.
  let htmxProcessed = false;
  const initialized = new Promise<void>((resolve) => {
    window.document.addEventListener(
      "htmx:after:process",
      () => {
        htmxProcessed = true;
        resolve();
      },
      { once: true },
    );
  });
  for (const path of [HTMX_SRC, HTMX_SSE_SRC]) {
    window.eval(readFileSync(resolve(process.cwd(), path.slice(1)), "utf8"));
  }
  if (options.instantReconnect)
    window.eval(
      "htmx.config.sse = {...htmx.config.sse, reconnectDelay: 0, reconnectJitter: 0}",
    );
  // A written document is past loading, so HTMX initializes from setTimeout.
  const initialize = async () => {
    if (options.clock) await vi.advanceTimersByTimeAsync(0);
    await initialized;
  };
  if (options.clientAfterHtmx) {
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await initialize();
  }
  const htmxProcessedBeforeClient = htmxProcessed;
  window.eval(client);
  if (!options.clientAfterHtmx) {
    window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await initialize();
  }
  return {
    window,
    document: window.document,
    requests,
    htmxProcessedBeforeClient,
    advanceTime: async (milliseconds: number) => {
      if (!options.clock) throw new Error("Browser clock is not enabled");
      // A test that timed out runs on; it must not move the next test's clock.
      if (closed) throw new Error("The browser is closed");
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
    close,
  };
}

export function page(body: string): string {
  return `<!doctype html><html><head><meta name="htmx-config" content="${escapeHtml(JSON.stringify(HTMX_CONFIG))}"></head><body hx-status:4xx:inherited="swap:none" hx-status:5xx:inherited="swap:none">${body}</body></html>`;
}

export function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    send(data: string, event?: string, id?: string) {
      controller.enqueue(
        new TextEncoder().encode(
          `${id === undefined ? "" : `id: ${id}\n`}${event ? `event: ${event}\n` : ""}${data
            .split("\n")
            .map((line) => `data: ${line}\n`)
            .join("")}\n`,
        ),
      );
    },
    end() {
      controller.close();
    },
    get cancelled() {
      return cancelled;
    },
  };
}
