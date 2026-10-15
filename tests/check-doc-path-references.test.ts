import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it, onTestFinished } from "vitest";

const script = resolve("scripts/check-doc-path-references.ts");

/** Run the check in a scratch checkout that holds only these files. */
function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "web-pi-doc-check-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

const guide = [
  "# Guide",
  "## Codemode, tool search, and MCP",
  "## Notes",
  "## Notes",
  "```bash",
  "# Fenced comment",
  "[example](missing.md)",
  "```",
  "[Home](../README.md#web-pi) [Again](#notes-1) [Image](images/a.png)",
].join("\n\n");

it("accepts paths, links, images and GitHub heading anchors that resolve", () => {
  const result = check({
    "README.md": [
      "# web-pi",
      "See `docs/guide.md`, [MCP](docs/guide.md#codemode-tool-search-and-mcp),",
      "[the top](#web-pi) and [the web](https://example.com/missing.md).",
      '![Shot](docs/images/a.png) <img src="docs/images/a.png" alt="" />',
    ].join("\n"),
    "docs/guide.md": guide,
    "docs/images/a.png": "",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("names every missing path, linked file and heading", () => {
  const result = check({
    "README.md": [
      "# web-pi",
      "`src/missing.ts` [file](docs/missing.md) [heading](docs/guide.md#nope)",
      "[fenced](docs/guide.md#fenced-comment) [self](#missing)",
      '<img src="docs/images/missing.png" alt="" />',
    ].join("\n"),
    "docs/guide.md": guide,
    "docs/images/a.png": "",
  });
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split("\n")).toEqual([
    "Broken references in the documentation:",
    "README.md: src/missing.ts does not exist",
    "README.md: link docs/missing.md names a missing file",
    "README.md: link docs/guide.md#nope names a missing heading",
    "README.md: link docs/guide.md#fenced-comment names a missing heading",
    "README.md: link #missing names a missing heading",
    "README.md: link docs/images/missing.png names a missing file",
  ]);
});
