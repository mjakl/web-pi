// The YAML block a Markdown file may open with. Only the shapes a card can
// show are understood — scalars, inline lists, and block lists — because
// anything deeper would be printed as a nested structure nobody reads. A
// value this parser cannot make sense of is dropped, never guessed at.

export type FrontmatterValue = string | string[];

export type Frontmatter = {
  fields: [string, FrontmatterValue][];
  /** The document with the block removed. */
  body: string;
  /**
   * There was a block, every line of it became a field and no key repeats,
   * so a card shows all of it.
   */
  complete: boolean;
};

function unquote(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseInlineList(text: string): string[] {
  return text
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter((item) => item !== "");
}

/** No block at all yields no fields and the original text as the body. */
export function parseFrontmatter(source: string): Frontmatter {
  const none = { fields: [], body: source, complete: false };
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return none;
  const end = lines.findIndex(
    (line, index) => index > 0 && /^---[ \t]*$/.test(line),
  );
  if (end === -1) return none;
  const body = lines.slice(end + 1).join("\n");
  const fields: [string, FrontmatterValue][] = [];
  let complete = true;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    // A comment is text a card would not show.
    if (line.trimStart().startsWith("#")) {
      complete = false;
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!match) {
      complete = false;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      fields.push([key, parseInlineList(value)]);
      continue;
    }
    if (value === "") {
      // A block list: the indented "- item" lines that follow.
      const items: string[] = [];
      while (index + 1 < end) {
        const next = lines[index + 1] ?? "";
        if (!/^[ \t]*-[ \t]+/.test(next)) break;
        items.push(unquote(next.replace(/^[ \t]*-[ \t]+/, "")));
        index += 1;
      }
      if (items.length > 0) fields.push([key, items]);
      else complete = false;
      continue;
    }
    fields.push([key, unquote(value)]);
  }
  const keys = new Set(fields.map(([key]) => key));
  return { fields, body, complete: complete && keys.size === fields.length };
}

const LIST_KEYS = ["tags", "categories", "keywords", "tag", "category"];

/** The card: a heading, one row of chips, and everything else as pairs. */
export function frontmatterCard(fields: [string, FrontmatterValue][]): {
  title?: string;
  chips: string[];
  rest: [string, string][];
} {
  const title = fields.find(([key]) => key === "title")?.[1];
  const chipKey = LIST_KEYS.find((key) =>
    fields.some(([name, value]) => name === key && Array.isArray(value)),
  );
  const chips = chipKey
    ? ((fields.find(([name]) => name === chipKey)?.[1] ?? []) as string[])
    : [];
  const rest: [string, string][] = [];
  for (const [key, value] of fields) {
    if (key === "title" && typeof value === "string") continue;
    if (key === chipKey) continue;
    rest.push([key, Array.isArray(value) ? value.join(", ") : value]);
  }
  return {
    ...(typeof title === "string" && title !== "" ? { title } : {}),
    chips,
    rest,
  };
}
