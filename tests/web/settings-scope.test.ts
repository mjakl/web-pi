// The Settings scope pickers are native radios, with the shipped htmx: an
// install posts whichever scope is checked.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeWorld } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { HTMLFormElement, HTMLInputElement } from "happy-dom";
import { expect, it, onTestFinished } from "vitest";
import { htmxBrowser, page } from "#/web/htmx4-browser";
import { required } from "#/web/helpers";

it("installs a found skill into the scope its picker has checked", async () => {
  const repo = await mkdtemp(join(tmpdir(), "web-pi-scope-"));
  onTestFinished(() => rm(repo, { recursive: true, force: true }));
  const app = createWebApp({
    workspace: createWorkspace(createFakeWorld()),
    defaultCwd: repo,
    staticRoot: "static",
  });
  const panel = await (
    await app.request(
      `/settings/skills/detail?cwd=${encodeURIComponent(repo)}&add=1`,
      { headers: { "HX-Request": "true" } },
    )
  ).text();
  const scopes: unknown[] = [];
  const b = await htmxBrowser(
    page(`<div id="settings-body">${panel}</div>`),
    async (request) => {
      if (new URL(request.url).pathname === "/settings/skills/install")
        scopes.push((await request.clone().formData()).get("scope"));
      return app.request(request);
    },
  );
  const search = async () => {
    const results = b.document.querySelector("#skill-search-results");
    required(
      b.document.querySelector<HTMLInputElement>('[name="query"]'),
    ).value = "changelog";
    required(
      b.document.querySelector<HTMLFormElement>(".skill-search-form"),
    ).requestSubmit();
    await expect
      .poll(() => b.document.querySelector("#skill-search-results"))
      .not.toBe(results);
  };
  const install = async (count: number) => {
    required(
      b.document.querySelector<HTMLFormElement>(".skill-search-install"),
    ).requestSubmit();
    await expect.poll(() => scopes.length).toBe(count);
  };
  await search();
  await install(1);
  required(
    b.document.querySelector<HTMLInputElement>(
      '[name="scope"][value="project"]',
    ),
  ).click();
  await search();
  await install(2);
  expect(scopes).toEqual(["global", "project"]);
});
