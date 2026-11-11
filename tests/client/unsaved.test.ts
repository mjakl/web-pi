import { DEFAULT_WEB_SETTINGS } from "@core/web-settings";
import { GeneralSettings } from "@web/views/Settings";
import { expect, it, vi } from "vitest";
import { byId, click, flush, json, mount } from "./helpers.ts";
import { required } from "#/web/helpers";

function unloading(): boolean {
  return !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
}

it("warns for in-memory attachments including pending conversions, not persisted text or skills", async () => {
  const { openDraft, saveDraftLater } = await import("@web/client/drafts");
  const { setUpUnsavedChanges } = await import("@web/client/unsaved");
  setUpUnsavedChanges();
  const draft = openDraft("s1");
  draft.text = "keep this text";
  saveDraftLater(draft);
  expect(unloading()).toBe(false);
  expect(localStorage.getItem("web-pi:draft:s1")).toBe("keep this text");
  draft.pending = 1;
  expect(unloading()).toBe(true);
  draft.pending = 0;
  draft.images.push(new File(["attachment"], "notes.txt"));
  expect(unloading()).toBe(true);
  draft.images.length = 0;
  expect(unloading()).toBe(false);
});

it("protects prompt edits until reverted or successfully saved, including failed saves and background refresh", async () => {
  mount(GeneralSettings({ settings: DEFAULT_WEB_SETTINGS }));
  const { setUpPreferences } = await import("@web/client/preferences");
  const { setUpUnsavedChanges } = await import("@web/client/unsaved");
  setUpPreferences();
  setUpUnsavedChanges();
  const prompt = byId("system-prompt-addition") as HTMLTextAreaElement;
  const initial = prompt.value;
  expect(unloading()).toBe(false);
  prompt.value = "edited";
  expect(unloading()).toBe(true);
  prompt.value = initial;
  expect(unloading()).toBe(false);
  prompt.value = "edited";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(DEFAULT_WEB_SETTINGS)));
  window.dispatchEvent(new Event("focus"));
  await flush();
  expect(prompt.value).toBe("edited");
  expect(unloading()).toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("failed", { status: 500 })),
  );
  click(byId("system-prompt-save"));
  await flush();
  expect(byId("system-prompt-status").textContent).toContain("Could not save");
  expect(prompt.value).toBe("edited");
  expect(unloading()).toBe(true);
  const pending = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
  click(byId("system-prompt-save"));
  expect(unloading()).toBe(true);
  pending.resolve(
    json({ ...DEFAULT_WEB_SETTINGS, systemPromptAddition: "edited" }),
  );
  await flush();
  expect(unloading()).toBe(false);
});

it("tracks model selection and plugin source but not model filters or skill queries", async () => {
  mount(
    '<form class="settings-models"><input name="model" type="checkbox" checked><input id="settings-model-filter"></form><input name="query"><input id="plugin-source">',
  );
  const { setUpUnsavedChanges } = await import("@web/client/unsaved");
  setUpUnsavedChanges();
  const model = required(
    document.querySelector<HTMLInputElement>('[name="model"]'),
  );
  model.checked = false;
  expect(unloading()).toBe(true);
  model.checked = true;
  (byId("settings-model-filter") as HTMLInputElement).value = "filter";
  required(document.querySelector<HTMLInputElement>('[name="query"]')).value =
    "search";
  expect(unloading()).toBe(false);
  const source = byId("plugin-source") as HTMLInputElement;
  source.value = "npm:plugin";
  expect(unloading()).toBe(true);
  source.value = "";
  expect(unloading()).toBe(false);
});
