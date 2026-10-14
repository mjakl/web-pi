import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  type WebSettings,
} from "@core/web-settings";
import { ConfigButton, ConfigSwitch } from "./ConfigControls.tsx";
import { SettingsSectionIcon, ThemeIcon } from "./icons.tsx";

// Settings is pi-web's modal over the app: a 1080px surface with a tabbed
// header over one section. Every class name is pi-web's
// (components/SettingsPanel.tsx, SettingsUi.tsx; app/settings.css). This
// module holds the dialog and General; Models, Skills and Plugins have their
// own (ModelSettings.tsx, SkillSettings.tsx, PluginSettings.tsx). Sections
// are server-rendered pages swapped by HTMX, not React state.

/** pi-web's order: light, dark, then system. */
const THEME_OPTIONS = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "auto", label: "System" },
] as const;

export const SETTINGS_SECTIONS = [
  { key: "general", label: "General", needsProject: false },
  { key: "models", label: "Models", needsProject: false },
  { key: "skills", label: "Skills", needsProject: true },
  { key: "plugins", label: "Plugins", needsProject: true },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
}

/** A section that needs a folder falls back to general when there is none. */
export function resolveSection(
  value: string | undefined,
  hasProject: boolean,
): SettingsSection {
  if (value === undefined || !isSettingsSection(value)) return "general";
  const section = SETTINGS_SECTIONS.find((entry) => entry.key === value);
  return section && section.needsProject && !hasProject ? "general" : value;
}

function sectionHref(section: SettingsSection, cwd: string): string {
  const query = new URLSearchParams({ section });
  if (cwd !== "") query.set("cwd", cwd);
  return `/settings?${query.toString()}`;
}

/** Desktop tabs and the mobile picker render the same list, one hidden. */
function SectionNav({ active, cwd }: { active: SettingsSection; cwd: string }) {
  const usable = (section: (typeof SETTINGS_SECTIONS)[number]) =>
    !section.needsProject || cwd !== "";
  return (
    <>
      <select
        class="settings-mobile-section-picker"
        aria-label="Settings"
        // A native select is the whole mobile navigation: no script, no menu.
        hx-get="/settings"
        hx-target="body"
        hx-swap="innerHTML"
        hx-push-url="true"
        name="section"
        hx-include="#settings-cwd"
        hx-trigger="change"
      >
        {SETTINGS_SECTIONS.map((section) => (
          <option
            value={section.key}
            selected={section.key === active}
            disabled={!usable(section)}
          >
            {section.label}
          </option>
        ))}
      </select>
      <nav class="settings-section-tabs" aria-label="Settings">
        {SETTINGS_SECTIONS.map((section) =>
          usable(section) ? (
            <a
              href={sectionHref(section.key, cwd)}
              class="settings-section-tab"
              title={section.label}
              aria-current={section.key === active ? "page" : undefined}
            >
              <SettingsSectionIcon section={section.key} />
              <span>{section.label}</span>
            </a>
          ) : (
            <button
              type="button"
              class="settings-section-tab"
              disabled
              title="Open a project to configure this section"
            >
              <SettingsSectionIcon section={section.key} />
              <span>{section.label}</span>
            </button>
          ),
        )}
      </nav>
    </>
  );
}

export function GeneralSettings({ settings }: { settings: WebSettings }) {
  return (
    <div class="settings-general" data-web-settings={JSON.stringify(settings)}>
      <h2 class="settings-general-title">General</h2>
      <p class="settings-general-description">
        Appearance, token threshold, sound and system prompt addition are shared
        across browsers and projects.
      </p>
      <p
        id="web-settings-status"
        class="settings-general-description"
        role="status"
        aria-live="polite"
      ></p>
      <section class="settings-general-section">
        <h3 class="settings-general-heading">Appearance</h3>
        <p class="settings-general-description">
          Select a theme or follow your system preference.
        </p>
        <div
          role="radiogroup"
          aria-label="Appearance"
          class="settings-theme-options"
        >
          {THEME_OPTIONS.map((option) => (
            <label class="settings-theme-option">
              <input
                type="radio"
                class="sr-only"
                name="theme"
                value={option.id}
                checked={settings.theme === option.id}
              />
              <ThemeIcon preference={option.id} />
              <span class="settings-theme-option-label">{option.label}</span>
            </label>
          ))}
        </div>
      </section>
      <section class="settings-general-section">
        <h3 class="settings-general-heading">Dumb zone</h3>
        <p class="settings-general-description">
          Highlight context usage and Compact when the current context reaches
          this many tokens.
        </p>
        <div class="settings-general-option">
          <label for="dumb-zone-tokens">Token threshold</label>
          <input
            id="dumb-zone-tokens"
            class="settings-number-input"
            type="number"
            min="1"
            step="1"
            max={String(Number.MAX_SAFE_INTEGER)}
            value={String(settings.warnTokens)}
          />
        </div>
      </section>
      <section class="settings-general-section">
        <h3 class="settings-general-heading">Completion sound</h3>
        <p class="settings-general-description">
          Play a tone when a task finishes.
        </p>
        <div class="settings-general-option">
          <span>Completion sound</span>
          <ConfigSwitch
            id="sound-toggle"
            checked={settings.sound}
            label="Completion sound"
          />
        </div>
      </section>
      <section class="settings-general-section">
        <h3 class="settings-general-heading">
          <label for="system-prompt-addition">System prompt addition</label>
        </h3>
        <p id="system-prompt-help" class="settings-general-description">
          Replaces only web-pi’s addition, not Pi’s base system prompt or your
          other instructions. Save empty text to add nothing. Reset restores the
          built-in default.
        </p>
        <p id="system-prompt-timing" class="settings-general-description">
          Applies to new sessions and stopped sessions when activated again.
          Already active sessions keep their addition, including after /reload
          or a browser refresh. Use Stop, then Activate in the session menu to
          apply it to an active session.
        </p>
        <textarea
          id="system-prompt-addition"
          class="settings-prompt-input"
          rows={6}
          aria-describedby="system-prompt-help system-prompt-timing"
        >
          {settings.systemPromptAddition ?? DEFAULT_SYSTEM_PROMPT_ADDITION}
        </textarea>
        <div class="settings-prompt-actions">
          <ConfigButton id="system-prompt-save" variant="primary">
            Save
          </ConfigButton>
          <ConfigButton id="system-prompt-reset">Reset to default</ConfigButton>
          <span
            id="system-prompt-status"
            class="settings-general-description"
            role="status"
            aria-live="polite"
          ></span>
        </div>
      </section>
      <section class="settings-general-section" id="push-settings">
        <h3 class="settings-general-heading">Push notifications</h3>
        <p class="settings-general-description">
          Notify this browser when a run finishes in this web server. Delivery
          depends on your browser and operating system. On iPhone or iPad, open
          web-pi from the Home Screen.
        </p>
        <div class="settings-general-option">
          <span id="push-status" role="status" aria-live="polite">
            Checking availability…
          </span>
          <ConfigButton
            id="push-toggle"
            disabled
            aria-describedby="push-status"
          >
            Subscribe
          </ConfigButton>
        </div>
      </section>
    </div>
  );
}

/**
 * pi-web opens settings over the workspace, which stays mounted behind the
 * modal, so this is an overlay the shell renders over whatever page the
 * reader was on. `back` is where the close button and Escape lead. A request
 * from inside the section replaces the section unless it names another
 * target.
 */
export function SettingsDialog({
  section,
  cwd,
  back,
  children,
}: {
  section: SettingsSection;
  cwd: string;
  back: string;
  children?: unknown;
}) {
  return (
    <>
      <input id="settings-cwd" type="hidden" name="cwd" value={cwd} />
      <dialog
        class="settings-dialog"
        aria-label="Settings"
        data-modal
        data-close-href={back}
        data-backdrop-close
        open
      >
        <div class="settings-dialog-surface" tabindex={-1} autofocus>
          <div class="settings-dialog-header">
            <strong class="settings-dialog-title">Settings</strong>
            <SectionNav active={section} cwd={cwd} />
            <a
              class="config-close-button settings-dialog-close"
              href={back}
              title="Close"
              aria-label="Close"
            >
              ×
            </a>
          </div>
          <main class="settings-dialog-main">
            <div
              id="settings-body"
              class="settings-section-host"
              hx-target:inherited="#settings-body"
              hx-swap:inherited="innerHTML"
            >
              {children}
            </div>
          </main>
        </div>
      </dialog>
    </>
  );
}
