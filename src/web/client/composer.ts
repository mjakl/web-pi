import {
  bashCommand,
  buildAtInsertText,
  cycleHistory,
  exactBuiltin,
} from "@core/composer";
import { setUpAtCompletion } from "./at-complete.ts";
import { draftKey, setUpDrafts } from "./drafts.ts";
import type { HtmxRequestCtx } from "htmx.org";
import {
  menuEndpoints,
  replaceRange,
  setComposerValue,
  textarea,
} from "./editor.ts";
import { setUpRegion } from "./lifecycle.ts";
import { setUpImages } from "./images.ts";
import { requestContext } from "./htmx.ts";
import { navigationIntent } from "./navigation.ts";
import { setUpSlashMenu } from "./slash-menu.ts";
import { setUpSkills } from "./skills.ts";
import type { SkillSelection } from "@core/ports";
import {
  focusSessionInput,
  setUpSessionInputFocus,
} from "./session-input-focus.ts";
import { showToast } from "./toasts.ts";

// Everything the composer cannot ask the server for: which key does what, the
// attachment previews, the local file index, and the draft in localStorage.

const COMPOSITION_GRACE_MS = 100;

type Action = "send" | "stop" | "steer" | "followup";

/**
 * The four states of pi-web's primary button. The shapes are the paths
 * views/icons.tsx draws (#51), repeated here because the button keeps one
 * `<svg>` and only its contents change.
 */
const ACTIONS: Record<Action, { shape: string; label: string; title: string }> =
  {
    send: {
      shape: '<path d="M12 19V5m-7 7 7-7 7 7"></path>',
      label: "Send",
      title: "Send",
    },
    stop: {
      shape:
        '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"></rect>',
      label: "Stop agent",
      title: "Stop agent",
    },
    steer: {
      shape: '<path d="M5 19v-5a4 4 0 0 1 4-4h10m-5-5 5 5-5 5"></path>',
      label: "Steer",
      title: "Interrupt the current run and inject this message now",
    },
    followup: {
      shape: '<path d="M4 6h14M4 12h8M4 18h8m6-6v8m-4-4h8"></path>',
      label: "Queue",
      title: "Queue after the agent finishes (Option/Alt)",
    },
  };

/** Alt turns steer into follow-up while it is down, as pi-web does. */
let altHeld = false;

export function abortTurn(): void {
  const id = document.querySelector("main")?.getAttribute("data-session-id");
  if (id) void fetch(`/sessions/${id}/abort`, { method: "POST" });
}

function narrowScreen(): boolean {
  return matchMedia("(max-width: 640px)").matches;
}

/** Enter sends on a desktop; a phone keyboard needs a modifier. */
function isSendShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return event.ctrlKey || event.metaKey || event.altKey || !narrowScreen();
}

let composerSetUp = false;
const submissions = new WeakMap<HtmxRequestCtx, () => void>();

export function setUpComposer(): void {
  if (composerSetUp) return;
  composerSetUp = true;
  setUpSessionInputFocus();
  // Confirmation belongs to the submitting draft even after its form leaves.
  // This runs before navigation suppresses a detached response's UI effects.
  document.addEventListener("htmx:before:response", (event) => {
    const ctx = requestContext(event);
    const clear = submissions.get(ctx);
    submissions.delete(ctx);
    if (
      ctx.response &&
      ctx.response.status >= 200 &&
      ctx.response.status < 300 &&
      ctx.response.headers.get("X-Web-Pi-Submission") === "accepted"
    )
      clear?.();
  });
  // The file panel's `@` buttons put a path into the composer.
  document.body.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-mention]",
    );
    const area = textarea();
    if (!chip || !area) return;
    const path = chip.dataset["mention"] ?? "";
    if (path === "") return;
    const isDir = chip.dataset["mentionDir"] === "1";
    const insert = buildAtInsertText({ path, isDir }, false);
    const caret = area.selectionStart;
    replaceRange(area, caret, area.selectionEnd, insert.text, insert.caret);
  });

  setUpModelMenu();
  setUpShelf();
  setUpRegion("#composer", mountComposer);
}

function mountComposer(form: HTMLElement, signal: AbortSignal): void {
  const textarea = () =>
    form.querySelector<HTMLTextAreaElement>("#composer-text");
  const sessionId = form.dataset["sessionId"] ?? null;
  const cwd = form.dataset["cwd"] ?? null;
  const endpoints = menuEndpoints(form as HTMLFormElement);
  const slash = setUpSlashMenu(endpoints, form, signal);
  const at = setUpAtCompletion(endpoints, form, signal);
  const images = setUpImages(
    () => {
      shellHint(textarea()?.value ?? "");
      syncAction();
    },
    form,
    signal,
    draftKey(sessionId, cwd),
    textarea()?.hasAttribute("data-restored-draft") === true,
  );

  /**
   * pi-web's primary button: send when idle, steer or follow-up while a turn
   * runs, stop when there is nothing to send. Alt swaps steer for follow-up,
   * which is a state of the keyboard, so it cannot come from the server.
   */
  const syncAction = (): void => {
    const button = form.querySelector<HTMLButtonElement>(
      ".composer-action-primary",
    );
    if (!button) return;
    const filled =
      (textarea()?.value.trim() ?? "") !== "" ||
      images.count() > 0 ||
      skills.count() > 0;
    const running = form.hasAttribute("data-running");
    const action: Action = !running
      ? "send"
      : form.hasAttribute("data-bash-running")
        ? "stop"
        : filled
          ? altHeld
            ? "followup"
            : "steer"
          : "stop";
    if (button.dataset["action"] !== action) {
      button.dataset["action"] = action;
      const svg = button.querySelector("svg");
      if (svg) svg.innerHTML = ACTIONS[action].shape;
      button.setAttribute("aria-label", ACTIONS[action].label);
      button.title = ACTIONS[action].title;
    }
    button.dataset["behavior"] = action === "followup" ? "followUp" : "steer";
    button.disabled = !running && !filled;
  };
  const drafts = setUpDrafts(sessionId, cwd, textarea, signal);
  const skills = setUpSkills(form, syncAction, signal);
  syncAction();

  let cycle: number | null = null;
  let compositionEndedAt = -Infinity;
  let composing = false;

  function history(): { text: string; skills: SkillSelection[] }[] {
    const entries = [
      ...document.querySelectorAll<HTMLElement>("[data-user-text]"),
    ].map((element) => {
      let selected: SkillSelection[] = [];
      try {
        const value: unknown = JSON.parse(
          element.dataset["userSkills"] ?? "[]",
        );
        if (Array.isArray(value)) {
          const items: unknown[] = value;
          selected = items.filter(
            (item): item is SkillSelection =>
              item !== null &&
              typeof item === "object" &&
              "id" in item &&
              "name" in item &&
              typeof item.id === "string" &&
              typeof item.name === "string",
          );
        }
      } catch {
        /* Older history has text only. */
      }
      const text = element.textContent ?? "";
      return {
        text: element.hasAttribute("data-user-skills") ? text : text.trim(),
        skills: selected,
      };
    });
    // Deduplicate by the full payload, so the same words with different skills remain distinct.
    const seen = new Set<string>();
    const distinct: typeof entries = [];
    for (const entry of entries.reverse()) {
      if (entry.text === "" && entry.skills.length === 0) continue;
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(entry);
      if (distinct.length === 50) break;
    }
    return distinct.reverse();
  }

  function shellHint(value: string): void {
    const hint = form.querySelector<HTMLElement>("#shell-hint");
    if (!hint) return;
    const shell = images.count() === 0 ? bashCommand(value) : null;
    hint.hidden = shell === null;
    hint.textContent = shell
      ? shell.excluded
        ? "Shell · output stays local"
        : "Shell · output sent to model"
      : "";
  }

  function onInput(): void {
    const area = textarea();
    if (!area) return;
    cycle = null;
    slash.refresh();
    at.refresh();
    shellHint(area.value);
    drafts.save(area.value);
    syncAction();
  }

  function clearComposer(): void {
    const area = textarea();
    if (area) setComposerValue(area, "");
    images.clear();
    drafts.clear();
    skills.restore([]);
    slash.close();
    at.close();
    cycle = null;
    shellHint("");
  }

  let copying = false;

  async function copyAnswer(): Promise<void> {
    if (copying) return;
    if (!sessionId) {
      showToast("No answer to copy yet.", "warning");
      return;
    }
    const version = drafts.version();
    const intent = navigationIntent();
    const current = () =>
      navigationIntent() === intent &&
      !signal.aborted &&
      form.isConnected &&
      drafts.version() === version &&
      textarea()?.value.trim() === "/copy" &&
      images.count() === 0 &&
      skills.count() === 0;
    copying = true;
    let failure = "Could not load the answer to copy.";
    try {
      const response = await fetch(
        `/sessions/${sessionId}/last-assistant-text`,
        { signal },
      );
      if (!response.ok) throw new Error("Answer lookup failed");
      const text = await response.text();
      if (!current()) return;
      if (!text) {
        showToast("No answer to copy yet.", "warning");
        return;
      }
      failure = "Could not reach the clipboard.";
      await navigator.clipboard.writeText(text);
      if (!current()) return;
      showToast("Answer copied.", "info");
      // Clear only this command, never attachments added while copying.
      drafts.clear(version);
    } catch {
      if (current()) showToast(failure);
    } finally {
      copying = false;
    }
  }

  /** These commands never submit a model prompt. */
  function runLocalBuiltin(value: string): boolean {
    if (images.count() > 0 || skills.count() > 0) return false;
    if (value === "/session") {
      const trigger = document.querySelector<HTMLElement>("#stats-trigger");
      if (!sessionId || !trigger) {
        showToast(
          "Send a request first to view session statistics.",
          "warning",
        );
        return true;
      }
      trigger.click();
      clearComposer();
      return true;
    }
    if (value === "/copy") {
      void copyAnswer();
      return true;
    }
    return false;
  }

  const setBehavior = (behavior: "steer" | "followUp"): void => {
    const field = form.querySelector<HTMLInputElement>("#composer-behavior");
    if (field) field.value = behavior;
  };

  function incompatibleSelection(): boolean {
    if (skills.count() === 0) return false;
    const text = textarea()?.value.trim() ?? "";
    if (
      text.startsWith("/skill:") ||
      (!text.startsWith("/") && !text.startsWith("!"))
    )
      return false;
    showToast("Remove selected skills before sending a command.", "warning");
    return true;
  }

  const submit = (behavior: "steer" | "followUp"): void => {
    const area = textarea();
    if (!area || incompatibleSelection()) return;
    if (runLocalBuiltin(area.value.trim())) return;
    setBehavior(behavior);
    slash.close();
    at.close();
    (form as HTMLFormElement).requestSubmit();
  };

  // The primary button goes through the same path as the keyboard: the
  // delivery mode is a hidden field, and a built-in that never leaves the
  // browser must not be posted as a prompt. With nothing to send while a turn
  // runs, the same button stops the agent instead.
  form.addEventListener(
    "click",
    (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-behavior]",
      );
      if (button?.dataset["action"] === "stop") {
        event.preventDefault();
        abortTurn();
        return;
      }
      const behavior = button?.dataset["behavior"];
      if (behavior !== "steer" && behavior !== "followUp") return;
      const area = textarea();
      if (
        incompatibleSelection() ||
        (area && runLocalBuiltin(area.value.trim()))
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      setBehavior(behavior);
      slash.close();
      at.close();
    },
    { signal },
  );
  // The toolbar's own fields (the model filter, the reasoning select) are in
  // the form too; only the textarea is the draft.
  form.addEventListener(
    "input",
    (event) => {
      if (event.target === textarea()) onInput();
    },
    { signal },
  );
  form.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    { signal },
  );
  form.addEventListener(
    "compositionend",
    () => {
      composing = false;
      compositionEndedAt = Date.now();
    },
    { signal },
  );

  form.addEventListener(
    "keydown",
    (event) => {
      const area = textarea();
      if (!area || event.target !== area) return;
      // oxlint-disable-next-line typescript/no-deprecated -- IMEs can report 229 without isComposing.
      if (composing || event.isComposing || event.keyCode === 229) return;
      const sendNow = isSendShortcut(event);
      // An IME confirmation must not complete a menu or run an exact command.
      if (sendNow && Date.now() - compositionEndedAt < COMPOSITION_GRACE_MS) {
        event.preventDefault();
        return;
      }

      const empty = area.value.trim() === "";
      if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        (cycle !== null || (event.key === "ArrowUp" && empty))
      ) {
        const past = history();
        if (past.length > 0) {
          event.preventDefault();
          slash.close();
          at.close();
          const step = cycleHistory(
            past.map((entry) => entry.text),
            cycle,
            event.key === "ArrowUp" ? "up" : "down",
          );
          const entry =
            step.cycle === null
              ? undefined
              : past[past.length - 1 - step.cycle];
          setComposerValue(area, entry?.text ?? "");
          skills.restore(entry?.skills ?? []);
          cycle = step.cycle;
          return;
        }
      }

      // A fully typed built-in runs on Enter instead of completing the menu.
      if (sendNow && exactBuiltin(area.value) !== undefined) {
        event.preventDefault();
        submit(event.altKey ? "followUp" : "steer");
        return;
      }
      if (slash.handleKey(event, sendNow)) return;
      if (at.handleKey(event, sendNow)) return;
      if (sendNow) {
        event.preventDefault();
        submit(event.altKey ? "followUp" : "steer");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        abortTurn();
      }
    },
    { signal },
  );

  form.addEventListener(
    "htmx:before:request",
    (event) => {
      if (event.target !== form) return;
      const textVersion = drafts.version();
      const clearSubmittedSkills = skills.submitted();
      const clearSubmittedImages = images.submitted();
      submissions.set(requestContext(event), () => {
        drafts.clear(textVersion);
        clearSubmittedSkills();
        clearSubmittedImages();
        if (!signal.aborted) {
          slash.close();
          at.close();
          cycle = null;
          syncAction();
        }
      });
    },
    { signal },
  );

  form.addEventListener(
    "htmx:error",
    (event) => {
      if (event.target !== form) return;
      showToast(
        requestContext(event).response?.headers.get("X-Web-Pi-Submission") ===
          "accepted"
          ? "Submission accepted, but the view could not refresh."
          : "Could not confirm submission. Check the conversation before sending again.",
      );
    },
    { signal },
  );

  /**
   * The state of the session, as the stream last reported it, mirrored onto
   * the form: the primary button, the shell hint and pi-web's disabled model
   * selector all read it, and CSS keys on it too.
   */
  const mirrorRunning = (): void => {
    const state = document.querySelector("#session-state");
    const running =
      state?.hasAttribute("data-running") === true ||
      state?.hasAttribute("data-bash-running") === true;
    form.toggleAttribute("data-running", running);
    form.toggleAttribute(
      "data-bash-running",
      state?.hasAttribute("data-bash-running") === true,
    );
    // pi-web locks the selector while a turn or a compaction runs. The server
    // renders that too, but only when the pick itself changed.
    const locked = running || state?.hasAttribute("data-compacting") === true;
    const selector = form.querySelector("#model-selector");
    selector?.classList.toggle("is-disabled", locked);
    for (const control of selector?.querySelectorAll<
      HTMLButtonElement | HTMLSelectElement
    >("#model-trigger, .composer-thinking-field select") ?? []) {
      control.disabled = locked || control.hasAttribute("data-unavailable");
    }
    const note = form.querySelector<HTMLElement>("#composer-running-note");
    if (note) note.textContent = running ? "Agent running" : "";
    syncAction();
  };
  document.body.addEventListener(
    "htmx:after:settle",
    (swap) => {
      const target = swap.target;
      if (!(target instanceof Element)) return;
      if (target.closest("#status")) mirrorRunning();
      // A recall or a rewind hands back a new textarea, and replacing an
      // element fires no input event: the button and the hint would go stale.
      if (target.contains(textarea())) onInput();
    },
    { signal },
  );

  // Alt is held down, not clicked: pi-web watches the key itself so the icon
  // changes before the press lands.
  const modifier = (event: KeyboardEvent): void => {
    const held =
      event.altKey && !event.getModifierState("AltGraph") && !event.isComposing;
    if (held === altHeld) return;
    altHeld = held;
    syncAction();
  };
  const clearModifier = (): void => {
    if (!altHeld) return;
    altHeld = false;
    syncAction();
  };
  addEventListener("keydown", modifier, { signal });
  addEventListener("keyup", modifier, { signal });
  addEventListener("blur", clearModifier, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) clearModifier();
    },
    { signal },
  );

  setUpDropZone(images, signal);
  mirrorRunning();
  onInput();
  focusSessionInput(textarea(), signal);
}

const COMPOSER_MENUS = new Set(["model-menu", "composer-controls"]);

/**
 * The filter above the model list, and what the browser does not do for a
 * popover: tell its trigger that it is open. Both are delegated, because a
 * model pick swaps the whole selector, menu and all, for the server's answer.
 * `toggle` does not bubble, so this listens in the capture phase.
 */
function setUpModelMenu(): void {
  const filterList = (query: string): void => {
    const menu = document.getElementById("model-menu");
    for (const group of menu?.querySelectorAll<HTMLElement>(
      "[data-provider]",
    ) ?? []) {
      let shown = 0;
      for (const option of group.querySelectorAll<HTMLElement>(
        "[data-model-name]",
      )) {
        const match = (option.dataset["modelName"] ?? "")
          .toLowerCase()
          .includes(query);
        option.hidden = !match;
        if (match) shown += 1;
      }
      group.hidden = shown === 0;
    }
  };
  document.addEventListener(
    "toggle",
    (event) => {
      const menu = event.target;
      if (!(menu instanceof HTMLElement) || !COMPOSER_MENUS.has(menu.id))
        return;
      const open =
        (event as unknown as { newState?: string }).newState === "open";
      document
        .querySelector(`[popovertarget="${menu.id}"]`)
        ?.setAttribute("aria-expanded", String(open));
      // A closed menu must not open again on yesterday's filter.
      const filter = menu.querySelector<HTMLInputElement>("#model-filter");
      if (!open && filter) {
        filter.value = "";
        filterList("");
      }
    },
    true,
  );
  document.body.addEventListener("change", (event) => {
    const select = event.target;
    if (
      !(select instanceof HTMLSelectElement) ||
      select.name !== "display-thinking"
    )
      return;
    const selector = select.closest(".model-selector");
    const override = selector?.querySelector<HTMLInputElement>(
      'input[name="thinking"]',
    );
    if (override) override.value = select.value;
    const detail = selector?.querySelector(".composer-model-detail");
    if (detail)
      detail.textContent =
        select.selectedOptions[0]?.textContent ?? select.value;
  });
  document.body.addEventListener("input", (event) => {
    const filter = event.target;
    if (!(filter instanceof HTMLInputElement) || filter.id !== "model-filter") {
      return;
    }
    filterList(filter.value.trim().toLowerCase());
  });
}

/** pi-web's drop overlay: the whole chat window takes an image (§4.1). */
function setUpDropZone(
  images: { add(files: readonly File[]): void },
  signal: AbortSignal,
): void {
  const pane = document.querySelector(".chat-window");
  const zone = pane?.querySelector<HTMLElement>(".chat-drop-zone");
  if (!pane || !zone) return;
  let depth = 0;
  signal.addEventListener(
    "abort",
    () => {
      zone.hidden = true;
    },
    { once: true },
  );
  const show = (open: boolean): void => {
    depth = open ? depth : 0;
    zone.hidden = !open;
  };
  pane.addEventListener(
    "dragenter",
    (event) => {
      if (!(event as DragEvent).dataTransfer?.types.includes("Files")) return;
      depth += 1;
      show(true);
    },
    { signal },
  );
  pane.addEventListener(
    "dragover",
    (event) => {
      if (!(event as DragEvent).dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
    },
    { signal },
  );
  pane.addEventListener(
    "dragleave",
    () => {
      depth -= 1;
      if (depth <= 0) show(false);
    },
    { signal },
  );
  pane.addEventListener(
    "drop",
    (event) => {
      const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
      show(false);
      if (files.length === 0) return;
      event.preventDefault();
      images.add(files);
    },
    { signal },
  );
}

/**
 * The extension shelf: which widget panel is open, kept across the stream's
 * re-renders, and the copy of the status line a phone reads in the composer's
 * menu, because the strip's own line is sr-only there.
 */
function setUpShelf(): void {
  // undefined until the reader has said something: null is "all closed", and
  // that has to survive the next render as much as an open panel does.
  let open: string | null | undefined;
  const paint = (): void => {
    const shelf = document.getElementById("shelf");
    const panels = shelf?.querySelector<HTMLElement>(
      ".extension-widget-panels",
    );
    if (shelf && panels) {
      // The server picked one; adopt it so the first click closes it.
      if (open === undefined) {
        open =
          shelf.querySelector<HTMLElement>(
            '.extension-widget-trigger[aria-expanded="true"]',
          )?.dataset["widget"] ?? null;
      }
      let shown = false;
      for (const trigger of shelf.querySelectorAll<HTMLElement>(
        "button.extension-widget-trigger",
      )) {
        const key = trigger.dataset["widget"] ?? "";
        const expanded = key === open;
        trigger.setAttribute("aria-expanded", String(expanded));
        const panel = document.getElementById(
          trigger.getAttribute("aria-controls") ?? "",
        );
        if (panel) panel.hidden = !expanded;
        shown ||= expanded;
      }
      panels.hidden = !shown;
    }
    const line = document.querySelector("#shelf .extension-status-text");
    const copy = document.getElementById("shelf-mobile");
    const section = document.getElementById("composer-status-section");
    if (copy && section) {
      copy.innerHTML = line?.innerHTML ?? "";
      section.hidden = line === null;
    }
  };
  document.body.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>(
      "button.extension-widget-trigger",
    );
    if (!trigger) return;
    const key = trigger.dataset["widget"] ?? "";
    open = open === key ? null : key;
    paint();
  });
  document.body.addEventListener("htmx:after:settle", (event) => {
    // The shelf can arrive on its own or inside a larger owner subtree.
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.id === "shelf" || target.querySelector("#shelf")) paint();
  });
  paint();
}
