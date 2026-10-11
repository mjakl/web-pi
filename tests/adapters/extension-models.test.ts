import { createPiModelCatalog } from "@adapters/pi/model-catalog";
import { createHarness } from "./pi-harness.ts";
import { createTempAgent } from "./temp-agent.ts";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  ProjectTrustStore,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { defaultSessionDir } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { createFakeWorld } from "@adapters/fake";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("discovers factory-registered models before a session exists", async () => {
  const temp = await createTempAgent("web-pi-extension-models-");
  try {
    await mkdir(join(temp.agentDir, "extensions"));
    await writeFile(
      join(temp.agentDir, "extensions", "provider.ts"),
      `
      export default function(pi) {
        pi.registerProvider("fixture", {
          api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "inert",
          models: [{ id: "extension-model", name: "Extension model", reasoning: true,
            input: ["text"], contextWindow: 8192, maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        });
      }
    `,
    );
    await writeFile(
      join(temp.agentDir, "settings.json"),
      JSON.stringify({ enabledModels: ["fixture/extension-model:high"] }),
    );
    const models = createPiModelCatalog({ agentDir: temp.agentDir });
    expect(await models.list(temp.project)).toMatchObject({
      models: [{ provider: "fixture", id: "extension-model", pin: "high" }],
      warnings: [],
    });
  } finally {
    await temp.dispose();
  }
});

function instanceProvider(next: () => number): InlineExtension {
  return (pi) => {
    const instance = next();
    pi.registerProvider("instance", {
      api: "openai-completions",
      baseUrl: "http://unused.invalid",
      apiKey: "inert",
      models: [
        {
          id: `model-${String(instance)}`,
          name: `Instance ${String(instance)}`,
          reasoning: true,
          thinkingLevelMap:
            instance === 1
              ? {
                  off: null,
                  minimal: null,
                  low: null,
                  medium: "balanced",
                  high: "thorough",
                }
              : {
                  off: null,
                  minimal: null,
                  low: null,
                  medium: null,
                  high: "thorough",
                },
          input: ["text"],
          contextWindow: 8192,
          maxTokens: 512,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    pi.on("session_start", () => {
      pi.appendEntry("instance-start", { instance });
    });
    pi.registerCommand("instance-state", {
      description: "Inspect the bound instance",
      handler: () => {
        pi.appendEntry("instance-action", { instance });
        return Promise.resolve();
      },
    });
    pi.registerCommand("remove-instance", {
      description: "Remove only this provider",
      handler: () => {
        pi.unregisterProvider("instance");
        return Promise.resolve();
      },
    });
  };
}

it("claims the displayed preparation once and gives concurrent sessions independent providers and actions", async () => {
  let factories = 0;
  const h = await createHarness({
    settings: { enabledModels: ["instance/*"] },
    extensions: [instanceProvider(() => ++factories)],
  });
  try {
    const listing = await h.runtime.models.list(h.cwd);
    expect(listing.models.map((model) => model.id)).toEqual(["model-1"]);
    await h.runtime.models.list(h.cwd);
    await h.runtime.models.settings(h.cwd);
    expect(factories).toBe(1);
    const [first, second] = await Promise.all([
      h.open({
        cwd: h.cwd,
        model: { provider: "instance", modelId: "model-1" },
      }),
      h.open(),
    ]);
    expect(factories).toBe(2);
    expect(first.snapshot().status.model?.id).toBe("model-1");
    expect(second.snapshot().status.model?.id).toBe("model-2");
    await first.prompt("/instance-state");
    await second.prompt("/instance-state");
    for (const [session, instance] of [
      [first, 1],
      [second, 2],
    ] as const) {
      expect(
        session
          .snapshot()
          .entries.filter(
            (entry) =>
              entry.type === "custom" &&
              entry.customType.startsWith("instance-"),
          )
          .map((entry) => (entry.type === "custom" ? entry.data : undefined)),
      ).toEqual([{ instance }, { instance }]);
    }
    const world = createFakeWorld();
    const workspace = createWorkspace({
      ...world,
      runtime: h.runtime,
      sessions: h.catalog,
      models: h.runtime.models,
    });
    expect(
      (await workspace.viewSession(first.id))?.models.map((model) => model.id),
    ).toEqual(["model-1"]);
    expect(
      (await workspace.viewSession(second.id))?.models.map((model) => model.id),
    ).toEqual(["model-2"]);
    const firstModel = (await h.runtime.models.list(h.cwd, first.id)).models[0];
    const secondModel = (await h.runtime.models.list(h.cwd, second.id))
      .models[0];
    if (!firstModel || !secondModel) throw new Error("Missing fixture models");
    expect(
      await h.runtime.models.resolveThinking(
        h.cwd,
        firstModel,
        "low",
        true,
        first.id,
      ),
    ).toBe("medium");
    expect(
      await h.runtime.models.resolveThinking(
        h.cwd,
        secondModel,
        "low",
        true,
        second.id,
      ),
    ).toBe("high");
    await first.setModel("instance", "model-1");
    await expect(first.setModel("instance", "model-2")).rejects.toThrow(
      "Unknown model",
    );
    await first.prompt("/remove-instance");
    expect((await workspace.viewSession(first.id))?.models).toEqual([]);
    expect(
      (await workspace.viewSession(second.id))?.models.map((model) => model.id),
    ).toEqual(["model-2"]);
    await second.reload();
    expect((await workspace.viewSession(first.id))?.models).toEqual([]);
    expect(
      (await workspace.viewSession(second.id))?.models.map((model) => model.id),
    ).toEqual(["model-3"]);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("reprojects model settings without rerunning factories or switching live models, then reloads the exact session", async () => {
  let factories = 0;
  const h = await createHarness({
    settings: { enabledModels: ["instance/*:high", "missing/*"] },
    extensions: [instanceProvider(() => ++factories)],
  });
  try {
    await h.runtime.models.list(h.cwd);
    const live = await h.open();
    const before = live.snapshot().status.model;
    const settings = await h.runtime.models.settings(h.cwd, live.id);
    expect(
      settings.available.some((model) => model.provider === "scripted"),
    ).toBe(true);
    await h.runtime.models.saveSettings(
      h.cwd,
      {
        patterns: settings.patterns,
        selected: [
          { provider: "instance", id: "model-1" },
          { provider: "scripted", id: "scripted-1" },
        ],
      },
      live.id,
    );
    expect(factories).toBe(1);
    expect(live.snapshot().status.model).toEqual(before);
    expect((await h.runtime.models.settings(h.cwd, live.id)).patterns).toEqual([
      "instance/*:high",
      "missing/*",
      "scripted/scripted-1",
    ]);
    expect(
      (await h.runtime.models.list(h.cwd, live.id)).models.map(
        (model) => model.id,
      ),
    ).toEqual(["model-1", "scripted-1"]);
    // A different pre-session view is not allowed to stand in for this owner.
    await h.runtime.models.list(h.cwd);
    expect(factories).toBe(2);
    await live.reload();
    expect(factories).toBe(3);
    expect(
      (await h.runtime.models.list(h.cwd, live.id)).models.map(
        (model) => model.id,
      ),
    ).toEqual(["model-3", "scripted-1"]);
    await live.prompt("/instance-state");
    expect(
      live
        .snapshot()
        .entries.filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "instance-action",
        )
        .map((entry) => (entry.type === "custom" ? entry.data : undefined)),
    ).toEqual([{ instance: 3 }]);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("reports discovery and reload errors from the exact session resources", async () => {
  let factories = 0;
  const h = await createHarness({
    extensions: [
      () => {
        throw new Error(`Factory failure ${String(++factories)}`);
      },
    ],
  });
  try {
    expect((await h.runtime.models.list(h.cwd)).warnings.join(" ")).toContain(
      "Factory failure 1",
    );
    const first = await h.open();
    const second = await h.open();
    expect(
      (await h.runtime.models.list(h.cwd, first.id)).warnings.join(" "),
    ).toContain("Factory failure 1");
    expect(
      (await h.runtime.models.list(h.cwd, second.id)).warnings.join(" "),
    ).toContain("Factory failure 2");
    await first.reload();
    const refreshed = (
      await h.runtime.models.list(h.cwd, first.id)
    ).warnings.join(" ");
    expect(refreshed).toContain("Factory failure 3");
    expect(refreshed).not.toContain("Factory failure 1");
    expect(
      (await h.runtime.models.list(h.cwd, second.id)).warnings.join(" "),
    ).toContain("Factory failure 2");
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("lists an inactive saved session without acquiring a transcript writer", async () => {
  let factories = 0;
  const h = await createHarness({
    settings: { enabledModels: ["instance/*"] },
    extensions: [instanceProvider(() => ++factories)],
  });
  try {
    const manager = SessionManager.create(
      h.cwd,
      defaultSessionDir(h.agentDir, h.cwd),
    );
    manager.appendModelChange("instance", "model-1");
    manager.appendThinkingLevelChange("low");
    manager.appendMessage({
      role: "user",
      content: "Saved without an owned runtime",
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    if (!file) throw new Error("Missing fixture file");
    await mkdir(dirname(file), { recursive: true });
    const content = `${[manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    await writeFile(file, content);
    const before = await stat(file);
    const world = createFakeWorld();
    const workspace = createWorkspace({
      ...world,
      runtime: h.runtime,
      sessions: h.catalog,
      models: h.runtime.models,
    });
    const view = await workspace.viewSession(manager.getSessionId());
    expect(view?.models.map((model) => model.id)).toEqual(["model-1"]);
    expect(view?.thinking).toBe("medium");
    expect(h.runtime.live()).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(content);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(factories).toBe(1);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("never executes an untrusted project factory or applies its model settings, and refreshes after saved trust changes", async () => {
  const temp = await createTempAgent("web-pi-untrusted-models-");
  try {
    await mkdir(join(temp.project, ".pi", "extensions"), { recursive: true });
    const marker = join(temp.root, "factory-executed");
    await writeFile(
      join(temp.project, ".pi", "extensions", "unsafe.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default function(pi) {
        writeFileSync(${JSON.stringify(marker)}, "executed");
        pi.registerProvider("project", { api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "inert", models: [{ id: "trusted" }] });
      }
    `,
    );
    await writeFile(
      join(temp.project, ".pi", "settings.json"),
      JSON.stringify({ enabledModels: ["project/trusted"] }),
    );
    const models = createPiModelCatalog({ agentDir: temp.agentDir });
    const untrusted = await models.settings(temp.project);
    expect(untrusted.projectPatterns).toBeNull();
    expect(
      untrusted.available.some((model) => model.provider === "project"),
    ).toBe(false);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    new ProjectTrustStore(temp.agentDir).set(temp.project, true);
    expect(
      (await models.list(temp.project)).models.map((model) => model.id),
    ).toEqual(["trusted"]);
    expect(await readFile(marker, "utf8")).toBe("executed");
  } finally {
    await temp.dispose();
  }
});
