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
function provenance(text: string): SkillPrompt | undefined {
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
    if (
      typeof record["text"] !== "string" ||
      !Array.isArray(record["skills"]) ||
      typeof expandedLength !== "number" ||
      !Number.isSafeInteger(expandedLength) ||
      expandedLength < 0 ||
      expandedLength > text.length - expandedStart
    )
      return undefined;
    const skills: SkillSelection[] = [];
    for (const item of record["skills"] as unknown[]) {
      if (typeof item !== "object" || item === null) return undefined;
      const selection = item as Record<string, unknown>;
      if (
        typeof selection["id"] !== "string" ||
        !selection["id"] ||
        typeof selection["name"] !== "string" ||
        !selection["name"]
      )
        return undefined;
      skills.push({ id: selection["id"], name: selection["name"] });
    }
    return {
      text:
        text.slice(0, start) +
        record["text"] +
        text.slice(expandedStart + expandedLength),
      skills: uniqueSkills(skills),
    };
  } catch {
    return undefined;
  }
}

/** Original draft and only its dropdown selections; legacy envelopes become commands. */
export function decodeSkillPrompt(text: string): SkillPrompt {
  return provenance(text) ?? { text: skillCommand(text) ?? text };
}

/** Decode each queued prompt before joining; union only its dropdown selections. */
export function recallSkillPrompts(
  queued: readonly QueuedMessage[],
): EditableMessage {
  const decoded = queued.map(({ text }) => decodeSkillPrompt(text));
  const skills = uniqueSkills(decoded.flatMap((prompt) => prompt.skills ?? []));
  return {
    text: decoded
      .map(({ text }) => text)
      .filter((text) => text !== "")
      .join("\n\n"),
    images: queued.flatMap((message) => message.images ?? []),
    ...(skills.length > 0 ? { skills } : {}),
  };
}
