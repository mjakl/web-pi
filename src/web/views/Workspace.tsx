import { ParentFolderIcon, PickerFolderIcon } from "./icons.tsx";
import { ConfigButton } from "./ConfigControls.tsx";

// "Custom path…" in the workspace menu: pi-web's DirectoryPicker
// (components/DirectoryPicker.tsx §3.7). One modal dialog that lists
// directory names, walks into them, and commits the folder it is standing in.
// Validating that folder is what grants access to it.

const PANEL = "#directory-picker-panel";

/** The panel: header, path form, listing and footer. Navigation swaps it whole. */
export function BrowsePane({
  path,
  parentPath,
  directories,
  error,
}: {
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
  error?: string;
}) {
  const go = (target: string) =>
    `/workspaces/browse?path=${encodeURIComponent(target)}`;
  return (
    <div id="directory-picker-panel" class="directory-picker-panel">
      <div class="directory-picker-header">
        <div class="directory-picker-heading">
          <div class="directory-picker-title">Select directory</div>
        </div>
        {/* A dialog form keeps Close working without script. */}
        <form method="dialog" class="directory-picker-close-form">
          <button
            type="submit"
            title="Close"
            aria-label="Close"
            class="directory-picker-close"
          >
            ×
          </button>
        </form>
      </div>

      <form
        hx-get="/workspaces/browse"
        hx-include="#directory-path"
        hx-target={PANEL}
        hx-swap="outerHTML"
        class="directory-picker-navigation"
      >
        <button
          class="directory-picker-back"
          type="button"
          title="Go to parent directory"
          aria-label="Go to parent directory"
          disabled={parentPath === null}
          {...(parentPath === null
            ? {}
            : {
                "hx-get": go(parentPath),
                "hx-target": PANEL,
                "hx-swap": "outerHTML",
              })}
        >
          <ParentFolderIcon />
        </button>
        <label for="directory-path" class="sr-only">
          Directory path
        </label>
        <input
          class="directory-picker-path"
          id="directory-path"
          name="path"
          type="text"
          value={path}
          placeholder="/path/to/project or ~/project"
          autofocus
          autocomplete="off"
          spellcheck={false}
        />
        <button
          class="directory-picker-action directory-picker-go"
          type="submit"
          title="Go to directory"
        >
          Go
        </button>
      </form>

      <div class="directory-picker-list">
        {directories.length === 0 ? (
          <div class="directory-picker-empty">No subdirectories</div>
        ) : null}
        {directories.map((entry) => (
          <button
            class="directory-picker-entry"
            type="button"
            title={entry.path}
            hx-get={go(entry.path)}
            hx-target={PANEL}
            hx-swap="outerHTML"
          >
            <PickerFolderIcon />
            <span class="directory-picker-entry-name">{entry.name}</span>
          </button>
        ))}
        {error === undefined ? null : (
          <div role="alert" class="directory-picker-error">
            {error}
          </div>
        )}
      </div>

      <div class="directory-picker-footer">
        <form method="dialog">
          <ConfigButton class="directory-picker-action" type="submit">
            Cancel
          </ConfigButton>
        </form>
        <ConfigButton
          class="directory-picker-action"
          variant="primary"
          type="button"
          title="Select current directory"
          hx-post="/workspaces/validate"
          hx-vals={JSON.stringify({ cwd: path })}
          hx-swap="none"
        >
          Select this folder
        </ConfigButton>
      </div>
    </div>
  );
}

/** The dialog the panel lives in. `client/dialogs.ts` makes it a real modal. */
export function DirectoryPicker(props: {
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
  error?: string;
}) {
  return (
    <dialog
      id="directory-picker"
      class="directory-picker-dialog"
      aria-label="Select directory"
      data-modal
      open
    >
      <BrowsePane {...props} />
    </dialog>
  );
}
