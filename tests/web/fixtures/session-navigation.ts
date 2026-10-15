import { assistantEntry, createFakeWorld, userEntry } from "@adapters/fake";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { HTMLElement, HTMLTextAreaElement } from "happy-dom";
import { expect } from "vitest";
import { htmxBrowser, type Transport } from "#/web/htmx4-browser";

/**
 * s1's page in a world of three sessions in /fixture. Sessions listed in
 * `answered` start with a settled exchange, so a test that needs an answer
 * does not wait for a live turn to reach a saved page's two-second check.
 */
export async function fixture(
  wrap: (transport: Transport) => Transport = (t) => t,
  answered: readonly string[] = [],
) {
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
      entries: answered.includes(id)
        ? [
            userEntry(`${id}-question`, null, "seed"),
            assistantEntry(
              `${id}-answer`,
              `${id}-question`,
              "Fixture answer",
              100,
            ),
          ]
        : [],
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
    {
      afterMarkup: (window) => {
        window.eval(`window.initialSidebarRefresh = new Promise(resolve => {
          const finished = event => {
            const ctx = event.detail.ctx;
            if (ctx.response?.status !== 200 || ctx.request.signal.aborted ||
                ctx.sourceElement !== document.getElementById('session-list') ||
                new URL(ctx.request.action, location.href).pathname !== '/sidebar/rows') return;
            document.removeEventListener('htmx:finally:request', finished);
            resolve();
          };
          document.addEventListener('htmx:finally:request', finished);
        });`);
      },
    },
  );
  browser.window.happyDOM.settings.navigation.disableMainFrameNavigation = true;
  return {
    ...browser,
    workspace,
    world,
    app,
    initialSidebarRefresh: browser.window.eval(
      "window.initialSidebarRefresh",
    ) as Promise<void>,
  };
}
export type Browser = Awaited<ReturnType<typeof fixture>>;
export function click(b: Browser, id: string) {
  b.document.querySelector<HTMLElement>(`#row-${id} a`)?.click();
}
export async function displayed(b: Browser, id: string) {
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
export function draft(b: Browser, text: string, image?: string) {
  b.window.eval(
    `document.querySelector('#composer-text').value=${JSON.stringify(text)};document.querySelector('#composer-text').dispatchEvent(new Event('input',{bubbles:true}));`,
  );
  if (image)
    b.window.eval(
      `{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(image)}],'image.png',{type:'image/png'}));const input=document.querySelector('#image-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}`,
    );
}
export function text(b: Browser) {
  return b.document.querySelector<HTMLTextAreaElement>("#composer-text")?.value;
}
export function selected(b: Browser, id: string) {
  return (
    b.document.querySelector(`#row-${id}`)?.classList.contains("is-selected") ??
    false
  );
}
