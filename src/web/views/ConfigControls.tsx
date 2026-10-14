import type { PackageScope } from "@core/packages";
import type { SkillInfo } from "@core/skills";
import { AddConfigIcon } from "./icons.tsx";

// The controls Settings and the shell dialogs share, and the pieces Skills
// and Plugins are both built from: the scope picker and tag, and the
// list/detail split view.

/** Shared action semantics for Settings and shell dialogs. */
export function ConfigButton({
  variant = "secondary",
  small,
  class: extraClass,
  children,
  ...rest
}: {
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
  class?: string;
  children?: unknown;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      {...rest}
      class={`config-button config-button-${variant} config-button-${small === true ? "small" : "default"}${extraClass ? ` ${extraClass}` : ""}`}
    >
      {children}
    </button>
  );
}

/** A preference toggle retains button semantics, not a form checkbox. */
export function ConfigSwitch({
  checked,
  label,
  ...rest
}: {
  checked: boolean;
  label: string;
  [key: string]: unknown;
}) {
  return (
    <button
      type="button"
      {...rest}
      class="config-switch"
      role="switch"
      aria-checked={checked ? "true" : "false"}
      aria-label={label}
      title={label}
    >
      <span class="config-switch-knob" />
    </button>
  );
}

export function ConfigField({
  label,
  children,
}: {
  label: string;
  children: unknown;
}) {
  return (
    <div class="config-field">
      <span class="config-field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * Global / project scope, as pi-web's segmented control: two radios the
 * surrounding form posts. The install path beside it follows the checked one
 * in settings.css.
 */
export function ScopePicker({
  name,
  trusted,
}: {
  name: string;
  trusted: boolean;
}) {
  return (
    <div class="config-scope-picker">
      <label>
        <input
          type="radio"
          class="sr-only"
          name={name}
          value="global"
          checked
        />
        global
      </label>
      <label
        {...(trusted
          ? {}
          : {
              title:
                "Project installs are unavailable while project resources are not loaded.",
            })}
      >
        <input
          type="radio"
          class="sr-only"
          name={name}
          value="project"
          disabled={!trusted}
        />
        project
      </label>
    </div>
  );
}

export function ScopeTag({
  scope,
}: {
  scope: PackageScope | SkillInfo["scope"];
}) {
  return (
    <span class={`config-scope-tag${scope === "project" ? " is-project" : ""}`}>
      {scope === "user" ? "global" : scope}
    </span>
  );
}

/**
 * Skills and Plugins: a list with an add button beside a detail pane, over a
 * footer. A request from inside it swaps the whole section, which the
 * settings body arranges for everything it holds.
 */
export function ConfigSplitView({
  what,
  trusted,
  list,
  add,
  detail,
  status,
  actions,
}: {
  /** What the project's own resources are called, for the trust notice. */
  what: string;
  /** False while the project's own resources are not loaded. */
  trusted: boolean;
  list: unknown;
  /** The add button, which opens the add form in the detail pane. */
  add: { label: string; href: string; open: boolean };
  detail: unknown;
  status: unknown;
  actions: unknown;
}) {
  return (
    <div class="config-panel-root">
      <div class="config-panel-surface">
        {trusted ? null : (
          <div role="status" class="config-trust-notice">
            Project {what} are not loaded because this project is not trusted.
          </div>
        )}
        <div class="config-split-view">
          <aside class="config-sidebar">
            <div class="config-sidebar-list">{list}</div>
            <div class="config-list-action">
              <button
                type="button"
                class="config-list-action-button"
                {...(add.open ? { "aria-current": "page" } : {})}
                hx-get={add.href}
              >
                <AddConfigIcon />
                {add.label}
              </button>
            </div>
          </aside>
          <div class="config-detail">{detail}</div>
        </div>
        <footer class="config-footer">
          <div class="config-footer-status">{status}</div>
          <div class="config-footer-actions">{actions}</div>
        </footer>
      </div>
    </div>
  );
}
