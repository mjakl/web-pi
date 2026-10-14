// What the web tests share outside the browser harness.

import { type Document, Window } from "happy-dom";
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
