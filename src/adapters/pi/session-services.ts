import type { SlashCommand } from "@core/composer";
import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  type WebSettingsStore,
} from "@core/web-settings";
import type { ImageAttachment } from "@core/ports";
import {
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  ExtensionRunner,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type BashOperations,
  type InlineExtension,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  createProjectBashExtension,
  preferUserBashExtension,
} from "./bash-env.ts";
import { projectTrustReloadOptions } from "./project-trust.ts";

export type PreparedSession = {
  services: AgentSessionServices;
  queuedImages: Map<string, ImageAttachment[]>;
};
export type PiServicePreparations = ReturnType<
  typeof createPiServicePreparations
>;

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino].join(":");
  } catch {
    return "-";
  }
}

// Pi creates an empty auth file on first access. That is not a config change.
function authStamp(agentDir: string): string {
  let content = "{}";
  try {
    content = readFileSync(join(agentDir, "auth.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return createHash("sha256").update(content).digest("hex");
}

// Model preferences are reprojected, not a reason to execute factories again.
function resourceSettingsStamp(agentDir: string): string {
  const path = join(agentDir, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const modelPreferences = [
      "enabledModels",
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "modelThinkingLevels",
    ];
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(settings).filter(
          ([key]) => !modelPreferences.includes(key),
        ),
      ),
    );
  } catch {
    return fileStamp(path);
  }
}

/**
 * The `/` menu Pi offers a session: extension commands under the invocation
 * names Pi gives duplicates (`name:2`), prompt templates, and skills, those
 * Pi may not invoke on its own marked so the menu can say who may run them.
 */
export function slashCommands(
  runner: ExtensionRunner,
  loader: ResourceLoader,
): SlashCommand[] {
  return [
    ...runner.getRegisteredCommands().map((command): SlashCommand => ({
      name: command.invocationName,
      description: command.description ?? "",
      source: "extension",
    })),
    ...loader.getPrompts().prompts.map((prompt): SlashCommand => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt",
    })),
    ...loader.getSkills().skills.map((skill): SlashCommand => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      skillId: skill.filePath,
      ...(skill.disableModelInvocation ? { manual: true } : {}),
    })),
  ];
}

/** Unbound services only. A claim removes ownership before its first await. */
export function createPiServicePreparations(options: {
  agentDir: string;
  webSettings?: WebSettingsStore;
  extensions?: InlineExtension[];
  bashOperations?: BashOperations;
}) {
  // Retain a few recently selected folders, not one runtime per saved transcript.
  const cache = new Map<
    string,
    { stamp: string; state: Promise<PreparedSession> }
  >();
  async function load(cwd: string): Promise<PreparedSession> {
    // Capture once: even resource reloads keep this runtime's addition stable.
    const addition =
      options.webSettings?.get().systemPromptAddition ??
      DEFAULT_SYSTEM_PROMPT_ADDITION;
    const settingsManager = SettingsManager.create(cwd, options.agentDir, {
      projectTrusted: false,
    });
    const trust = projectTrustReloadOptions(cwd, options.agentDir);
    const queuedImages = new Map<string, ImageAttachment[]>();
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      settingsManager,
      resourceLoaderOptions: {
        appendSystemPromptOverride: (base) =>
          addition === "" ? base : [...base, addition],
        extensionFactories: [
          {
            name: "codemode",
            builtin: true,
            replaceable: true,
            factory: createCodemodeExtension(),
          },
          {
            name: "tool-search",
            builtin: true,
            replaceable: true,
            factory: createToolSearchExtension(),
          },
          {
            name: "mcp",
            builtin: true,
            replaceable: true,
            factory: createMcpExtension(),
          },
          createProjectBashExtension({
            cwd,
            agentDir: options.agentDir,
            settings: settingsManager,
            ...(options.bashOperations
              ? { operations: options.bashOperations }
              : {}),
          }),
          ...(options.extensions ?? []),
          {
            name: "web-pi-queue-images",
            hidden: true,
            factory(pi) {
              // Inline extensions follow discovered ones. Selected prompts are
              // already expanded; observe after user hooks to key their images
              // by the final queued text, including transformed attachments.
              pi.on("input", (event) => {
                if (event.streamingBehavior) {
                  const images = event.images?.map(({ data, mimeType }) => ({
                    data,
                    mimeType,
                  }));
                  if (images?.length) queuedImages.set(event.text, images);
                  else queuedImages.delete(event.text);
                }
                return { action: "continue" };
              });
            },
          },
        ],
        extensionsOverride: (base) => {
          const loaded = preferUserBashExtension(base);
          // MCP uses Pi's process-wide directory, not the services' agentDir.
          // Check after exclusions/replacements, and again on resource reload.
          if (
            loaded.extensions.some(
              (extension) => extension.path === "builtin:mcp",
            ) &&
            resolve(getAgentDir()) !== resolve(options.agentDir)
          ) {
            throw new Error(
              'Built-in MCP requires the runtime agent directory to match Pi\'s process-wide directory. Set PI_CODING_AGENT_DIR to the intended agent directory before starting web-pi, then restart. Alternatively, disable built-in MCP with extensions: ["-builtin:mcp"].',
            );
          }
          return loaded;
        },
      },
      ...(trust ? { resourceLoaderReloadOptions: trust } : {}),
    });

    return { services, queuedImages };
  }
  function stateFor(cwd: string) {
    const folder = resolve(cwd || options.agentDir);
    const stamp = [
      authStamp(options.agentDir),
      fileStamp(join(options.agentDir, "models.json")),
      fileStamp(join(options.agentDir, "trust.json")),
      resourceSettingsStamp(options.agentDir),
      fileStamp(join(folder, ".pi", "settings.json")),
      options.webSettings?.get().systemPromptAddition,
    ].join(":");
    const hit = cache.get(folder);
    if (hit?.stamp === stamp) return hit.state;
    const state = load(folder);
    cache.delete(folder);
    cache.set(folder, { stamp, state });
    if (cache.size > 4) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    void state.catch(() => {
      if (cache.get(folder)?.state === state) cache.delete(folder);
    });
    return state;
  }
  return {
    prepare: stateFor,
    /** The menu a session started in `cwd` would offer, without one. */
    async commands(cwd: string): Promise<SlashCommand[]> {
      const { services } = await stateFor(cwd);
      const { extensions, runtime } = services.resourceLoader.getExtensions();
      // Never bound: only here for Pi's naming of duplicate commands.
      const runner = new ExtensionRunner(
        extensions,
        runtime,
        services.cwd,
        SessionManager.inMemory(services.cwd),
        new ModelRegistry(services.modelRuntime),
      );
      return slashCommands(runner, services.resourceLoader);
    },
    claim(cwd: string) {
      const state = stateFor(cwd);
      cache.delete(resolve(cwd || options.agentDir));
      return state;
    },
    invalidate(cwd?: string) {
      if (cwd === undefined) cache.clear();
      else cache.delete(resolve(cwd || options.agentDir));
    },
  };
}
