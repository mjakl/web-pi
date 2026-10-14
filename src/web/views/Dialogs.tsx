import { TrustDialogShieldIcon, TrustShieldIcon } from "./icons.tsx";
import { ConfigButton } from "./ConfigControls.tsx";

// The dialogs the shell owns: the host they are swapped into and the trust
// flow. The workspace picker's dialog is its own (Workspace.tsx).

/** Everything modal renders here; the client turns it into a real modal. */
export function DialogHost() {
  return <div id="dialogs" />;
}

/**
 * Trust. Project resources are code Pi runs, so a repository nobody vouched
 * for stays dormant until someone says otherwise, here or in the terminal.
 * pi-web's markup: components/ProjectTrustDialog.tsx.
 */
export function TrustDialog({ cwd }: { cwd: string }) {
  return (
    <dialog
      id="trust-dialog"
      class="project-trust-dialog"
      aria-labelledby="project-trust-title"
      data-modal
      data-backdrop-close
      open
    >
      <div class="project-trust-panel">
        <div class="project-trust-body">
          <TrustDialogShieldIcon />
          <div class="project-trust-content">
            <div id="project-trust-title" class="project-trust-title">
              Trust this project?
            </div>
            <div class="project-trust-message">
              Project resources can run local code. Trust only projects whose
              contents you know.
            </div>
            <code class="project-trust-path">{cwd}</code>
          </div>
        </div>
        <div class="dialog-actions project-trust-actions">
          <form method="dialog">
            <ConfigButton type="submit">Cancel</ConfigButton>
          </form>
          <ConfigButton
            variant="primary"
            hx-post="/workspaces/trust"
            hx-vals={JSON.stringify({ cwd })}
            hx-swap="none"
          >
            Trust project
          </ConfigButton>
        </div>
      </div>
    </dialog>
  );
}

/**
 * The top bar's trust warning (ui-map 2.3). pi-web keeps it beside the tabs,
 * in `--warning`, and it opens the dialog.
 */
export function TrustBadge({
  cwd,
  status,
  banner,
}: {
  cwd: string;
  status: { requiresTrust: boolean; trusted: boolean };
  /** The phone variant: a full-width row under the bar, not a bar button. */
  banner?: boolean;
}) {
  if (!status.requiresTrust || status.trusted) return <></>;
  return (
    <button
      type="button"
      data-trust-warning
      {...(banner === true ? { "data-mobile-trust-banner": "true" } : {})}
      class={`project-trust-badge${banner === true ? " is-banner" : ""}`}
      title="Restricted mode"
      aria-label="Restricted mode"
      hx-get={`/workspaces/trust?cwd=${encodeURIComponent(cwd)}`}
      hx-target="#dialogs"
      hx-swap="innerHTML"
    >
      <TrustShieldIcon />
      <span>Restricted mode</span>
    </button>
  );
}

/**
 * What pi-web puts in the composer's place when the session's folder is gone
 * (ChatWindow.tsx `chatInputElement`): one sentence, in the class its own
 * stylesheet indents and dims.
 */
export function MissingFolderNotice() {
  return (
    <div role="status" class="project-folder-message">
      Working folder is unavailable. This session is read-only.
    </div>
  );
}
