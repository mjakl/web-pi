import {
  createFakeWorld,
  FAKE_MODEL,
  assistantEntry,
  userEntry,
} from "@adapters/fake/index";
import { createWebSettingsStore } from "@adapters/fs/web-settings";
import { createPiModelCatalog } from "@adapters/pi/model-catalog";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { createTempAgent } from "#/adapters/temp-agent";
import { htmxBrowser } from "#/web/htmx4-browser";
import type { HTMLInputElement, HTMLButtonElement } from "happy-dom";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let temp: Awaited<ReturnType<typeof createTempAgent>>;
beforeEach(async () => {
  temp = await createTempAgent("web-pi-model-settings-");
});
afterEach(async () => {
  await temp.dispose();
});

const first = { provider: "first", id: "shared" };
const second = { provider: "second", id: "shared" };
const piSettings = {
  enabledModels: ["first/shared:high"],
  defaultProvider: "first",
  defaultModel: "shared",
  defaultThinkingLevel: "low",
};
async function catalog(providers = ["first", "second"]) {
  await writeFile(
    join(temp.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        unauthenticated: {
          api: "openai-completions",
          baseUrl: "http://unused.invalid",
          models: [{ id: "not-runnable" }],
        },
        ...Object.fromEntries(
          providers.map((provider) => [
            provider,
            {
              api: "openai-completions",
              baseUrl: "http://unused.invalid",
              apiKey: "fixture",
              models: [
                { id: "shared", name: `${provider} <model>`, reasoning: true },
              ],
            },
          ]),
        ),
      },
    }),
  );
}
async function fixture() {
  await catalog();
  await writeFile(
    join(temp.agentDir, "settings.json"),
    JSON.stringify(piSettings),
  );
  const world = createFakeWorld();
  // The fake world's file port delegates to disk; use the isolated project for /repo.
  const stat = world.files.stat.bind(world.files);
  world.files.stat = (path) => stat(path === "/repo" ? temp.project : path);
  world.files.realpath = (path) => Promise.resolve(path);
  world.models = createPiModelCatalog({ agentDir: temp.agentDir });
  world.webSettings = createWebSettingsStore(temp.agentDir);
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
  });
  const save = (models: unknown[] | null) => {
    const body = new URLSearchParams({ cwd: "/repo" });
    if (models === null) body.set("defaults", "1");
    else
      for (const model of models) body.append("model", JSON.stringify(model));
    return app.request("/settings/models", { method: "POST", body });
  };
  return { world, workspace, app, save };
}

it("lists the full credential-available catalog, independently of Pi's scope and escaped labels", async () => {
  const { app, workspace } = await fixture();
  expect(
    (await workspace.newSession("/repo")).models.map(({ provider, id }) => ({
      provider,
      id,
    })),
  ).toEqual([first]);
  const html = await (await app.request("/settings?section=models")).text();
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("first &lt;model&gt;");
  expect(html).toContain("second &lt;model&gt;");
  expect(html).not.toContain("<model>");
  const view = await workspace.modelSettings("/repo");
  expect(view.available.map(({ provider, id }) => ({ provider, id }))).toEqual([
    first,
    second,
  ]);
  expect(view.selected.map(({ provider, id }) => ({ provider, id }))).toEqual([
    first,
  ]);
  expect(view.available[0]?.pin).toBe("high");
  for (const section of ["general", "skills", "plugins"]) {
    const response = await app.request(`/settings?section=${section}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`section=${section}`);
  }
});

it("persists provider-qualified choices through a new store and workspace without changing Pi defaults", async () => {
  const { save, world, workspace, app } = await fixture();
  world.webSettings.update({
    theme: "dark",
    systemPromptAddition: "keep this",
  });
  const response = await save([second]);
  expect(await response.text()).toContain("Selection saved.");
  expect(response.headers.get("HX-Trigger")).toBe("models-changed");
  expect(
    (await workspace.newSession("/repo")).models.map(
      ({ provider }) => provider,
    ),
  ).toEqual(["second"]);
  expect((await workspace.newSession("/repo")).model?.provider).toBe("first");
  const chooser = await (
    await app.request("/workspaces/model-selector?cwd=/repo")
  ).text();
  expect(chooser).toContain('data-model-name="second &lt;model&gt;"');
  expect(chooser).not.toContain('data-model-name="first &lt;model&gt;"');
  world.webSettings = createWebSettingsStore(temp.agentDir);
  world.models = createPiModelCatalog({ agentDir: temp.agentDir });
  expect(
    (await createWorkspace(world).newSession("/repo")).models.map(
      ({ provider }) => provider,
    ),
  ).toEqual(["second"]);
  expect(world.webSettings.get()).toMatchObject({
    theme: "dark",
    systemPromptAddition: "keep this",
    visibleModels: [second],
  });
  expect(
    JSON.parse(await readFile(join(temp.agentDir, "settings.json"), "utf8")),
  ).toEqual(piSettings);
});

it("keeps an empty selection empty and resets explicitly to Pi's original scope", async () => {
  const { save, workspace, app } = await fixture();
  await save([]);
  expect((await workspace.newSession("/repo")).models).toEqual([]);
  const chooser = await (
    await app.request("/workspaces/model-selector?cwd=/repo")
  ).text();
  expect(chooser).toContain("Choose models in Settings");
  expect(chooser).not.toContain("data-model-name=");
  await save(null);
  expect(
    (await workspace.newSession("/repo")).models.map(
      ({ provider }) => provider,
    ),
  ).toEqual(["first"]);
});

it("retains unavailable saved identities, excludes newly discovered models, and recovers returning models", async () => {
  const { world, workspace, save } = await fixture();
  await save([first, second]);
  await catalog(["second", "third"]);
  world.models.invalidate();
  expect(
    (await workspace.newSession("/repo")).models.map(
      ({ provider }) => provider,
    ),
  ).toEqual(["second"]);
  await save([]);
  expect(world.webSettings.get().visibleModels).toEqual([first]);
  await catalog(["first", "second", "third"]);
  world.models.invalidate();
  expect(
    (await workspace.newSession("/repo")).models.map(
      ({ provider }) => provider,
    ),
  ).toEqual(["first"]);
});

it.each([
  { selection: [{ provider: "first" }] },
  { selection: [{ provider: "unknown", id: "shared" }] },
  { selection: ["first/shared"] },
])(
  "rejects invalid or unavailable selections without losing the saved choice: %j",
  async ({ selection }) => {
    const { save, world } = await fixture();
    await save([second]);
    const response = await save(selection);
    expect(await response.text()).toContain("Could not save models:");
    expect(response.headers.get("HX-Trigger")).toBeNull();
    expect(world.webSettings.get().visibleModels).toEqual([second]);
  },
);

it("hides choices without switching active or stored session models, and refreshes the session chooser", async () => {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "stored",
          cwd: temp.project,
          name: "Stored",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          fileSize: 10,
        },
        entries: [
          userEntry("u", null, "hello"),
          assistantEntry("a", "u", "answer", 100),
        ],
      },
    ],
  });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    staticRoot: "/nonexistent",
    defaultCwd: temp.project,
  });
  const id = await workspace.createSession(temp.project);
  await workspace.saveModelVisibility(temp.project, []);
  expect((await workspace.viewSession(id))?.status?.model).toEqual(FAKE_MODEL);
  expect((await workspace.viewSession("stored"))?.model).toEqual(FAKE_MODEL);
  const html = await (
    await app.request(`/sessions/${id}/model-selector`)
  ).text();
  expect(html).toContain(FAKE_MODEL.name);
  expect(html).toContain("Choose models in Settings");
  expect(html).not.toContain("data-model-name=");
  expect(html).toContain('hx-trigger="models-changed from:body"');
  await workspace.saveModelVisibility(temp.project, [
    { provider: FAKE_MODEL.provider, id: FAKE_MODEL.id },
  ]);
  const refreshed = await (
    await app.request(`/sessions/${id}/model-selector`)
  ).text();
  expect(refreshed).toContain(`data-model-name="${FAKE_MODEL.name}"`);
});

it("refreshes the mounted chooser after a real HTMX save without navigation", async () => {
  const { app, world } = await fixture();
  const browser = await htmxBrowser(
    await (await app.request("/settings?section=models")).text(),
    (request) => app.request(request),
  );
  try {
    const checkboxes = [
      ...browser.document.querySelectorAll<HTMLInputElement>(
        '.settings-models input[type="checkbox"]',
      ),
    ];
    expect(checkboxes).toHaveLength(2);
    for (const checkbox of checkboxes)
      checkbox.checked = checkbox.value === JSON.stringify(second);
    browser.document
      .querySelector<HTMLButtonElement>(
        '.settings-models button[type="submit"]',
      )
      ?.click();
    await expect
      .poll(
        () =>
          browser.document.querySelector('.settings-models [role="status"]')
            ?.textContent,
      )
      .toBe("Selection saved.");
    await expect
      .poll(() =>
        [...browser.document.querySelectorAll("[data-model-name]")].map(
          (element) => element.getAttribute("data-model-name"),
        ),
      )
      .toEqual(["second <model>"]);
    expect(world.webSettings.get().visibleModels).toEqual([second]);
    expect(
      browser.requests.some(
        (request) =>
          new URL(request.url).pathname === "/workspaces/model-selector",
      ),
    ).toBe(true);
    browser.document
      .querySelector<HTMLButtonElement>(
        '.settings-models button[name="defaults"]',
      )
      ?.click();
    await expect
      .poll(() =>
        [...browser.document.querySelectorAll("[data-model-name]")].map(
          (element) => element.getAttribute("data-model-name"),
        ),
      )
      .toEqual(["first <model>"]);
    expect(world.webSettings.get().visibleModels).toBeNull();
  } finally {
    await browser.close();
  }
});

it("reports a failed persistence attempt without announcing success", async () => {
  const { save, world } = await fixture();
  vi.spyOn(world.webSettings, "update").mockImplementation(() => {
    throw new Error("Disk is read-only");
  });
  const response = await save([second]);
  const html = await response.text();
  expect(html).toContain('role="alert"');
  expect(html).toContain("Disk is read-only");
  expect(html).not.toContain("Selection saved.");
  expect(response.headers.get("HX-Trigger")).toBeNull();
  expect(createWebSettingsStore(temp.agentDir).get().visibleModels).toBeNull();
});
