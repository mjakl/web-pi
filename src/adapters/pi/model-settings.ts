import {
  sameModel,
  type ModelSettingsEdit,
  type ModelSettingsView,
} from "@core/model-settings";
import type { ModelOption } from "@core/ports";
import {
  type ModelRuntime,
  SettingsManager,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { projectTrustReloadOptions } from "./project-trust.ts";

function checkErrors(settings: SettingsManager): void {
  const errors = settings.drainErrors();
  if (errors.length)
    throw new Error(
      errors
        .map(
          (error) =>
            `${error.scope} settings: ${error.error.message}. Check Pi's ${error.scope} settings.json and reload Models.`,
        )
        .join("; "),
    );
}

function patterns(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    !value.every((entry: unknown) => typeof entry === "string")
  ) {
    throw new Error(
      "enabledModels must be an array of patterns. Repair Pi settings.json before saving.",
    );
  }
  return value;
}

export async function loadModelSettings(
  cwd: string,
  agentDir: string,
): Promise<SettingsManager> {
  // Do not read project settings until trust is known, including their load errors.
  const settings = SettingsManager.create(cwd || agentDir, agentDir, {
    projectTrusted: false,
  });
  if (cwd) {
    const trust = projectTrustReloadOptions(cwd, agentDir);
    settings.setProjectTrusted(
      trust ? await trust.resolveProjectTrust() : true,
    );
  }
  checkErrors(settings);
  patterns(settings.getGlobalSettings().enabledModels);
  patterns(settings.getProjectSettings().enabledModels);
  return settings;
}

export async function readModelSettings(
  runtime: ModelRuntime,
  settings: SettingsManager,
  available: ModelOption[],
): Promise<ModelSettingsView> {
  const global = patterns(settings.getGlobalSettings().enabledModels);
  const scope = await resolveModelScopeWithDiagnostics(global ?? [], runtime);
  const unavailable: string[] = [];
  for (const pattern of global ?? []) {
    const resolved = await resolveModelScopeWithDiagnostics([pattern], runtime);
    // A warning-bearing match is still a match, not an unavailable entry.
    if (resolved.scopedModels.length === 0) unavailable.push(pattern);
  }
  return {
    available,
    selected: global?.length
      ? scope.scopedModels.map(({ model }) => ({
          provider: model.provider,
          id: model.id,
        }))
      : available,
    patterns: global,
    projectPatterns: patterns(settings.getProjectSettings().enabledModels),
    unavailable,
    warnings: scope.diagnostics
      .filter((entry) => entry.code !== "no-match")
      .map((entry) => entry.message),
  };
}

/** Preserve untouched patterns; expand only patterns whose current matches were removed. */
export async function saveModelSettings(
  runtime: ModelRuntime,
  settings: SettingsManager,
  edit: ModelSettingsEdit,
): Promise<void> {
  checkErrors(settings);
  const original = patterns(settings.getGlobalSettings().enabledModels);
  if (JSON.stringify(original) !== JSON.stringify(edit.patterns)) {
    throw new Error(
      "Pi's global model selection changed. Reload Models before saving.",
    );
  }
  const available = await runtime.getAvailable();
  if (available.length === 0)
    throw new Error(
      "No models available. Configure a provider in Pi before changing the model list.",
    );
  let next: string[];
  if (edit.selected === null) {
    next = [];
  } else {
    const selected = edit.selected;
    if (!selected.length)
      throw new Error(
        "Keep at least one available model selected, or choose Use all models.",
      );
    if (
      selected.some(
        (choice) => !available.some((model) => sameModel(choice, model)),
      )
    ) {
      throw new Error(
        "A selected model is no longer available. Reload Models and try again.",
      );
    }
    const scope = await resolveModelScopeWithDiagnostics(
      original ?? [],
      runtime,
    );
    const current = original?.length
      ? scope.scopedModels
      : available.map((model) => ({ model, thinkingLevel: undefined }));
    if (
      current.length === selected.length &&
      current.every(({ model }) =>
        selected.some((choice) => sameModel(choice, model)),
      )
    )
      return;
    const exact = (entry: ScopedModel) =>
      `${entry.model.provider}/${entry.model.id}${entry.thinkingLevel === undefined ? "" : `:${entry.thinkingLevel}`}`;
    next = [];
    for (const pattern of original ?? []) {
      const { scopedModels: matches } = await resolveModelScopeWithDiagnostics(
        [pattern],
        runtime,
      );
      if (
        matches.every(({ model }) =>
          selected.some((choice) => sameModel(choice, model)),
        )
      ) {
        next.push(pattern);
      } else {
        for (const entry of matches) {
          if (selected.some((choice) => sameModel(choice, entry.model))) {
            next.push(
              exact(
                current.find(({ model }) => sameModel(model, entry.model)) ??
                  entry,
              ),
            );
          }
        }
      }
    }
    const resolved = await resolveModelScopeWithDiagnostics(next, runtime);
    for (const choice of selected) {
      if (!resolved.scopedModels.some(({ model }) => sameModel(choice, model)))
        next.push(`${choice.provider}/${choice.id}`);
    }
    const result = await resolveModelScopeWithDiagnostics(next, runtime);
    if (
      result.scopedModels.length !== selected.length ||
      result.scopedModels.some(({ model, thinkingLevel }) => {
        const previous = current.find((entry) => sameModel(entry.model, model));
        return (
          !selected.some((choice) => sameModel(choice, model)) ||
          (previous !== undefined && thinkingLevel !== previous.thinkingLevel)
        );
      })
    ) {
      throw new Error(
        "Pi cannot represent this exact selection with model patterns. Check for case-only or ambiguous provider/model IDs in models.json, then reload Models.",
      );
    }
  }
  settings.setEnabledModels(next);
  await settings.flush();
  checkErrors(settings);
}
