// The shell's routes and chrome: pages, the top bar and its panels,
// settings, and extension dialogs.

import { type ScriptedStep, userEntry } from "@adapters/fake/index";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { until } from "#/adapters/pi-harness";
import { rawFrames, streamingFixture } from "#/web/fixtures/streaming";
import { testApp } from "#/web/fixtures/test-app";
import { parseHtml, required } from "#/web/helpers";

it("applies the rendered theme script before the stylesheet loads", async () => {
  const { app } = testApp();
  const html = await (await app.request("/sessions/s1")).text();
  const script = /<script>([^<]+)<\/script>/.exec(html)?.[1];
  expect(script).toBeDefined();
  expect(html.indexOf(script ?? "NO SCRIPT")).toBeLessThan(
    html.indexOf('<link rel="stylesheet"'),
  );
  const window = new Window();
  try {
    for (const [theme, systemDark, expectedDark] of [
      ["auto", true, true],
      ["auto", false, false],
      ["dark", false, true],
      ["light", true, false],
    ] as const) {
      window.document.documentElement.classList.remove("dark");
      window.document.documentElement.dataset["theme"] = theme;
      window.happyDOM.settings.device.prefersColorScheme = systemDark
        ? "dark"
        : "light";
      window.eval(script ?? "");
      expect(window.document.documentElement.classList.contains("dark")).toBe(
        expectedDark,
      );
    }
  } finally {
    await window.happyDOM.close();
  }
});

it("reads the session out in the top bar, as pi-web does", async () => {
  const { app, world } = testApp();
  // The gauge comes off the running agent, as pi-web's does.
  await world.runtime.open({ sessionId: "s1" });
  const bar = (await (await app.request("/sessions/s1")).text()).slice(
    0,
    undefined,
  );
  const stats = bar.slice(bar.indexOf('id="stats-trigger"'));
  // Cumulative totals first, then the context gauge, both compacted.
  expect(stats).toContain("40k");
  expect(stats).toContain("40k / 100k (40%)");
  // The exact numbers live in the hover text.
  expect(bar).toContain("in: 39,990");
  expect(bar).toContain("cache write: 0");
  expect(bar).toContain("Context: 40,000 / 100,000 tokens (40%)");
  // Compact carries the dumb-zone marker only above the threshold.
  expect(bar).not.toContain("data-warning");
  world.webSettings.update({ warnTokens: 1000 });
  const warned = await (await app.request("/sessions/s1")).text();
  expect(warned).toContain("data-warning");
  expect(warned).toContain('class="mobile-session-context is-warn"');
});

it("renders a pending extension request in its dialog panel", async () => {
  const { app, world } = testApp({
    script: () =>
      [
        {
          dialog: { method: "confirm", title: "Push it?", message: "Sure?" },
        },
      ] as ScriptedStep[],
  });
  const body = new FormData();
  body.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body });
  // The scripted turn reaches its dialog on a timer.
  await until(
    required(world.runtime.get("s1")),
    (snapshot) => snapshot.status.dialog !== null,
  );
  const page = await (await app.request("/sessions/s1")).text();
  const dialog = page.slice(page.indexOf('class="extension-dialog"'));
  expect(dialog).toContain("extension request");
  expect(dialog).toContain("Push it?");
  expect(dialog).toContain("Confirm");
  expect(dialog).toContain("data-dialog-cancel");
});

it("keeps new-session preference separate from direct session and settings context", async () => {
  const { app } = testApp();
  const headers = {
    cookie: "web-pi-cwd=%2Frepo%2Ftwo; web-pi-project=%2Fobsolete",
  };
  const opened = await app.request("/sessions/s1", { headers });
  expect(opened.headers.getSetCookie().join(" ")).toContain(
    "web-pi-session=s1",
  );
  expect(opened.headers.getSetCookie().join(" ")).not.toContain("web-pi-cwd=");
  expect(opened.headers.getSetCookie().join(" ")).not.toContain(
    "web-pi-project=",
  );
  const page = await opened.text();
  expect(page).toContain('data-cwd="/repo/one"');
  expect(page).not.toContain('id="project-select"');
  const settings = await (
    await app.request("/settings?section=skills", {
      headers: { cookie: `${headers.cookie}; web-pi-session=s1` },
    })
  ).text();
  expect(settings).toContain('data-close-href="/sessions/s1"');
  expect(settings).toContain('value="/repo/one"');
  const blank = await (await app.request("/new", { headers })).text();
  expect(blank).toContain('name="cwd" value="/repo/two"');
  expect(blank).toContain('id="project-select"');
});

it("colours the context badge from the reader's own threshold", async () => {
  const { app, world } = testApp();
  // pi-web reads context usage off the running agent, so the badge belongs
  // to an attached session and a stored one shows none.
  const stored = await (await app.request("/sessions/s1")).text();
  expect(stored).not.toContain("data-context-readout");
  await world.runtime.open({ sessionId: "s1" });
  const plain = await (await app.request("/sessions/s1")).text();
  expect(plain).toContain("data-context-readout");
  expect(plain).toContain('class="mobile-session-context is-ok"');
  // 40 000 tokens of a 100 000 window is 40 %: below every percent rule,
  // above a threshold the reader set at 30 000.
  world.webSettings.update({ warnTokens: 30000 });
  const warned = await (
    await app.request("/sessions/s1", {
      headers: { cookie: "web-pi-warn-tokens=1000000" },
    })
  ).text();
  expect(warned).toContain('class="mobile-session-context is-warn"');
});

it("refuses to compact while a turn owns the context", async () => {
  // pi-web disables the button for the length of the run and hands it back
  // when the turn settles (ChatWindow.tsx `compactionControl`).
  const { app, world } = testApp({ delayMs: 1000 });
  const live = await world.runtime.open({ sessionId: "s1" });
  await live.prompt("go");
  const running = await (await app.request("/sessions/s1")).text();
  expect(running).toMatch(/id="context-compact"[^>]*disabled/);
  await live.abort();
  const settled = await (await app.request("/sessions/s1")).text();
  expect(settled).not.toMatch(/id="context-compact"[^>]*disabled/);
});

it.each(["success", "failure"])(
  "streams compact progress and restores the button after %s",
  async (outcome) => {
    const { app, world } = testApp({ delayMs: 200 });
    await world.runtime.open({ sessionId: "s1" });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    const readUntil = async (marker: string) => {
      let html = "";
      while (!html.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Stream ended before ${marker}`);
        html += decoder.decode(chunk.value);
      }
      return html;
    };
    const compactButton = (html: string) =>
      parseHtml(html).querySelector("#context-compact")?.outerHTML ?? "";
    try {
      await readUntil('id="context-compact"');
      const form = new FormData();
      form.set("text", "/compact fail");
      const response = await app.request(
        outcome === "success" ? "/sessions/s1/compact" : "/sessions/s1/prompt",
        { method: "POST", ...(outcome === "failure" ? { body: form } : {}) },
      );
      expect(response.status).toBe(204);
      const running = compactButton(await readUntil('data-compacting="true"'));
      expect(running).toContain('hx-swap-oob="true"');
      expect(running).toContain("disabled");
      expect(running).toContain('aria-busy="true"');
      expect(running).toContain('aria-label="Compacting context…"');
      const revisited = compactButton(
        await (await app.request("/sessions/s1")).text(),
      );
      expect(revisited).toContain("disabled");
      expect(revisited).toContain('aria-busy="true"');
      const settled = await readUntil(
        outcome === "success"
          ? 'aria-label="Compact context"'
          : "Compaction failed:",
      );
      const restored = compactButton(settled);
      expect(restored).toContain('aria-label="Compact context"');
      expect(restored).not.toContain("disabled");
      expect(restored).not.toContain('aria-busy="true"');
    } finally {
      await reader.cancel();
    }
  },
);

it("keeps the compact button's warning in step with the readout", async () => {
  const { app, world } = testApp();
  await world.runtime.open({ sessionId: "s1" });
  world.webSettings.update({ warnTokens: 1000 });
  const page = await (await app.request("/sessions/s1")).text();
  expect(page).toMatch(/id="context-compact"[^>]*data-warning/);
  // The stream re-renders the button beside the readout, so a turn that
  // moves the context tints it without a reload.
  const form = new FormData();
  form.set("text", "go");
  await app.request("/sessions/s1/prompt", { method: "POST", body: form });
  const res = await app.request("/sessions/s1/events");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  let received = "";
  const decoder = new TextDecoder();
  while (!received.includes('hx-target="#status"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value);
  }
  await reader.cancel();
  expect(received).toMatch(/id="context-compact"[^>]*hx-swap-oob/);
  expect(received).toMatch(/id="context-compact"[^>]*data-warning/);
});

it("renders the readout alike on the page and in the stream when the model has no window", async () => {
  const f = await streamingFixture();
  f.finish("an answer that used tokens", false);
  const model = required(f.snapshot.status.model);
  f.update({
    status: { ...f.snapshot.status, model: { ...model, contextWindow: 0 } },
  });
  const readout = (html: string) =>
    required(parseHtml(html).querySelector("#context-readout"));
  const page = readout(await (await f.app.request(`/sessions/${f.id}`)).text());
  const frame = await (await rawFrames(f))();
  const streamed = readout(
    frame.replaceAll(/^data: /gm, "").replace(/^id: .*$/m, ""),
  );
  // The token totals beside it already say something, on both paths.
  for (const element of [page, streamed]) {
    expect(element.hasAttribute("hidden")).toBe(true);
    expect(element.textContent).toBe("");
  }
});

it("shows the name, the session file, and the context window in stats", async () => {
  const { app, world } = testApp();
  const stored = await (await app.request("/sessions/s1/stats")).text();
  expect(stored).toContain("Session File");
  expect(stored).toContain("/agent/sessions/s1.jsonl");
  expect(stored).toContain("data-session-copy");
  // Only a running agent knows what is in context, as in pi-web.
  expect(stored).not.toContain("Context window");
  await world.runtime.open({ sessionId: "s1" });
  const live = await (await app.request("/sessions/s1/stats")).text();
  expect(live).toContain("Context window");
});

it("reloads the live sessions of a folder from the plugins panel", async () => {
  const { app, world } = testApp();
  await world.runtime.open({ sessionId: "s1" });
  const body = new FormData();
  body.set("cwd", "/repo/one");
  const reloaded = await app.request("/settings/plugins/reload", {
    method: "POST",
    body,
  });
  expect(reloaded.status).toBe(200);
  expect(await reloaded.text()).toContain("Reloaded 1 session");
});

it("remembers a folder's selected skill across requests", async () => {
  const { app } = testApp();
  const detail = await app.request(
    "/settings/skills/detail?cwd=/repo/one&path=/agent/skills/changelog/SKILL.md",
  );
  const cookie = detail.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("web-pi-skill");
  const page = await (
    await app.request("/settings?section=skills&cwd=/repo/one", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    })
  ).text();
  expect(page.slice(page.indexOf('class="config-detail"'))).toContain(
    "changelog",
  );
});

/**
 * The chrome pi-web keeps on every route: the top bar's three tabs, the file
 * panel, the sidebar's explorer, and settings as a modal over the workspace
 * rather than a page of its own.
 */
describe("the shell chrome, on every route", () => {
  it("disables history on a blank session but keeps the file panel available", async () => {
    const { app } = testApp();
    const html = await (await app.request("/new")).text();
    expect(html).toContain(
      "Full history is available after the session is saved",
    );
    expect(html).toContain('id="file-panel-toggle"');
  });

  it("shows the explorer for the folder, with no session open", async () => {
    const { app } = testApp();
    const html = await (await app.request("/new")).text();
    const explorer = html.slice(html.indexOf('id="explorer-section"'));
    expect(explorer).toContain("/files/explorer?cwd=%2Frepo");
    expect(explorer).toContain('id="explorer-search-toggle"');
    // pi-web keeps the field behind the magnifier until it is asked for.
    expect(explorer).toContain('id="file-search-field"');
    expect(explorer).toMatch(/id="file-search-field"[^>]*hidden/);
  });

  it("opens settings over the workspace, not on a page of its own", async () => {
    const { app } = testApp();
    // The Settings link is a full page load from the session's page.
    const html = await (
      await app.request("/settings", {
        headers: { Referer: "http://x/sessions/s1" },
      })
    ).text();
    expect(html).toContain('class="settings-dialog"');
    // The session stays behind the dialog: transcript, composer and rail.
    expect(html).toContain('class="chat-transcript"');
    expect(html).toContain('id="composer"');
    expect(html).toContain('id="rail-column"');
    expect(html).toContain('data-session-id="s1"');
    // Its complete row is selected before any client request.
    expect(html).toMatch(/id="row-s1"[^>]*class="session-row is-selected/);
  });

  it("opens settings over the session the reader last opened", async () => {
    const { app } = testApp();
    // A settings page reached by its own URL carries no referrer, so the
    // session behind it comes from the cookie instead.
    const html = await (
      await app.request("/settings?section=general", {
        headers: { cookie: "web-pi-session=s1" },
      })
    ).text();
    expect(html).toContain('class="settings-dialog"');
    expect(html).toContain('data-session-id="s1"');
    expect(html).toContain('id="rail-column"');
    expect(html).toContain('class="chat-transcript"');
    // Full history exports that session, rather than sitting disabled.
    expect(html).toContain('href="/sessions/s1/export"');
    // Leaving for the index closes it: settings opened from there is the
    // new-session view again, as it is in pi-web.
    const index = await app.request("/");
    expect(index.headers.get("set-cookie")).toContain("web-pi-session=;");
  });

  it("reads a stored session's reasoning level off its own branch", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("no session");
    stored.entries.push({
      type: "thinking_level_change",
      id: "t1",
      parentId: "a1",
      timestamp: new Date().toISOString(),
      thinkingLevel: "high",
    });
    stored.leafId = "t1";
    const html = await (await app.request("/sessions/s1")).text();
    const chip = html.slice(html.indexOf('id="model-trigger"'));
    // The fake model names its levels the way a provider would.
    expect(chip).toContain(
      '<span class="composer-model-detail">thorough</span>',
    );
  });

  it("opens a transcript image in a dialog instead of a new tab", async () => {
    const { app, world } = testApp();
    world.store.set("s2", {
      summary: {
        id: "s2",
        cwd: "/repo/one",
        createdAt: "2026-09-01T00:00:00.000Z",
        modifiedAt: "2026-09-02T00:00:00.000Z",
        fileSize: 2,
      },
      entries: [userEntry("i1", null, "look at this", 1)],
    });
    const html = await (await app.request("/sessions/s2")).text();
    expect(html).toContain("data-image-preview=");
    expect(html).toContain('aria-haspopup="dialog"');
  });
});
