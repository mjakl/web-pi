import { createFakeWorld } from "@adapters/fake/index";
import { createPiModelCatalog } from "@adapters/pi/model-catalog";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import {
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HTMLButtonElement, HTMLSelectElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  MODEL_ID,
  MODEL_2,
  PROVIDER,
  next,
  type Harness,
} from "#/adapters/pi-harness";
import { htmxBrowser, page } from "#/web/htmx4-browser";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let h: Harness | undefined;
const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await h?.dispose();
  h = undefined;
  vi.restoreAllMocks();
});

async function fixture(bashOperations?: BashOperations) {
  h = await createHarness({
    settings: { defaultThinkingLevel: "low" },
    ...(bashOperations ? { bashOperations } : {}),
  });
  const harness = h;
  // The menu reads disk metadata; the harness registers the same models with
  // an offline provider. Neither path can contact a real model endpoint.
  await writeFile(
    join(h.agentDir, "models.json"),
    JSON.stringify({
      providers: {
        uncredentialed: {
          api: "openai-completions",
          baseUrl: "http://unused.invalid",
          models: [{ id: "registered", name: "No credentials" }],
        },
        [PROVIDER]: {
          api: "openai-completions",
          baseUrl: "http://scripted.invalid",
          apiKey: "fixture",
          models: [
            { id: MODEL_ID, name: "Global model", reasoning: false },
            { id: MODEL_2, name: "Scoped model", reasoning: true },
          ],
        },
      },
    }),
  );
  await mkdir(join(h.cwd, ".pi"));
  await writeFile(
    join(h.cwd, ".pi", "settings.json"),
    JSON.stringify({ enabledModels: [`${PROVIDER}/${MODEL_2}:high`] }),
  );
  new ProjectTrustStore(h.agentDir).set(h.cwd, true);
  const world = createFakeWorld();
  world.runtime = h.runtime;
  world.sessions = h.catalog;
  world.webSettings = h.webSettings;
  world.models = createPiModelCatalog({ agentDir: h.agentDir });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: h.cwd,
    staticRoot: "static",
    renderIntervalMs: 1,
  });
  return { app, h: harness };
}

type App = Awaited<ReturnType<typeof fixture>>["app"];
async function composer(app: App, id?: string) {
  const html = await (
    await app.request(id ? `/sessions/${id}` : "/new")
  ).text();
  const form = required(/<form id="composer"[\s\S]*?<\/form>/.exec(html)?.[0]);
  const browser = await htmxBrowser(
    page(
      `<div id="session-region" hx-history-elt hx-sync="this:replace"><main ${id ? `data-session-id="${id}"` : ""}>${form}</main><div id="toasts"></div></div>`,
    ),
    (request) => app.request(request),
  );
  browsers.push(browser);
  return browser;
}

function shell() {
  const finish = Promise.withResolvers<{ exitCode: number | null }>();
  let aborted = false;
  const exec = vi.fn<BashOperations["exec"]>((_command, _cwd, options) => {
    options.onData(Buffer.from("shell output\n"));
    options.signal?.addEventListener(
      "abort",
      () => {
        aborted = true;
        finish.resolve({ exitCode: null });
      },
      { once: true },
    );
    return finish.promise;
  });
  return {
    operations: { exec },
    finish,
    get aborted() {
      return aborted;
    },
  };
}

const post = (app: App, cwd: string, text: string, id?: string) =>
  app.request(id ? `/sessions/${id}/prompt` : "/sessions", {
    method: "POST",
    headers: { "HX-Request": "true" },
    body: new URLSearchParams({ cwd, text }),
  });

describe("production startup from the rendered composer", () => {
  it.each([
    { name: "SDK fallback", settings: {}, expected: "medium" },
    {
      name: "global default",
      settings: { defaultThinkingLevel: "low" },
      expected: "low",
    },
    {
      name: "per-model default",
      settings: {
        defaultThinkingLevel: "low",
        modelThinkingLevels: { [`${PROVIDER}/${MODEL_2}`]: "high" },
      },
      expected: "high",
    },
    {
      name: "unsupported default",
      settings: { defaultThinkingLevel: "xhigh" },
      expected: "high",
    },
  ])(
    "previews $name without turning it into an override",
    async ({ settings, expected }) => {
      const { app, h } = await fixture();
      const file = join(h.agentDir, "settings.json");
      const original = JSON.stringify({
        defaultProvider: PROVIDER,
        defaultModel: MODEL_2,
        ...settings,
      });
      await writeFile(file, original);
      await writeFile(
        join(h.cwd, ".pi", "settings.json"),
        JSON.stringify({ enabledModels: [`${PROVIDER}/${MODEL_2}`] }),
      );
      const browser = await composer(app);
      const select = required(
        browser.document.querySelector<HTMLSelectElement>(
          ".composer-thinking-field select",
        ),
      );
      expect(
        select.querySelector("option[selected]")?.getAttribute("value"),
      ).toBe(expected);
      expect(select.querySelector('option[value="auto"]')).toBeNull();
      expect(select.querySelector('option[value="xhigh"]')).toBeNull();
      expect(select.querySelector('option[value="max"]')).toBeNull();
      expect(
        browser.document
          .querySelector('input[name="thinking"]')
          ?.getAttribute("value"),
      ).toBe("");
      expect(
        browser.document.querySelector(".composer-model-detail")?.textContent,
      ).toBe(expected);
      await post(app, h.cwd, "/name inherited default");
      expect(
        required(h.runtime.live()[0]).snapshot().status.thinkingLevel,
      ).toBe(expected);
      expect(await readFile(file, "utf8")).toBe(original);
      expect(h.calls).toHaveLength(0);
    },
  );

  it("previews an unsupported explicit choice at its clamped level but preserves the override", async () => {
    const { app, h } = await fixture();
    const html = await (
      await app.request(
        `/workspaces/model-selector?cwd=${encodeURIComponent(h.cwd)}&model=${PROVIDER}/${MODEL_2}&thinking=max`,
      )
    ).text();
    expect(html).toContain('<option value="high" selected="">high</option>');
    expect(html).toContain('name="thinking" value="max"');
    expect(html).not.toContain('<option value="max"');
    expect(html).not.toContain('<option value="auto"');
  });

  it.each([
    {
      saved: "low" as const,
      expected: "low",
      replyModel: MODEL_2,
      restoredModel: MODEL_2,
    },
    {
      saved: "max" as const,
      expected: "high",
      replyModel: MODEL_2,
      restoredModel: MODEL_2,
    },
    {
      saved: undefined,
      expected: "low",
      replyModel: MODEL_2,
      restoredModel: MODEL_2,
    },
    {
      saved: "high" as const,
      expected: "high",
      replyModel: MODEL_ID,
      restoredModel: MODEL_2,
    },
    {
      saved: "off" as const,
      expected: "off",
      replyModel: MODEL_2,
      restoredModel: MODEL_ID,
    },
  ])(
    "restores $restoredModel at $expected after a $replyModel reply (saved $saved)",
    async ({ saved, expected, replyModel, restoredModel }) => {
      const { app, h } = await fixture();
      await writeFile(
        join(h.cwd, ".pi", "settings.json"),
        JSON.stringify({
          enabledModels: [
            `${PROVIDER}/${MODEL_2}:high`,
            `${PROVIDER}/${MODEL_ID}`,
          ],
        }),
      );
      const manager = SessionManager.create(
        h.cwd,
        join(h.agentDir, "sessions", "saved"),
      );
      manager.appendModelChange(PROVIDER, replyModel);
      manager.appendMessage({
        role: "user",
        content: "saved",
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-completions",
        provider: PROVIDER,
        model: replyModel,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      manager.appendModelChange(PROVIDER, restoredModel);
      if (saved !== undefined) manager.appendThinkingLevelChange(saved);
      const id = manager.getSessionId();
      for (const active of [false, true]) {
        if (active) await h.open({ sessionId: id });
        const browser = await composer(app, id);
        expect(
          browser.document
            .querySelector('[role="option"][aria-selected="true"]')
            ?.getAttribute("hx-post"),
        ).toContain(
          `model=${encodeURIComponent(`${PROVIDER}/${restoredModel}`)}`,
        );
        expect(
          browser.document.querySelector<HTMLSelectElement>(
            ".composer-thinking-field select",
          )?.disabled,
        ).toBe(restoredModel === MODEL_ID);
        expect(
          browser.document
            .querySelector(".composer-thinking-field option[selected]")
            ?.getAttribute("value"),
        ).toBe(expected);
        expect(
          browser.document.querySelector(".composer-model-detail")?.textContent,
        ).toBe(expected);
      }
    },
  );

  it("renders Pi's selected level after live model and reasoning switches", async () => {
    const { app, h } = await fixture();
    const live = await h.open();
    const response = await app.request(
      `/sessions/${live.id}/model?model=${PROVIDER}/${MODEL_2}`,
      { method: "POST", body: new URLSearchParams({ thinking: "max" }) },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      '<option value="high" selected="">high</option>',
    );
    expect(live.snapshot().status.thinkingLevel).toBe("high");
    const switched = await app.request(
      `/sessions/${live.id}/model?model=${PROVIDER}/${MODEL_ID}`,
      { method: "POST" },
    );
    expect(switched.status).toBe(200);
    expect(await switched.text()).toContain('<select name="thinking" disabled');
    expect(live.snapshot().status.thinkingLevel).toBe("off");
  });

  it("keeps untrusted project settings out of both the menu and startup", async () => {
    const { app, h } = await fixture();
    new ProjectTrustStore(h.agentDir).set(h.cwd, false);
    const browser = await composer(app);
    expect(
      browser.document.querySelector("#model-trigger")?.textContent,
    ).toMatch(/^Global model/);
    expect(
      browser.document.querySelector(".composer-model-detail")?.textContent,
    ).toBe("off");
    const select = required(
      browser.document.querySelector<HTMLSelectElement>(
        ".composer-thinking-field select",
      ),
    );
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("off");
    expect(Array.from(select.options, (option) => option.value)).toEqual([
      "off",
    ]);
    const response = await post(app, h.cwd, "/name untrusted");
    expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
    expect(required(h.runtime.live()[0]).snapshot().status).toMatchObject({
      model: { id: MODEL_ID },
      thinkingLevel: "off",
    });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    { scope: `${MODEL_2}:high`, selected: MODEL_ID, level: "off" },
    { scope: MODEL_ID, selected: MODEL_2, level: "low" },
  ])(
    "starts a Settings-selected model outside Pi's cycling scope: $selected",
    async ({ scope, selected, level }) => {
      const { app, h } = await fixture();
      const projectSettings = JSON.stringify({
        enabledModels: [`${PROVIDER}/${scope}`],
      });
      await writeFile(join(h.cwd, ".pi", "settings.json"), projectSettings);
      const globalBefore = await readFile(
        join(h.agentDir, "settings.json"),
        "utf8",
      );
      const saved = await app.request("/settings/models", {
        method: "POST",
        body: new URLSearchParams({
          cwd: h.cwd,
          model: JSON.stringify({ provider: PROVIDER, id: selected }),
        }),
      });
      expect(await saved.text()).toContain("Selection saved.");
      expect(await readFile(join(h.agentDir, "settings.json"), "utf8")).toBe(
        globalBefore,
      );
      const preview = await app.request(
        `/workspaces/model-selector?${new URLSearchParams({ cwd: h.cwd, model: `${PROVIDER}/${selected}` })}`,
      );
      expect(await preview.text()).toContain(
        `name="model" value="${PROVIDER}/${selected}"`,
      );
      const response = await app.request("/sessions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({
          cwd: h.cwd,
          text: "/name chosen outside scope",
          model: `${PROVIDER}/${selected}`,
        }),
      });
      expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
      const live = required(h.runtime.live()[0]);
      expect(live.snapshot().status).toMatchObject({
        model: { provider: PROVIDER, id: selected },
        thinkingLevel: level,
      });
      const settings: unknown = JSON.parse(
        await readFile(join(h.agentDir, "settings.json"), "utf8"),
      );
      expect(settings).toMatchObject({
        defaultProvider: PROVIDER,
        defaultModel: selected,
        defaultThinkingLevel: "low",
      });
      expect(await readFile(join(h.cwd, ".pi", "settings.json"), "utf8")).toBe(
        projectSettings,
      );
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each([`${PROVIDER}/missing-model`, "uncredentialed/registered"])(
    "rejects an unavailable model choice instead of silently falling back: %s",
    async (model) => {
      const control = shell();
      const { app, h } = await fixture(control.operations);
      const response = await app.request("/sessions", {
        method: "POST",
        headers: { "HX-Request": "true" },
        body: new URLSearchParams({
          cwd: h.cwd,
          text: "!!private command",
          model,
        }),
      });
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toContain(
        "Model is not available:",
      );
      expect(h.runtime.live()).toHaveLength(0);
      expect(control.operations.exec).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each(["untouched", "model", "thinking", "both"])(
    "honours scope independently of preference writes: %s",
    async (choice) => {
      const { app, h } = await fixture();
      const original = await readFile(
        join(h.agentDir, "settings.json"),
        "utf8",
      );
      const modelWrite = vi.spyOn(
        SettingsManager.prototype,
        "setDefaultModelAndProvider",
      );
      const thinkingWrite = vi.spyOn(
        SettingsManager.prototype,
        "setDefaultThinkingLevel",
      );
      const browser = await composer(app);
      expect(
        browser.document.querySelector(".composer-model-detail")?.textContent,
      ).toBe("high");
      if (choice === "model" || choice === "both") {
        required(
          browser.document.querySelector<HTMLButtonElement>(
            '[data-model-name="Scoped model"]',
          ),
        ).click();
        await expect
          .poll(() =>
            browser.document
              .querySelector("input[name=model]")
              ?.getAttribute("value"),
          )
          .toBe(`${PROVIDER}/${MODEL_2}`);
      }
      if (choice === "thinking" || choice === "both") {
        const select = required(
          browser.document.querySelector<HTMLSelectElement>(
            ".composer-thinking-field select",
          ),
        );
        select.value = "medium";
        select.dispatchEvent(
          new browser.window.Event("change", { bubbles: true }),
        );
      }
      const area = required(browser.document.querySelector("textarea"));
      area.value = "/name offline startup";
      area.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      required(
        browser.document.querySelector<HTMLButtonElement>(
          ".composer-action-primary",
        ),
      ).click();
      await expect
        .poll(
          () =>
            browser.document
              .querySelector("main")
              ?.getAttribute("data-session-id") ?? "",
        )
        .not.toBe("");
      const live = required(h.runtime.live()[0]);
      expect(live.snapshot().status.model).toMatchObject({
        provider: PROVIDER,
        id: MODEL_2,
      });
      expect(live.snapshot().status.thinkingLevel).toBe(
        choice === "thinking" || choice === "both" ? "medium" : "high",
      );
      expect(modelWrite).toHaveBeenCalledTimes(
        choice === "model" || choice === "both" ? 1 : 0,
      );
      expect(thinkingWrite).toHaveBeenCalledTimes(
        choice === "thinking" || choice === "both" ? 1 : 0,
      );
      const settings: unknown = JSON.parse(
        await readFile(join(h.agentDir, "settings.json"), "utf8"),
      );
      expect(settings).toMatchObject({
        defaultModel:
          choice === "model" || choice === "both" ? MODEL_2 : MODEL_ID,
        defaultThinkingLevel:
          choice === "thinking" || choice === "both" ? "medium" : "low",
      });
      if (choice === "untouched")
        expect(await readFile(join(h.agentDir, "settings.json"), "utf8")).toBe(
          original,
        );
      expect(h.calls).toHaveLength(0);
    },
  );
});

describe("production shell admission and persistence", () => {
  it("owns pending shell completion through session disposal", async () => {
    const control = shell();
    const { h } = await fixture(control.operations);
    const live = await h.open();
    await live.runBash("pending at disposal", true);
    await live.stop();
    expect(control.aborted).toBe(true);
    expect(h.runtime.get(live.id)).toBeUndefined();
    const stored = SessionManager.open(
      required(live.snapshot().summary.filePath),
    );
    expect(stored.getEntries().at(-1)).toMatchObject({
      type: "message",
      message: {
        role: "bashExecution",
        cancelled: true,
        excludeFromContext: true,
      },
    });
  });

  it("rejects shell admission while a prompt is still in preflight", async () => {
    const control = shell();
    const { h } = await fixture(control.operations);
    const live = await h.open();
    const done = next(live, "turn_done");
    const prompt = live.prompt("offline prompt");
    await expect(live.runBash("must not execute", false)).rejects.toThrow(
      "busy",
    );
    expect(control.operations.exec).not.toHaveBeenCalled();
    await prompt;
    await done;
  });

  it("observes a persistence failure before publishing settlement", async () => {
    const control = shell();
    const { h } = await fixture(control.operations);
    const live = await h.open();
    await live.runBash("output cannot be saved", false);
    await rm(dirname(required(live.snapshot().summary.filePath)), {
      recursive: true,
    });
    const done = next(live, "turn_done");
    control.finish.resolve({ exitCode: 0 });
    await done;
    expect(live.snapshot().status.bashRunning).toBe(false);
    expect(live.snapshot().status.notices).toContainEqual({
      level: "error",
      message: expect.stringContaining("Could not save shell result") as string,
    });
  });

  it.each([false, true])(
    "saves shell-only history before turn_done and reopens it (excluded: %s)",
    async (excluded) => {
      const control = shell();
      control.finish.resolve({ exitCode: 0 });
      const { h } = await fixture(control.operations);
      const live = await h.open();
      const file = required(live.snapshot().summary.filePath);
      let savedAtSettlement = false;
      live.subscribe((event) => {
        if (event.type === "turn_done") savedAtSettlement = existsSync(file);
      });
      for (const command of ["first command", "second command"]) {
        const done = next(live, "turn_done");
        await live.runBash(command, excluded);
        await done;
      }
      expect(savedAtSettlement).toBe(true);
      const entries = SessionManager.open(file).getEntries();
      const commands = entries.flatMap((entry) =>
        entry.type === "message" ? [entry.message] : [],
      );
      expect(commands).toEqual(
        ["first command", "second command"].map(
          (command) =>
            expect.objectContaining({
              role: "bashExecution",
              command,
              output: "shell output\n",
              excludeFromContext: excluded,
            }) as unknown,
        ),
      );
      await live.stop();
      // A stored conversation restores its own model/level, not today's scope.
      await writeFile(
        join(h.cwd, ".pi", "settings.json"),
        JSON.stringify({ enabledModels: [`${PROVIDER}/${MODEL_ID}:off`] }),
      );
      const reopened = await h.open({ sessionId: live.id });
      expect(reopened.snapshot().branch).toEqual(entries);
      expect(reopened.snapshot().status.model?.id).toBe(MODEL_2);
      expect(reopened.snapshot().status.thinkingLevel).toBe("high");
      expect(h.calls).toHaveLength(0);
    },
  );

  it("returns the new session while bash is pending and its Stop reaches that shell", async () => {
    const control = shell();
    const { app, h } = await fixture(control.operations);
    const request = post(app, h.cwd, "!!long command");
    try {
      await expect
        .poll(() => control.operations.exec.mock.calls.length)
        .toBe(1);
      const response = await Promise.race([
        request,
        pause(100).then(() => null),
      ]);
      expect(
        response,
        "response must not wait for shell completion",
      ).not.toBeNull();
      const live = required(h.runtime.live()[0]);
      expect(
        JSON.parse(required(response).headers.get("HX-Location") ?? "{}"),
      ).toMatchObject({
        path: `/sessions/${live.id}`,
        target: "#session-region",
      });
      expect(required(response).headers.get("HX-Trigger")).toContain(live.id);
      expect(required(response).headers.get("X-Web-Pi-Submission")).toBe(
        "accepted",
      );
      expect(live.snapshot().status.bashRunning).toBe(true);
      const browser = await composer(app, live.id);
      const button = required(
        browser.document.querySelector<HTMLButtonElement>(
          ".composer-action-primary",
        ),
      );
      expect(button.dataset["action"]).toBe("stop");
      const draft = required(browser.document.querySelector("textarea"));
      draft.value = "a later request";
      draft.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      expect(button.dataset["action"]).toBe("stop");
      const done = next(live, "turn_done");
      button.click();
      await done;
      expect(control.aborted).toBe(true);
      expect(
        browser.requests.some(
          (sent) => new URL(sent.url).pathname === `/sessions/${live.id}/abort`,
        ),
      ).toBe(true);
      const entries = SessionManager.open(
        required(live.snapshot().summary.filePath),
      ).getEntries();
      expect(entries.at(-1)).toMatchObject({
        type: "message",
        message: {
          role: "bashExecution",
          cancelled: true,
          excludeFromContext: true,
        },
      });
      expect(h.calls).toHaveLength(0);
    } finally {
      control.finish.resolve({ exitCode: 0 });
      await request;
    }
  });

  it("rejects a second shell before admission and reports a later executor failure", async () => {
    const control = shell();
    const { app, h } = await fixture(control.operations);
    const request = post(app, h.cwd, "!pending command");
    try {
      await expect
        .poll(() => control.operations.exec.mock.calls.length)
        .toBe(1);
      const response = await Promise.race([
        request,
        pause(100).then(() => null),
      ]);
      expect(response).not.toBeNull();
      const live = required(h.runtime.live()[0]);
      const browser = await composer(app, live.id);
      const draft = required(browser.document.querySelector("textarea"));
      draft.value = "!!second command";
      draft.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
      draft.dispatchEvent(
        new browser.window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
      await expect
        .poll(() => browser.document.querySelector("#toasts")?.textContent)
        .toContain("busy");
      expect(draft.value).toBe("!!second command");
      expect(control.operations.exec).toHaveBeenCalledTimes(1);
      const done = next(live, "turn_done");
      control.finish.reject(new Error("executor disconnected"));
      await done;
      expect(live.snapshot().status.bashRunning).toBe(false);
      expect(live.snapshot().status.notices).toContainEqual({
        level: "error",
        message: expect.stringContaining("executor disconnected") as string,
      });
      const stream = await app.request(`/sessions/${live.id}/events`);
      const reader = required(stream.body).getReader();
      let received = "";
      while (!received.includes("executor disconnected")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      await reader.cancel();
      expect(received).toContain('hx-target="#toasts"');
      expect(received).toContain("executor disconnected");
      expect(h.calls).toHaveLength(0);
    } finally {
      control.finish.resolve({ exitCode: 0 });
      await request;
    }
  });
});
