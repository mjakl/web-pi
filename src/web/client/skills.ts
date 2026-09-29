import type { SkillSelection } from "@core/ports";
import { draftKey } from "./drafts.ts";

type SkillDraft = {
  key: string;
  selections: SkillSelection[];
  revision: number;
  membership: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
  changed: Set<() => void>;
};
const drafts = new Map<string, SkillDraft>();
const PREFIX = "web-pi:draft-skills:";

function parse(value: string | undefined | null): SkillSelection[] {
  try {
    const decoded: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(decoded)) return [];
    const seen = new Set<string>();
    const entries: unknown[] = decoded;
    return entries.filter((entry): entry is SkillSelection => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("id" in entry) ||
        !("name" in entry) ||
        typeof entry.id !== "string" ||
        typeof entry.name !== "string" ||
        !entry.id ||
        seen.has(entry.id)
      )
        return false;
      seen.add(entry.id);
      return true;
    });
  } catch {
    return [];
  }
}

function read(key: string): SkillSelection[] {
  try {
    return parse(localStorage.getItem(PREFIX + key));
  } catch {
    return [];
  }
}
function flush(draft: SkillDraft): void {
  clearTimeout(draft.timer);
  draft.timer = undefined;
  try {
    if (draft.selections.length === 0)
      localStorage.removeItem(PREFIX + draft.key);
    else
      localStorage.setItem(
        PREFIX + draft.key,
        JSON.stringify(draft.selections),
      );
  } catch {
    /* Storage may be unavailable; the in-memory draft remains. */
  }
}

export type SkillDrafts = {
  count(): number;
  submitted(): () => void;
  restore(skills: SkillSelection[]): void;
};

/** Selection drafts are independent of text drafts; each selected identity has its own submission ownership. */
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
  let key = draftKey(
    form.dataset["sessionId"] ?? null,
    form.dataset["cwd"] ?? null,
  );
  const draft = drafts.get(key) ?? {
    key,
    selections: read(key),
    revision: 0,
    membership: new Map<string, number>(),
    changed: new Set<() => void>(),
  };
  for (const skill of draft.selections) {
    if (!draft.membership.has(skill.id))
      draft.membership.set(skill.id, ++draft.revision);
  }
  drafts.set(key, draft);
  const restored =
    form.querySelector<HTMLTextAreaElement>("#composer-text")?.dataset[
      "restoredSkills"
    ];
  if (restored !== undefined) {
    draft.selections = parse(restored);
    draft.membership = new Map(
      draft.selections.map((skill) => [skill.id, ++draft.revision]),
    );
    flush(draft);
  }

  function rows(): HTMLElement[] {
    return [
      ...(results?.querySelectorAll<HTMLElement>("[data-skill-id]") ?? []),
    ];
  }
  function paint(): void {
    if (signal.aborted) return;
    if (field) field.value = JSON.stringify(draft.selections);
    const title = draft.selections.length
      ? `Skills (${String(draft.selections.length)})`
      : "Skills";
    if (label) label.textContent = title;
    trigger?.setAttribute("aria-label", title);
    for (const old of results?.querySelectorAll(
      ".composer-skill-unavailable",
    ) ?? [])
      old.remove();
    const known = new Set(rows().map((row) => row.dataset["skillId"]));
    for (const skill of draft.selections) {
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
      const selected = draft.selections.some(
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
  function notify(): void {
    for (const listener of draft.changed) listener();
  }
  function replace(skills: SkillSelection[], newOwnership = false): void {
    const next = parse(JSON.stringify(skills));
    const membership = new Map<string, number>();
    for (const skill of next)
      membership.set(
        skill.id,
        newOwnership
          ? ++draft.revision
          : (draft.membership.get(skill.id) ?? ++draft.revision),
      );
    draft.selections = next;
    draft.membership = membership;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(() => {
      flush(draft);
    }, 300);
    notify();
  }
  const update = (): void => {
    paint();
    changed();
  };
  draft.changed.add(update);
  signal.addEventListener(
    "abort",
    () => {
      flush(draft);
      draft.changed.delete(update);
    },
    { once: true },
  );
  addEventListener(
    "pagehide",
    () => {
      flush(draft);
    },
    { signal },
  );
  document.body.addEventListener(
    "web-pi:session-created",
    (event) => {
      const detail = (event as CustomEvent<{ cwd?: string; id?: string }>)
        .detail;
      if (!detail?.id || key !== draftKey(null, detail.cwd ?? null)) return;
      flush(draft);
      try {
        localStorage.removeItem(PREFIX + key);
      } catch {
        /* Private storage. */
      }
      drafts.delete(key);
      key = detail.id;
      draft.key = key;
      drafts.set(key, draft);
      flush(draft);
    },
    { signal },
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
      const existing = draft.selections.find((skill) => skill.id === id);
      replace(
        existing
          ? draft.selections.filter((skill) => skill.id !== id)
          : [...draft.selections, { id, name: row.dataset["skillName"] ?? "" }],
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
    count: () => draft.selections.length,
    submitted() {
      const sent = new Map(draft.membership);
      return () => {
        const remaining = draft.selections.filter(
          (skill) => sent.get(skill.id) !== draft.membership.get(skill.id),
        );
        if (remaining.length === draft.selections.length) return;
        replace(remaining);
        flush(draft);
      };
    },
    restore(skills) {
      replace(skills, true);
    },
  };
}
