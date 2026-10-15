import type { SkillSelection } from "@core/ports";
import { skillSelections } from "@core/skill-prompt";

// The unsent draft of a composer: one per session, or per folder until the
// server names the session. Its text and selected skills survive a reload in
// localStorage; attached images stay in this page's memory. Every composer
// mounted for the same draft shares it, and each part keeps its own rule for
// what a submission clears: the text's version, the skills' membership and
// the images' generation.

const TEXT_PREFIX = "web-pi:draft:";
const SKILLS_PREFIX = "web-pi:draft-skills:";
const SAVE_DELAY_MS = 300;

export function draftKey(sessionId: string | null, cwd: string | null): string {
  return sessionId ?? `new:${cwd ?? ""}`;
}

export type DraftPart = "text" | "skills" | "images";

export type Draft = {
  key: string;
  text: string;
  /** Bumped by every text change, so a submission clears only what it sent. */
  version: number;
  skills: SkillSelection[];
  /** When each selected skill joined, numbered from `revision`. */
  membership: Map<string, number>;
  revision: number;
  /** Attached images; changed in place, never replaced. */
  images: File[];
  /** Images still being downscaled. */
  pending: number;
  /** Bumped by a clear, so a late downscale or acceptance changes nothing. */
  generation: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  listeners: Record<DraftPart, Set<() => void>>;
};

const drafts = new Map<string, Draft>();

function read(prefix: string, key: string): string | null {
  try {
    return localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

function write(prefix: string, key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, value);
  } catch {
    /* Private storage: the in-memory draft still works. */
  }
}

/** Stores the draft now and cancels a pending write. */
export function saveDraft(draft: Draft): void {
  clearTimeout(draft.timer);
  draft.timer = undefined;
  // A draft opened without a key belongs to its caller alone.
  if (drafts.get(draft.key) !== draft) return;
  write(TEXT_PREFIX, draft.key, draft.text);
  write(
    SKILLS_PREFIX,
    draft.key,
    draft.skills.length === 0 ? "" : JSON.stringify(draft.skills),
  );
}

/** Stores the draft after a pause, so typing is not a write per keystroke. */
export function saveDraftLater(draft: Draft): void {
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => {
    saveDraft(draft);
  }, SAVE_DELAY_MS);
}

/** Tells every composer showing the draft that one part of it changed. */
export function draftChanged(draft: Draft, part: DraftPart): void {
  for (const listener of draft.listeners[part]) listener();
}

/** Calls `listener` when `part` changes, until `signal` aborts and saves. */
export function onDraftChange(
  draft: Draft,
  part: DraftPart,
  listener: () => void,
  signal?: AbortSignal,
): void {
  draft.listeners[part].add(listener);
  signal?.addEventListener(
    "abort",
    () => {
      draft.listeners[part].delete(listener);
      saveDraft(draft);
    },
    { once: true },
  );
}

let watching = false;

/** The store's own listeners, added with its first draft. */
function watch(): void {
  if (watching) return;
  watching = true;
  addEventListener("pagehide", () => {
    for (const draft of drafts.values()) {
      if (draft.timer !== undefined) saveDraft(draft);
    }
  });
  // The server named the session a folder's draft was written for.
  document.body.addEventListener("web-pi:session-created", (event) => {
    const detail = (event as CustomEvent<{ cwd?: string; id?: string }>).detail;
    const draft = drafts.get(draftKey(null, detail?.cwd ?? null));
    if (!detail?.id || !draft) return;
    write(TEXT_PREFIX, draft.key, "");
    write(SKILLS_PREFIX, draft.key, "");
    drafts.delete(draft.key);
    draft.key = detail.id;
    drafts.set(draft.key, draft);
    saveDraft(draft);
  });
}

/**
 * The draft stored under `key`, read from storage the first time and shared
 * by every composer mounted for it. Without a key, a draft no one else sees
 * and nothing stores.
 */
export function openDraft(key?: string): Draft {
  watch();
  const known = key === undefined ? undefined : drafts.get(key);
  if (known) return known;
  const skills =
    key === undefined
      ? []
      : (skillSelections(read(SKILLS_PREFIX, key) ?? "[]") ?? []);
  const draft: Draft = {
    key: key ?? "",
    text: key === undefined ? "" : (read(TEXT_PREFIX, key) ?? ""),
    version: 0,
    skills,
    membership: new Map(skills.map((skill, index) => [skill.id, index + 1])),
    revision: skills.length,
    images: [],
    pending: 0,
    generation: 0,
    listeners: { text: new Set(), skills: new Set(), images: new Set() },
  };
  if (key !== undefined) drafts.set(key, draft);
  return draft;
}

export type Drafts = {
  save(value: string): void;
  clear(version?: number): boolean;
  version(): number;
};

/** The draft's text: what the textarea holds, across mounts and reloads. */
export function setUpDrafts(
  sessionId: string | null,
  cwd: string | null,
  area: () => HTMLTextAreaElement | null,
  signal?: AbortSignal,
): Drafts {
  const draft = openDraft(draftKey(sessionId, cwd));
  const field = area();
  if (field) {
    if (
      field.hasAttribute("data-restored-draft") ||
      field.value.trim() !== ""
    ) {
      draft.text = field.value;
      draft.version += 1;
      saveDraft(draft);
    } else field.value = draft.text;
  }
  onDraftChange(
    draft,
    "text",
    () => {
      const field = area();
      if (!field || signal?.aborted || field.value === draft.text) return;
      field.value = draft.text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    },
    signal,
  );
  return {
    save(value) {
      if (signal?.aborted) return;
      if (value !== draft.text) {
        draft.text = value;
        draft.version += 1;
      }
      saveDraftLater(draft);
    },
    clear(version) {
      if (version !== undefined && version !== draft.version) return false;
      draft.text = "";
      draft.version += 1;
      saveDraft(draft);
      draftChanged(draft, "text");
      return true;
    },
    version: () => draft.version,
  };
}
