// Switching sessions through the sidebar, links and native history: owners,
// URLs and selection stay aligned however requests race.

import type { HTMLElement, HTMLFormElement } from "happy-dom";
import { expect, it, vi } from "vitest";
import {
  click,
  displayed,
  draft,
  fixture,
  selected,
  text,
} from "#/web/fixtures/session-navigation";

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
  // s2 starts answered: its star toggle is there once it is displayed.
  const b = await fixture(undefined, ["s2"]);
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
  // The replacement stream's connection refresh precedes progressive paging.
  const initialRow = b.document.querySelector("#row-s1");
  await expect
    .poll(() => b.document.querySelector("#row-s1") !== initialRow)
    .toBe(true);
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
  // Parallel DOM work can outlast the display poll while a valid swap is pending.
  const navigationDone = b.window.eval(`new Promise((resolve, reject) => {
    const finished = event => {
      const ctx = event.detail.ctx;
      if (new URL(ctx.request.action, location.href).pathname !== '/sessions/page-0') return;
      document.removeEventListener('htmx:finally:request', finished);
      if (ctx.request.signal.aborted || ctx.response?.status !== 200 || ctx.status !== 'swapped')
        reject(new Error('Navigation did not finish successfully'));
      else resolve();
    };
    document.addEventListener('htmx:finally:request', finished);
  })`) as Promise<void>;
  click(b, "page-0");
  await navigationDone;
  await displayed(b, "page-0");
  expect(
    b.document.querySelectorAll("#session-list .session-row"),
  ).toHaveLength(68);
  expect(b.document.querySelector("#session-list")).toBe(list);
  expect(b.document.querySelector("#sidebar-events")).toBe(stream);
  expect(selected(b, "page-0")).toBe(true);
  // The explorer partial settles independently of the session region.
  await expect
    .poll(() =>
      b.document.querySelector("#file-explorer")?.getAttribute("data-cwd"),
    )
    .toBe("/folder-0");
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
