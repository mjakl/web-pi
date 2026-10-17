import { createFakeWorld } from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchMessages,
  createHarness,
  gate,
  type Harness,
  next,
  reply,
} from "#/adapters/pi-harness";

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await h.dispose();
});

function web() {
  const workspace = createWorkspace({
    ...createFakeWorld(),
    runtime: h.runtime,
    sessions: h.catalog,
    models: h.runtime.models,
    resources: h.runtime.resources,
    webSettings: h.webSettings,
  });
  return createWebApp({ workspace, defaultCwd: h.cwd, staticRoot: "static" });
}

const post = async (app: ReturnType<typeof web>, path: string, text?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "HX-Request": "true" },
    ...(text === undefined ? {} : { body: new URLSearchParams({ text }) }),
  });

async function pendingInput() {
  const entered = gate();
  const release = gate();
  const shutdowns: string[] = [];
  h = await createHarness({
    extensions: [
      (pi) => {
        pi.on("input", async (event) => {
          if (event.text === "delayed request") {
            entered.open();
            await release.wait;
          }
          return { action: "continue" };
        });
        pi.on("session_shutdown", (event) => {
          shutdowns.push(event.reason);
        });
      },
    ],
  });
  const live = await h.open();
  // Observe the real SDK's public idle/transcript state after the web owner stops.
  const inner = (live as unknown as { inner: AgentSession }).inner;
  h.script(reply("seed answer"));
  const seeded = next(live, "turn_done");
  await live.prompt("seed request");
  await seeded;
  await inner.waitForIdle();
  const app = web();
  const prompt = post(app, `/sessions/${live.id}/prompt`, "delayed request");
  await entered.wait;
  const stopEntered = gate();
  const stop = live.stop.bind(live);
  vi.spyOn(live, "stop").mockImplementation(() => {
    const task = stop();
    stopEntered.open();
    return task;
  });
  return { app, live, inner, prompt, release, shutdowns, stopEntered };
}

describe("Stop during asynchronous prompt admission", () => {
  it("drains pending input before HTTP Stop succeeds, without late acceptance or unowned provider work", async () => {
    const { app, live, inner, prompt, release, shutdowns, stopEntered } =
      await pendingInput();
    let stopFinished = false;
    const providerCalls: {
      afterStop: boolean;
      owned: boolean;
      aborted: boolean;
    }[] = [];
    h.script((turn) => {
      providerCalls.push({
        afterStop: stopFinished,
        owned: h.runtime.live().includes(live),
        aborted: turn.options?.signal?.aborted === true,
      });
      if (turn.options?.signal?.aborted) turn.error("Request was aborted");
      else {
        turn.text("late answer");
        turn.done();
      }
    });
    const stopping = post(app, `/sessions/${live.id}/stop`).then((response) => {
      stopFinished = true;
      return response;
    });
    try {
      await stopEntered.wait;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopFinished).toBe(false);
      expect(h.runtime.live()).toContain(live);
      expect(shutdowns).toEqual([]);
      release.open();
      const submission = await prompt;
      expect(submission.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(submission.headers.get("HX-Trigger")).toContain("cancelled");
      const response = await stopping;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        `hx-post="/sessions/${live.id}/activate"`,
      );
      expect(shutdowns).toEqual(["quit"]);
      expect(h.runtime.live()).not.toContain(live);
      const file = inner.sessionManager.getSessionFile();
      if (!file) throw new Error("Missing seed transcript");
      const atStop = await readFile(file, "utf8");
      await inner.waitForIdle();
      expect(await readFile(file, "utf8")).toBe(atStop);
      expect(
        providerCalls.every(
          (call) => !call.afterStop && call.owned && call.aborted,
        ),
      ).toBe(true);
      const saved = await createPiSessionCatalog({ agentDir: h.agentDir }).read(
        live.id,
      );
      expect(branchMessages(saved?.branch ?? [])).toEqual(
        branchMessages(live.snapshot().branch),
      );
      expect(branchMessages(saved?.branch ?? [])).toContain(
        "user:seed request",
      );
      expect(branchMessages(saved?.branch ?? [])).not.toContain(
        "assistant:late answer",
      );
      expect(await h.open({ sessionId: live.id })).not.toBe(live);
    } finally {
      release.open();
      await Promise.all([prompt, stopping]);
      await inner.waitForIdle();
    }
  });

  it("times out Stop and reopening without disposing an owner whose input hook is still waiting", async () => {
    const { app, live, inner, prompt, release, shutdowns, stopEntered } =
      await pendingInput();
    // The scripted provider respects a signal already aborted before entry.
    h.script((turn) => {
      if (turn.options?.signal?.aborted) turn.error("Request was aborted");
      else turn.done();
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = post(app, `/sessions/${live.id}/stop`);
    try {
      await stopEntered.wait;
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await stopping;
      expect(response.headers.get("HX-Trigger")).toContain("still stopping");
      expect(h.runtime.live()).toContain(live);
      expect(shutdowns).toEqual([]);
      expect(h.calls).toHaveLength(1);
      const reopening = expect(h.open({ sessionId: live.id })).rejects.toThrow(
        "Cannot reopen a session that is still stopping.",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await reopening;
    } finally {
      vi.useRealTimers();
      release.open();
      await prompt;
      await live.stop();
      await inner.waitForIdle();
    }
    expect(h.runtime.live()).not.toContain(live);
    expect(shutdowns).toEqual(["quit"]);
  });
});

describe("idle-only command admission", () => {
  it.each(["/reload", "/compact", "compact control", "folder reload control"])(
    "refuses %s without disturbing the active provider or extensions",
    async (action) => {
      const lifecycle: string[] = [];
      h = await createHarness({
        extensions: [
          (pi) => {
            pi.on("session_start", (event) => {
              lifecycle.push(`start:${event.reason}`);
            });
            pi.on("session_shutdown", (event) => {
              lifecycle.push(`shutdown:${event.reason}`);
            });
          },
        ],
      });
      const entered = gate();
      h.script(() => {
        entered.open();
      });
      const live = await h.open();
      await live.prompt("held request");
      await entered.wait;
      const app = web();
      const response =
        action === "folder reload control"
          ? await app.request("/settings/plugins/reload", {
              method: "POST",
              headers: { "HX-Request": "true" },
              body: new URLSearchParams({ cwd: h.cwd }),
            })
          : action === "compact control"
            ? await post(app, `/sessions/${live.id}/compact`)
            : await post(app, `/sessions/${live.id}/prompt`, action);
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toContain("idle");
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.options?.signal?.aborted).toBe(false);
      expect(live.snapshot().status.running).toBe(true);
      expect(lifecycle).toEqual(["start:startup"]);
    },
  );

  it("rechecks reload eligibility when its lifecycle operation starts", async () => {
    const finished = Promise.withResolvers<{ exitCode: number | null }>();
    const lifecycle: string[] = [];
    h = await createHarness({
      bashOperations: {
        exec: (_command, _cwd, options) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              finished.resolve({ exitCode: null });
            },
            { once: true },
          );
          return finished.promise;
        },
      },
      extensions: [
        (pi) => {
          pi.on("session_shutdown", (event) => {
            lifecycle.push(event.reason);
          });
        },
      ],
    });
    const live = await h.open();
    const reloading = expect(live.reload()).rejects.toThrow("idle");
    try {
      await live.runBash("held shell", false);
      await reloading;
      expect(live.snapshot().status.bashRunning).toBe(true);
      expect(lifecycle).toEqual([]);
    } finally {
      finished.resolve({ exitCode: 0 });
    }
  });

  it("keeps steering and extension commands available during a run", async () => {
    let commands = 0;
    h = await createHarness({
      extensions: [
        (pi) => {
          pi.registerCommand("inspect", {
            description: "Inspect the running session",
            handler: () => {
              commands += 1;
              return Promise.resolve();
            },
          });
        },
      ],
    });
    const entered = gate();
    h.script(() => {
      entered.open();
    });
    const live = await h.open();
    await live.prompt("held request");
    await entered.wait;
    const app = web();
    for (const text of ["/inspect", "steer the run"]) {
      const response = await post(app, `/sessions/${live.id}/prompt`, text);
      expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
    }
    expect(commands).toBe(1);
    expect(live.snapshot().status.queue).toEqual([
      { text: "steer the run", behavior: "steer" },
    ]);
    expect(live.snapshot().status.running).toBe(true);
    expect(h.calls[0]?.options?.signal?.aborted).toBe(false);
  });

  it("keeps the fake adapter's compact and reload admission consistent", async () => {
    h = await createHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const live = await createFakeWorld().runtime.open({ cwd: h.cwd });
    try {
      await live.prompt("held request");
      await expect(live.compact()).rejects.toThrow("idle");
      await expect(live.reload()).rejects.toThrow("idle");
      expect(live.snapshot().status.running).toBe(true);
    } finally {
      await live.stop();
    }
  });
});
