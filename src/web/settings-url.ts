import type { SettingsSection } from "@web/views/Settings";

/** Even an empty session is explicit: another tab's cookie cannot choose it. */
export function settingsUrl(
  session: string,
  cwd: string,
  section?: SettingsSection,
): string {
  return `/settings?${new URLSearchParams({ session, cwd, ...(section ? { section } : {}) })}`;
}
