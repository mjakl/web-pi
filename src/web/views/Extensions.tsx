import { ansiToHtml, normalizeFrame } from "@core/ansi";
import {
  closesIn,
  type CustomFrame,
  type DialogRequest,
} from "@core/extension-ui";
import { raw } from "hono/html";
import { ConfigButton } from "./ConfigControls.tsx";

// Dialogs and terminal panels arrive on the session stream. Their owner
// subtrees stay mounted while frame content changes, preserving focus/input.

/** Enter chooses the first submit button. CSS places Cancel visually first. */
function Cancel() {
  return (
    <ConfigButton
      type="submit"
      name="cancelled"
      value="1"
      class="extension-dialog-cancel"
      data-dialog-cancel
    >
      Cancel
    </ConfigButton>
  );
}

function Footer({ children }: { children?: unknown }) {
  return <div class="dialog-actions extension-dialog-actions">{children}</div>;
}

function Body({ dialog }: { dialog: DialogRequest }) {
  switch (dialog.method) {
    case "select":
      return (
        <>
          <div class="extension-dialog-body is-scrollable">
            <div class="extension-dialog-options">
              {(dialog.options ?? []).map((option) => (
                <button
                  type="submit"
                  name="value"
                  value={option}
                  class="extension-dialog-option"
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <Footer>
            <Cancel />
          </Footer>
        </>
      );
    case "confirm":
      return (
        <>
          <div class="extension-dialog-body">
            <div class="extension-dialog-message">{dialog.message ?? ""}</div>
          </div>
          <Footer>
            <ConfigButton
              type="submit"
              name="confirmed"
              value="1"
              variant="primary"
            >
              Confirm
            </ConfigButton>
            <Cancel />
          </Footer>
        </>
      );
    case "input":
      return (
        <>
          <div class="extension-dialog-body">
            <input
              type="text"
              name="value"
              class="extension-dialog-input"
              placeholder={dialog.placeholder ?? ""}
              autofocus
            />
          </div>
          <Footer>
            <ConfigButton type="submit" variant="primary">
              Submit
            </ConfigButton>
            <Cancel />
          </Footer>
        </>
      );
    case "editor":
      return (
        <>
          <div class="extension-dialog-body">
            <textarea
              name="value"
              class="extension-dialog-editor"
              data-dialog-submit
              autofocus
            >
              {dialog.prefill ?? ""}
            </textarea>
          </div>
          <Footer>
            <ConfigButton type="submit" variant="primary">
              Submit
            </ConfigButton>
            <Cancel />
          </Footer>
        </>
      );
    default:
      return <></>;
  }
}

/** The dialog itself, or nothing when no extension is waiting. */
export function ExtensionDialogBody({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: DialogRequest | null;
}) {
  if (!dialog) return <></>;
  return (
    <dialog class="extension-dialog" aria-label={dialog.title} data-modal open>
      <form
        class="extension-dialog-panel"
        hx-post={`/sessions/${sessionId}/ui/${dialog.id}`}
        hx-swap="none"
      >
        <div class="extension-dialog-heading">
          <div class="extension-dialog-title">{dialog.title}</div>
          {/* The time left, not the deadline: the browser's clock may differ. */}
          <div
            class="extension-dialog-timeout"
            data-expires-in={
              dialog.expiresAt === undefined
                ? undefined
                : dialog.expiresAt - Date.now()
            }
          >
            {dialog.expiresAt === undefined
              ? "extension request"
              : closesIn(dialog.expiresAt)}
          </div>
        </div>
        <Body dialog={dialog} />
      </form>
    </dialog>
  );
}

export function ExtensionDialog({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: DialogRequest | null;
}) {
  return (
    <div id="extension-dialog">
      <ExtensionDialogBody sessionId={sessionId} dialog={dialog} />
    </div>
  );
}

/** ANSI colors are runtime content, not a finite UI presentation state. */
export function CustomFrameBody({ frame }: { frame: CustomFrame | null }) {
  if (!frame) return <></>;
  return <>{raw(ansiToHtml(normalizeFrame(frame.lines).join("\n")))}</>;
}

/** Only the frame swaps on redraw, so the panel keeps focus and scroll. */
export function CustomPanelBody({
  sessionId,
  frame,
}: {
  sessionId: string;
  frame: CustomFrame | null;
}) {
  if (!frame) return <></>;
  return (
    <dialog
      class="extension-dialog"
      aria-label="Extension terminal input"
      data-modal
      data-no-escape
      open
    >
      <section
        class="extension-custom-panel"
        data-custom-ui={`/sessions/${sessionId}/ui/${frame.id}/input`}
      >
        <div class="extension-custom-heading">
          <div class="extension-custom-title">Extension panel</div>
          <ConfigButton
            data-custom-close
            title="Sends Ctrl+C, which is how a component is asked to finish"
          >
            Close
          </ConfigButton>
        </div>
        <pre
          id="custom-frame"
          class="extension-custom-frame"
          tabindex={0}
          role="application"
          aria-label="Extension terminal UI"
        >
          <CustomFrameBody frame={frame} />
        </pre>
      </section>
    </dialog>
  );
}

export function CustomPanel({
  sessionId,
  frame,
}: {
  sessionId: string;
  frame: CustomFrame | null;
}) {
  return (
    <div id="custom-ui">
      <CustomPanelBody sessionId={sessionId} frame={frame} />
    </div>
  );
}

/** What the browser needs to know changed, so a frame is only re-sent once. */
export function customSignature(frame: CustomFrame | null): string {
  return frame === null ? "" : `${frame.id}:${frame.lines.join("\n")}`;
}

export function dialogSignature(dialog: DialogRequest | null): string {
  return dialog === null ? "" : dialog.id;
}
