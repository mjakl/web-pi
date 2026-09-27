import type { SlashCommand } from "@core/composer";
import type { ProjectResources } from "@core/ports";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { projectTrustReloadOptions } from "./project-trust.ts";

const CACHE_TTL_MS = 10_000;

/**
 * The commands a folder's slash menu offers before anything is running:
 * extension commands, prompt templates and skills. pi-web fills this menu from
 * a resumed session, so extensions are loaded here too — gated by the SDK's
 * project-trust store, which is what keeps an untrusted repository's
 * `.pi/extensions` from being imported and run.
 */
export function createPiProjectResources(options: {
  agentDir: string;
}): ProjectResources {
  const cache = new Map<
    string,
    { expiresAt: number; commands: Promise<SlashCommand[]> }
  >();

  async function load(cwd: string): Promise<SlashCommand[]> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: options.agentDir,
      settingsManager: SettingsManager.create(cwd, options.agentDir),
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload(projectTrustReloadOptions(cwd, options.agentDir));
    const extensions = loader
      .getExtensions()
      .extensions.filter((extension) => extension.hidden !== true)
      .flatMap((extension) => [...extension.commands.values()])
      .map((command): SlashCommand => ({
        name: command.name,
        description: command.description ?? "",
        source: "extension",
      }));
    const prompts = loader.getPrompts().prompts.map((prompt): SlashCommand => ({
      name: prompt.name,
      description: prompt.description,
      source: "prompt",
    }));
    const skills = loader.getSkills().skills.map((skill): SlashCommand => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      skillId: skill.filePath,
      ...(skill.disableModelInvocation ? { manual: true } : {}),
    }));
    return [...extensions, ...prompts, ...skills];
  }

  return {
    commands(cwd) {
      const hit = cache.get(cwd);
      if (hit && hit.expiresAt > Date.now()) return hit.commands;
      const commands = load(cwd);
      cache.set(cwd, { expiresAt: Date.now() + CACHE_TTL_MS, commands });
      commands.catch(() => cache.delete(cwd));
      return commands;
    },
  };
}
