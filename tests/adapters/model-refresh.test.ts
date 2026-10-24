import { createHarness, reply, next } from "#/adapters/pi-harness";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const retained = {
  id: "retained",
  name: "Retained model",
  reasoning: false,
  input: ["text" as const],
  contextWindow: 8192,
  maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("refreshes only the owning runtime in place, preserving its model, conversation and enabled patterns", async () => {
  vi.stubEnv("PI_OFFLINE", undefined);
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            id: "published-model",
            name: "Published model",
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            reasoning: false,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ]),
        {
          headers: {
            "last-modified": "Thu, 01 Jan 2099 00:00:00 GMT",
            etag: '"catalog-v1"',
          },
        },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  let instances = 0;
  let version = 1;
  const refreshed: number[] = [];
  const h = await createHarness({
    settings: { enabledModels: ["dynamic/*:high"] },
    extensions: [
      (pi) => {
        const instance = ++instances;
        const models = () => [
          {
            id: `model-${String(instance)}-${String(version)}`,
            name: `Model ${String(version)}`,
            reasoning: true,
            input: ["text" as const],
            contextWindow: 8192,
            maxTokens: 512,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ];
        pi.registerProvider("dynamic", {
          api: "openai-completions",
          baseUrl: "http://unused.invalid",
          apiKey: "fixture",
          models: models(),
          refreshModels: (context) => {
            if (context.allowNetwork) refreshed.push(instance);
            return Promise.resolve(models());
          },
        });
      },
    ],
  });
  try {
    await writeFile(
      join(h.agentDir, "models.json"),
      JSON.stringify({ providers: { anthropic: { apiKey: "fixture" } } }),
    );
    await h.runtime.models.list(h.cwd);
    const first = await h.open({
      cwd: h.cwd,
      model: { provider: "scripted", id: "scripted-1" },
    });
    const second = await h.open();
    h.script(reply("Kept answer"));
    const finished = next(first, "turn_done");
    await first.prompt("Kept question");
    await finished;
    const before = first.snapshot();
    const secondBefore = second.snapshot();
    const settings = await readFile(join(h.agentDir, "settings.json"), "utf8");
    version = 2;
    await writeFile(
      join(h.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { apiKey: "fixture" },
          local: {
            api: "openai-completions",
            apiKey: "fixture",
            baseUrl: "http://unused.invalid",
            models: [{ id: "added-after-start" }],
          },
        },
      }),
    );
    const result = await h.runtime.models.refresh(
      h.cwd,
      new AbortController().signal,
      first.id,
    );
    expect(result).toMatchObject({
      aborted: false,
      errors: [],
      offline: false,
      scope: "session",
    });
    expect(result.view.available).toContainEqual(
      expect.objectContaining({ id: "model-1-2" }),
    );
    expect(refreshed).toEqual([1]);
    expect(result.view.available).toContainEqual(
      expect.objectContaining({ provider: "anthropic", id: "published-model" }),
    );
    expect(result.view.available).toContainEqual(
      expect.objectContaining({ provider: "local", id: "added-after-start" }),
    );
    expect(first.snapshot().status.model).toEqual(before.status.model);
    expect(first.snapshot().entries).toEqual(before.entries);
    expect(second.snapshot().status.model).toEqual(secondBefore.status.model);
    expect(second.snapshot().entries).toEqual(secondBefore.entries);
    expect(
      (await h.runtime.models.list(h.cwd, second.id)).models.map(
        (model) => model.id,
      ),
    ).toEqual(["model-2-1"]);
    expect(await readFile(join(h.agentDir, "settings.json"), "utf8")).toBe(
      settings,
    );
    expect(fetch).toHaveBeenCalled();
    for (const [url] of fetch.mock.calls as unknown as [URL][]) {
      expect(url.origin).toBe("https://pi.dev");
      expect(url.pathname).toMatch(/^\/api\/models\/providers\//);
    }
    fetch.mockClear();
    await h.runtime.models.refresh(
      h.cwd,
      new AbortController().signal,
      first.id,
    );
    // Force bypasses the freshness window, while preserving ETag revalidation.
    const anthropicRequests = (
      fetch.mock.calls as unknown as [URL, RequestInit][]
    ).filter(([url]) => url.pathname === "/api/models/providers/anthropic");
    expect(anthropicRequests).toHaveLength(1);
    const init = anthropicRequests[0]?.[1];
    expect(init?.headers).toMatchObject({ "if-none-match": '"catalog-v1"' });
  } finally {
    await h.dispose();
  }
});

it("reloads local models in an unbound preparation without network in offline mode", async () => {
  vi.stubEnv("PI_OFFLINE", "1");
  const fetch = vi.fn(() => Promise.reject(new Error("Unexpected network")));
  vi.stubGlobal("fetch", fetch);
  const h = await createHarness();
  try {
    await h.runtime.models.list(h.cwd);
    await writeFile(
      join(h.agentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            api: "openai-completions",
            apiKey: "fixture",
            baseUrl: "http://unused.invalid",
            models: [{ id: "new-local-model" }],
          },
        },
      }),
    );
    const result = await h.runtime.models.refresh(
      h.cwd,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      scope: "folder",
      offline: true,
      aborted: false,
      errors: [],
    });
    expect(result.view.available).toContainEqual(
      expect.objectContaining({ id: "new-local-model" }),
    );
    expect((await h.runtime.models.list(h.cwd)).models).toContainEqual(
      expect.objectContaining({ id: "new-local-model" }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(h.runtime.live()).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("returns per-provider refresh failures without losing the available catalog", async () => {
  vi.stubEnv("PI_OFFLINE", undefined);
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(null, { status: 404 })),
  );
  const h = await createHarness({
    extensions: [
      (pi) => {
        pi.registerProvider("broken", {
          api: "openai-completions",
          apiKey: "fixture",
          baseUrl: "http://unused.invalid",
          models: [retained],
          refreshModels: ({ allowNetwork }) => {
            return allowNetwork
              ? Promise.reject(new Error("Catalog unavailable"))
              : Promise.resolve([retained]);
          },
        });
      },
    ],
  });
  try {
    const result = await h.runtime.models.refresh(
      h.cwd,
      new AbortController().signal,
    );
    expect(result.aborted).toBe(false);
    expect(result.errors).toContain("broken: Catalog unavailable");
    expect(result.view.available).toContainEqual(
      expect.objectContaining({ id: "retained" }),
    );
  } finally {
    await h.dispose();
  }
});

it.each(["caller", "timeout"])(
  "cancels catalog refresh through the %s signal",
  async (mode) => {
    vi.stubEnv("PI_OFFLINE", undefined);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    const entered = Promise.withResolvers<undefined>();
    const h = await createHarness({
      extensions: [
        (pi) => {
          pi.registerProvider("waiting", {
            api: "openai-completions",
            apiKey: "fixture",
            baseUrl: "http://unused.invalid",
            models: [retained],
            refreshModels: async ({ allowNetwork, signal }) => {
              if (allowNetwork) {
                entered.resolve(undefined);
                await new Promise<void>((resolve) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      resolve();
                    },
                    {
                      once: true,
                    },
                  );
                });
              }
              return [retained];
            },
          });
        },
      ],
    });
    try {
      // Node's AbortSignal.timeout uses native timers; substitute its clock only.
      const timeout = new AbortController();
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(timeout.signal);
      const caller = new AbortController();
      const pending = h.runtime.models.refresh(h.cwd, caller.signal);
      await entered.promise;
      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      (mode === "caller" ? caller : timeout).abort();
      const result = await pending;
      expect(result.aborted).toBe(true);
      expect(result.view.available).toContainEqual(
        expect.objectContaining({ id: "retained" }),
      );
      timeoutSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await h.dispose();
    }
  },
);
