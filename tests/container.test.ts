import { createFakeWorld } from "@adapters/fake/index";
import { createDeps, disposeWorld } from "@/container";
import { createWebApp } from "@web/app";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "#/adapters/pi-harness";

let h: Harness | undefined;

afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

it("stops every live session on shutdown, as Stop does", async () => {
  let aborted = false;
  let shutdowns = 0;
  h = await createHarness({
    bashOperations: {
      exec: (_command, _cwd, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve({ exitCode: null });
            },
            { once: true },
          );
        }),
    },
    extensions: [
      (pi: ExtensionAPI) => {
        pi.on("session_shutdown", () => {
          shutdowns += 1;
        });
      },
    ],
  });
  const busy = await h.open();
  await busy.runBash("pending at shutdown", true);
  await h.open();
  const { push } = createFakeWorld();
  const closePush = vi.spyOn(push, "dispose");

  await disposeWorld({ runtime: h.runtime, push });

  expect(aborted).toBe(true);
  expect(shutdowns).toBe(2);
  expect(h.runtime.live()).toEqual([]);
  expect(closePush).toHaveBeenCalledOnce();
});

it("serves the demo sessions for --runtime fake", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "web-pi-demo-"));
  const { workspace, dispose } = createDeps({
    runtime: "fake",
    agentDir: join(cwd, "agent"),
    defaultCwd: cwd,
    host: "127.0.0.1",
    port: 0,
    staticRoot: "/nonexistent",
    notificationGracePeriodMs: 0,
  });
  try {
    const app = createWebApp({
      workspace,
      staticRoot: "/nonexistent",
      defaultCwd: cwd,
    });
    const report = await (await app.request("/sessions/demo-report")).text();
    expect(report).toContain("Here is the <strong>summary</strong>.");
    expect(report).toContain('id="composer"');
    // Its folder is not there, which is what the read-only notice is for.
    expect(await (await app.request("/sessions/demo-bugfix")).text()).toContain(
      "Working folder is unavailable. This session is read-only.",
    );
  } finally {
    await dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
