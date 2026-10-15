import {
  SKILL_GROUPS,
  skillGroup,
  type SkillInfo,
  type SkillSearchHit,
  type SkillUpdate,
} from "@core/skills";
import { shortPath } from "@core/workspaces";
import {
  ConfigButton,
  ConfigField,
  ConfigSplitView,
  ConfigSwitch,
  ScopePicker,
  ScopeTag,
} from "./ConfigControls.tsx";

// Settings → Skills: the folder's skills grouped by where they come from,
// one in detail, and the skills.sh search to install more (pi-web's
// components/SkillsConfig.tsx).

export type SkillsView = {
  cwd: string;
  skills: SkillInfo[];
  diagnostics: string[];
  projectResourcesLoaded: boolean;
  /** The last check, so a row can carry its ↑ marker. */
  updates?: SkillUpdate[];
};

function detailHref(cwd: string, path: string): string {
  return `/settings/skills/detail?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
}

function SkillList({
  view,
  selected,
  add,
}: {
  view: SkillsView;
  selected?: string;
  add?: boolean;
}) {
  const updated = new Set(
    (view.updates ?? [])
      .filter((update) => update.state === "update-available")
      .map((update) => update.package),
  );
  const groups = SKILL_GROUPS.map((group) => ({
    ...group,
    skills: view.skills.filter((skill) => skillGroup(skill) === group.key),
  })).filter((group) => group.skills.length > 0);
  return (
    <>
      {groups.length === 0 ? (
        <div class="config-sidebar-message">No skills found</div>
      ) : null}
      {groups.map((group) => (
        <div class="config-sidebar-group">
          <div class="config-sidebar-group-label">{group.label}</div>
          {group.skills.map((skill) => (
            <button
              type="button"
              class="config-sidebar-item"
              aria-current={
                add !== true && skill.filePath === selected ? "page" : undefined
              }
              hx-get={detailHref(view.cwd, skill.filePath)}
            >
              <span class="config-sidebar-text is-grow">{skill.name}</span>
              {skill.disableModelInvocation ? (
                <span class="skill-mode-badge">Manual</span>
              ) : null}
              {updated.has(skill.install?.package ?? "") ? (
                <span class="skill-update-indicator" title="Update available">
                  ↑
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/** One skill: what it is, who may call it, and where it came from. */
export function SkillDetail({
  cwd,
  skill,
  update,
  message,
  home,
}: {
  cwd: string;
  skill?: SkillInfo;
  update?: SkillUpdate;
  message?: string;
  home?: string;
}) {
  if (!skill) {
    return <div class="config-empty-state">Select a skill</div>;
  }
  const install = skill.install;
  const relative = skill.filePath.startsWith(`${cwd}/`)
    ? `./${skill.filePath.slice(cwd.length + 1)}`
    : shortPath(skill.filePath, home);
  const manual = skill.disableModelInvocation;
  const action = (extra: Record<string, string>) =>
    JSON.stringify({ cwd, path: skill.filePath, ...extra });
  return (
    <div class="config-detail-stack">
      <div class="skill-detail-heading">
        <div class="config-detail-header">
          <div class="config-detail-header-info">
            <ScopeTag scope={skill.scope} />
            <span class="config-detail-path" title={skill.filePath}>
              {relative}
            </span>
          </div>
          <div class="config-detail-actions">
            <ConfigSwitch
              checked={!manual}
              label={manual ? "Switch to Model-visible" : "Switch to Manual"}
              hx-post="/settings/skills/toggle"
              hx-vals={action({ disable: manual ? "" : "1" })}
            />
          </div>
        </div>
        <div class="skill-detail-status-row">
          <span class="skill-mode-label">
            {manual ? "Manual" : "Model-visible"}
          </span>
          {message === undefined ? null : (
            <span class="skill-detail-error">{message}</span>
          )}
        </div>
      </div>
      {install?.skillsShUrl ? (
        <ConfigField label="Source">
          <a
            class="skill-source-link"
            href={install.skillsShUrl}
            target="_blank"
            rel="noreferrer"
            title={install.skillsShUrl}
          >
            <span class="skill-source-link-text">
              {install.skillsShUrl.replace(/^https?:\/\//, "")} ↗
            </span>
          </a>
        </ConfigField>
      ) : null}
      {install ? (
        <ConfigField label="Version">
          <div class="skill-version-row">
            <span class="skill-version-value">
              {(install.versionHash ?? "unknown").slice(0, 8)}
            </span>
            {install.canCheckForUpdates ? (
              <ConfigButton
                small
                hx-post="/settings/skills/check"
                hx-vals={action({
                  package: install.package,
                  scope: install.scope,
                })}
              >
                Check
              </ConfigButton>
            ) : null}
            {update?.state === "update-available" ? (
              <span class="skill-version-value is-update">
                {(update.latestVersion ?? "").slice(0, 8)}
              </span>
            ) : null}
            {update === undefined ||
            update.state === "update-available" ? null : (
              <span
                class={`skill-update-status ${
                  update.state === "up-to-date"
                    ? "is-success"
                    : update.state === "error"
                      ? "is-error"
                      : "is-muted"
                }`}
              >
                {update.state === "up-to-date"
                  ? "Up to date"
                  : update.state === "unsupported"
                    ? "Automatic checks unavailable"
                    : (update.message ?? "Check failed")}
              </span>
            )}
            {update?.state === "update-available" ? (
              <ConfigButton
                variant="primary"
                small
                hx-post="/settings/skills/update"
                hx-vals={action({
                  package: install.package,
                  scope: install.scope,
                })}
              >
                Update
              </ConfigButton>
            ) : null}
          </div>
        </ConfigField>
      ) : null}
      <ConfigField label="Name">
        <span class="skill-name-value">{skill.name}</span>
      </ConfigField>
      <ConfigField label="Description">
        <span class="skill-description">{skill.description}</span>
      </ConfigField>
    </div>
  );
}

export function SkillSearchResults({
  hits,
  cwd,
  message,
}: {
  hits: SkillSearchHit[];
  cwd: string;
  message?: string;
}) {
  return (
    <div id="skill-search-results" class="skill-search-results">
      {message === undefined ? null : (
        <div role="status" class="config-message">
          {message}
        </div>
      )}
      {hits.length === 0 && message === undefined ? (
        <div class="config-message">No skills found</div>
      ) : null}
      {hits.map((hit) => {
        const at = hit.package.indexOf("@");
        const repo = at > -1 ? hit.package.slice(0, at) : hit.package;
        const name = at > -1 ? hit.package.slice(at + 1) : repo;
        return (
          <div class="skill-search-result">
            <div class="skill-search-info">
              <div class="skill-search-name">{name}</div>
              <div class="skill-search-meta">
                <span class="skill-search-repo">{repo}</span>
                <span class="skill-search-installs">{hit.installs}</span>
                {hit.url === "" ? null : (
                  <a
                    href={hit.url}
                    target="_blank"
                    rel="noreferrer"
                    class="skill-search-link"
                  >
                    skills.sh ↗
                  </a>
                )}
              </div>
            </div>
            <form
              class="skill-search-install"
              hx-post="/settings/skills/install"
              hx-target="#skill-search-results"
              hx-swap="outerHTML"
              hx-include=".skill-search-form [name=scope]"
            >
              <input type="hidden" name="cwd" value={cwd} />
              <input type="hidden" name="package" value={hit.package} />
              <ConfigButton type="submit" small>
                Install
              </ConfigButton>
            </form>
          </div>
        );
      })}
    </div>
  );
}

/** The detail pane in add mode: search skills.sh and install one. */
function AddSkillPanel({ view, home }: { view: SkillsView; home?: string }) {
  return (
    <div class="config-detail-stack is-full-height">
      <form
        class="skill-search-form"
        hx-post="/settings/skills/search"
        hx-target="#skill-search-results"
        hx-swap="outerHTML"
      >
        <div class="config-detail-title">Add skill</div>
        <input type="hidden" name="cwd" value={view.cwd} />
        <div class="skill-search-query">
          <input
            name="query"
            class="config-input"
            placeholder="e.g. react, testing, deploy"
            aria-label="Search skills"
          />
          <ConfigButton type="submit" variant="primary">
            Search
          </ConfigButton>
        </div>
        <div class="skill-search-scope">
          <ScopePicker name="scope" trusted={view.projectResourcesLoaded} />
          <span class="skill-search-scope-path">
            <span class="config-scope-global">→ ~/.pi/agent/skills/</span>
            <span class="config-scope-project">
              → {shortPath(view.cwd, home)}/.pi/skills/
            </span>
          </span>
        </div>
      </form>
      <SkillSearchResults
        hits={[]}
        cwd={view.cwd}
        message="Search skills.sh to discover and install skills for your agent."
      />
    </div>
  );
}

export function SkillsSection({
  view,
  selected,
  add,
  update,
  message,
  home,
}: {
  view: SkillsView;
  /** The skill to show; the first one when it is gone or not given. */
  selected?: string;
  /** The detail pane shows the add form instead of a skill. */
  add?: boolean;
  /** The result of the last single-skill check, for the version row. */
  update?: SkillUpdate;
  message?: string;
  home?: string;
}) {
  const skill =
    view.skills.find((entry) => entry.filePath === selected) ?? view.skills[0];
  const pending = (view.updates ?? []).filter(
    (entry) => entry.state === "update-available",
  ).length;
  return (
    <ConfigSplitView
      what="skills"
      trusted={view.projectResourcesLoaded}
      list={<SkillList view={view} selected={skill?.filePath} add={add} />}
      add={{
        label: "Add skill",
        href: `/settings/skills/detail?cwd=${encodeURIComponent(view.cwd)}&add=1`,
        open: add === true,
      }}
      detail={
        add === true ? (
          <AddSkillPanel view={view} home={home} />
        ) : (
          <div class="config-detail-stack is-fill">
            <SkillDetail
              cwd={view.cwd}
              skill={skill}
              update={update}
              message={message}
              home={home}
            />
          </div>
        )
      }
      status={
        pending === 0 ? (
          view.diagnostics.map((diagnostic) => <span>{diagnostic}</span>)
        ) : (
          <span class="skill-update-count">
            {String(pending)} {pending === 1 ? "update" : "updates"}
          </span>
        )
      }
      actions={
        view.skills.some((entry) => entry.install !== undefined) ? (
          <ConfigButton
            hx-post="/settings/skills/check"
            hx-vals={JSON.stringify({ cwd: view.cwd })}
          >
            Check updates
          </ConfigButton>
        ) : null
      }
    />
  );
}
