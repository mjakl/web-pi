import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Source references must exist even in a checkout that has not been built.
// Only these known justfile outputs may legitimately be absent.
const generatedOutputs = new Set(["static/app.css", "static/client.js"]);
const roots = ["AGENTS.md", "README.md", "docs"];
const pathPattern = /`((?:src|tests|scripts|docs|static)\/[\w./-]+)`/g;
// Markdown links and images, and the HTML images Markdown cannot size.
const linkPattern = /\]\(([^)\s]+)\)|<img\s[^>]*src="([^"]+)"/g;

function* markdownFiles(path: string): Generator<string> {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const child of readdirSync(path))
      yield* markdownFiles(join(path, child));
  } else if (path.endsWith(".md")) {
    yield path;
  }
}

/** The lines outside fenced code, where Markdown renders links and headings. */
function proseLines(text: string): string[] {
  let fenced = false;
  return text.split("\n").filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) return true;
    return false;
  });
}

const anchorCache = new Map<string, Set<string>>();
/** Heading anchors as GitHub derives them: lowercase, punctuation and
 * symbols dropped, each space a hyphen, repeated headings numbered. */
function anchors(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const found = new Set<string>();
  const repeats = new Map<string, number>();
  for (const line of proseLines(readFileSync(file, "utf8"))) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc} -]/gu, "")
      .replaceAll(" ", "-");
    const seen = repeats.get(slug) ?? 0;
    repeats.set(slug, seen + 1);
    found.add(seen === 0 ? slug : `${slug}-${String(seen)}`);
  }
  anchorCache.set(file, found);
  return found;
}

const broken: string[] = [];
for (const root of roots) {
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pathPattern)) {
      const target = match[1];
      if (target && !generatedOutputs.has(target) && !existsSync(target))
        broken.push(`${file}: ${target} does not exist`);
    }
    for (const match of proseLines(text).join("\n").matchAll(linkPattern)) {
      const target = match[1] ?? match[2] ?? "";
      // A scheme (https:, mailto:) or a protocol-relative URL leaves the repo.
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
      const [path = "", anchor] = target.split("#");
      const linked =
        path === "" ? file : join(dirname(file), decodeURIComponent(path));
      if (!existsSync(linked)) {
        broken.push(`${file}: link ${target} names a missing file`);
      } else if (
        anchor !== undefined &&
        linked.endsWith(".md") &&
        !anchors(linked).has(decodeURIComponent(anchor))
      ) {
        broken.push(`${file}: link ${target} names a missing heading`);
      }
    }
  }
}
if (broken.length > 0) {
  process.stderr.write(
    `Broken references in the documentation:\n${broken.join("\n")}\n`,
  );
  process.exit(1);
}
