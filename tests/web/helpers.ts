// What the web tests share outside the browser harness.

import {
  type CustomEvent,
  type Document,
  type Event,
  type EventTarget,
  Window,
} from "happy-dom";
import { onTestFinished } from "vitest";

export function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected test value");
  return value;
}

/** Server markup as a queryable document, closed when the test finishes. */
export function parseHtml(html: string): Document {
  const window = new Window();
  onTestFinished(() => window.happyDOM.close());
  window.document.body.innerHTML = html;
  return window.document;
}

/**
 * The next `type` event at `target` that `accept` takes. Create it before the
 * action that causes the event; it has no deadline but the test's own.
 */
export function nextEvent<T extends Event = CustomEvent>(
  target: EventTarget,
  type: string,
  accept: (event: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      if (!accept(event as T)) return;
      target.removeEventListener(type, listener);
      resolve(event as T);
    };
    target.addEventListener(type, listener);
  });
}

type RequestDetail = { ctx: { request: { action: string } } };

/** The next request to `path` that the page finishes, whatever its outcome. */
export function requestFinished(
  document: Document,
  path: string,
): Promise<CustomEvent> {
  return nextEvent(
    document,
    "htmx:finally:request",
    (event) =>
      new URL(
        (event.detail as RequestDetail).ctx.request.action,
        document.location.href,
      ).pathname === path,
  );
}

/**
 * Resolves once `owner`'s stream has reconnected and applied its first
 * message. The initial connection is attempt 0; reconnections count up.
 */
export function reconnected(owner: EventTarget): Promise<void> {
  return new Promise((resolve) => {
    const connected = (event: Event) => {
      const { connection } = (event as CustomEvent).detail as {
        connection: { attempt: number };
      };
      if (connection.attempt === 0) return;
      owner.removeEventListener("htmx:sse:after:connection", connected);
      // Registered synchronously, so the first message cannot slip past.
      owner.addEventListener(
        "htmx:sse:after:message",
        () => {
          resolve();
        },
        { once: true },
      );
    };
    owner.addEventListener("htmx:sse:after:connection", connected);
  });
}

/**
 * Lets every promise continuation queued so far run, for asserting that
 * discarded promise-only work had no effect: the next task follows them all.
 */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
