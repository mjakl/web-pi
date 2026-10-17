import { createFakeWorld } from "@adapters/fake/index";
import { createPiPackages } from "@adapters/pi/packages";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createTempAgent, type TempAgent } from "#/adapters/temp-agent";
import { parseHtml } from "#/web/helpers";

let temp: TempAgent;
beforeEach(async () => {
  temp = await createTempAgent("web-pi-plugin-errors-");
  await mkdir(join(temp.project, ".pi"));
});
afterEach(async () => {
  await temp.dispose();
});

function web() {
  return createWebApp({
    workspace: createWorkspace({
      ...createFakeWorld(),
      packages: createPiPackages({ agentDir: temp.agentDir }),
    }),
    defaultCwd: temp.project,
    staticRoot: "static",
  });
}

it.each(["global", "project"] as const)(
  "reports unreadable %s settings on the Plugins page and refresh without changing the file",
  async (scope) => {
    const file =
      scope === "global"
        ? join(temp.agentDir, "settings.json")
        : join(temp.project, ".pi", "settings.json");
    await writeFile(file, "{ malformed");
    if (scope === "project") {
      await createPiProjectTrust({ agentDir: temp.agentDir }).trust(
        temp.project,
      );
    }
    const app = web();
    const cwd = encodeURIComponent(temp.project);
    const page = await (
      await app.request(`/settings?section=plugins&cwd=${cwd}`)
    ).text();
    const alert = parseHtml(page).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(`${scope} settings:`);
    expect(alert?.textContent).toContain(`Check Pi's ${scope} settings.json.`);
    expect(page).not.toContain("No plugins configured");
    const refresh = await app.request(`/settings/plugins?cwd=${cwd}`);
    expect(refresh.headers.get("HX-Trigger")).toContain(`${scope} settings:`);
    expect(refresh.headers.get("HX-Reswap")).toBe("none");
    expect(await refresh.text()).not.toContain("No plugins configured");
    expect(await readFile(file, "utf8")).toBe("{ malformed");
  },
);

it("does not read malformed settings from an untrusted project", async () => {
  const file = join(temp.project, ".pi", "settings.json");
  await writeFile(file, "{ malformed");
  const app = web();
  const cwd = encodeURIComponent(temp.project);
  for (const path of [
    `/settings?section=plugins&cwd=${cwd}`,
    `/settings/plugins?cwd=${cwd}`,
  ]) {
    const response = await app.request(path);
    expect(response.headers.get("HX-Trigger")).toBeNull();
    const html = await response.text();
    expect(html).toContain("No plugins configured");
    expect(html).not.toContain("project settings:");
  }
  expect(await readFile(file, "utf8")).toBe("{ malformed");
});
