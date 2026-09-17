import type { ModelOption } from "@core/ports";

export type ModelIdentity = { provider: string; id: string };
export type ModelSettingsView = {
  available: ModelOption[];
  selected: ModelIdentity[];
  /** Null distinguishes an absent global setting from an explicit empty array. */
  patterns: string[] | null;
  projectPatterns: string[] | null;
  unavailable: string[];
  warnings: string[];
};
export type ModelSettingsEdit = {
  /** Null is the deliberate Use all models action, not an empty selection. */
  selected: ModelIdentity[] | null;
  /** Reject a stale form rather than overwrite another editor's model scope. */
  patterns: string[] | null;
};

export function modelSettingsEdit(
  selected: unknown,
  patterns: unknown,
): ModelSettingsEdit {
  if (
    patterns !== null &&
    (!Array.isArray(patterns) ||
      !patterns.every((value: unknown) => typeof value === "string"))
  ) {
    throw new Error(
      "Invalid saved model patterns. Reload Models and try again.",
    );
  }
  if (
    selected !== null &&
    (!Array.isArray(selected) ||
      !selected.every(
        (value: unknown) =>
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          "provider" in value &&
          typeof value.provider === "string" &&
          value.provider.length > 0 &&
          "id" in value &&
          typeof value.id === "string" &&
          value.id.length > 0 &&
          Object.keys(value).length === 2,
      ))
  ) {
    throw new Error("Invalid model selection.");
  }
  return { selected: selected as ModelIdentity[] | null, patterns: patterns };
}

export function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.provider === b.provider && a.id === b.id;
}
