import { createDemoWorld } from "@adapters/fake/demo";
import { createDirectoryBrowser } from "@adapters/fs/browse";
import { createFileTree } from "@adapters/fs/file-tree";
import { createWatcher } from "@adapters/fs/watch";
import { createGit } from "@adapters/git/git";
import { createPiAgentRuntime } from "@adapters/pi/agent-runtime";
import { createPiPackages } from "@adapters/pi/packages";
import { createPiProjectResolver } from "@adapters/pi/projects";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createPiSkills } from "@adapters/pi/skills";
import { createWebPushNotifier } from "@adapters/pi/web-push";
import { createWebSettingsStore } from "@adapters/fs/web-settings";
import type { AgentRuntime, PushNotifier } from "@core/ports";
import { createWorkspace, type Workspace } from "@core/workspace";
import { tmpdir } from "node:os";
import type { Config } from "./config.ts";

/**
 * Shutdown stops every live session the way Stop does: running tools and
 * shell commands are aborted with their process trees, and extensions get
 * `session_shutdown` to close what they opened.
 */
export async function disposeWorld(world: {
  runtime: AgentRuntime;
  push: PushNotifier;
}): Promise<void> {
  world.push.dispose();
  await Promise.allSettled(world.runtime.live().map((live) => live.stop()));
}

// The only place that knows both the core and the Pi adapters.
export function createDeps(config: Config): {
  workspace: Workspace;
  dispose: () => Promise<void>;
} {
  if (config.runtime === "fake") {
    const world = createDemoWorld(config.defaultCwd);
    return {
      dispose: () => disposeWorld(world),
      workspace: createWorkspace(world),
    };
  }
  const catalog = createPiSessionCatalog({ agentDir: config.agentDir });
  const webSettings = createWebSettingsStore(config.agentDir);
  const runtime = createPiAgentRuntime({
    agentDir: config.agentDir,
    catalog,
    webSettings,
  });
  const push = createWebPushNotifier({
    agentDir: config.agentDir,
    gracePeriodMs: config.notificationGracePeriodMs,
  });
  return {
    dispose: () => disposeWorld({ runtime, push }),
    workspace: createWorkspace({
      sessions: catalog,
      runtime,
      models: runtime.models,
      projects: createPiProjectResolver({ agentDir: config.agentDir }),
      browser: createDirectoryBrowser(),
      trust: createPiProjectTrust({ agentDir: config.agentDir }),
      skills: createPiSkills({ agentDir: config.agentDir }),
      packages: createPiPackages({ agentDir: config.agentDir }),
      resources: runtime.resources,
      files: createFileTree(),
      git: createGit(),
      watcher: createWatcher(),
      push,
      webSettings,
      tmpdir: tmpdir(),
    }),
  };
}
