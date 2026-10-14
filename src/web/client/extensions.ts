// The browser half of the extension bridge: Escape cancels a dialog, a
// dialog's timeout counts down, the custom-UI panel forwards keystrokes as
// terminal bytes, and text an extension sends lands at the composer's cursor.
// Everything else about these panels is server-rendered and arrives on the
// session stream.

import { closesIn } from "@core/extension-ui";
import { bracketedPaste, terminalKeyData } from "@core/terminal-input";
import { replaceRange, textarea } from "./editor.ts";

/** How a pi-tui component is asked to finish: there is no close command. */
const CTRL_C = "\u0003";

/** Each panel's last keystroke request; the next one waits for it. */
const sending = new WeakMap<HTMLElement, Promise<void>>();

function post(panel: HTMLElement, data: string): void {
  const url = panel.dataset["customUi"] ?? "";
  // One request at a time per panel: separate fetches can arrive out of
  // order, and a component has to see the keys in the order they were typed.
  const sent = (sending.get(panel) ?? Promise.resolve())
    .then(() =>
      // Percent-encoded, not multipart: a lone carriage return is exactly
      // what Enter sends, and a multipart parser eats it with the line ending.
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data }).toString(),
      }),
    )
    .then(
      () => undefined,
      () => {
        // A dropped keystroke is not worth a toast; the next frame still
        // arrives.
      },
    );
  sending.set(panel, sent);
}

function customPanel(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>("[data-custom-ui]");
}

/**
 * Native `<dialog>` gives Escape for free, but the extension has to hear about
 * it: the cancel is turned into the form's own Cancel button so the server
 * sees one kind of answer.
 */
function setUpDialogCancel(): void {
  document.body.addEventListener(
    "cancel",
    (event) => {
      const dialog = event.target;
      if (!(dialog instanceof HTMLDialogElement)) return;
      // The custom-UI panel forwards Escape to the component as \x1b, so the
      // dialog must never treat the same key as a request to close.
      if (dialog.dataset["noEscape"] !== undefined) {
        event.preventDefault();
        return;
      }
      const cancel = dialog.querySelector<HTMLButtonElement>(
        "[data-dialog-cancel]",
      );
      if (!cancel) return;
      event.preventDefault();
      cancel.click();
    },
    true,
  );
}

/**
 * The server renders "Closes in Ns" once, with the deadline beside it; this
 * counts it down while a dialog with a timeout is on the page.
 */
function setUpDialogCountdown(): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (): void => {
    const lines = document.querySelectorAll<HTMLElement>("[data-expires-at]");
    for (const line of lines)
      line.textContent = closesIn(Number(line.dataset["expiresAt"]));
    if (lines.length === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const start = (): void => {
    timer ??= setInterval(tick, 1000);
  };
  document.body.addEventListener("htmx:after:settle", start);
  start();
}

/** Ctrl/Cmd+Enter saves the editor dialog, where Enter is a newline. */
function setUpDialogSubmit(): void {
  document.body.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement)) return;
    if (field.dataset["dialogSubmit"] === undefined) return;
    event.preventDefault();
    field.form?.requestSubmit();
  });
}

function setUpCustomUi(): void {
  document.body.addEventListener("keydown", (event) => {
    const panel = customPanel(event.target);
    if (panel === null) return;
    const data = terminalKeyData(event);
    if (data === null) return;
    event.preventDefault();
    post(panel, data);
  });
  document.body.addEventListener("paste", (event) => {
    const panel = customPanel(event.target);
    if (panel === null) return;
    const text = event.clipboardData?.getData("text") ?? "";
    if (text === "") return;
    event.preventDefault();
    post(panel, bracketedPaste(text));
  });
  document.body.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const panel = customPanel(target);
    if (panel === null) return;
    // Ctrl+C is how a pi-tui component is asked to finish; there is no
    // separate close command for it to listen to.
    if (target.closest("[data-custom-close]")) post(panel, CTRL_C);
    else document.getElementById("custom-frame")?.focus();
  });
  // A panel that has just appeared takes focus: it is the only thing on the
  // page that wants the keyboard.
  document.body.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (target instanceof Element && target.id === "custom-ui") {
      document.getElementById("custom-frame")?.focus();
    }
  });
}

/** `setEditorText` and `pasteToEditor`, both an insert at the cursor. */
function setUpEditorInserts(): void {
  document.body.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.id !== "editor-insert") return;
    const text =
      target.querySelector<HTMLElement>("[data-insert]")?.dataset["insert"];
    const area = textarea();
    if (text && area) {
      // Always an insert at the cursor, never a replace: the composer belongs
      // to the reader even while an extension is writing into it.
      const before = area.value.slice(0, area.selectionStart);
      const separator = before === "" || before.endsWith(" ") ? "" : " ";
      replaceRange(
        area,
        area.selectionStart,
        area.selectionEnd,
        `${separator}${text}`,
        separator.length + text.length,
      );
    }
    target.replaceChildren();
  });
}

/** `setTitle`: the badge the status bar renders also names the browser tab. */
function setUpExtensionTitle(): void {
  const apply = (): void => {
    const title = document.getElementById("extension-title")?.dataset["title"];
    if (title) document.title = title;
  };
  document.body.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (target instanceof Element && target.id === "status") apply();
  });
  // A page rendered with the title already set never swaps `#status`.
  apply();
}

export function setUpExtensions(): void {
  setUpDialogCancel();
  setUpDialogCountdown();
  setUpDialogSubmit();
  setUpCustomUi();
  setUpEditorInserts();
  setUpExtensionTitle();
}
