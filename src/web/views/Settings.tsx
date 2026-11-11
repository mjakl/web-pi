import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  type WebSettings,
} from "@core/web-settings";
import { ConfigButton, ConfigSwitch } from "./ConfigControls.tsx";
import { SettingsSectionIcon, ThemeIcon } from "./icons.tsx";

import { settingsUrl } from "@web/settings-url";
import { DialogHost } from "./Dialogs.tsx";

// Sections are full pages; actions inside them retain their HTMX targets.

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

/** Desktop tabs and the mobile GET form share the same explicit context. */
function SectionNav({
  active,
  cwd,
  session,
  hasProject,
}: {
  active: SettingsSection;
  cwd: string;
  session: string;
  hasProject: boolean;
}) {
  const usable = (section: (typeof SETTINGS_SECTIONS)[number]) =>
    !section.needsProject || hasProject;
  return (
    <>
      <form class="settings-mobile-nav" action="/settings" method="get">
        <input type="hidden" name="session" value={session} />
        <input type="hidden" name="cwd" value={cwd} />
        <select
          class="settings-mobile-section-picker"
          aria-label="Settings section"
          name="section"
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
        <ConfigButton type="submit">Go</ConfigButton>
      </form>
      <nav class="settings-section-tabs" aria-label="Settings">
        {SETTINGS_SECTIONS.map((section) =>
          usable(section) ? (
            <a
              href={settingsUrl(session, cwd, section.key)}
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

export function SettingsPage({
  section,
  cwd,
  session,
  hasProject,
  children,
}: {
  section: SettingsSection;
  cwd: string;
  session: string;
  hasProject: boolean;
  children?: unknown;
}) {
  const back = session
    ? `/sessions/${encodeURIComponent(session)}`
    : `/new?cwd=${encodeURIComponent(cwd)}`;
  return (
    <main
      class="settings-page"
      data-settings-url={settingsUrl(session, cwd, section)}
      data-session-id={session}
      data-cwd={cwd}
    >
      <div class="settings-page-surface">
        <header class="settings-page-header">
          <h1 class="settings-page-title">Settings</h1>
          <a class="settings-back" href={back}>
            ← Back to {session ? "conversation" : "workspace"}
          </a>
        </header>
        <SectionNav
          active={section}
          cwd={cwd}
          session={session}
          hasProject={hasProject}
        />
        <div class="settings-page-main">
          <div
            id="settings-body"
            class="settings-section-host"
            hx-target:inherited="#settings-body"
            hx-swap:inherited="innerHTML"
          >
            {children}
          </div>
        </div>
      </div>
      <div class="chat-notices">
        <div id="toasts" hx-preserve />
      </div>
      <DialogHost />
    </main>
  );
}
