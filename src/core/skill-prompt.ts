import type {
  EditableMessage,
  QueuedMessage,
  SkillSelection,
} from "./ports.ts";

// One self-contained record travels with the ordinary user message through Pi's
// queue, JSONL, forks and tree navigation. URI encoding keeps user text from
// closing the comment. This is provenance, not authorization to read a skill.
const PREFIX = "<!-- web-pi:skill-selection:v1:";
const SUFFIX = " -->\n";

export type SkillPrompt = { text: string; skills?: SkillSelection[] };

export function uniqueSkills(
  skills: readonly SkillSelection[],
): SkillSelection[] {
  const seen = new Set<string>();
  return skills.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * A list of skill identities, from a parsed value or its JSON text, without
 * repeats. Anything that is not one makes the whole list undefined: a
 * damaged selection is refused, never half-read.
 */
export function skillSelections(value: unknown): SkillSelection[] | undefined {
  let list = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(list)) return undefined;
  const skills: SkillSelection[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { id, name } = item as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name)
      return undefined;
    skills.push({ id, name });
  }
  return uniqueSkills(skills);
}

export function encodeSkillPrompt(
  text: string,
  skills: readonly SkillSelection[],
  expanded: string,
): string {
  // String length frames the expansion without parsing delimiters in arbitrary
  // skill Markdown. Input hooks can prepend/append text without losing it on recall.
  return `${PREFIX}${encodeURIComponent(JSON.stringify({ text, skills: uniqueSkills(skills), expandedLength: expanded.length }))}${SUFFIX}${expanded}`;
}

/** Pi's legacy single-skill envelope, retained for terminal and older sessions. */
const SKILL_EXPANSION =
  /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function skillCommand(text: string): string | undefined {
  const match = SKILL_EXPANSION.exec(text);
  if (!match || (text.match(/^<skill name=/gm)?.length ?? 0) !== 1)
    return undefined;
  const name = match[1] ?? "";
  const args = match[4];
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}

/** Decode only our versioned record. Unknown or damaged records remain literal text. */
function provenance(
  text: string,
): { draft: SkillPrompt; prefix: string; suffix: string } | undefined {
  const start = text.indexOf(PREFIX);
  if (start < 0) return undefined;
  // The record precedes the envelopes. Never promote an instruction-body
  // example if an extension removes the real record, or skip a damaged record.
  const firstSkill = text.indexOf('<skill name="');
  if (firstSkill >= 0 && firstSkill < start) return undefined;
  const end = text.indexOf(SUFFIX, start + PREFIX.length);
  if (end < 0) return undefined;
  const expandedStart = end + SUFFIX.length;
  try {
    const value: unknown = JSON.parse(
      decodeURIComponent(text.slice(start + PREFIX.length, end)),
    );
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const expandedLength = record["expandedLength"];
    const skills = skillSelections(record["skills"]);
    if (
      typeof record["text"] !== "string" ||
      skills === undefined ||
      typeof expandedLength !== "number" ||
      !Number.isSafeInteger(expandedLength) ||
      expandedLength < 0 ||
      expandedLength > text.length - expandedStart
    )
      return undefined;
    return {
      draft: { text: record["text"], skills },
      prefix: text.slice(0, start),
      suffix: text.slice(expandedStart + expandedLength),
    };
  } catch {
    return undefined;
  }
}

/** Readable message content includes additions retained outside the generated expansion. */
export function displaySkillPrompt(text: string): SkillPrompt {
  const frame = provenance(text);
  return frame
    ? { ...frame.draft, text: frame.prefix + frame.draft.text + frame.suffix }
    : { text: skillCommand(text) ?? text };
}

/** Recover authored intent, not hook output: hooks will run again on a new submission. */
export function recoverSkillPrompt(text: string): SkillPrompt {
  return provenance(text)?.draft ?? { text: skillCommand(text) ?? text };
}

export type QueueRecall = EditableMessage & { warning?: string };

/**
 * Recover each authored request before joining; union only dropdown
 * selections. The draft the reader has in the composer goes last, as Pi's
 * editor puts it after the queued text.
 */
export function recallSkillPrompts(
  queued: readonly QueuedMessage[],
  available: readonly SkillSelection[],
  current: SkillPrompt = { text: "" },
): QueueRecall {
  const drafts = queued.map(({ text }) => recoverSkillPrompt(text));
  const skills = uniqueSkills([
    ...drafts.flatMap((prompt) => prompt.skills ?? []),
    ...(current.skills ?? []),
  ]);
  // Resolve names against this live session's discovery, just as resend will.
  // A selected identity or the combined draft's first command already includes it.
  const included = new Set(skills.map((skill) => skill.id));
  const lost = new Set<string>();
  const leadingSkill = (text: string) => {
    const name = /^\/skill:([^\s]+)/.exec(text.trimStart())?.[1];
    return { name, id: available.find((skill) => skill.name === name)?.id };
  };
  let precedingText = false;
  for (const [index, draft] of drafts.entries()) {
    const { name, id } = leadingSkill(draft.text);
    const invoked =
      draft.skills !== undefined ||
      skillCommand(queued[index]?.text ?? "") !== undefined;
    if (name && invoked) {
      if (!precedingText && id) included.add(id);
      else if (precedingText && (!id || !included.has(id))) lost.add(name);
    }
    precedingText ||= draft.text.trim() !== "";
  }
  // The reader's draft goes after the queued text, so a /skill: command
  // typed at its start no longer starts the request either.
  const typed = leadingSkill(current.text);
  if (typed.name && typed.id && precedingText && !included.has(typed.id))
    lost.add(typed.name);
  const warning =
    lost.size > 0
      ? `After queue recall, ${[...lost].map((name) => `/skill:${name}`).join(", ")} will not invoke from the middle of the combined request. Select ${[...lost].join(", ")} in Skills to include ${lost.size === 1 ? "it" : "them"} on resend.`
      : undefined;
  const texts = drafts.map(({ text }) => text).filter((text) => text !== "");
  if (current.text.trim() !== "") texts.push(current.text);
  return {
    text: texts.join("\n\n"),
    images: queued.flatMap((message) => message.images ?? []),
    ...(skills.length > 0 ? { skills } : {}),
    ...(warning ? { warning } : {}),
  };
}
