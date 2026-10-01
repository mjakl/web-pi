import type { FrameComponent } from "@core/extension-ui";
import { createCoordinator, type Coordinator } from "@core/coordinator";
import { createOpenAiCoordinatorProvider } from "@adapters/openai/coordinator";
import { randomUUID } from "node:crypto";
import {
  assistantEntry,
  createFakeWorld,
  type FakeStoredSession,
  type ScriptedStep,
  userEntry,
} from "@adapters/fake/index";
import { createDirectoryBrowser } from "@adapters/fs/browse";
import { createFileTree } from "@adapters/fs/file-tree";
import { createWatcher } from "@adapters/fs/watch";
import { createGit } from "@adapters/git/git";
import { createPiAgentRuntime } from "@adapters/pi/agent-runtime";
import { createPiModelCatalog } from "@adapters/pi/model-catalog";
import { createPiPackages } from "@adapters/pi/packages";
import { createPiProjectResolver } from "@adapters/pi/projects";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { createPiProjectResources } from "@adapters/pi/resources";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createPiSkills } from "@adapters/pi/skills";
import { createWebPushNotifier } from "@adapters/pi/web-push";
import { createWebSettingsStore } from "@adapters/fs/web-settings";
import { createWorkspace, type Workspace } from "@core/workspace";
import { tmpdir } from "node:os";
import type { Config } from "./config.ts";

/** Two stored sessions so the demo runtime has a sidebar worth looking at. */
function demoSessions(cwd: string): FakeStoredSession[] {
  const at = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();
  return [
    {
      summary: {
        id: "demo-report",
        cwd,
        createdAt: at(2),
        modifiedAt: at(1),
        fileSize: 4,
      },
      entries: [
        userEntry("d1", null, "Summarise the release notes"),
        assistantEntry("d2", "d1", "Here is the **summary**.", 12_000),
        userEntry("d3", "d2", "Now add the migration steps"),
        assistantEntry("d4", "d3", "1. Back up\n2. Migrate\n3. Verify", 18_000),
      ],
    },
    {
      summary: {
        id: "demo-bugfix",
        cwd: `${cwd}/worktree`,
        name: "Flaky test",
        createdAt: at(5),
        modifiedAt: at(3),
        fileSize: 2,
      },
      entries: [
        userEntry("b1", null, "Why does the timer test flake?"),
        assistantEntry("b2", "b1", "It races the fake clock.", 9000),
      ],
    },
  ];
}

/**
 * The demo answer: reasoning, a tool call with progress, an edit with a diff,
 * a subagent, and prose with a code fence and a diagram. Everything the
 * transcript can render, without a model.
 */
/**
 * A counter component, for checking the custom-UI panel without an extension:
 * the arrow keys change the number, Enter finishes, and every keystroke draws
 * a fresh frame the way a real pi-tui component would.
 */
function demoCounter(): FrameComponent {
  let count = 0;
  return {
    render(width: number) {
      const bar = "\u2500".repeat(Math.max(0, width - 2));
      return [
        `\u250C${bar}\u2510`,
        `\u2502 Count: \u001B[1m${String(count)}\u001B[0m`,
        "\u2502 Up/Down to change, Enter to finish",
        `\u2514${bar}\u2518`,
      ];
    },
    handleInput(data: string) {
      if (data === "\u001B[A") count += 1;
      if (data === "\u001B[B") count -= 1;
    },
  };
}

function demoScript(cwd: string, prompt: string): ScriptedStep[] {
  const patch = `--- a/src/answer.ts\n+++ b/src/answer.ts\n@@ -1,3 +1,3 @@\n export function answer() {\n-  return 41;\n+  return 42;\n }\n`;
  // Two scripted answers exist only for checking the extension bridge by hand.
  if (prompt.includes("/dialog")) {
    return [
      {
        dialog: {
          method: "select",
          title: "Which branch should I use?",
          options: ["main", "release", "a new one"],
        },
      },
      {
        dialog: {
          method: "confirm",
          title: "Push it?",
          message: "This rewrites the remote.",
        },
      },
      {
        dialog: {
          method: "input",
          title: "Name the branch",
          placeholder: "feature/…",
        },
      },
      {
        dialog: {
          method: "editor",
          title: "Commit message",
          prefill: "Fix the thing\n\n",
        },
      },
      { text: "Dialogs answered." },
    ];
  }
  if (prompt.includes("/custom")) {
    return [
      { title: "Counting" },
      { custom: demoCounter() },
      { insert: "counted to three" },
      { text: "Custom UI closed." },
    ];
  }
  return [
    { status: "git", statusText: "\u001B[32mmain\u001B[0m ✓ clean" },
    {
      widget: "todo",
      lines: [
        "\u001B[1mOpen\u001B[0m",
        "  1. change the answer",
        "  2. check the callers",
      ],
    },
    { thinking: "Reading the file before changing it, then checking callers." },
    {
      tool: "read",
      arguments: { path: `${cwd}/src/answer.ts` },
      progress: ["reading src/answer.ts"],
      result: "export function answer() {\n  return 41;\n}",
    },
    {
      tool: "edit",
      arguments: { file_path: `${cwd}/src/answer.ts` },
      progress: ["applying the edit"],
      details: { patch },
      result: "Edited src/answer.ts",
    },
    {
      tool: "subagent",
      arguments: {
        calls: [
          { agent: "explorer", prompt: "Find every caller of answer()." },
        ],
      },
      details: {
        kind: "pi-subagent",
        results: [
          {
            agent: "explorer",
            exitCode: 0,
            model: "fake-1",
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: "Two callers: `src/main.ts` and the test.",
                  },
                ],
              },
            ],
          },
        ],
      },
      result: "explorer finished",
    },
    {
      widget: "todo",
      lines: ["\u001B[1mDone\u001B[0m", "  \u001B[32m✓\u001B[0m all clear"],
    },
    { status: "git", statusText: "\u001B[32mmain\u001B[0m ● 1 changed" },
    {
      text: `You asked: **${prompt}**\n\nThis reply comes from the fake runtime, streamed word by word so the page can be checked without a model.\n\n\`\`\`ts\nexport const answer = 42;\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  ask --> think --> tools --> answer\n\`\`\`\n\n| step | state |\n| --- | --- |\n| edit | done |`,
    },
  ];
}

// The only place that knows both the core and the Pi adapters.
export function createDeps(config: Config): {
  workspace: Workspace;
  coordinator: Coordinator;
} {
  const { workspace } = createWorkspaceDeps(config);
  const apiKey = process.env["OPENAI_API_KEY"];
  return {
    workspace,
    coordinator: createCoordinator(
      workspace,
      createOpenAiCoordinatorProvider(apiKey ? { apiKey } : {}),
      randomUUID,
    ),
  };
}

function createWorkspaceDeps(config: Config): { workspace: Workspace } {
  if (config.runtime === "fake") {
    const world = createFakeWorld({
      sessions: demoSessions(config.defaultCwd),
      delayMs: 40,
      script: (prompt) => demoScript(config.defaultCwd, prompt),
      worktrees: (cwd) => [
        { path: cwd, branch: "main" },
        { path: `${cwd}/worktree`, branch: "feature" },
      ],
      // The second demo session lives in a folder that is not there, which
      // is what the read-only notice is for.
      trustRequired: [config.defaultCwd],
      missingFolders: [`${config.defaultCwd}/worktree`],
    });
    // Files, Git, and the watcher stay real even in the demo world: an
    // explorer is only worth looking at against an actual checkout, and the
    // fake index only knows two invented paths.
    return {
      workspace: createWorkspace({
        ...world,
        files: createFileTree(),
        tmpdir: tmpdir(),
      }),
    };
  }
  const catalog = createPiSessionCatalog({ agentDir: config.agentDir });
  const webSettings = createWebSettingsStore(config.agentDir);
  return {
    workspace: createWorkspace({
      sessions: catalog,
      runtime: createPiAgentRuntime({
        agentDir: config.agentDir,
        catalog,
        webSettings,
      }),
      models: createPiModelCatalog({ agentDir: config.agentDir }),
      projects: createPiProjectResolver({ agentDir: config.agentDir }),
      browser: createDirectoryBrowser(),
      trust: createPiProjectTrust({ agentDir: config.agentDir }),
      skills: createPiSkills({ agentDir: config.agentDir }),
      packages: createPiPackages({ agentDir: config.agentDir }),
      resources: createPiProjectResources({ agentDir: config.agentDir }),
      files: createFileTree(),
      git: createGit(),
      watcher: createWatcher(),
      push: createWebPushNotifier({ agentDir: config.agentDir }),
      webSettings,
      tmpdir: tmpdir(),
    }),
  };
}
