import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Pi's SettingsManager records a settings file it could not read or write
 * instead of throwing, so a caller that wrote through it drains them after
 * `flush()`: otherwise a failed save looks like success.
 */
export function checkSettingsErrors(settings: SettingsManager): void {
  const messages = settings
    .drainErrors()
    .map(
      (error) =>
        `${error.scope} settings: ${error.error.message}. Check Pi's ${error.scope} settings.json.`,
    );
  // A load error is recorded again on every reload.
  if (messages.length) throw new Error([...new Set(messages)].join("; "));
}
