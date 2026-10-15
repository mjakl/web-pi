import { sameModel, type ModelIdentity } from "./model-settings.ts";
import type { ModelOption, ThinkingLevel } from "./ports.ts";

// Which model a new session starts on, and which of those choices are written
// back to Pi's settings as the new default.

/** Every level Pi knows, in the order a picker shows them. */
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi writes the level as a plain string; only these seven are levels. */
export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as string[]).includes(value);
}

/** The configured default when it is still in scope, else the first model. */
export function initialModel(
  models: readonly ModelOption[],
  preferred?: ModelIdentity,
): ModelOption | undefined {
  const match = preferred
    ? models.find((model) => sameModel(model, preferred))
    : undefined;
  return match ?? models[0];
}

/** Only pass a scope pin to startup; unpinned models inherit Pi's defaults. */
export function initialThinking(
  model: ModelOption | undefined,
): ThinkingLevel | undefined {
  return model?.pin;
}

export type StartupChoice = {
  model?: ModelIdentity;
  thinkingLevel?: ThinkingLevel;
};

/**
 * pi-web's `persistExplicitStartupPreferences`: only a choice the reader
 * actually made is written back, and only when Pi honoured it.
 *
 * - the default model is written when the session really started on the
 *   requested model, so a silent fallback never becomes the new default;
 * - the thinking level is written unless it was clamped to `off` because the
 *   model cannot reason at all.
 */
export function startupWrites(
  explicit: StartupChoice,
  effective: {
    model: ModelIdentity;
    thinkingLevel: ThinkingLevel;
    supportsThinking: boolean;
  },
): StartupChoice {
  const keepModel =
    explicit.model !== undefined && sameModel(explicit.model, effective.model);
  const keepLevel =
    explicit.thinkingLevel !== undefined &&
    (effective.supportsThinking || effective.thinkingLevel !== "off");
  return {
    ...(keepModel ? { model: effective.model } : {}),
    ...(keepLevel ? { thinkingLevel: effective.thinkingLevel } : {}),
  };
}
