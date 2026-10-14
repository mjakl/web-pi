import { setUpRegion } from "./lifecycle.ts";
import { requestContext } from "./htmx.ts";
import {
  DEFAULT_SYSTEM_PROMPT_ADDITION,
  DEFAULT_WEB_SETTINGS,
  webSettingsPatch,
  type WebSettings,
} from "@core/web-settings";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Without storage the choice lasts for this page only.
  }
}

/** Unset means on, as in pi-web: the tone is the useful default. */
export function soundEnabled(): boolean {
  return document.documentElement.dataset["sound"] !== "false";
}

/**
 * pi-web draws a preference toggle as `button[role=switch]`, not a checkbox,
 * so its state is an attribute rather than `checked`.
 */
export function setSwitch(element: Element, on: boolean): void {
  element.setAttribute("aria-checked", String(on));
}

let confirmed = { ...DEFAULT_WEB_SETTINGS };

function apply(settings: WebSettings, replacePrompt = false): void {
  const prompt = document.querySelector<HTMLTextAreaElement>(
    "#system-prompt-addition",
  );
  if (
    prompt &&
    (replacePrompt ||
      prompt.value ===
        (confirmed.systemPromptAddition ?? DEFAULT_SYSTEM_PROMPT_ADDITION))
  ) {
    prompt.value =
      settings.systemPromptAddition ?? DEFAULT_SYSTEM_PROMPT_ADDITION;
  }
  confirmed = settings;
  document.documentElement.dataset["theme"] = settings.theme;
  document.documentElement.dataset["sound"] = String(settings.sound);
  for (const option of document.querySelectorAll<HTMLInputElement>(
    'input[name="theme"]',
  )) {
    option.checked = option.value === settings.theme;
  }
  const sound = document.getElementById("sound-toggle");
  if (sound) setSwitch(sound, settings.sound);
  const tokens = document.querySelector<HTMLInputElement>("#dumb-zone-tokens");
  if (tokens) tokens.value = String(settings.warnTokens);
  document.dispatchEvent(new Event("web-pi:settings"));
}

let revision = 0;
let saving = false;

async function refresh(): Promise<void> {
  if (saving) return;
  const started = ++revision;
  try {
    const response = await fetch("/settings/web", { cache: "no-store" });
    if (!response.ok) return;
    const settings = {
      ...DEFAULT_WEB_SETTINGS,
      ...webSettingsPatch(await response.json()),
    };
    if (started === revision) apply(settings);
  } catch {
    /* Keep the last server-rendered settings while offline. */
  }
}

export function setUpPreferences(): void {
  window.addEventListener("focus", () => {
    void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  setUpRegion("[data-web-settings]", (region, signal) => {
    apply({
      ...DEFAULT_WEB_SETTINGS,
      ...webSettingsPatch(
        JSON.parse(region.getAttribute("data-web-settings") ?? "{}"),
      ),
    });
    const status = region.querySelector<HTMLElement>("#web-settings-status");
    // The theme radios stay enabled while a save runs: disabling the focused
    // one would drop keyboard focus halfway through an arrow-key move. A
    // theme picked during another save is dropped, and that save's answer
    // checks the confirmed theme again.
    const controls = () =>
      document.querySelectorAll<
        HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
      >(
        "#sound-toggle, #dumb-zone-tokens, #system-prompt-addition, #system-prompt-save, #system-prompt-reset",
      );
    for (const control of controls()) control.disabled = saving;
    const save = async (patch: Partial<WebSettings>) => {
      if (saving) return;
      const promptEdit = "systemPromptAddition" in patch;
      const feedback = promptEdit
        ? region.querySelector<HTMLElement>("#system-prompt-status")
        : status;
      saving = true;
      revision += 1;
      for (const control of controls()) control.disabled = true;
      if (feedback) feedback.textContent = "Saving…";
      try {
        const response = await fetch("/settings/web", {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok)
          throw new Error(
            "Could not save settings. Check the connection and try again.",
          );
        apply(
          {
            ...DEFAULT_WEB_SETTINGS,
            ...webSettingsPatch(await response.json()),
          },
          promptEdit,
        );
        if (feedback) feedback.textContent = "Saved.";
      } catch (error) {
        apply(confirmed);
        if (feedback)
          feedback.textContent =
            error instanceof Error
              ? error.message
              : "Could not save settings. Try again.";
      } finally {
        saving = false;
        for (const control of controls()) control.disabled = false;
      }
    };
    region.addEventListener(
      "click",
      (event) => {
        const target =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(
                "#sound-toggle, #system-prompt-save, #system-prompt-reset",
              )
            : null;
        if (!target) return;
        if (target.id === "system-prompt-save") {
          const prompt = region.querySelector<HTMLTextAreaElement>(
            "#system-prompt-addition",
          );
          if (prompt) void save({ systemPromptAddition: prompt.value });
          return;
        }
        if (target.id === "system-prompt-reset") {
          void save({ systemPromptAddition: null });
          return;
        }
        if (target.id === "sound-toggle") void save({ sound: !soundEnabled() });
      },
      { signal },
    );
    // The theme radios: a click or an arrow key checks one.
    region.addEventListener(
      "change",
      (event) => {
        const option = event.target;
        if (!(option instanceof HTMLInputElement) || option.name !== "theme")
          return;
        const theme = option.value;
        if (theme === "light" || theme === "dark" || theme === "auto")
          void save({ theme });
      },
      { signal },
    );
    region
      .querySelector<HTMLInputElement>("#dumb-zone-tokens")
      ?.addEventListener(
        "change",
        (event) => {
          const input = event.target as HTMLInputElement;
          const value = Number(input.value);
          if (!Number.isSafeInteger(value) || value <= 0) {
            input.value = String(confirmed.warnTokens);
            if (status) status.textContent = "Enter a positive safe integer.";
          } else void save({ warnTokens: value });
        },
        { signal },
      );
  });
}

const LAST_CWD_KEY = "web-pi:last-cwd";

/**
 * The folder the picker last committed. The server keeps its own cookie for
 * the selected workspace; this is what pre-fills the browse box, so a reader
 * who browsed somewhere unusual finds the path already typed and one click
 * (Go, or Enter) away. Seeding only the input keeps the listing below it
 * honest: it still shows the folder the server actually opened.
 */
export function setUpFolderMemory(): void {
  document.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.id !== "dialogs") return;
    const input = target.querySelector<HTMLInputElement>("#directory-path");
    const remembered = read(LAST_CWD_KEY);
    if (input && remembered !== null && remembered !== input.value) {
      input.value = remembered;
    }
  });
  document.addEventListener("htmx:config:request", (event) => {
    const { request } = requestContext(event);
    if (
      new URL(request.action, document.baseURI).pathname !==
      "/workspaces/validate"
    )
      return;
    const cwd =
      request.body instanceof FormData ? request.body.get("cwd") : null;
    if (typeof cwd === "string" && cwd !== "") write(LAST_CWD_KEY, cwd);
  });
}
