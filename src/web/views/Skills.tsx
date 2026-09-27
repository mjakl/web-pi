import type { SlashCommand } from "@core/composer";
import type { SkillSelection } from "@core/ports";
import { ChevronDownIcon } from "./icons.tsx";

/** A fragment loaded when the Skills popover opens. Identity is the discovered skill's file path, not its display name. */
export function SkillsMenu({ commands }: { commands: SlashCommand[] }) {
  return (
    <div
      class="composer-skills-list"
      role="listbox"
      aria-label="Select skills"
      aria-multiselectable="true"
    >
      {commands
        .filter(
          (command) =>
            command.source === "skill" && typeof command.skillId === "string",
        )
        .map((command) => (
          <button
            type="button"
            role="option"
            class="menu-item composer-skill-option"
            aria-selected="false"
            data-skill-id={command.skillId}
            data-skill-name={command.name.slice("skill:".length)}
            data-skill-search={`${command.name} ${command.description}`}
          >
            <span class="composer-model-check-space" aria-hidden="true" />
            <span
              class="composer-skill-label"
              title={command.name.slice("skill:".length)}
            >
              {command.name.slice("skill:".length)}
            </span>
            {command.manual ? (
              <span class="composer-command-manual">Manual</span>
            ) : null}
            {command.description ? (
              <span class="composer-skill-description">
                {command.description}
              </span>
            ) : null}
          </button>
        ))}
      {commands.every(
        (command) =>
          command.source !== "skill" || typeof command.skillId !== "string",
      ) ? (
        <div class="composer-skills-empty">No skills found</div>
      ) : null}
    </div>
  );
}

export function SkillsSelector({
  sessionId,
  cwd,
  skills,
}: {
  sessionId?: string;
  cwd?: string;
  skills?: SkillSelection[];
}) {
  return (
    <div
      class="skills-selector is-composer"
      id="skills-selector"
      data-skills-url={
        sessionId
          ? `/sessions/${encodeURIComponent(sessionId)}/skills`
          : `/workspaces/skills?cwd=${encodeURIComponent(cwd ?? "")}`
      }
    >
      <input
        type="hidden"
        name="skills"
        id="composer-skills"
        value={JSON.stringify(skills ?? [])}
      />
      <button
        type="button"
        id="skills-trigger"
        class="anchor-skills-selector"
        popovertarget="skills-menu"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-label="Skills"
        title="Select skills"
      >
        <span id="skills-label">
          Skills{skills?.length ? ` (${String(skills.length)})` : ""}
        </span>
        <ChevronDownIcon />
      </button>
      <div
        id="skills-menu"
        popover="auto"
        class="anchored-menu menu-surface opens-up menu-skills-selector"
        role="dialog"
        aria-label="Skills"
      >
        <div class="composer-skills-filter">
          <input
            id="skills-filter"
            class="menu-filter"
            type="search"
            placeholder="Search skills…"
            aria-label="Search skills"
            autocomplete="off"
            spellcheck={false}
          />
        </div>
        <div
          id="skills-results"
          class="composer-skills-results"
          role="listbox"
          aria-label="Select skills"
          aria-multiselectable="true"
        />
      </div>
    </div>
  );
}
