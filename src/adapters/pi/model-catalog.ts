import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { ModelCatalog, ModelListing, ModelOption } from "@core/ports";
import {
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  loadModelSettings,
  readModelSettings,
  saveModelSettings,
} from "./model-settings.ts";

const CACHE_TTL_MS = 60_000;

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
 * Credentials and model metadata are edited in the Pi terminal, never here,
 * so nothing invalidates the cache when they change. Stamping it with the
 * modification times of credentials, model metadata and settings makes external
 * changes show up on the next request instead of after the whole TTL. Opaque: only
 * equality matters.
 */
export function agentConfigStamp(agentDir: string): string {
  return ["auth.json", "models.json", "settings.json"]
    .map((name) => {
      try {
        return String(statSync(join(agentDir, name)).mtimeMs);
      } catch {
        return "-";
      }
    })
    .join(":");
}

/**
 * Models Pi has credentials for, narrowed by the `enabledModels` setting.
 * Built from auth.json and models.json only, so listing never loads project
 * extensions. Unmatched patterns are reported without exposing all models.
 */
// ponytail: extension-registered providers are missing; read them from the
// live session's runtime when someone misses a model.
export function createPiModelCatalog(options: {
  agentDir: string;
}): ModelCatalog {
  const cache = new Map<
    string,
    { expiresAt: number; stamp: string; state: ReturnType<typeof load> }
  >();

  async function load(cwd: string) {
    const runtime = await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
    });
    const settings = await loadModelSettings(cwd, options.agentDir);
    const listing = await resolveModelListing(runtime, settings);
    const full = await resolveModelListing(runtime, settings, true);
    const available = full.models.map(
      (model) =>
        listing.models.find(
          (scoped) =>
            scoped.provider === model.provider && scoped.id === model.id,
        ) ?? model,
    );
    return { runtime, settings, listing, available };
  }

  function stateFor(cwd: string) {
    const stamp = `${agentConfigStamp(options.agentDir)}:${agentConfigStamp(join(cwd, ".pi"))}`;
    const hit = cache.get(cwd);
    if (hit && hit.expiresAt > Date.now() && hit.stamp === stamp) {
      return hit.state;
    }
    const state = load(cwd);
    cache.set(cwd, {
      stamp,
      expiresAt: Date.now() + CACHE_TTL_MS,
      state,
    });
    state.catch(() => cache.delete(cwd));
    return state;
  }

  return {
    async settings(cwd) {
      const { runtime, available } = await stateFor(cwd);
      return readModelSettings(
        runtime,
        await loadModelSettings(cwd, options.agentDir),
        available,
      );
    },
    async saveSettings(cwd, edit) {
      const { runtime } = await stateFor(cwd);
      try {
        await saveModelSettings(
          runtime,
          await loadModelSettings(cwd, options.agentDir),
          edit,
        );
      } finally {
        // A global write affects every folder, including failures after a partial write.
        cache.clear();
      }
    },
    async listAvailable(cwd) {
      return (await stateFor(cwd)).available;
    },
    async list(cwd) {
      return (await stateFor(cwd)).listing;
    },
    async resolveThinking(cwd, option, level, continuing = false) {
      const { runtime, settings } = await stateFor(cwd);
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
      if (cwd === undefined) cache.clear();
      else cache.delete(cwd);
    },
  };
}
