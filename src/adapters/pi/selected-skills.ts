import type { SkillSelection } from "@core/ports";
import { encodeSkillPrompt, uniqueSkills } from "@core/skill-prompt";
import { stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

/** Resolve every identity before reading anything; never interpret a client ID as a path. */
export function selectedSkillPrompt(
  text: string,
  selections: readonly SkillSelection[],
  available: readonly Skill[],
): string {
  const selected = uniqueSkills(selections).map((selection) => {
    const skill = available.find((value) => value.filePath === selection.id);
    if (!skill)
      throw new Error(`Selected skill is unavailable: ${selection.name}`);
    return skill;
  });
  const dropdown = selected.map((skill) => ({
    id: skill.filePath,
    name: skill.name,
  }));
  let request = text;
  if (text.trimStart().startsWith("/")) {
    const command = /^\/skill:([^\s]+)(?:\s([\s\S]*))?$/.exec(text.trimStart());
    const leading =
      command && available.find((skill) => skill.name === command[1]);
    if (!leading) {
      throw new Error(
        "Selected skills cannot be combined with another slash command. Use a known /skill:name or an ordinary request.",
      );
    }
    // Keep a distinct leading invocation first, without changing dropdown order.
    if (!selected.some((skill) => skill.filePath === leading.filePath))
      selected.unshift(leading);
    request = command?.[2] ?? "";
  }
  const envelopes = selected.map((skill) => {
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
    } catch (error) {
      throw new Error(`Could not read selected skill: ${skill.name}`, {
        cause: error,
      });
    }
    // Match Pi's explicit /skill envelope, including its reference base.
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  });
  const expanded = [...envelopes, ...(request ? [request] : [])].join("\n\n");
  return encodeSkillPrompt(text, dropdown, expanded);
}
