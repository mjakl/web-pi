// Drafts, attachments and composer focus survive switching sessions,
// late submissions, cloning and deleting.

import type {
  HTMLElement,
  HTMLFormElement,
  HTMLInputElement,
  HTMLTextAreaElement,
} from "happy-dom";
import { expect, it } from "vitest";
import {
  click,
  displayed,
  draft,
  fixture,
  text,
} from "#/web/fixtures/session-navigation";

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

it("keeps the shell and other drafts when cloning or deleting the displayed session", async () => {
  const b = await fixture(undefined, ["s1"]);
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
  // happy-dom retains a max-age=0 cookie until the clock passes its expiry.
  await expect.poll(() => b.document.cookie).not.toContain("web-pi-session=");
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
  // The connection refresh replaces row anchors independently of navigation.
  await b.initialSidebarRefresh;
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
    const b = await fixture(
      (transport) => async (request) => {
        if (new URL(request.url).pathname === "/sessions/s1/prompt") {
          posted = true;
          await release.promise;
        }
        return transport(request);
      },
      ["s1"],
    );
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
