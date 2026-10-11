import { createFakeWorld } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { createHarness } from "#/adapters/pi-harness";
import { expect, it } from "vitest";

it("keeps pre-session discovery through settings saves and carries the exact live registry through a Models form", async () => {
  let factories = 0;
  const h = await createHarness({
    settings: { enabledModels: ["context/*:high"] },
    extensions: [
      (pi) => {
        const instance = ++factories;
        pi.registerProvider("context", {
          api: "openai-completions",
          baseUrl: "http://unused.invalid",
          apiKey: "inert",
          models: [
            {
              id: `model-${String(instance)}`,
              name: `Context ${String(instance)}`,
              reasoning: true,
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        });
      },
    ],
  });
  try {
    const world = createFakeWorld();
    const workspace = createWorkspace({
      ...world,
      runtime: h.runtime,
      sessions: h.catalog,
      models: h.runtime.models,
    });
    const app = createWebApp({
      workspace,
      defaultCwd: h.cwd,
      staticRoot: "static",
    });
    const missingContext = await app.request("/settings/models", {
      method: "POST",
      body: new URLSearchParams({ patterns: "null", defaults: "1" }),
    });
    expect(await missingContext.text()).toContain(
      "Choose a folder before loading Models.",
    );
    expect(factories).toBe(0);
    const initial = await (await app.request("/new")).text();
    expect(initial).toContain("Context 1");
    expect(h.runtime.live()).toHaveLength(0);
    const patterns = ["context/*:high"];
    const save = await app.request("/settings/models", {
      method: "POST",
      body: new URLSearchParams({
        cwd: h.cwd,
        patterns: JSON.stringify(patterns),
        model: JSON.stringify({ provider: "context", id: "model-1" }),
      }),
    });
    expect(await save.text()).toContain("Selection saved.");
    expect((await h.runtime.models.settings(h.cwd)).patterns).toEqual(patterns);
    expect(factories).toBe(1);
    const first = await workspace.createSession(h.cwd, {
      model: { provider: "context", modelId: "model-1" },
    });
    expect(factories).toBe(1);
    const second = await workspace.createSession(h.cwd);
    expect(factories).toBe(2);
    const form = await (
      await app.request("/settings?section=models", {
        headers: { "X-Web-Pi-Session": first },
      })
    ).text();
    expect(form).toContain(`name="sessionId" value="${first}"`);
    expect(form).toContain("Context 1");
    expect(form).not.toContain("Context 2");
    expect(form).toContain("Scripted 1");
    expect(factories).toBe(2);
    const saved = await app.request("/settings/models", {
      method: "POST",
      body: new URLSearchParams({
        cwd: h.cwd,
        sessionId: first,
        patterns: JSON.stringify(patterns),
        defaults: "1",
      }),
    });
    expect(await saved.text()).toContain("Selection saved.");
    expect(factories).toBe(2);
    expect(h.runtime.get(first)?.snapshot().status.model?.id).toBe("model-1");
    expect(h.runtime.get(second)?.snapshot().status.model?.id).toBe("model-2");
    expect(
      (await workspace.viewSession(first))?.models.some(
        (model) => model.id === "model-1",
      ),
    ).toBe(true);
    expect(
      (await workspace.viewSession(second))?.models.some(
        (model) => model.id === "model-2",
      ),
    ).toBe(true);
    expect(h.calls).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});
