// Whether Pi may invoke a skill on its own. The flag is one YAML line in the
// skill's frontmatter, and the file belongs to the person who wrote it: the
// edit is a line insert, rewrite or delete, so every other field, comment and
// line ending survives untouched. A shape this cannot edit is refused rather
// than guessed at, because a duplicate key would make the file unparseable
// and drop the skill entirely.

const KEY = "disable-model-invocation";

/** The key line: optionally indented, optionally quoted, up to the colon. */
const KEY_LINE = new RegExp(
  String.raw`^([ \t]*(?:"${KEY}"|'${KEY}'|${KEY})[ \t]*:)[^\r\n]*(\r?)$`,
  "m",
);

/** The same line with the newline before it, so removing leaves no gap. */
const KEY_LINE_WITH_BREAK = new RegExp(
  String.raw`\n[ \t]*(?:"${KEY}"|'${KEY}'|${KEY})[ \t]*:[^\n]*`,
);

export class SkillFrontmatterError extends Error {}

/** The frontmatter block and everything after it, or null when there is none. */
function splitBlock(content: string): [string, string] | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  return [content.slice(0, end), content.slice(end)];
}

export function hasDisableModelInvocation(content: string): boolean {
  const block = splitBlock(content);
  // Only the frontmatter counts: a body line that looks like the key is prose.
  return block !== null && KEY_LINE.test(block[0]);
}

/**
 * `disable === false` on a file that never had the key is a no-op, so a skill
 * that was always model-visible is not rewritten just for being toggled on.
 */
export function setDisableModelInvocation(
  content: string,
  disable: boolean,
): string {
  const block = splitBlock(content);
  const firstField = block?.[0]
    .split("\n")
    .slice(1)
    .find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  // A root flow mapping cannot be edited as block-key lines, even when the
  // target key happens to occupy its own line inside the braces.
  if (firstField?.trimStart().startsWith("{")) {
    throw new SkillFrontmatterError(
      `Cannot edit ${KEY}: unsupported frontmatter formatting`,
    );
  }
  const present = hasDisableModelInvocation(content);
  if (!disable && !present) return content;
  if (!disable) {
    if (!block) return content;
    const [head, tail] = block;
    const stripped = head.replace(KEY_LINE_WITH_BREAK, "");
    if (stripped === head) {
      throw new SkillFrontmatterError(
        `Cannot edit ${KEY}: unsupported frontmatter formatting`,
      );
    }
    return stripped + tail;
  }
  if (!block) {
    return `---\n${KEY}: true\n---\n${content}`;
  }
  const [head, tail] = block;
  if (present) {
    const rewritten = head.replace(KEY_LINE, `$1 true$2`);
    if (rewritten === head) {
      throw new SkillFrontmatterError(
        `Cannot edit ${KEY}: unsupported frontmatter formatting`,
      );
    }
    return rewritten + tail;
  }
  // Straight after the opening `---`, keeping whichever line ending it used.
  const firstBreak = head.indexOf("\n");
  const crlf = head.slice(0, firstBreak).endsWith("\r");
  const open = head.slice(0, firstBreak);
  return `${open}\n${KEY}: true${crlf ? "\r" : ""}${head.slice(firstBreak)}${tail}`;
}
