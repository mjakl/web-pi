import { hasPendingAttachments, flushDrafts } from "./drafts.ts";
import { hasUnsavedPreferences } from "./preferences.ts";
import { requestContext } from "./htmx.ts";

/** Only edits with an explicit commit, not search/filter or persisted drafts. */
export function hasUnsavedSettings(): boolean {
  if (hasUnsavedPreferences()) return true;
  for (const input of document.querySelectorAll<HTMLInputElement>(
    '.settings-models input[name="model"]',
  )) {
    if (input.checked !== input.defaultChecked) return true;
  }
  const source = document.querySelector<HTMLInputElement>("#plugin-source");
  return source !== null && source.value !== source.defaultValue;
}

export function setUpUnsavedChanges(): void {
  const page = document.querySelector<HTMLElement>("[data-settings-url]");
  if (page?.dataset["settingsUrl"])
    history.replaceState(history.state, "", page.dataset["settingsUrl"]);

  // One native prompt covers links, GET forms, Back/Forward, reload and close.
  // It does not interfere with background fetches or HTMX saves.
  window.addEventListener("beforeunload", (event) => {
    flushDrafts();
    if (!hasPendingAttachments() && !hasUnsavedSettings()) return;
    event.preventDefault();
  });
  document.addEventListener("htmx:before:request", (event) => {
    const ctx = requestContext(event);
    const url = new URL(ctx.request.action, location.href);
    if (
      ctx.request.method.toUpperCase() !== "GET" ||
      !["/settings/plugins", "/settings/skills/detail"].includes(
        url.pathname,
      ) ||
      !hasUnsavedSettings()
    )
      return;
    if (!window.confirm("Discard unsaved Settings edits?"))
      event.preventDefault();
  });
}
