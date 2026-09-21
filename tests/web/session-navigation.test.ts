import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HTMLElement,
  HTMLInputElement,
  HTMLTextAreaElement,
  HTMLFormElement,
} from "happy-dom";
import { createFakeWorld } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { htmxBrowser, type Transport } from "#/web/htmx4-browser";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(wrap: (transport: Transport) => Transport = (t) => t) {
  const world = createFakeWorld({
    sessions: ["s1", "s2", "s3"].map((id) => ({
      summary: {
        id,
        cwd: "/fixture",
        name: id,
        modifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        fileSize: 0,
      },
      entries: [],
    })),
    reply: () => "Fixture answer",
    delayMs: 2,
  });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    renderIntervalMs: 1,
    defaultCwd: "/fixture",
    staticRoot: "static",
  });
  const browser = await htmxBrowser(
    await (await app.request("/sessions/s1")).text(),
    wrap((request) => app.request(request)),
  );
  browsers.push(browser);
  browser.window.happyDOM.settings.navigation.disableMainFrameNavigation = true;
  return { ...browser, workspace, world, app };
}
type Browser = Awaited<ReturnType<typeof fixture>>;
function click(b: Browser, id: string) {
  b.document.querySelector<HTMLElement>(`#row-${id} a`)?.click();
}
async function displayed(b: Browser, id: string) {
  await expect
    .poll(
      () =>
        b.document.querySelector("main")?.getAttribute("data-session-id") ?? "",
    )
    .toBe(id);
  await expect
    .poll(() => b.window.location.pathname)
    .toBe(id ? `/sessions/${id}` : "/new");
  await expect
    .poll(() =>
      b.document.querySelector("#composer")?.hasAttribute("data-htmx-powered"),
    )
    .toBe(true);
}
function draft(b: Browser, text: string, image?: string) {
  b.window.eval(
    `document.querySelector('#composer-text').value=${JSON.stringify(text)};document.querySelector('#composer-text').dispatchEvent(new Event('input',{bubbles:true}));`,
  );
  if (image)
    b.window.eval(
      `{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(image)}],'image.png',{type:'image/png'}));const input=document.querySelector('#image-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
}
function text(b: Browser) {
  return b.document.querySelector<HTMLTextAreaElement>("#composer-text")?.value;
}
function selected(b: Browser, id: string) {
  return (
    b.document.querySelector(`#row-${id}`)?.classList.contains("is-selected") ??
    false
  );
}

it("keeps same-session clicks local and preserves the shell across session switches", async () => {
  const b = await fixture();
  const shell = b.document.querySelector("#session-sidebar"),
    files = b.document.querySelector("#file-panel"),
    main = b.document.querySelector("main");
  b.window.eval(
    `window.wasHandled=false;document.addEventListener('click',event=>{window.wasHandled=event.defaultPrevented;event.preventDefault();},{once:true});document.querySelector('#row-s1 a').click()`,
  );
  expect(b.window.eval("window.wasHandled")).toBe(true);
  expect(b.document.querySelector("main")).toBe(main);
  expect(
    b.requests.filter((r) => new URL(r.url).pathname === "/sessions/s1"),
  ).toHaveLength(0);
  click(b, "s2");
  await displayed(b, "s2");
  expect(b.document.querySelector("#session-sidebar")).toBe(shell);
  expect(b.document.querySelector("#file-panel")).toBe(files);
  expect(b.document.querySelectorAll("#file-panel")).toHaveLength(1);
  click(b, "s1");
  await displayed(b, "s1");
  expect(b.document.querySelector("#file-panel")).toBe(files);
});

it("flushes the latest text on pagehide rather than waiting 300ms", async () => {
  const b = await fixture();
  draft(b, "just typed");
  b.window.dispatchEvent(new b.window.Event("pagehide"));
  expect(b.window.localStorage.getItem("web-pi:draft:s1")).toBe("just typed");
});

it("retains independent text and File drafts across immediate switches, including new chat", async () => {
  const b = await fixture();
  b.window.eval(
    `window.revoked=[];const revoke=URL.revokeObjectURL.bind(URL);URL.revokeObjectURL=url=>{window.revoked.push(url);revoke(url);}`,
  );
  draft(b, "draft A", "bytes A");
  click(b, "s2");
  await displayed(b, "s2");
  expect(text(b)).toBe("");
  draft(b, "draft B", "bytes B");
  click(b, "s1");
  await displayed(b, "s1");
  expect(text(b)).toBe("draft A");
  expect(
    await b.window.eval(
      `document.querySelector('#image-input').files[0].text()`,
    ),
  ).toBe("bytes A");
  expect(b.window.eval("window.revoked.length > 0")).toBe(true);
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  expect(b.window.location.search).toBe("?cwd=%2Ffixture");
  draft(b, "new draft", "new bytes");
  click(b, "s2");
  await displayed(b, "s2");
  expect(text(b)).toBe("draft B");
  expect(
    await b.window.eval(
      `document.querySelector('#image-input').files[0].text()`,
    ),
  ).toBe("bytes B");
  b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
  await displayed(b, "");
  expect(text(b)).toBe("new draft");
  expect(
    await b.window.eval(
      `document.querySelector('#image-input').files[0].text()`,
    ),
  ).toBe("new bytes");
});

it("keeps old content until ready and rejects a reversed obsolete navigation, including its trigger", async () => {
  const release = Promise.withResolvers<undefined>();
  let delayed: Request | undefined;
  const b = await fixture((transport) => async (request) => {
    const response = await transport(request);
    if (new URL(request.url).pathname === "/sessions/s2") {
      delayed = request;
      await release.promise;
      response.headers.set(
        "HX-Trigger",
        JSON.stringify({
          "web-pi:session-created": { cwd: "/fixture", id: "obsolete" },
        }),
      );
    }
    return response;
  });
  const main = b.document.querySelector("main");
  b.window.eval(
    `window.obsoleteEvents=0;document.addEventListener('web-pi:session-created',()=>window.obsoleteEvents++);document.addEventListener('htmx:finally:request',event=>{if(new URL(event.detail.ctx.request.action,location.href).pathname==='/sessions/s2')window.obsoleteFinished=true;});`,
  );
  click(b, "s2");
  await expect.poll(() => !!delayed).toBe(true);
  expect(b.document.querySelector("main")).toBe(main);
  try {
    click(b, "s3");
    await displayed(b, "s3");
    expect(delayed?.signal.aborted).toBe(true);
  } finally {
    release.resolve(undefined);
  }
  await expect
    .poll(() => b.window.eval("window.obsoleteFinished") === true)
    .toBe(true);
  expect(
    b.document.querySelector("main")?.getAttribute("data-session-id"),
  ).toBe("s3");
  expect(b.window.location.pathname).toBe("/sessions/s3");
  expect(b.window.eval("window.obsoleteEvents")).toBe(0);
});

it.each(["back", "forward", "new-chat back", "ordinary"] as const)(
  "keeps URL and owners aligned when a same-session click cancels pending %s navigation",
  async (direction) => {
    const release = Promise.withResolvers<undefined>();
    let hold = false;
    let pending: Request | undefined;
    const destination =
      direction === "forward"
        ? "/sessions/s2"
        : direction === "new-chat back"
          ? "/new"
          : "/sessions/s1";
    const b = await fixture((transport) => async (request) => {
      const response = await transport(request);
      if (hold && new URL(request.url).pathname === destination) {
        pending = request;
        await release.promise;
      }
      return response;
    });
    if (direction === "new-chat back") {
      b.document.querySelector<HTMLElement>("a[data-session-link]")?.click();
      await displayed(b, "");
    }
    click(b, "s2");
    await displayed(b, "s2");
    if (direction === "forward") {
      b.window.history.back();
      await displayed(b, "s1");
    }
    const selectedId = direction === "forward" ? "s1" : "s2";
    const selectors = [
      "#session-region",
      "main",
      "#composer",
      "#session-sidebar",
      "#file-panel",
    ];
    const owners = selectors.map((selector) =>
      b.document.querySelector(selector),
    );
    // happy-dom replaceState truncates forward entries. Check no push here;
    // Chromium verifies that the real history length and forward entry survive.
    const push = vi.spyOn(b.window.history, "pushState");
    draft(b, "keep this draft");
    b.window.eval(
      `window.canceledFinished=false;document.addEventListener('htmx:finally:request',event=>{if(new URL(event.detail.ctx.request.action,location.href).pathname===${JSON.stringify(destination)})window.canceledFinished=true;});`,
    );
    hold = true;
    let requests = 0;
    try {
      if (direction === "ordinary") click(b, "s1");
      else if (direction === "forward") b.window.history.forward();
      else b.window.history.back();
      await expect.poll(() => !!pending).toBe(true);
      expect(b.window.location.pathname).toBe(
        direction === "ordinary" ? "/sessions/s2" : destination,
      );
      if (direction === "new-chat back")
        expect(b.window.location.search).toBe("?cwd=%2Ffixture");
      expect(pending?.headers.get("HX-History-Restore-Request")).toBe(
        direction === "ordinary" ? null : "true",
      );
      requests = b.requests.length;
      const state = b.window.history.state as unknown;
      const replace = vi.spyOn(b.window.history, "replaceState");
      click(b, selectedId);
      expect(pending?.signal.aborted).toBe(true);
      expect(b.window.location.pathname).toBe(`/sessions/${selectedId}`);
      expect(b.window.location.search).toBe("");
      expect(push).not.toHaveBeenCalled();
      expect(b.window.history.state).toEqual(state);
      expect(replace).toHaveBeenCalledTimes(direction === "ordinary" ? 0 : 1);
      expect(b.requests).toHaveLength(requests);
    } finally {
      release.resolve(undefined);
    }
    await expect
      .poll(() => b.window.eval("window.canceledFinished") === true)
      .toBe(true);
    expect(b.window.location.pathname).toBe(`/sessions/${selectedId}`);
    expect(push).not.toHaveBeenCalled();
    expect(b.requests).toHaveLength(requests);
    selectors.forEach((selector, index) => {
      expect(b.document.querySelector(selector)).toBe(owners[index]);
    });
    expect(
      b.document.querySelector("main")?.getAttribute("data-session-id"),
    ).toBe(selectedId);
    expect(text(b)).toBe("keep this draft");
  },
);

it("uses native history restoration without replacing the shell", async () => {
  const b = await fixture();
  const shell = b.document.querySelector("#session-sidebar");
  click(b, "s2");
  await displayed(b, "s2");
  click(b, "s3");
  await displayed(b, "s3");
  b.window.history.back();
  await displayed(b, "s2");
  b.window.history.back();
  await displayed(b, "s1");
  b.window.history.forward();
  await displayed(b, "s2");
  expect(b.document.querySelector("#session-sidebar")).toBe(shell);
});

it("keeps selection on the displayed session across global stream, star and lazy rows", async () => {
  const b = await fixture();
  await b.workspace.send("s1", "hello");
  await expect
    .poll(() => b.document.querySelector("#row-s1")?.textContent)
    .toContain("2 msgs");
  await expect.poll(() => selected(b, "s1")).toBe(true);
  click(b, "s2");
  await displayed(b, "s2");
  await b.workspace.send("s1", "background");
  await expect
    .poll(() => b.document.querySelector("#row-s1")?.textContent)
    .toContain("4 msgs");
  expect(selected(b, "s1")).toBe(false);
  expect(selected(b, "s2")).toBe(true);
  await b.workspace.send("s2", "foreground");
  await expect
    .poll(() => b.document.querySelector("#messages .answer-star-toggle"), {
      timeout: 4000,
    })
    .not.toBeNull();
  b.document
    .querySelector<HTMLElement>("#messages .answer-star-toggle")
    ?.click();
  await expect
    .poll(() =>
      b.document.querySelector('#row-s2 [aria-label="1 starred answers"]'),
    )
    .not.toBeNull();
  await expect.poll(() => selected(b, "s2")).toBe(true);
  await b.window.eval(
    `htmx.ajax('GET','/sessions/s1/row?active=s1',{target:'#row-s1',swap:'outerHTML'})`,
  );
  expect(selected(b, "s1")).toBe(false);
  expect(selected(b, "s2")).toBe(true);
});

it.each(["accepted", "rejected"])(
  "handles a late %s submission only for its originating draft",
  async (outcome) => {
    const release = Promise.withResolvers<undefined>();
    let pending: Request | undefined;
    const b = await fixture((transport) => async (request) => {
      if (new URL(request.url).pathname === "/sessions/s1/prompt") {
        pending = request;
        await release.promise;
        return outcome === "accepted"
          ? new Response(null, {
              status: 204,
              headers: { "X-Web-Pi-Submission": "accepted" },
            })
          : new Response("rejected", { status: 400 });
      }
      return transport(request);
    });
    draft(b, "submitted A", "image A");
    await expect
      .poll(
        () =>
          b.document.querySelector<HTMLInputElement>("#image-input")?.files
            ?.length,
      )
      .toBe(1);
    b.document.querySelector<HTMLFormElement>("#composer")?.requestSubmit();
    await expect.poll(() => !!pending).toBe(true);
    try {
      click(b, "s2");
      await displayed(b, "s2");
      draft(b, "keep B", "image B");
    } finally {
      release.resolve(undefined);
    }
    await expect
      .poll(() => b.window.localStorage.getItem("web-pi:draft:s1"))
      .toBe(outcome === "accepted" ? null : "submitted A");
    expect(text(b)).toBe("keep B");
    click(b, "s1");
    await displayed(b, "s1");
    expect(text(b)).toBe(outcome === "accepted" ? "" : "submitted A");
    expect(
      b.document.querySelector<HTMLInputElement>("#image-input")?.files?.length,
    ).toBe(outcome === "accepted" ? 0 : 1);
  },
);

it("suppresses obsolete HX-Trigger headers when cancellation interrupts response body reading", async () => {
  const b = await fixture((transport) => async (request) => {
    if (new URL(request.url).pathname !== "/sessions/s2")
      return transport(request);
    return new Response(
      new ReadableStream({
        start(controller) {
          request.signal.addEventListener(
            "abort",
            () => {
              controller.error(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        },
      }),
      { headers: { "HX-Trigger": "obsolete-header" } },
    );
  });
  b.window
    .eval(`window.headersAdmitted=false;window.headerEffects=0;window.finishedOld=false;
    document.addEventListener('obsolete-header',()=>window.headerEffects++);
    document.addEventListener('htmx:before:response',e=>{if(new URL(e.detail.ctx.request.action,location.href).pathname==='/sessions/s2')window.headersAdmitted=true});
    document.addEventListener('htmx:finally:request',e=>{if(new URL(e.detail.ctx.request.action,location.href).pathname==='/sessions/s2')window.finishedOld=true});`);
  click(b, "s2");
  await expect.poll(() => Boolean(b.window.eval("headersAdmitted"))).toBe(true);
  click(b, "s3");
  await displayed(b, "s3");
  await expect.poll(() => Boolean(b.window.eval("finishedOld"))).toBe(true);
  expect(b.window.eval("headerEffects")).toBe(0);
});

it("keeps the displayed URL and owner when a navigation or Back target is missing", async () => {
  const b = await fixture();
  b.world.store.delete("s2");
  const main = b.document.querySelector("main");
  click(b, "s2");
  await expect
    .poll(() => b.document.querySelector("#toasts")?.textContent)
    .toContain("Could not open");
  expect(b.window.location.pathname).toBe("/sessions/s1");
  expect(b.document.querySelector("main")).toBe(main);
  click(b, "s3");
  await displayed(b, "s3");
  b.world.store.delete("s1");
  b.window.history.back();
  await expect.poll(() => b.window.location.pathname).toBe("/sessions/s3");
  expect(
    b.document.querySelector("main")?.getAttribute("data-session-id"),
  ).toBe("s3");
});

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

it("keeps the shell and other drafts when cloning or deleting the displayed session", async () => {
  const b = await fixture();
  await b.workspace.send("s1", "seed");
  await expect
    .poll(() => b.document.querySelector("#messages")?.textContent, {
      timeout: 4000,
    })
    .toContain("Fixture answer");
  const shell = b.document.querySelector("#session-sidebar");
  const panel = b.document.querySelector("#file-panel");
  draft(b, "keep original", "original image");
  await b.window.eval(
    `htmx.ajax('POST','/sessions/s1/clone',{source:'#row-s1',target:'#row-s1',swap:'none'})`,
  );
  await displayed(b, "copy-1");
  await expect.poll(() => b.document.activeElement?.id).toBe("composer-text");
  expect(b.document.querySelector("#session-sidebar")).toBe(shell);
  expect(b.document.querySelector("#file-panel")).toBe(panel);
  click(b, "s1");
  await displayed(b, "s1");
  expect(text(b)).toBe("keep original");
  expect(
    b.document.querySelector<HTMLInputElement>("#image-input")?.files?.length,
  ).toBe(1);
  await b.window.eval(
    `htmx.ajax('POST','/sessions/s1/delete',{source:'#row-s1',target:'#row-s1',swap:'none'})`,
  );
  await displayed(b, "");
  expect(b.document.querySelector("#session-sidebar")).toBe(shell);
  expect(b.document.querySelector("#file-panel")).toBe(panel);
  expect(b.document.cookie).not.toContain("web-pi-session=");
});

it("retains a pending image decode across owner replacement", async () => {
  const b = await fixture();
  b.window
    .eval(`window.decode=Promise.withResolvers();window.createImageBitmap=()=>window.decode.promise;
    const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(2*1024*1024)],'large.png',{type:'image/png'}));
    const input=document.querySelector('#image-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));`);
  click(b, "s2");
  await displayed(b, "s2");
  click(b, "s1");
  await displayed(b, "s1");
  b.window.eval(
    `window.decode.reject(new Error('fixture decoder unavailable'));`,
  );
  await expect
    .poll(
      () =>
        b.document.querySelector<HTMLInputElement>("#image-input")?.files
          ?.length,
    )
    .toBe(1);
  expect(
    b.document.querySelector<HTMLInputElement>("#image-input")?.files?.[0]
      ?.size,
  ).toBe(2 * 1024 * 1024);
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
  directories.push(unknown);
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

it("retains progressively loaded global rows across cross-directory navigation", async () => {
  const b = await fixture();
  for (let i = 0; i < 65; i += 1) {
    const id = `page-${String(i)}`;
    b.world.store.set(id, {
      summary: {
        id,
        cwd: `/folder-${String(i % 4)}`,
        name: id,
        createdAt: "2020-01-01",
        modifiedAt: `2020-01-${String(i + 1).padStart(2, "0")}`,
        fileSize: 0,
      },
      entries: [],
    });
  }
  await b.window.eval(
    `htmx.ajax('GET','/sidebar',{source:'#sidebar-refresh',target:'#session-nav',swap:'outerHTML'})`,
  );
  expect(
    b.document.querySelectorAll("#session-list .session-row"),
  ).toHaveLength(50);
  const sentinel = b.document.querySelector(".session-rows-loading");
  const url = sentinel?.getAttribute("hx-get");
  expect(url).toBe("/sidebar/rows?after=50&selected=s1");
  await b.window.eval(
    `htmx.ajax('GET',${JSON.stringify(url)},{source:'.session-rows-loading',target:'.session-rows-loading',swap:'outerHTML'})`,
  );
  expect(
    b.document.querySelectorAll("#session-list .session-row"),
  ).toHaveLength(68);
  const list = b.document.querySelector("#session-list");
  const stream = b.document.querySelector("#sidebar-events");
  click(b, "page-0");
  await displayed(b, "page-0");
  expect(
    b.document.querySelectorAll("#session-list .session-row"),
  ).toHaveLength(68);
  expect(b.document.querySelector("#session-list")).toBe(list);
  expect(b.document.querySelector("#sidebar-events")).toBe(stream);
  expect(selected(b, "page-0")).toBe(true);
  expect(
    b.document.querySelector("#file-explorer")?.getAttribute("data-cwd"),
  ).toBe("/folder-0");
});

it("does not let an old submit navigate while the reader's newer choice is loading", async () => {
  const releasePost = Promise.withResolvers<undefined>();
  const releasePage = Promise.withResolvers<undefined>();
  let posted = false,
    requested = false;
  const b = await fixture((transport) => async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/sessions/s1/prompt") {
      posted = true;
      await releasePost.promise;
      return new Response(null, {
        status: 200,
        headers: {
          "X-Web-Pi-Submission": "accepted",
          "HX-Location": JSON.stringify({
            path: "/sessions/s3",
            source: "#session-region",
            target: "#session-region",
            swap: "outerHTML",
          }),
        },
      });
    }
    if (path === "/sessions/s2") {
      requested = true;
      await releasePage.promise;
    }
    return transport(request);
  });
  draft(b, "submitted A");
  b.document.querySelector<HTMLFormElement>("#composer")?.requestSubmit();
  await expect.poll(() => posted).toBe(true);
  click(b, "s2");
  await expect.poll(() => requested).toBe(true);
  try {
    releasePost.resolve(undefined);
    await expect
      .poll(() => b.window.localStorage.getItem("web-pi:draft:s1"))
      .toBeNull();
    expect(
      b.document.querySelector("main")?.getAttribute("data-session-id"),
    ).toBe("s1");
    expect(
      b.requests.filter(
        (request) => new URL(request.url).pathname === "/sessions/s3",
      ),
    ).toHaveLength(0);
  } finally {
    releasePage.resolve(undefined);
    releasePost.resolve(undefined);
  }
  await displayed(b, "s2");
});

it("autofocuses the restored draft through real sidebar and native history navigation", async () => {
  const b = await fixture();
  const focused = () => b.document.activeElement?.id;
  await expect.poll(focused).toBe("composer-text");
  draft(b, "draft one");
  b.document.querySelector<HTMLElement>("#row-s2 a")?.focus();
  click(b, "s2");
  await displayed(b, "s2");
  await expect.poll(focused).toBe("composer-text");
  draft(b, "draft two");
  b.window.history.back();
  await displayed(b, "s1");
  await expect.poll(focused).toBe("composer-text");
  const input = b.document.querySelector<HTMLTextAreaElement>("#composer-text");
  expect(input?.value).toBe("draft one");
  expect(input?.selectionStart).toBe(9);
  expect(input?.selectionEnd).toBe(9);
  b.window.history.forward();
  await displayed(b, "s2");
  await expect.poll(focused).toBe("composer-text");
  expect(text(b)).toBe("draft two");
});

it("does not steal focus after interaction while a real session request loads", async () => {
  const release = Promise.withResolvers<undefined>();
  let requested = false;
  const b = await fixture((transport) => async (request) => {
    if (new URL(request.url).pathname === "/sessions/s2") {
      requested = true;
      await release.promise;
    }
    return transport(request);
  });
  click(b, "s2");
  try {
    await expect.poll(() => requested).toBe(true);
    b.document.querySelector<HTMLElement>("#row-s3 a")?.focus();
  } finally {
    release.resolve(undefined);
  }
  await displayed(b, "s2");
  await new Promise<void>((resolve) =>
    b.window.requestAnimationFrame(() => {
      resolve();
    }),
  );
  expect(b.document.activeElement).toBe(b.document.querySelector("#row-s3 a"));
});

it.each([false, true])(
  "clone command preserves autofocus cancellation during creation: %s",
  async (interact) => {
    const release = Promise.withResolvers<undefined>();
    let posted = false;
    const b = await fixture((transport) => async (request) => {
      if (new URL(request.url).pathname === "/sessions/s1/prompt") {
        posted = true;
        await release.promise;
      }
      return transport(request);
    });
    await b.workspace.send("s1", "seed");
    await expect
      .poll(() => b.document.querySelector("#messages")?.textContent, {
        timeout: 4000,
      })
      .toContain("Fixture answer");
    draft(b, "/clone");
    const send = b.document.querySelector<HTMLElement>(
      ".composer-action-primary",
    );
    send?.focus();
    send?.click();
    try {
      await expect.poll(() => posted).toBe(true);
      if (interact) b.document.querySelector<HTMLElement>("#row-s3 a")?.focus();
    } finally {
      release.resolve(undefined);
    }
    await displayed(b, "copy-1");
    if (!interact)
      await expect
        .poll(() => b.document.activeElement?.id)
        .toBe("composer-text");
    await new Promise<void>((resolve) =>
      b.window.requestAnimationFrame(() => {
        resolve();
      }),
    );
    expect(b.document.activeElement?.id === "composer-text").toBe(!interact);
  },
);
