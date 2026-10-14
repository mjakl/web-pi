// Folder choice for new sessions: worktrees, the folder picker, preference
// cookies and folder-scoped drafts.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HTMLElement, HTMLFormElement } from "happy-dom";
import { expect, it, onTestFinished } from "vitest";
import {
  click,
  displayed,
  draft,
  fixture,
  text,
} from "#/web/fixtures/session-navigation";

it("selects a worktree on the blank composer and retains it after opening old sessions", async () => {
  const b = await fixture();
  b.world.projects.resolve = (cwd) =>
    Promise.resolve({
      root: "/fixture",
      branch: cwd === "/fixture.wt" ? "topic" : null,
      isWorktree: cwd === "/fixture.wt",
      isTopLevel: cwd !== "/fixture.wt",
    });
  draft(b, "session draft");
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  await b.window.eval(
    `htmx.ajax('GET','/new?cwd=%2Ffixture.wt',{source:'#project-select',target:'#session-region',swap:'outerHTML'})`,
  );
  expect(
    b.document.querySelector("#project-select")?.getAttribute("data-cwd"),
  ).toBe("/fixture.wt");
  click(b, "s1");
  await displayed(b, "s1");
  expect(text(b)).toBe("session draft");
  expect(b.document.querySelector("#project-select")).toBeNull();
  expect(b.document.cookie).toContain("web-pi-cwd=%2Ffixture.wt");
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  expect(b.document.querySelector("main")?.getAttribute("data-cwd")).toBe(
    "/fixture.wt",
  );
  expect(text(b)).toBe("");
  expect(b.window.location.search).toBe("?cwd=%2Ffixture.wt");
  await expect
    .poll(() =>
      b.document.querySelector("#file-explorer")?.getAttribute("data-cwd"),
    )
    .toBe("/fixture.wt");
  expect(
    b.document.querySelector("#file-explorer")?.getAttribute("hx-get"),
  ).toBe("/files/explorer?cwd=%2Ffixture.wt");
});

it("rejects a late folder-picker response without committing preference cookies", async () => {
  const release = Promise.withResolvers<undefined>();
  let started = false;
  let cookie: string | null | undefined;
  const b = await fixture((transport) => async (request) => {
    if (new URL(request.url).search !== "?cwd=%2Fstale")
      return transport(request);
    started = true;
    await release.promise;
    const response = await transport(request);
    cookie = response.headers.get("Set-Cookie");
    return response;
  });
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  void b.window.eval(
    `htmx.ajax('GET','/new?cwd=%2Fstale',{source:'#project-select',target:'#session-region',swap:'outerHTML'})`,
  );
  await expect.poll(() => started).toBe(true);
  click(b, "s2");
  await displayed(b, "s2");
  release.resolve(undefined);
  await expect.poll(() => cookie).toBeNull();
  expect(b.document.querySelector("#project-select")).toBeNull();
  expect(b.document.cookie).toContain("web-pi-cwd=%2Ffixture");
  expect(
    b.document.querySelector("main")?.getAttribute("data-session-id"),
  ).toBe("s2");
});

it("does not clear the remembered session when a settings modal mounts its own main", async () => {
  const b = await fixture();
  expect(b.document.cookie).toContain("web-pi-session=s1");
  await b.window.eval(
    `htmx.ajax('GET','/settings',{target:'body',swap:'outerHTML'})`,
  );
  expect(b.document.querySelector("main.settings-dialog-main")).not.toBeNull();
  expect(
    b.document
      .querySelector("#session-region main")
      ?.getAttribute("data-session-id"),
  ).toBe("s1");
  expect(b.document.cookie).toContain("web-pi-session=s1");
});

it("restores folder-scoped new drafts and refreshes sidebar context on native Back", async () => {
  const b = await fixture();
  const other = b.world.store.get("s3");
  if (!other) throw new Error("Missing fixture session");
  other.summary.cwd = "/other";
  const shell = b.document.querySelector("#session-sidebar");
  const files = b.document.querySelector("#file-panel");
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  draft(b, "new in fixture", "fixture image");
  await b.window.eval(
    `htmx.ajax('GET','/new?cwd=%2Fother',{source:'#project-select',target:'#session-region',swap:'outerHTML',push:'/new?cwd=%2Fother'})`,
  );
  await expect
    .poll(() => b.document.querySelector("main")?.getAttribute("data-cwd"))
    .toBe("/other");
  expect(text(b)).toBe("");
  draft(b, "new in other", "other image");
  await b.workspace.send("s3", "background in other");
  await expect
    .poll(() => b.document.querySelector("#row-s3")?.textContent)
    .toContain("2 msgs");
  expect(
    b.document.querySelector("#project-select")?.getAttribute("title"),
  ).toBe("/other");
  b.window.history.back();
  await expect
    .poll(() => b.document.querySelector("main")?.getAttribute("data-cwd"))
    .toBe("/fixture");
  expect(text(b)).toBe("new in fixture");
  await expect
    .poll(() =>
      b.document.querySelector("#project-select")?.getAttribute("title"),
    )
    .toBe("/fixture");
  expect(
    await b.window.eval(
      `document.querySelector('#image-input').files[0].text()`,
    ),
  ).toBe("fixture image");
  b.window.history.forward();
  await expect
    .poll(() => b.document.querySelector("main")?.getAttribute("data-cwd"))
    .toBe("/other");
  expect(text(b)).toBe("new in other");
  expect(b.document.querySelector("#session-sidebar")).toBe(shell);
  expect(b.document.querySelector("#file-panel")).toBe(files);
});

it("uses the existing directory menu and custom-folder picker before creating a session", async () => {
  const unknown = await mkdtemp(join(tmpdir(), "web-pi-new-directory-"));
  // Registered before the page, so the page closes before the folder goes.
  onTestFinished(() => rm(unknown, { recursive: true, force: true }));
  const b = await fixture();
  const other = b.world.store.get("s3");
  if (!other) throw new Error("missing fixture");
  other.summary.cwd = "/other";
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  // happy-dom has no native popover actions; deliver the platform toggle.
  b.window.eval(
    `document.querySelector('#sidebar-project-menu').dispatchEvent(new Event('toggle'))`,
  );
  await expect
    .poll(() => b.document.querySelector('.project-folder-row[title="/other"]'))
    .not.toBeNull();
  b.document
    .querySelector<HTMLElement>('.project-folder-row[title="/other"]')
    ?.click();
  await expect
    .poll(() => b.document.querySelector("main")?.getAttribute("data-cwd"))
    .toBe("/other");
  await displayed(b, "");
  await expect.poll(() => b.document.cookie).toContain("web-pi-cwd=%2Fother");
  expect(b.world.runtime.live()).toHaveLength(0);
  b.window.eval(
    `document.querySelector('#sidebar-project-menu').dispatchEvent(new Event('toggle'))`,
  );
  await expect
    .poll(() => b.document.querySelector('[hx-get="/workspaces/picker"]'))
    .not.toBeNull();
  b.document
    .querySelector<HTMLElement>('[hx-get="/workspaces/picker"]')
    ?.click();
  await expect
    .poll(() => b.document.querySelector("#directory-picker"))
    .not.toBeNull();
  await b.window.eval(
    `htmx.ajax('POST','/workspaces/validate',{source:'#directory-picker',values:{cwd:${JSON.stringify(unknown)}},swap:'none'})`,
  );
  await expect
    .poll(() => b.document.querySelector("main")?.getAttribute("data-cwd"))
    .toBe(unknown);
  await displayed(b, "");
  expect(b.document.querySelector("#directory-picker")).toBeNull();
  expect(
    b.document.querySelector("#project-select")?.getAttribute("title"),
  ).toBe(unknown);
  await expect
    .poll(() =>
      b.document.querySelector("#composer")?.hasAttribute("data-htmx-powered"),
    )
    .toBe(true);
  draft(b, "create in the chosen folder");
  b.document.querySelector<HTMLFormElement>("#composer")?.requestSubmit();
  await displayed(b, "new-1");
  expect((await b.workspace.row("new-1"))?.summary.cwd).toBe(unknown);
});
