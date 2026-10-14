import { createFakeWorld } from "@adapters/fake/index";
import { disposeWorld } from "@/container";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
