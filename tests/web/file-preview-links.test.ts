import { createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { parseHtml } from "#/web/helpers";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root = "";
let project = "";
let docs = "";
let app: ReturnType<typeof createWebApp>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-preview-"));
  project = join(root, "project");
  docs = join(project, "docs");
  await mkdir(docs, { recursive: true });
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: project,
          fileSize: 100,
          createdAt: "2026-10-17T00:00:00.000Z",
          modifiedAt: "2026-10-17T00:00:00.000Z",
        },
        entries: [],
      },
    ],
  });
  app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: project,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function view(path: string) {
  return app.request(
    `/files/view?${new URLSearchParams({ session: "s1", path })}`,
  );
}

async function preview(path: string, source: string) {
  await writeFile(path, source);
  const response = await view(path);
  expect(response.status).toBe(200);
  return parseHtml(await response.text());
}

it("resolves sibling and parent links and images against the viewed document, not toolbar cwd", async () => {
  await writeFile(join(docs, "sibling.md"), "nested sibling");
  await writeFile(join(project, "sibling.md"), "wrong root sibling");
  await writeFile(join(project, "README.md"), "parent document");
  await writeFile(join(docs, "diagram.png"), "nested image");
  await writeFile(join(project, "parent.png"), "parent image");
  const document = await preview(
    join(docs, "guide.md"),
    "[Sibling](sibling.md)\n\n[Parent](../README.md)\n\n![Diagram](diagram.png)\n\n![Parent image](../parent.png)",
  );
  const targets = [...document.querySelectorAll(".markdown-file-ref")].map(
    (link) => link.getAttribute("data-file-path"),
  );
  expect(targets).toEqual([
    join(docs, "sibling.md"),
    join(project, "README.md"),
  ]);
  for (const [index, text] of ["nested sibling", "parent document"].entries()) {
    const response = await view(targets[index] ?? "");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(text);
  }
  const images = [...document.querySelectorAll(".markdown-local-image")];
  expect(images).toHaveLength(2);
  for (const [index, text] of ["nested image", "parent image"].entries()) {
    const response = await app.request(
      images[index]?.getAttribute("src") ?? "",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
  }
  expect(document.querySelector(".file-viewer-path")?.textContent).toBe(
    "docs/guide.md",
  );
  const mode = document
    .querySelector('[hx-get*="mode=source"]')
    ?.getAttribute("hx-get");
  expect(mode).toContain("session=s1&mode=source");
});

it.each(["", "docs", "docs%20literal"])(
  "decodes preview URL filenames once with a literal document directory %s",
  async (directory) => {
    const folder = join(project, directory);
    await mkdir(folder, { recursive: true });
    const cases = [
      ["./space%20name.md", "space name.md"],
      ["literal%2520name.md", "literal%20name.md"],
      ["./hash%23name.md#heading", "hash#name.md"],
      ["./caf%C3%A9.md?view=1", "café.md"],
      ["./100%25.md", "100%.md"],
    ] as const;
    for (const [, name] of cases)
      await writeFile(join(folder, name), `Contents of ${name}`);
    await writeFile(join(folder, "image name.png"), "encoded image");
    const document = await preview(
      join(folder, "encoded.md"),
      `${cases.map(([url, name]) => `[${name}](${url})`).join("\n\n")}\n\n![Image](./image%20name.png)`,
    );
    const targets = [...document.querySelectorAll(".markdown-file-ref")].map(
      (link) => link.getAttribute("data-file-path"),
    );
    expect(targets).toEqual(cases.map(([, name]) => join(folder, name)));
    for (const [index, [, name]] of cases.entries()) {
      const response = await view(targets[index] ?? "");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`Contents of ${name}`);
    }
    const image = await app.request(
      document.querySelector(".markdown-local-image")?.getAttribute("src") ??
        "",
    );
    expect(image.status).toBe(200);
    expect(await image.text()).toBe("encoded image");
    // Filesystem request parameters are literal paths, not another URL conversion.
    const literal = await view(join(folder, "literal%20name.md"));
    expect(literal.status).toBe(200);
    expect(await literal.text()).toContain("Contents of literal%20name.md");
  },
);

it("still denies document-relative parent and symlink targets outside authorized roots", async () => {
  await writeFile(join(root, "secret.md"), "outside roots");
  await symlink(root, join(docs, "escape"));
  const document = await preview(
    join(docs, "guide.md"),
    "[Parent escape](../../secret.md)\n\n[Symlink escape](./escape/secret.md)\n\n![Outside](../../secret.md)",
  );
  const targets = [...document.querySelectorAll(".markdown-file-ref")].map(
    (link) => link.getAttribute("data-file-path"),
  );
  expect(targets).toEqual([
    join(root, "secret.md"),
    join(docs, "escape", "secret.md"),
  ]);
  for (const target of targets)
    expect((await view(target ?? "")).status).toBe(403);
  const image = await app.request(
    document.querySelector(".markdown-local-image")?.getAttribute("src") ?? "",
  );
  expect(image.status).toBe(403);
});
