import {
  type Api,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import {
  initialModel,
  initialThinking,
  type StartupChoice,
} from "@core/models";
import type {
  ModelCatalog,
  ModelListing,
  ModelOption,
  ThinkingLevel,
} from "@core/ports";
import {
  type AgentSessionServices,
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createPiServicePreparations,
  type PiServicePreparations,
} from "./session-services.ts";
import {
  loadModelSettings,
  readModelSettings,
  saveModelSettings,
} from "./model-settings.ts";

/** The menu and session startup must resolve the same scope and reasoning pins. */
export async function resolveModelListing(
  runtime: ModelRuntime,
  settings: SettingsManager,
  fullCatalog = false,
): Promise<ModelListing> {
  const available = await runtime.getAvailable();
  const describe = (model: (typeof available)[number]): ModelOption => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevels: getSupportedThinkingLevels(model).map((level) => ({
      level,
      label: model.thinkingLevelMap?.[level] ?? level,
    })),
  });
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  const preferred =
    provider !== undefined && model !== undefined
      ? { preferred: { provider, id: model } }
      : {};
  const patterns = settings.getEnabledModels() ?? [];
  if (fullCatalog || patterns.length === 0) {
    return { models: available.map(describe), warnings: [], ...preferred };
  }
  const scope = await resolveModelScopeWithDiagnostics(patterns, runtime);
  const warnings = scope.diagnostics.map((diagnostic) => diagnostic.message);
  const scoped = scope.scopedModels.map((entry) => ({
    ...describe(entry.model),
    ...(entry.thinkingLevel === undefined ? {} : { pin: entry.thinkingLevel }),
  }));
  return { models: scoped, warnings, ...preferred };
}

/**
 * The model and reasoning level a new session starts on: the reader's choice,
 * else Pi's preferred or first model in scope. Pi's cycling scope supplies
 * defaults and reasoning pins, not an allowlist for deliberate web choices.
 */
export async function startupModel(
  runtime: ModelRuntime,
  settings: SettingsManager,
  startup: StartupChoice,
): Promise<{ model?: Model<Api>; thinkingLevel?: ThinkingLevel }> {
  const listing = await resolveModelListing(runtime, settings);
  const requested = startup.model;
  const selected = requested
    ? (await resolveModelListing(runtime, settings, true)).models.find(
        (model) =>
          model.provider === requested.provider &&
          model.id === requested.modelId,
      )
    : initialModel(listing.models, listing.preferred);
  if (requested && !selected) {
    throw new Error(
      `Model is not available: ${requested.provider}/${requested.modelId}`,
    );
  }
  const scoped = listing.models.find(
    (model) =>
      model.provider === selected?.provider && model.id === selected.id,
  );
  const thinkingLevel =
    startup.thinkingLevel ?? initialThinking(scoped ?? selected);
  const model = selected && runtime.getModel(selected.provider, selected.id);
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

export function serviceDiagnostics(services: AgentSessionServices): string[] {
  const extensions = services.resourceLoader.getExtensions();
  return [
    ...services.diagnostics.map((entry) => entry.message),
    ...extensions.errors.map(
      (entry) => `Failed to load extension "${entry.path}": ${entry.error}`,
    ),
    ...(extensions.warnings ?? []).map(
      (entry) => `Extension "${entry.path}": ${entry.warning}`,
    ),
  ];
}

/** Project discovery and startup share unbound services; live queries name their owner. */
export function createPiModelCatalog(options: {
  agentDir: string;
  preparations?: PiServicePreparations;
  sessionServices?: (id: string) => AgentSessionServices | undefined;
}): ModelCatalog {
  const preparations =
    options.preparations ?? createPiServicePreparations(options);
  async function stateFor(cwd: string, sessionId?: string) {
    const owned =
      sessionId === undefined
        ? undefined
        : options.sessionServices?.(sessionId);
    if (!owned && !cwd)
      throw new Error("Choose a folder before loading Models.");
    const services = owned ?? (await preparations.prepare(cwd)).services;
    const settings = await loadModelSettings(services.cwd, options.agentDir);
    return { services, runtime: services.modelRuntime, settings };
  }
  return {
    async settings(cwd, sessionId) {
      const { services, runtime, settings } = await stateFor(cwd, sessionId);
      const full = await resolveModelListing(runtime, settings, true);
      const view = await readModelSettings(runtime, settings, full.models);
      view.warnings.push(...serviceDiagnostics(services));
      return view;
    },
    async saveSettings(cwd, edit, sessionId) {
      const { runtime, settings } = await stateFor(cwd, sessionId);
      await saveModelSettings(runtime, settings, edit);
    },
    async listAvailable(cwd, sessionId) {
      const { runtime, settings } = await stateFor(cwd, sessionId);
      const available = await resolveModelListing(runtime, settings, true);
      const scoped = await resolveModelListing(runtime, settings);
      return available.models.map(
        (model) =>
          scoped.models.find(
            (option) =>
              option.provider === model.provider && option.id === model.id,
          ) ?? model,
      );
    },
    async list(cwd, sessionId) {
      const { services, runtime, settings } = await stateFor(cwd, sessionId);
      const listing = await resolveModelListing(runtime, settings);
      listing.warnings.push(...serviceDiagnostics(services));
      return listing;
    },
    async resolveThinking(cwd, option, level, continuing = false, sessionId) {
      const { runtime, settings } = await stateFor(cwd, sessionId);
      const model = runtime.getModel(option.provider, option.id);
      if (!model)
        throw new Error(`Model unavailable: ${option.provider}/${option.id}`);
      const requested =
        level ??
        (continuing
          ? undefined
          : (option.pin ??
            settings.getModelThinkingLevel(model.provider, model.id)));
      // Pi's SDK startup fallback is medium (the constant is not exported).
      return clampThinkingLevel(
        model,
        requested ?? settings.getDefaultThinkingLevel() ?? "medium",
      );
    },
    invalidate(cwd) {
      preparations.invalidate(cwd);
    },
  };
}
