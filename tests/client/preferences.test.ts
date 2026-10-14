import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  DEFAULT_WEB_SETTINGS,
} from "@core/web-settings";
import { GeneralSettings } from "@web/views/Settings";
import { describe, expect, it, vi } from "vitest";
import {
  byId,
  click,
  field,
  flush,
  htmxEvent,
  json,
  mockFetch,
  mount,
  text,
} from "./helpers.ts";

async function load() {
  mount(GeneralSettings({ settings: DEFAULT_WEB_SETTINGS }));
  const preferences = await import("@web/client/preferences");
  preferences.setUpPreferences();
  return preferences;
}

describe("shared preferences", () => {
  it("explicitly saves exact prompt text, empty text, and resets to the default", async () => {
    const fetch = mockFetch((_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON settings");
      return json({ ...DEFAULT_WEB_SETTINGS, ...JSON.parse(init.body) });
    });
    await load();
    const input = byId("system-prompt-addition") as HTMLTextAreaElement;
    expect(input.value).toBe(DEFAULT_SYSTEM_PROMPT_ADDITION);
    for (const value of ["  Custom\naddition.  ", ""]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
      expect(fetch).toHaveBeenCalledTimes(value === "" ? 1 : 0);
      click(byId("system-prompt-save"));
      expect(input.disabled).toBe(true);
      await flush();
      expect(fetch).toHaveBeenLastCalledWith(
        "/settings/web",
        expect.objectContaining({
          body: JSON.stringify({ systemPromptAddition: value }),
        }),
      );
      expect(input.value).toBe(value);
      expect(input.disabled).toBe(false);
    }
    click(byId("system-prompt-reset"));
    await flush();
    expect(fetch).toHaveBeenLastCalledWith(
      "/settings/web",
      expect.objectContaining({ body: '{"systemPromptAddition":null}' }),
    );
    expect(input.value).toBe(DEFAULT_SYSTEM_PROMPT_ADDITION);
    expect(byId("system-prompt-status").textContent).toBe("Saved.");
  });

  it("preserves an unsaved prompt through focus refresh, unrelated saves and failed writes", async () => {
    mockFetch(() =>
      json({
        ...DEFAULT_WEB_SETTINGS,
        systemPromptAddition: "Another browser's edit",
      }),
    );
    await load();
    const input = byId("system-prompt-addition") as HTMLTextAreaElement;
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(input.value).toBe("Another browser's edit");
    input.value = "Unsent draft";
    window.dispatchEvent(new Event("focus"));
    await flush();
    click(byId("sound-toggle"));
    await flush();
    expect(input.value).toBe("Unsent draft");
    mockFetch(() => text("failed", 500));
    click(byId("system-prompt-save"));
    await flush();
    expect(input.value).toBe("Unsent draft");
    expect(byId("system-prompt-status").textContent).toContain(
      "Could not save",
    );
  });

  it("ignores legacy values and saves sound on the server before applying it", async () => {
    localStorage.setItem("web-pi:sound", "false");
    const fetch = mockFetch(() =>
      json({ ...DEFAULT_WEB_SETTINGS, sound: false }),
    );
    const { soundEnabled } = await load();
    expect(soundEnabled()).toBe(true);
    click(byId("sound-toggle"));
    expect(soundEnabled()).toBe(true);
    await flush();
    expect(soundEnabled()).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "/settings/web",
      expect.objectContaining({ body: '{"sound":false}' }),
    );
  });

  it("saves the checked theme and follows the server's answer without browser storage", async () => {
    const fetch = mockFetch(() =>
      json({ ...DEFAULT_WEB_SETTINGS, theme: "dark" }),
    );
    await load();
    const dark = field('input[name="theme"][value="dark"]');
    const light = field('input[name="theme"][value="light"]');
    // A click or an arrow key in the group checks a radio and says so. The
    // radios stay enabled, so keyboard focus survives the save.
    dark.checked = true;
    dark.dispatchEvent(new Event("change", { bubbles: true }));
    expect(byId("sound-toggle").hasAttribute("disabled")).toBe(true);
    expect(dark.disabled).toBe(false);
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      "/settings/web",
      expect.objectContaining({ body: '{"theme":"dark"}' }),
    );
    expect(dark.checked).toBe(true);
    expect(dark.disabled).toBe(false);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(localStorage.getItem("web-pi-theme")).toBeNull();
    // A failed save puts the confirmed choice back.
    mockFetch(() => text("failed", 500));
    light.checked = true;
    light.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(dark.checked).toBe(true);
    expect(light.checked).toBe(false);
  });

  it("rejects invalid thresholds and persists a positive safe integer", async () => {
    const fetch = mockFetch(() =>
      json({ ...DEFAULT_WEB_SETTINGS, warnTokens: 120001 }),
    );
    await load();
    const input = field("#dumb-zone-tokens");
    input.value = "-5";
    input.dispatchEvent(new Event("change"));
    expect(input.value).toBe("100000");
    expect(fetch).not.toHaveBeenCalled();
    input.value = "120001";
    input.dispatchEvent(new Event("change"));
    await flush();
    expect(fetch).toHaveBeenCalledWith(
      "/settings/web",
      expect.objectContaining({ body: '{"warnTokens":120001}' }),
    );
    expect(input.value).toBe("120001");
  });

  it("retains confirmed state and reports failed writes", async () => {
    mockFetch(() => text("failed", 500));
    const { soundEnabled } = await load();
    click(byId("sound-toggle"));
    await flush();
    expect(soundEnabled()).toBe(true);
    expect(byId("web-settings-status").textContent).toContain("Could not save");
    expect((byId("sound-toggle") as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads another browser's shared settings when this page regains focus", async () => {
    mockFetch(() => json({ warnTokens: 12345, sound: false, theme: "dark" }));
    const { soundEnabled } = await load();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(soundEnabled()).toBe(false);
    expect(field("#dumb-zone-tokens").value).toBe("12345");
  });

  it("keeps replacement controls disabled until a pending save finishes", async () => {
    const saved = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => saved.promise),
    );
    const { soundEnabled } = await load();
    click(byId("sound-toggle"));
    mount(GeneralSettings({ settings: DEFAULT_WEB_SETTINGS }));
    htmxEvent(document.body, "htmx:after:process");
    expect((byId("sound-toggle") as HTMLButtonElement).disabled).toBe(true);
    saved.resolve(json({ ...DEFAULT_WEB_SETTINGS, sound: false }));
    await flush();
    expect(soundEnabled()).toBe(false);
    expect((byId("sound-toggle") as HTMLButtonElement).disabled).toBe(false);
  });

  it("detaches replaced General controls and mounts the replacement once", async () => {
    const fetch = mockFetch(() =>
      json({ ...DEFAULT_WEB_SETTINGS, sound: false }),
    );
    await load();
    const old = byId("sound-toggle");
    mount(GeneralSettings({ settings: DEFAULT_WEB_SETTINGS }));
    htmxEvent(document.body, "htmx:after:process");
    htmxEvent(document.body, "htmx:after:process");
    click(old);
    expect(fetch).not.toHaveBeenCalled();
    click(byId("sound-toggle"));
    await flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
