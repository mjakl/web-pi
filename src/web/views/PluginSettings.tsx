import {
  type PackageInfo,
  type PackagesView,
  type PackageScope,
} from "@core/packages";
import { shortPath } from "@core/workspaces";
import {
  ConfigButton,
  ConfigField,
  ConfigSplitView,
  ConfigSwitch,
  ScopePicker,
  ScopeTag,
} from "./ConfigControls.tsx";
import { PiDevLogoIcon } from "./icons.tsx";

// Settings → Plugins: the Pi packages configured globally and for the
// project, one in detail with what it resolved to, and the form to install
// another (pi-web's components/PluginsConfig.tsx).

/**
 * pi-web groups a package's resources by kind, in this order, and drops the
 * kinds it has none of (PluginsConfig.tsx L127-L219).
 */
const RESOURCE_GROUPS = [
  ["extensions", "Extensions"],
  ["skills", "Skills"],
  ["prompts", "Prompts"],
  ["themes", "Themes"],
] as const;

function ResourceList({ info }: { info: PackageInfo }) {
  const groups = RESOURCE_GROUPS.map(([kind, label]) => ({
    label,
    resources: info.resources.filter((resource) => resource.kind === kind),
  })).filter((group) => group.resources.length > 0);
  if (groups.length === 0) {
    return (
      <div class="config-message">
        {info.disabled ? "Package disabled." : "No resolved resources"}
      </div>
    );
  }
  return (
    <div class="plugin-resource-groups">
      {groups.map((group) => (
        <div class="plugin-resource-group">
          <div class="plugin-resource-heading">{group.label}</div>
          <div class="plugin-resource-list">
            {group.resources.map((resource) => (
              <div class="plugin-resource">
                <div title={resource.path} class="plugin-resource-name">
                  {resource.name}
                </div>
                <div title={resource.path} class="plugin-resource-path">
                  {resource.relativePath}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function pluginKey(info: PackageInfo): string {
  return `${info.scope} ${info.source}`;
}

const RESOURCE_LABELS = [
  ["extensions", "ext"],
  ["skills", "skills"],
  ["prompts", "prompts"],
  ["themes", "themes"],
] as const;

/** pi-web's `resourceSummary`: one count per kind, dot-separated. */
function resourceSummary(info: PackageInfo): string {
  if (info.disabled) return "Disabled";
  const parts = RESOURCE_LABELS.flatMap(([kind, label]) => {
    const count = info.resources.filter(
      (resource) => resource.kind === kind,
    ).length;
    return count === 0 ? [] : [`${String(count)} ${label}`];
  });
  return parts.length === 0 ? "No resources" : parts.join(" · ");
}

/** pi-web's `versionSummary`: "installed 1.2.0 · configured ^1.2.0". */
function versionSummary(info: PackageInfo): string {
  const parts = [
    ...(info.version === undefined ? [] : [`installed ${info.version}`]),
    ...(info.configuredVersion === undefined
      ? []
      : [`configured ${info.configuredVersion}`]),
  ];
  return parts.length === 0 ? "Unknown" : parts.join(" · ");
}

function InfoRow({
  label,
  value,
  class: valueClass,
}: {
  label: string;
  value: string;
  class?: string;
}) {
  return (
    <>
      <div class="plugin-info-label">{label}</div>
      <div class={`plugin-info-value${valueClass ? ` ${valueClass}` : ""}`}>
        {value}
      </div>
    </>
  );
}

export function PluginDetail({
  cwd,
  info,
  message,
  home,
}: {
  cwd: string;
  info?: PackageInfo;
  message?: string;
  home?: string;
}) {
  if (!info) {
    return <div class="config-empty-state">Select a package</div>;
  }
  const act = (action: string) =>
    JSON.stringify({
      cwd,
      action,
      source: info.source,
      scope: info.scope,
      selected: pluginKey(info),
    });
  return (
    <div class="config-detail-stack">
      <div class="config-detail-header is-top-aligned">
        <div class="config-detail-header-info">
          <ScopeTag scope={info.scope} />
          {info.disabled ? (
            <span class="config-scope-tag">Disabled</span>
          ) : info.filtered ? (
            <span class="config-scope-tag is-filtered">filtered</span>
          ) : null}
          <span class="plugin-source">{info.source}</span>
        </div>
        <div class="config-detail-actions">
          <ConfigButton
            small
            hx-post="/settings/plugins"
            hx-vals={act("update")}
          >
            Update
          </ConfigButton>
          <ConfigButton
            small
            title="Reload extensions, skills, and prompts in the sessions of this folder"
            hx-post="/settings/plugins/reload"
            hx-vals={JSON.stringify({ cwd })}
          >
            Reload session
          </ConfigButton>
          <ConfigButton
            variant="danger"
            small
            hx-post="/settings/plugins"
            hx-vals={act("remove")}
            hx-confirm="Remove this plugin and its settings entry?"
          >
            Remove
          </ConfigButton>
          <ConfigSwitch
            checked={!info.disabled}
            label={info.disabled ? "Enable package" : "Disable package"}
            hx-post="/settings/plugins"
            hx-vals={act(info.disabled ? "enable" : "disable")}
          />
        </div>
      </div>
      <div class="plugin-info">
        <InfoRow
          label="Status"
          value={info.status}
          class={`plugin-status is-${info.status}`}
        />
        <InfoRow
          label="Version"
          value={versionSummary(info)}
          class="plugin-info-version"
        />
        <InfoRow
          label="Package"
          value={info.packageName ?? "Unknown"}
          class="plugin-info-path"
        />
        <InfoRow label="Resources" value={resourceSummary(info)} />
        <InfoRow
          label="Installed path"
          value={
            info.installedPath === undefined
              ? "Not found"
              : shortPath(info.installedPath, home)
          }
          class={`plugin-info-path${info.installedPath === undefined ? " is-missing" : ""}`}
        />
        <InfoRow
          label="CWD"
          value={shortPath(cwd, home)}
          class="plugin-info-path is-muted"
        />
      </div>
      <div class="plugin-resources">
        <div class="config-section-title">Resolved Resources</div>
        <ResourceList info={info} />
      </div>
      {message === undefined ? null : (
        <div role="status" class="plugin-message">
          {message}
        </div>
      )}
    </div>
  );
}

/** The detail pane in add mode: install a package by source. */
function AddPluginPanel({
  view,
  cwd,
  home,
}: {
  view: PackagesView;
  cwd: string;
  home?: string;
}) {
  const examples = [
    "npm:@scope/pi-plugin",
    "git:https://github.com/user/repo",
    "/absolute/path/to/plugin",
  ];
  return (
    <form class="config-detail-stack is-fill" hx-post="/settings/plugins">
      <input type="hidden" name="cwd" value={cwd} />
      <input type="hidden" name="action" value="install" />
      <div class="plugin-add-heading">
        <div class="plugin-add-title-row">
          <div class="config-detail-title">Add plugin</div>
          <a
            href="https://pi.dev/packages"
            target="_blank"
            rel="noreferrer"
            class="plugin-directory-link"
          >
            <PiDevLogoIcon />
            pi.dev/packages
          </a>
        </div>
        <div class="plugin-scope-path">
          <span class="config-scope-global">~/.pi/agent/{"{npm,git}"}</span>
          <span class="config-scope-project">
            {shortPath(cwd, home)}/.pi/agent/{"{npm,git}"}
          </span>
        </div>
      </div>
      <ConfigField label="Source">
        <input
          id="plugin-source"
          name="source"
          class="config-input plugin-source-input"
          placeholder="npm:@scope/package"
          aria-label="Plugin source"
        />
      </ConfigField>
      <div class="plugin-install-actions">
        <ScopePicker name="scope" trusted={view.projectResourcesLoaded} />
        <ConfigButton type="submit" variant="primary">
          Install
        </ConfigButton>
      </div>
      <div class="plugin-examples">
        <div class="plugin-examples-heading">Examples</div>
        <div class="plugin-example-list">
          {examples.map((example) => (
            <button
              type="button"
              data-plugin-example={example}
              class="plugin-example"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}

export function PluginsSection({
  cwd,
  view,
  selected,
  add,
  message,
  home,
}: {
  cwd: string;
  view: PackagesView;
  selected?: string;
  add?: boolean;
  message?: string;
  home?: string;
}) {
  const info =
    view.packages.find((entry) => pluginKey(entry) === selected) ??
    view.packages[0];
  const scopes: PackageScope[] = ["project", "user"];
  const errors = view.diagnostics.length;
  return (
    <ConfigSplitView
      what="plugins"
      trusted={view.projectResourcesLoaded}
      list={
        <>
          {view.packages.length === 0 ? (
            <div class="config-sidebar-message">No plugins configured</div>
          ) : null}
          {scopes.map((scope) => {
            const rows = view.packages.filter((entry) => entry.scope === scope);
            if (rows.length === 0) return <></>;
            return (
              <div class="config-sidebar-group">
                <div class="config-sidebar-group-label">
                  {scope === "user" ? "global" : "project"}
                </div>
                {rows.map((entry) => (
                  <button
                    type="button"
                    class="config-sidebar-item"
                    aria-current={
                      add !== true &&
                      info !== undefined &&
                      pluginKey(entry) === pluginKey(info)
                        ? "page"
                        : undefined
                    }
                    hx-get={`/settings/plugins?cwd=${encodeURIComponent(cwd)}&selected=${encodeURIComponent(pluginKey(entry))}`}
                  >
                    <span
                      class={`config-status-dot is-${entry.status}${entry.disabled ? " is-inactive" : ""}`}
                      aria-hidden="true"
                    />
                    <span
                      class={
                        entry.disabled
                          ? "config-sidebar-text is-grow is-muted"
                          : "config-sidebar-text is-grow"
                      }
                    >
                      {entry.source}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </>
      }
      add={{
        label: "Add plugin",
        href: `/settings/plugins?cwd=${encodeURIComponent(cwd)}&add=1`,
        open: add === true,
      }}
      detail={
        add === true || view.packages.length === 0 ? (
          <AddPluginPanel view={view} cwd={cwd} home={home} />
        ) : (
          <PluginDetail cwd={cwd} info={info} message={message} home={home} />
        )
      }
      status={
        errors === 0 ? (
          <span>
            {String(view.totals.extensions)} ext · {String(view.totals.skills)}{" "}
            skills · {String(view.totals.prompts)} prompts ·{" "}
            {String(view.totals.themes)} themes
          </span>
        ) : (
          <span
            class={`plugin-diagnostic-count ${view.diagnostics.some((diagnostic) => diagnostic.type === "error") ? "is-error" : "is-warning"}`}
            title={view.diagnostics
              .map(
                (diagnostic) =>
                  `${diagnostic.type}: ${diagnostic.source === undefined ? "" : `${diagnostic.source}: `}${diagnostic.message}`,
              )
              .join("\n")}
          >
            {String(errors)} diagnostic{errors === 1 ? "" : "s"}
          </span>
        )
      }
      actions={
        <ConfigButton
          hx-get={`/settings/plugins?cwd=${encodeURIComponent(cwd)}`}
        >
          Refresh
        </ConfigButton>
      }
    />
  );
}
