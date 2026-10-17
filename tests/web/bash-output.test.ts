import { createFakeWorld, userEntry } from "@adapters/fake/index";
import { createFileTree } from "@adapters/fs/file-tree";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { parseHtml } from "#/web/helpers";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root = "";
let captures = "";
let cwd = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-capture-"));
  captures = join(root, "captures");
  cwd = join(root, "project");
  await mkdir(captures);
  await mkdir(cwd);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function captureApp(path: string, referenced = true) {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd,
          fileSize: 100,
          createdAt: "2026-10-17T00:00:00.000Z",
          modifiedAt: "2026-10-17T00:00:00.000Z",
        },
        entries: referenced
          ? [
              {
                type: "message",
                id: "bash1",
                parentId: null,
                timestamp: "2026-10-17T00:00:00.000Z",
                message: {
                  role: "bashExecution",
                  command: "synthetic, never executed",
                  output: "truncated",
                  exitCode: 0,
                  cancelled: false,
                  truncated: true,
                  fullOutputPath: path,
                  timestamp: 1,
                },
              },
            ]
          : [
              userEntry(
                "u1",
                null,
                `A mention alone is not a capture reference: ${path}`,
              ),
            ],
      },
    ],
  });
  world.files = createFileTree();
  world.tmpdir = captures;
  return createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: cwd,
  });
}

function captureUrl(path: string, download = false): string {
  return `/sessions/s1/bash-output?${new URLSearchParams({ path, download: download ? "1" : "0" })}`;
}

it("downloads the complete large capture from the advertised action while keeping the inline cap", async () => {
  const path = join(captures, "pi-bash-large.log");
  const app = captureApp(path);
  const small = "small capture\n";
  await writeFile(path, small);
  for (const download of [false, true]) {
    const response = await app.request(captureUrl(path, download));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(small);
  }
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
  bytes.write("full capture\n");
  bytes.write("end", bytes.length - 3);
  await writeFile(path, bytes);
  const page = parseHtml(await (await app.request("/sessions/s1")).text());
  const link = page.querySelector('a[href*="bash-output"][href*="download=1"]');
  expect(link).not.toBeNull();
  const inline = await app.request(captureUrl(path));
  expect(inline.status).toBe(413);
  expect(await inline.text()).toContain("Download it instead.");
  const response = await app.request(link?.getAttribute("href") ?? "");
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toContain("attachment;");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
});

it.each([false, true])(
  "keeps capture-specific authorization for download=%s",
  async (download) => {
    const path = join(captures, "pi-bash-allowed.log");
    await writeFile(path, "capture");
    const mentioned = captureApp(path, false);
    expect((await mentioned.request(captureUrl(path, download))).status).toBe(
      403,
    );
    for (const invalid of [
      join(captures, "other.log"),
      join(cwd, "pi-bash-wrong-directory.log"),
    ]) {
      await writeFile(invalid, "not a permitted capture");
      const app = captureApp(invalid);
      const refused = await app.request(captureUrl(invalid, download));
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe("Not a shell output file");
    }
  },
);

it.each([false, true])(
  "refuses symlinks and directories even when referenced, download=%s",
  async (download) => {
    const target = join(cwd, "target.txt");
    await writeFile(target, "must not be served");
    const link = join(captures, "pi-bash-link.log");
    await symlink(target, link);
    const directory = join(captures, "pi-bash-directory.log");
    await mkdir(directory);
    for (const path of [link, directory]) {
      const response = await captureApp(path).request(
        captureUrl(path, download),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Cannot read that output file");
    }
  },
);
