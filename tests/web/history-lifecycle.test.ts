import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type {
  Element as BrowserElement,
  HTMLButtonElement,
  HTMLFormElement,
  HTMLInputElement,
} from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
const worlds: ReturnType<typeof createFakeWorld>[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  for (const world of worlds.splice(0)) {
    for (const session of world.runtime.live()) {
      await session.abort();
      await session.stop();
    }
  }
  vi.restoreAllMocks();
});

async function fixture(text: string) {
  const image = {
    type: "image" as const,
    data: "AAECA//+",
    mimeType: "image/png",
  };
  const user = userEntry("u2", "a1", text);
  if (user.type !== "message" || user.message.role !== "user")
    throw new Error("Expected user");
  user.message.content = [
    ...(text ? [{ type: "text" as const, text }] : []),
    image,
  ];
  const world = createFakeWorld({
    delayMs: 200,
    script: () => [
      { text: "first streamed chunk" },
      { text: "second streamed chunk" },
    ],
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo",
          name: "History",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          fileSize: 10,
        },
        entries: [
          userEntry("u1", null, "first"),
          assistantEntry("a1", "u1", "answer", 100),
          user,
          assistantEntry("a2", "u2", "second answer", 100),
        ],
      },
    ],
  });
  const app = createWebApp({
    workspace: createWorkspace(world),
    defaultCwd: "/repo",
    staticRoot: "static",
    renderIntervalMs: 1,
  });
  const streams: Request[] = [];
  const browser = await htmxBrowser(
    await (await app.request("/sessions/s1")).text(),
    (request) => {
      if (new URL(request.url).pathname.endsWith("/events"))
        streams.push(request);
      return app.request(request);
    },
  );
  browser.window.eval("window.confirm = () => true");
  browsers.push(browser);
  worlds.push(world);
  return { browser, world, streams, image };
}

it.each([
  { action: "fork", text: "edit this" },
  { action: "rewind", text: "edit this" },
  { action: "fork", text: "" },
  { action: "rewind", text: "" },
])(
  "restores editable text '$text' and exact images after $action, then Enter sends once",
  async ({ action, text }) => {
    const { browser, image } = await fixture(text);
    browser.window.localStorage.setItem(
      "web-pi:draft:s1",
      "unrelated old draft",
    );
    browser.window.eval(`{
      const area=document.querySelector('#composer-text');area.value='unrelated in-memory draft';area.dispatchEvent(new Event('input',{bubbles:true}));
      const transfer=new DataTransfer();transfer.items.add(new File(['obsolete bytes'],'old.png',{type:'image/png'}));
      const input=document.querySelector('#image-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    }`);
    await expect
      .poll(
        () =>
          browser.document.querySelector<HTMLInputElement>("#image-input")
            ?.files?.length,
      )
      .toBe(1);
    const before = required(browser.document.querySelector("#composer"));
    if (action === "fork") {
      // User-entry forks remain supported by the endpoint, but no longer
      // have a per-message button in the transcript.
      browser.window.eval(`htmx.ajax('POST', '/sessions/s1/fork', {
        target: document.body, swap: 'innerHTML', values: {entryId: 'u2'}
      })`);
    } else {
      required(
        browser.document.querySelector<HTMLButtonElement>(
          '#entry-u2 [hx-post$="/rewind"]',
        ),
      ).click();
    }
    await expect
      .poll(() => browser.document.querySelector("#composer") !== before)
      .toBe(true);
    const area = required(browser.document.querySelector("textarea"));
    expect(area.value).toBe(text);
    if (action === "fork") {
      await expect.poll(() => browser.document.activeElement).toBe(area);
      expect(area.selectionStart).toBe(text.length);
      expect(area.selectionEnd).toBe(text.length);
    }
    const input = required(
      browser.document.querySelector<HTMLInputElement>("#image-input"),
    );
    await expect.poll(() => input.files?.length).toBe(1);
    expect(
      Buffer.from(await required(input.files?.[0]).arrayBuffer()).toString(
        "base64",
      ),
    ).toBe(image.data);
    const send = required(
      browser.document.querySelector<HTMLButtonElement>(
        ".composer-action-primary",
      ),
    );
    expect(send.disabled).toBe(false);
    const id = required(
      browser.document.querySelector("main")?.getAttribute("data-session-id"),
    );
    const form = required(
      browser.document.querySelector<HTMLFormElement>("#composer"),
    );
    const submit = vi.spyOn(form, "requestSubmit");
    // An ordinary fragment swap must keep this owner's attachment controller.
    const star =
      browser.document.querySelector<HTMLButtonElement>('[hx-post$="/star"]');
    if (star) {
      star.click();
      await expect
        .poll(() =>
          browser.document
            .querySelector('[hx-post$="/star"]')
            ?.getAttribute("hx-vals"),
        )
        .toContain('"starred":false');
      expect(browser.document.querySelector("#composer")).toBe(form);
      expect(input.files?.length).toBe(1);
    }
    area.dispatchEvent(
      new browser.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    await expect
      .poll(
        () =>
          browser.requests.filter(
            (request) =>
              new URL(request.url).pathname === `/sessions/${id}/prompt`,
          ).length,
      )
      .toBe(1);
    const sent = required(
      browser.requests.find(
        (request) => new URL(request.url).pathname === `/sessions/${id}/prompt`,
      ),
    );
    const body = await sent.formData();
    expect(body.get("text")).toBe(text);
    const files = body.getAll("images[]");
    expect(files).toHaveLength(1);
    const file = files[0];
    if (!(file instanceof File)) throw new Error("Expected image file");
    expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(
      image.data,
    );
  },
);

it("keeps controls, stream following, and teardown correct through repeated history body swaps", async () => {
  const { browser, world, streams } = await fixture("edit this");
  const body = browser.document.body;
  const oldLogs: BrowserElement[] = [];
  const swap = async (
    action: "fork" | "rewind" | "navigate",
    entry: string,
  ) => {
    const before = required(browser.document.querySelector("#composer"));
    oldLogs.push(required(browser.document.querySelector("#log")));
    required(
      browser.document.querySelector<HTMLButtonElement>(
        action === "rewind"
          ? `#entry-${entry} [hx-post$="/${action}"]`
          : `.history-action-host:has(> #entry-${entry}) [hx-post$="/${action}"]`,
      ),
    ).click();
    await expect
      .poll(() => browser.document.querySelector("#composer") !== before)
      .toBe(true);
    expect(browser.document.body).toBe(body);
    const main = required(browser.document.querySelector("main"));
    const expectedStreams = main.hasAttribute("hx-sse:connect") ? 2 : 1;
    if (expectedStreams === 1) {
      expect(main.hasAttribute("data-saved-session")).toBe(true);
      expect(main.hasAttribute("data-live-events")).toBe(true);
    }
    await expect
      .poll(() => streams.filter((request) => !request.signal.aborted).length)
      .toBe(expectedStreams);
    expect(
      browser.document.querySelectorAll(".message-preview-popover"),
    ).toHaveLength(1);
  };
  for (let cycle = 0; cycle < 3; cycle += 1) {
    if (cycle > 0) {
      await browser.window.eval(
        `htmx.ajax('GET', '/sessions/s1', {target:document.body, swap:'innerHTML'})`,
      );
    }
    await swap("navigate", "a1");
    await swap("fork", "a1");
    await swap("rewind", "u1");
    const toggle = required(
      browser.document.querySelector<HTMLButtonElement>("#sidebar-toggle"),
    );
    const sidebar = required(
      browser.document.querySelector("#session-sidebar"),
    );
    const wasOpen = sidebar.classList.contains("sidebar-open");
    toggle.click();
    expect(sidebar.classList.contains("sidebar-open")).toBe(!wasOpen);
    const mobile = required(
      browser.document.querySelector<HTMLButtonElement>("#mobile-toolbar-more"),
    );
    mobile.click();
    expect(
      browser.document
        .querySelector("#top-bar-tabs")
        ?.hasAttribute("data-open"),
    ).toBe(true);
    mobile.click();
    expect(
      browser.document
        .querySelector("#top-bar-tabs")
        ?.hasAttribute("data-open"),
    ).toBe(false);
  }
  const form = required(
    browser.document.querySelector<HTMLFormElement>("#composer"),
  );
  const area = required(form.querySelector("textarea"));
  const send = required(
    form.querySelector<HTMLButtonElement>(".composer-action-primary"),
  );
  const id = required(
    browser.document.querySelector("main")?.getAttribute("data-session-id"),
  );
  const submit = vi.spyOn(form, "requestSubmit");
  const log = required(browser.document.querySelector("#log"));
  Object.defineProperty(log, "clientHeight", {
    configurable: true,
    value: 400,
  });
  Object.defineProperty(log, "scrollHeight", {
    configurable: true,
    value: 1600,
  });
  for (const old of oldLogs) old.scrollTop = 17;
  area.value = "after repeated history";
  area.dispatchEvent(new browser.window.Event("input", { bubbles: true }));
  expect(send.disabled).toBe(false);
  area.dispatchEvent(
    new browser.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }),
  );
  expect(submit).toHaveBeenCalledTimes(1);
  await expect
    .poll(
      () =>
        browser.requests.filter(
          (request) =>
            new URL(request.url).pathname === `/sessions/${id}/prompt`,
        ).length,
    )
    .toBe(1);
  await expect.poll(() => send.dataset["action"]).toBe("stop");
  await expect
    .poll(() => streams.filter((request) => !request.signal.aborted).length)
    .toBe(2);
  const live = required(world.runtime.get(id));
  const abort = vi.spyOn(live, "abort");
  await expect.poll(() => log.scrollTop).toBe(1600);
  for (const old of oldLogs) expect(old.scrollTop).toBe(17);
  send.click();
  await expect.poll(() => abort.mock.calls.length).toBe(1);
  expect(
    browser.requests
      .filter((request) => new URL(request.url).pathname.endsWith("/abort"))
      .map((request) => new URL(request.url).pathname),
  ).toEqual([`/sessions/${id}/abort`]);
  await expect.poll(() => !live.snapshot().status.running).toBe(true);
  // Clearing the entire body has no inserted owner to process. Cleanup must
  // still release every stream and the rail popup, without new subscriptions.
  await browser.window.eval(
    `htmx.swap({target:document.body,sourceElement:document.body,text:'',swap:'innerHTML'})`,
  );
  await expect
    .poll(() => streams.every((request) => request.signal.aborted))
    .toBe(true);
  expect(
    browser.document.querySelectorAll(".message-preview-popover"),
  ).toHaveLength(0);
});
