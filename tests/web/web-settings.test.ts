import { createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { describe, expect, it } from "vitest";

function fixture() {
  const world = createFakeWorld();
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
  });
  const save = (patch: unknown) =>
    app.request("/settings/web", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  return { app, world, save };
}

const defaults = {
  warnTokens: 100000,
  theme: "auto",
  sound: true,
  systemPromptAddition: null,
  visibleModels: null,
};

describe("shared web settings routes", () => {
  it("renders shared defaults, ignoring the old preference cookie", async () => {
    const { app } = fixture();
    const response = await app.request("/settings/web", {
      headers: { cookie: "web-pi-warn-tokens=1" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(defaults);
  });

  it("saves independently from browser cookies and renders the same values for another browser", async () => {
    const { app, save } = fixture();
    expect(
      (await save({ warnTokens: 12345, sound: false, theme: "dark" })).status,
    ).toBe(200);
    const html = await (await app.request("/settings?section=general")).text();
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-sound="false"');
    expect(html).toContain('value="12345"');
    expect(html).toContain('aria-checked="true" data-theme-option="dark"');
    expect(html).toContain('id="push-toggle"');
    expect(await (await app.request("/settings/web")).json()).toEqual({
      ...defaults,
      warnTokens: 12345,
      theme: "dark",
      sound: false,
    });
  });

  it("renders custom prompt text safely and supports empty and default reset", async () => {
    const { app, save } = fixture();
    const custom = '</textarea><script>alert("hi")</script>\nKeep spaces.  ';
    expect((await save({ systemPromptAddition: custom })).status).toBe(200);
    const html = await (await app.request("/settings?section=general")).text();
    expect(html).toContain("&lt;/textarea&gt;&lt;script&gt;");
    expect(html).not.toContain(custom);
    expect(html).toContain("stopped sessions when activated again");
    for (const value of ["", null]) {
      expect((await save({ systemPromptAddition: value })).status).toBe(200);
      expect(await (await app.request("/settings/web")).json()).toEqual({
        ...defaults,
        systemPromptAddition: value,
      });
    }
  });

  it.each([
    { warnTokens: 0 },
    { warnTokens: -1 },
    { warnTokens: 1.1 },
    { warnTokens: "123" },
    { warnTokens: 9007199254740992 },
    { theme: "sepia" },
    { sound: "true" },
    { systemPromptAddition: 123, sound: false },
    { other: true },
    null,
  ])("rejects the whole invalid edit %j", async (invalid) => {
    const { save, world } = fixture();
    expect((await save(invalid)).status).toBe(400);
    expect(world.webSettings.get()).toEqual(defaults);
  });
});
