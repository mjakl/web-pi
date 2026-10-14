import type { SkillSelection } from "@core/ports";
import { skillSelections, uniqueSkills } from "@core/skill-prompt";
import {
  draftChanged,
  draftKey,
  onDraftChange,
  openDraft,
  saveDraft,
  saveDraftLater,
} from "./drafts.ts";

function parse(value: string | undefined): SkillSelection[] {
  return skillSelections(value ?? "[]") ?? [];
}

export type SkillDrafts = {
  count(): number;
  submitted(): () => void;
  restore(skills: SkillSelection[]): void;
};

/**
 * The draft's selected skills, cleared independently of its text: each
 * selected identity has its own submission ownership.
 */
export function setUpSkills(
  form: HTMLElement,
  changed: () => void,
  signal: AbortSignal,
): SkillDrafts {
  const field = form.querySelector<HTMLInputElement>("#composer-skills");
  const label = form.querySelector<HTMLElement>("#skills-label");
  const menu = form.querySelector<HTMLElement>("#skills-menu");
  const filter = form.querySelector<HTMLInputElement>("#skills-filter");
  const results = form.querySelector<HTMLElement>("#skills-results");
  const trigger = form.querySelector<HTMLElement>("#skills-trigger");
  const selector = form.querySelector<HTMLElement>("#skills-selector");
  const draft = openDraft(
    draftKey(form.dataset["sessionId"] ?? null, form.dataset["cwd"] ?? null),
  );
  const restored =
    form.querySelector<HTMLTextAreaElement>("#composer-text")?.dataset[
      "restoredSkills"
    ];
  if (restored !== undefined) {
    draft.skills = parse(restored);
    draft.membership = new Map(
      draft.skills.map((skill) => [skill.id, ++draft.revision]),
    );
    saveDraft(draft);
  }

  function rows(): HTMLElement[] {
    return [
      ...(results?.querySelectorAll<HTMLElement>("[data-skill-id]") ?? []),
    ];
  }
  function paint(): void {
    if (signal.aborted) return;
    if (field) field.value = JSON.stringify(draft.skills);
    const title = draft.skills.length
      ? `Skills (${String(draft.skills.length)})`
      : "Skills";
    if (label) label.textContent = title;
    trigger?.setAttribute("aria-label", title);
    for (const old of results?.querySelectorAll(
      ".composer-skill-unavailable",
    ) ?? [])
      old.remove();
    const known = new Set(rows().map((row) => row.dataset["skillId"]));
    for (const skill of draft.skills) {
      if (known.has(skill.id)) continue;
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "menu-item composer-skill-option composer-skill-unavailable";
      row.setAttribute("role", "option");
      row.dataset["skillId"] = skill.id;
      row.dataset["skillName"] = skill.name;
      row.dataset["skillSearch"] = skill.name;
      const check = document.createElement("span");
      check.className = "composer-skill-check";
      const name = document.createElement("span");
      name.className = "composer-skill-label";
      name.textContent = skill.name;
      name.title = skill.name;
      const note = document.createElement("span");
      note.className = "composer-skill-unavailable-note";
      note.textContent = "Unavailable · select to remove";
      row.append(check, name, note);
      results?.append(row);
    }
    const needle = filter?.value.trim().toLocaleLowerCase() ?? "";
    let shown = 0;
    for (const row of rows()) {
      const selected = draft.skills.some(
        (skill) => skill.id === row.dataset["skillId"],
      );
      row.setAttribute("aria-selected", String(selected));
      const check = row.firstElementChild;
      if (check instanceof HTMLElement) {
        check.className = selected
          ? "composer-skill-check"
          : "composer-model-check-space";
        check.textContent = selected ? "✓" : "";
      }
      row.hidden = !(row.dataset["skillSearch"] ?? "")
        .toLocaleLowerCase()
        .includes(needle);
      if (!row.hidden) shown += 1;
    }
    const empty = results?.querySelector<HTMLElement>(".composer-skills-empty");
    if (empty && empty.textContent === "No skills found")
      empty.hidden = shown > 0 || needle !== "";
    results?.querySelector(".composer-skills-no-match")?.remove();
    if (shown === 0 && needle !== "") {
      const none = document.createElement("div");
      none.className = "composer-skills-empty composer-skills-no-match";
      none.textContent = "No matching skills";
      results?.append(none);
    }
  }
  function replace(skills: SkillSelection[], newOwnership = false): void {
    const next = uniqueSkills(skills);
    const membership = new Map<string, number>();
    for (const skill of next)
      membership.set(
        skill.id,
        newOwnership
          ? ++draft.revision
          : (draft.membership.get(skill.id) ?? ++draft.revision),
      );
    draft.skills = next;
    draft.membership = membership;
    saveDraftLater(draft);
    draftChanged(draft, "skills");
  }
  onDraftChange(
    draft,
    "skills",
    () => {
      paint();
      changed();
    },
    signal,
  );

  async function load(): Promise<void> {
    if (!selector || !results) return;
    results.innerHTML =
      '<div class="composer-skills-empty" role="status">Loading skills…</div>';
    paint();
    try {
      const response = await fetch(selector.dataset["skillsUrl"] ?? "", {
        signal,
      });
      if (!response.ok) throw new Error("Skill lookup failed");
      const html = await response.text();
      if (signal.aborted || !form.isConnected) return;
      const fragment = document.createElement("div");
      fragment.innerHTML = html;
      const list = fragment.querySelector(".composer-skills-list");
      if (!list) throw new Error("Missing skills list");
      results.replaceChildren(...list.childNodes);
      paint();
    } catch {
      if (signal.aborted || !form.isConnected) return;
      results.innerHTML =
        '<div class="composer-skills-empty" role="status">Could not load skills. Close and reopen to retry.</div>';
      paint();
    }
  }
  menu?.addEventListener(
    "toggle",
    (event) => {
      const open = event.newState === "open";
      trigger?.setAttribute("aria-expanded", String(open));
      if (open) {
        void load();
        filter?.focus();
      } else if (filter) {
        filter.value = "";
        paint();
      }
    },
    { signal },
  );
  filter?.addEventListener(
    "input",
    () => {
      paint();
    },
    { signal },
  );
  filter?.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") {
        // Search is inside the composer form; even IME confirmation must not submit it.
        event.preventDefault();
      } else if (event.key === "Escape") {
        event.preventDefault();
        menu?.hidePopover();
        trigger?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const visible = rows().filter((row) => !row.hidden);
        const target = event.key === "ArrowDown" ? visible[0] : visible.at(-1);
        if (target) {
          event.preventDefault();
          target.focus();
        }
      }
    },
    { signal },
  );
  results?.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      const row = event.target.closest<HTMLElement>("[data-skill-id]");
      if (!row || !results.contains(row)) return;
      const id = row.dataset["skillId"] ?? "";
      const existing = draft.skills.find((skill) => skill.id === id);
      replace(
        existing
          ? draft.skills.filter((skill) => skill.id !== id)
          : [...draft.skills, { id, name: row.dataset["skillName"] ?? "" }],
      );
    },
    { signal },
  );
  results?.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        menu?.hidePopover();
        trigger?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const visible = rows().filter((row) => !row.hidden);
      const index =
        event.target instanceof HTMLElement
          ? visible.indexOf(event.target)
          : -1;
      const next = visible[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        next.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        filter?.focus();
      }
    },
    { signal },
  );

  const seen = new WeakSet<Element>();
  const drain = (): void => {
    if (signal.aborted) return;
    const area = form.querySelector<HTMLTextAreaElement>("#composer-text");
    if (area?.hasAttribute("data-restored-skills") && !seen.has(area)) {
      seen.add(area);
      replace(parse(area.dataset["restoredSkills"]), true);
    }
  };
  document.body.addEventListener("htmx:after:settle", drain, { signal });
  const initialArea = form.querySelector("#composer-text");
  if (initialArea) seen.add(initialArea);
  drain();
  paint();
  return {
    count: () => draft.skills.length,
    submitted() {
      const sent = new Map(draft.membership);
      return () => {
        const remaining = draft.skills.filter(
          (skill) => sent.get(skill.id) !== draft.membership.get(skill.id),
        );
        if (remaining.length === draft.skills.length) return;
        replace(remaining);
        saveDraft(draft);
      };
    },
    restore(skills) {
      replace(skills, true);
    },
  };
}
