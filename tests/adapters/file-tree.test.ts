import { createFileTree } from "@adapters/fs/file-tree";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-files-"));
  await mkdir(join(root, "src", "web"), { recursive: true });
  await mkdir(join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(join(root, "README.md"), "hi");
  await writeFile(join(root, "src", "web", "app.tsx"), "x");
  await writeFile(join(root, "src", "ignored.log"), "x");
  await writeFile(join(root, "node_modules", "junk", "index.js"), "x");
  await writeFile(join(root, ".gitignore"), "*.log\nnode_modules/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "src/web/app.tsx"], { cwd: root });
  // Ignore rules must not hide a file already present in Git's index.
  await writeFile(join(root, ".gitignore"), "*.log\nnode_modules/\n*.tsx\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("file tree", () => {
  it("lists tracked and untracked files while honouring .gitignore", async () => {
    const index = await createFileTree().index(root);
    expect(index.files).toContain("src/web/app.tsx");
    expect(index.files).toContain("README.md");
    expect(index.files).not.toContain("src/ignored.log");
    expect(index.files.some((file) => file.startsWith("node_modules"))).toBe(
      false,
    );
    expect(index.truncated).toBe(false);
  });

  it("falls back to a directory walk outside a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "web-pi-plain-"));
    await mkdir(join(plain, "node_modules"), { recursive: true });
    await writeFile(join(plain, "node_modules", "skip.js"), "x");
    await writeFile(join(plain, "kept.txt"), "x");
    const index = await createFileTree().index(plain);
    expect(index.files).toEqual(["kept.txt"]);
    await rm(plain, { recursive: true, force: true });
  });

  it("completes immediate children by prefix, directories first", async () => {
    const files = createFileTree();
    const children = await files.children("./src/", root);
    expect(children.map((entry) => entry.path)).toEqual([
      join(root, "src", "web"),
      join(root, "src", "ignored.log"),
    ]);
    const filtered = await files.children("./src/w", root);
    expect(filtered).toEqual([{ path: join(root, "src", "web"), isDir: true }]);
  });

  it("lists children with directories first and the ignore list applied", async () => {
    const entries = await createFileTree().list(root);
    expect(entries.map((entry) => entry.name)).not.toContain("node_modules");
    const names = entries.map((entry) => entry.name);
    expect(names.indexOf("src")).toBeLessThan(names.indexOf("README.md"));
    expect(entries.find((entry) => entry.name === "src")?.isDir).toBe(true);
  });

  it("stats, resolves, and reads text", async () => {
    const files = createFileTree();
    const readme = join(root, "README.md");
    expect((await files.stat(readme))?.isFile).toBe(true);
    expect(await files.stat(join(root, "missing"))).toBeUndefined();
    expect(await files.realpath(readme)).toBe(readme);
    expect(await files.realpath(join(root, "missing"))).toBeUndefined();
    expect(await files.readText(readme)).toBe("hi");
  });

  it("reads complete UTF-8 text above the former preview limit", async () => {
    const path = join(root, "large.txt");
    const text = `${"é".repeat(131_073)}\nend of file\n`;
    await writeFile(path, text);
    expect(await createFileTree().readText(path)).toBe(text);
  });

  it("streams a byte range", async () => {
    const stream = createFileTree().stream(join(root, "README.md"), {
      start: 1,
      end: 1,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("i");
  });

  it("reads a capture file and refuses a directory", async () => {
    const files = createFileTree();
    await writeFile(join(root, "capture.log"), "output");
    expect(await files.readOutput(join(root, "capture.log"))).toBe("output");
    await expect(files.readOutput(join(root, "src"))).rejects.toThrow();
  });

  it("answers 413, not 404, for a capture past the 5 MiB cap", async () => {
    const files = createFileTree();
    const big = join(root, "huge.log");
    await writeFile(big, "");
    await truncate(big, 5 * 1024 * 1024 + 1);
    await expect(files.readOutput(big)).rejects.toMatchObject({ status: 413 });
  });
});
