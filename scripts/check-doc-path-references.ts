import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Source references must exist even in a checkout that has not been built.
// Only these known justfile outputs may legitimately be absent.
const generatedOutputs = new Set([
  "static/app.css",
  "static/client.js",
  "static/mermaid.js",
]);
const roots = ["AGENTS.md", "README.md", "docs"];
const pattern = /`((?:src|tests|scripts|docs|static)\/[\w./-]+)`/g;

function* markdownFiles(path: string): Generator<string> {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const child of readdirSync(path))
      yield* markdownFiles(join(path, child));
  } else if (path.endsWith(".md")) {
    yield path;
  }
}

const missing: string[] = [];
for (const root of roots) {
  for (const file of markdownFiles(root)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const target = match[1];
      if (target && !generatedOutputs.has(target) && !existsSync(target))
        missing.push(`${file}: ${target}`);
    }
  }
}
if (missing.length > 0) {
  process.stderr.write(
    `Missing paths referenced in docs:\n${missing.join("\n")}\n`,
  );
  process.exit(1);
}
