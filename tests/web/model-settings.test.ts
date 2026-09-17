import { createDeps } from "@/container";
import { createFakeWorld } from "@adapters/fake/index";
import { createPiModelCatalog } from "@adapters/pi/model-catalog";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { createTempAgent } from "#/adapters/temp-agent";
import { htmxBrowser } from "#/web/htmx4-browser";
import {
  ProjectTrustStore,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { HTMLInputElement, HTMLButtonElement } from "happy-dom";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let temp: Awaited<ReturnType<typeof createTempAgent>>;
beforeEach(async () => {
  temp = await createTempAgent("web-pi-global-models-");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await temp.dispose();
});
const first = { provider: "first", id: "shared" };
const second = { provider: "second", id: "shared" };
const extra = { provider: "first", id: "extra" };
const file = () => join(temp.agentDir, "settings.json");
const globals = async () =>
  JSON.parse(await readFile(file(), "utf8")) as {
    enabledModels?: string[];
  } & Record<string, unknown>;
async function catalog(models = [first, second, extra]) {
  const providers = Object.fromEntries(
    [...new Set(models.map((model) => model.provider))].map((provider) => [
      provider,
      {
        api: "openai-completions",
        baseUrl: "http://unused.invalid",
        apiKey: "fixture",
        models: models
          .filter((model) => model.provider === provider)
          .map((model) => ({
            id: model.id,
            name: `${model.provider} ${model.id} <model>`,
            reasoning: true,
          })),
      },
    ]),
  );
  await writeFile(
    join(temp.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        ...providers,
        unauthenticated: {
          api: "openai-completions",
          baseUrl: "http://unused.invalid",
          models: [{ id: "not-runnable" }],
        },
      },
    }),
  );
}
async function fixture(patterns?: string[]) {
  await catalog();
  if (patterns !== undefined)
    await writeFile(
      file(),
      JSON.stringify({
        enabledModels: patterns,
        defaultThinkingLevel: "low",
        theme: "dark",
        custom: { keep: true },
      }),
    );
  const world = createFakeWorld();
  world.models = createPiModelCatalog({ agentDir: temp.agentDir });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    staticRoot: "static",
    defaultCwd: temp.project,
  });
  const save = async (
    selected: unknown[] | null,
    baseline?: string[] | null,
  ) => {
    const current =
      baseline === undefined
        ? (await workspace.modelSettings(temp.project)).patterns
        : baseline;
    const body = new URLSearchParams({
      cwd: temp.project,
      patterns: JSON.stringify(current),
    });
    if (selected === null) body.set("defaults", "1");
    else
      for (const model of selected) body.append("model", JSON.stringify(model));
    return app.request("/settings/models", { method: "POST", body });
  };
  return { world, workspace, app, save };
}

it.each([undefined, []])(
  "treats absent/empty global config as all without writing on open or unchanged save: %j",
  async (patterns) => {
    const { workspace, app, save } = await fixture(patterns);
    const before = existsSync(file())
      ? await readFile(file(), "utf8")
      : undefined;
    const view = await workspace.modelSettings(temp.project);
    expect(
      view.available.map(({ provider, id }) => ({ provider, id })),
    ).toEqual([first, extra, second]);
    expect(view.selected).toHaveLength(3);
    const html = await (await app.request("/settings?section=models")).text();
    expect(html).toContain("Using all available models");
    expect(html).toContain("&lt;model&gt;");
    expect(html).not.toContain("<model>");
    await save([first, second, extra]);
    expect(
      existsSync(file()) ? await readFile(file(), "utf8") : undefined,
    ).toBe(before);
  },
);

it("persists only global enabledModels, reconstructs it, and leaves General preferences unchanged", async () => {
  const { world, workspace, app, save } = await fixture(["first/shared:high"]);
  world.webSettings.update({ theme: "light", sound: false });
  const before = await globals();
  const response = await save([second]);
  expect(await response.text()).toContain("Selection saved.");
  expect(response.headers.get("HX-Trigger")).toBe("models-changed");
  expect(await globals()).toEqual({
    ...before,
    enabledModels: ["second/shared"],
  });
  expect(
    (
      await createPiModelCatalog({ agentDir: temp.agentDir }).settings(
        temp.project,
      )
    ).selected,
  ).toEqual([second]);
  expect(
    (await workspace.newSession(temp.project)).models.map(
      ({ provider, id }) => ({ provider, id }),
    ),
  ).toEqual([second]);
  expect(world.webSettings.get()).toMatchObject({
    theme: "light",
    sound: false,
  });
  for (const section of ["general", "skills", "plugins"])
    expect((await app.request(`/settings?section=${section}`)).status).toBe(
      200,
    );
});

it("edits global rather than trusted project patterns and refreshes cached folders while retaining overrides", async () => {
  const { world, workspace, save } = await fixture(["first/*:high"]);
  const other = join(temp.root, "other");
  await mkdir(other);
  await mkdir(join(temp.project, ".pi"));
  const projectFile = join(temp.project, ".pi", "settings.json");
  const project = JSON.stringify({
    enabledModels: ["first/extra:low"],
    custom: "project",
  });
  await writeFile(projectFile, project);
  new ProjectTrustStore(temp.agentDir).set(temp.project, true);
  const view = await workspace.modelSettings(temp.project);
  expect(view.patterns).toEqual(["first/*:high"]);
  expect(view.selected).toEqual([first, extra]);
  expect(view.projectPatterns).toEqual(["first/extra:low"]);
  expect((await world.models.list(other)).models).toHaveLength(2);
  expect(
    (await world.models.list(temp.project)).models.map((model) => model.id),
  ).toEqual(["extra"]);
  await save([second]);
  expect(
    (await world.models.list(other)).models.map((model) => model.provider),
  ).toEqual(["second"]);
  expect(
    (await world.models.list(temp.project)).models.map((model) => model.id),
  ).toEqual(["extra"]);
  expect(await readFile(projectFile, "utf8")).toBe(project);
  new ProjectTrustStore(temp.agentDir).set(temp.project, false);
  world.models.invalidate();
  await writeFile(projectFile, "{untrusted malformed project config");
  expect(
    (await workspace.modelSettings(temp.project)).projectPatterns,
  ).toBeNull();
  expect(
    (await world.models.list(temp.project)).models.map(
      (model) => model.provider,
    ),
  ).toEqual(["second"]);
});

it("preserves unchanged fuzzy patterns, wildcard patterns, unavailable entries and pins byte-for-byte", async () => {
  const patterns = ["first/*:high", "second/shared:low", "missing/*", "extra"];
  const { save, workspace } = await fixture(patterns);
  const before = await readFile(file(), "utf8");
  expect((await workspace.modelSettings(temp.project)).unavailable).toEqual([
    "missing/*",
  ]);
  await save([first, second, extra]);
  expect(await readFile(file(), "utf8")).toBe(before);
});

it("expands only affected wildcards with effective pins and excludes their future matches", async () => {
  const { save, world } = await fixture([
    "first/*:high",
    "second/*:low",
    "missing/*",
  ]);
  await save([extra, second]);
  expect((await globals()).enabledModels).toEqual([
    "first/extra:high",
    "second/*:low",
    "missing/*",
  ]);
  const future = { provider: "first", id: "future" };
  const futureSecond = { provider: "second", id: "future" };
  await catalog([first, extra, second, future, futureSecond]);
  world.models.invalidate();
  expect(
    (await world.models.list(temp.project)).models.map(
      ({ provider, id, pin }) => ({ provider, id, pin }),
    ),
  ).toEqual([
    { ...extra, pin: "high" },
    { ...second, pin: "low" },
    { ...futureSecond, pin: "low" },
  ]);
});

it("removes a warning-bearing matched pattern rather than retaining and resurrecting it", async () => {
  const { workspace, save } = await fixture([
    "first/shared:bogus",
    "second/shared:low",
    "missing",
  ]);
  const view = await workspace.modelSettings(temp.project);
  expect(view.unavailable).toEqual(["missing"]);
  expect(view.warnings).toHaveLength(1);
  await save([second]);
  expect((await globals()).enabledModels).toEqual([
    "second/shared:low",
    "missing",
  ]);
});

it("preserves an unmatched nonempty list, permits replacements and deliberately resets to all", async () => {
  const { workspace, world, app, save } = await fixture(["missing/*"]);
  expect((await workspace.modelSettings(temp.project)).selected).toEqual([]);
  expect((await world.models.list(temp.project)).models).toEqual([]);
  expect(
    await (await app.request("/settings?section=models")).text(),
  ).toContain("unavailable saved");
  expect(await (await save([])).text()).toContain(
    "Keep at least one available model",
  );
  expect((await globals()).enabledModels).toEqual(["missing/*"]);
  await save([second]);
  expect((await globals()).enabledModels).toEqual([
    "missing/*",
    "second/shared",
  ]);
  await save(null);
  expect((await globals()).enabledModels).toEqual([]);
  expect((await world.models.list(temp.project)).models).toHaveLength(3);
});

it("shows no-model guidance and disabled save without clearing saved config", async () => {
  const { world, app, save } = await fixture(["missing"]);
  await catalog([]);
  world.models.invalidate();
  const before = await readFile(file(), "utf8");
  const html = await (await app.request("/settings?section=models")).text();
  expect(html).toContain("No models available");
  expect(html).toContain("Configure a provider");
  expect(html).toMatch(/data-model-save[^>]*disabled/);
  expect(await (await save([])).text()).toContain("No models available");
  expect(await (await save(null)).text()).toContain("No models available");
  expect(await readFile(file(), "utf8")).toBe(before);
});

it.each([
  [{ provider: "first" }],
  ["first/shared"],
  [{ provider: "gone", id: "shared" }],
])("rejects malformed/unavailable selection %j", async (...selection) => {
  const { save } = await fixture(["first/shared"]);
  const before = await readFile(file(), "utf8");
  const response = await save(selection);
  expect(await response.text()).toContain("Could not save models:");
  expect(response.headers.get("HX-Trigger")).toBeNull();
  expect(await readFile(file(), "utf8")).toBe(before);
});

it("preserves exact case, slash and colon identities when Pi can represent them", async () => {
  const { save, world } = await fixture([]);
  const exact = { provider: "Mixed", id: "folder/Model:high" };
  await catalog([first, exact]);
  world.models.invalidate();
  expect(await (await save([exact])).text()).toContain("Selection saved.");
  expect((await globals()).enabledModels).toEqual(["Mixed/folder/Model:high"]);
  expect(
    (await world.models.list(temp.project)).models.map(({ provider, id }) => ({
      provider,
      id,
    })),
  ).toEqual([exact]);
});

it("rejects a case-ambiguous identity that cannot round-trip through Pi without exposing other models", async () => {
  const { save, world } = await fixture([]);
  const upper = { provider: "first", id: "Shared" };
  await catalog([first, upper, second]);
  world.models.invalidate();
  const response = await save([upper]);
  expect(await response.text()).toContain(
    "Pi cannot represent this exact selection",
  );
  expect((await globals()).enabledModels).toEqual([]);
});

it("refuses stale forms and merges unrelated external edits at the SDK write boundary", async () => {
  const { save } = await fixture(["first/shared"]);
  await writeFile(
    file(),
    JSON.stringify({ enabledModels: ["second/shared"], external: 1 }),
  );
  expect(await (await save([extra], ["first/shared"])).text()).toContain(
    "global model selection changed",
  );
  // eslint-disable-next-line typescript/unbound-method -- called with the original receiver below
  const original = SettingsManager.prototype.setEnabledModels;
  vi.spyOn(SettingsManager.prototype, "setEnabledModels").mockImplementation(
    function (this: SettingsManager, patterns) {
      original.call(this, patterns);
      writeFileSync(
        file(),
        JSON.stringify({
          enabledModels: ["second/shared"],
          external: 2,
          theme: "light",
        }),
      );
    },
  );
  await save([extra]);
  expect(await globals()).toEqual({
    enabledModels: ["first/extra"],
    external: 2,
    theme: "light",
  });
});

it("reports real load errors without changing the malformed file", async () => {
  const { app } = await fixture();
  await writeFile(file(), "{broken");
  const html = await (await app.request("/settings?section=models")).text();
  expect(html).toContain('role="alert"');
  expect(html).toContain("global settings:");
  const response = await app.request("/settings/models", {
    method: "POST",
    body: new URLSearchParams({
      cwd: temp.project,
      patterns: "null",
      defaults: "1",
    }),
  });
  expect(await response.text()).not.toContain("Selection saved.");
  expect(response.headers.get("HX-Trigger")).toBeNull();
  expect(await readFile(file(), "utf8")).toBe("{broken");
});

it("reports real SDK write errors even though flush resolves, without announcing success", async () => {
  const { save } = await fixture(["first/shared"]);
  // eslint-disable-next-line typescript/unbound-method -- called with the original receiver below
  const original = SettingsManager.prototype.setEnabledModels;
  vi.spyOn(SettingsManager.prototype, "setEnabledModels").mockImplementation(
    function (this: SettingsManager, patterns) {
      original.call(this, patterns);
      rmSync(file());
      mkdirSync(file());
    },
  );
  const response = await save([second]);
  const html = await response.text();
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Selection saved.");
  expect(response.headers.get("HX-Trigger")).toBeNull();
});

it("wires Models to global Pi persistence through the production composition", async () => {
  await catalog();
  await writeFile(
    file(),
    JSON.stringify({ enabledModels: ["first/shared"], theme: "dark" }),
  );
  const { workspace } = createDeps({
    runtime: "pi",
    agentDir: temp.agentDir,
    defaultCwd: temp.project,
    host: "127.0.0.1",
    port: 0,
    staticRoot: "static",
  });
  const app = createWebApp({
    workspace,
    staticRoot: "static",
    defaultCwd: temp.project,
  });
  expect(
    await (await app.request("/settings?section=models")).text(),
  ).toContain("first shared &lt;model&gt;");
  const response = await app.request("/settings/models", {
    method: "POST",
    body: new URLSearchParams({
      cwd: temp.project,
      patterns: '["first/shared"]',
      model: JSON.stringify(second),
    }),
  });
  expect(await response.text()).toContain("Selection saved.");
  expect(await globals()).toEqual({
    enabledModels: ["second/shared"],
    theme: "dark",
  });
  const chooser = await (
    await app.request(
      `/workspaces/model-selector?cwd=${encodeURIComponent(temp.project)}`,
    )
  ).text();
  expect(chooser).toContain("second shared &lt;model&gt;");
  expect(chooser).not.toContain("first shared &lt;model&gt;");
});

it("refreshes the mounted chooser after a real HTMX global save and preserves the active model", async () => {
  const { app, world, workspace } = await fixture(["first/shared"]);
  const id = await workspace.createSession(temp.project);
  const active = world.runtime.get(id)?.snapshot().status.model;
  const browser = await htmxBrowser(
    await (await app.request("/settings?section=models")).text(),
    (request) => app.request(request),
  );
  try {
    for (const checkbox of browser.document.querySelectorAll<HTMLInputElement>(
      '.settings-models input[type="checkbox"]',
    ))
      checkbox.checked = checkbox.value === JSON.stringify(second);
    browser.document
      .querySelector<HTMLButtonElement>("[data-model-save]")
      ?.click();
    await expect
      .poll(
        () =>
          browser.document.querySelector("[data-model-status]")?.textContent,
      )
      .toBe("Selection saved.");
    await expect
      .poll(() =>
        [...browser.document.querySelectorAll("[data-model-name]")].map(
          (node) => node.getAttribute("data-model-name"),
        ),
      )
      .toEqual(["second shared <model>"]);
    expect((await globals()).enabledModels).toEqual(["second/shared"]);
    expect(world.runtime.get(id)?.snapshot().status.model).toEqual(active);
  } finally {
    await browser.close();
  }
});
