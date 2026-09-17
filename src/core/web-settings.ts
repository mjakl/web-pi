import { DEFAULT_WARN_TOKENS } from "@core/context-usage";

export const DEFAULT_SYSTEM_PROMPT_ADDITION =
  "The interface renders Markdown with tables, task lists, links, and fenced code blocks. LaTeX/math typesetting is not supported; use plain text or code for math.";

export type WebSettings = {
  warnTokens: number;
  theme: "light" | "dark" | "auto";
  sound: boolean;
  /** Null follows Pi's scope; an empty list deliberately offers no choices. */
  visibleModels: { provider: string; id: string }[] | null;
  /** Null follows the built-in default; an empty string disables the addition. */
  systemPromptAddition: string | null;
};

export const DEFAULT_WEB_SETTINGS: WebSettings = {
  warnTokens: DEFAULT_WARN_TOKENS,
  theme: "auto",
  sound: true,
  visibleModels: null,
  systemPromptAddition: null,
};

/** Reject the whole edit rather than quietly saving only some fields. */
export function webSettingsPatch(value: unknown): Partial<WebSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected web settings");
  }
  const patch: Partial<WebSettings> = {};
  for (const [key, setting] of Object.entries(value) as [string, unknown][]) {
    if (
      key === "warnTokens" &&
      typeof setting === "number" &&
      Number.isSafeInteger(setting) &&
      setting > 0
    ) {
      patch.warnTokens = setting;
    } else if (
      key === "theme" &&
      (setting === "light" || setting === "dark" || setting === "auto")
    ) {
      patch.theme = setting;
    } else if (key === "sound" && typeof setting === "boolean") {
      patch.sound = setting;
    } else if (
      key === "visibleModels" &&
      (setting === null ||
        (Array.isArray(setting) &&
          setting.every(
            (entry: unknown) =>
              !!entry &&
              typeof entry === "object" &&
              !Array.isArray(entry) &&
              Object.keys(entry).length === 2 &&
              "provider" in entry &&
              typeof entry.provider === "string" &&
              entry.provider.length > 0 &&
              "id" in entry &&
              typeof entry.id === "string" &&
              entry.id.length > 0,
          )))
    ) {
      patch.visibleModels = setting as WebSettings["visibleModels"];
    } else if (
      key === "systemPromptAddition" &&
      (setting === null || typeof setting === "string")
    ) {
      patch.systemPromptAddition = setting;
    } else {
      throw new Error(`Invalid web setting: ${key}`);
    }
  }
  return patch;
}

export type WebSettingsStore = {
  get(): WebSettings;
  update(patch: Partial<WebSettings>): WebSettings;
};
