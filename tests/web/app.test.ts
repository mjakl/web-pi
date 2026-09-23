import {
  assistantEntry,
  createFakeWorld,
  type ScriptedStep,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

async function renderedHtml(html: string): Promise<string> {
  const window = new Window();
  try {
    window.document.body.innerHTML = html;
    for (const template of window.document.querySelectorAll("template")) {
      template.remove();
    }
    return window.document.body.innerHTML;
  } finally {
    await window.happyDOM.close();
  }
}

function testApp(options: Parameters<typeof createFakeWorld>[0] = {}) {
  const world = createFakeWorld({
    delayMs: 2,
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo/one",
          name: "Stored one",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 10,
        },
        entries: [
          userEntry("u1", null, "first <b>question</b>"),
          assistantEntry("a1", "u1", "**bold** <script>x</script>", 40_000),
        ],
      },
    ],
    ...options,
  });
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
    renderIntervalMs: 1,
  });
  return { app, world };
}

/** The URL behind a collapsed tool card, as htmx would follow it. */
function deferredUrl(page: string): string {
  const url = /hx-get="([^"]*tool-result[^"]*)"/.exec(page)?.[1] ?? "";
  expect(url).not.toBe("");
  return url.replaceAll("&amp;", "&");
}

describe("web app", () => {
  it("lists stored sessions with their working folders", async () => {
    const { app } = testApp();
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("repo/one");
    expect(html).toContain('href="/sessions/s1"');
  });

  it("renders a stored session with escaped user text and markdown answers", async () => {
    const { app } = testApp();
    const html = await (await app.request("/sessions/s1")).text();
    expect(html).toContain("first &lt;b&gt;question&lt;/b&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain('id="composer"');
  });

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
    const { app } = testApp({
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
    await new Promise((resolve) => setTimeout(resolve, 40));
    const page = await (await app.request("/sessions/s1")).text();
    const dialog = page.slice(page.indexOf('class="extension-dialog"'));
    expect(dialog).toContain("extension request");
    expect(dialog).toContain("Push it?");
    expect(dialog).toContain("Confirm");
    expect(dialog).toContain("data-dialog-cancel");
  });

  it("returns a fragment for HTMX requests and 404 for unknown ids", async () => {
    const { app } = testApp();
    const fragment = await (
      await app.request("/sessions/s1", { headers: { "HX-Request": "true" } })
    ).text();
    expect(fragment).not.toContain("<html");
    expect((await app.request("/sessions/nope")).status).toBe(404);
    expect((await app.request("/sessions/..%2Fetc")).status).toBe(404);
  });

  it("starts a session from the form and redirects to it", async () => {
    const { app, world } = testApp();
    const form = new FormData();
    form.set("cwd", "/repo/two");
    form.set("text", "hello");
    const res = await app.request("/sessions", { method: "POST", body: form });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sessions/new-1");
    expect(world.runtime.get("new-1")?.snapshot().status.running).toBe(true);
  });

  it("streams the turn and then settles it", async () => {
    const { app } = testApp({ reply: () => "alpha beta" });
    const form = new FormData();
    form.set("text", "go");
    const prompt = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form,
    });
    expect(prompt.status).toBe(204);

    const res = await app.request("/sessions/s1/events?after=a1");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("event: settled")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain(
      '<hx-partial hx-target="#turn" hx-swap="innerMorph">',
    );
    expect(received).toContain("alpha beta");
    expect(received).toContain(
      '<hx-partial hx-target="#status" hx-swap="innerHTML">',
    );
    expect(received).toMatch(
      /data: <hx-partial hx-target="#messages" hx-swap="beforeend"><section id="turn-[^"]+" class="turn"/,
    );
    const clear =
      '<hx-partial hx-target="#turn" hx-swap="innerMorph"></hx-partial>';
    // Rejoin multiline HTML before parsing; recovery templates are inert.
    const rendered = await renderedHtml(received.replaceAll(/^data: /gm, ""));
    expect(rendered).toContain(clear);
    expect(rendered.indexOf(clear)).toBeLessThan(
      rendered.indexOf("event: settled\n"),
    );
    expect(received).toContain("event: settled\ndata: s1");
    expect(received).not.toMatch(
      /event: (turn|status|shelf|dialog|custom|editor|notice)\n/,
    );
    expect(received).toContain("Estimated token count while streaming");
  });

  it("renders metadata and actions in the initial response, including on revisit", async () => {
    const { app, world } = testApp();
    await world.sessions.setStar("s1", "a1", true);
    for (let visit = 0; visit < 2; visit += 1) {
      const list = await (await app.request("/")).text();
      expect(list).toContain("Stored one");
      expect(list).toContain("2 msgs");
      expect(list).toContain("1 starred answers");
      expect(list).toContain("Clear all stars");
      expect(list).toContain("Activate");
      expect(list).toContain("Delete");
      expect(list).not.toContain('hx-get="/sessions/s1/row"');
      expect(list).not.toContain('aria-label="Loading..."');
    }

    const row = await (await app.request("/sessions/s1/row")).text();
    expect(row).toContain("Stored one");
    expect(row).toContain("2 msgs");
    expect(row).toContain("Activate");
    expect(row).toContain("Delete");
    // The endpoint still serves row actions and rename cancellation.
    expect(row).not.toContain("hx-trigger=");
    expect(row).not.toContain('hx-get="/sessions/s1/row"');
    // A row whose session went away answers with a 404,
    // which htmx leaves unswapped.
    expect((await app.request("/sessions/gone/row")).status).toBe(404);
  });

  it("renders full metadata in 50-row pages without reading the next page early", async () => {
    const { app, world } = testApp();
    for (let index = 0; index < 60; index += 1) {
      const id = `p${String(index)}`;
      world.store.set(id, {
        summary: {
          id,
          cwd: `/repo/folder-${String(index % 7)}`,
          createdAt: "2026-08-01T00:00:00.000Z",
          modifiedAt: `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`,
          fileSize: 1,
        },
        entries: [userEntry(`${id}-u`, null, `prompt ${id}`)],
      });
    }
    const read = world.sessions.rowMetadata.bind(world.sessions);
    const metadata = vi
      .spyOn(world.sessions, "rowMetadata")
      .mockImplementation((id) =>
        id === "p40" ? Promise.resolve(undefined) : read(id),
      );
    const page = await (await app.request("/")).text();
    // The unreadable row consumes its slot, without shifting the next offset.
    expect(page.match(/class="session-row(?: [^"]*)?"/g)).toHaveLength(49);
    expect(page).not.toContain('id="row-p40"');
    expect(metadata).toHaveBeenCalledTimes(50);
    expect(page).toContain("prompt p59");
    expect(page).not.toContain('hx-get="/sessions/p59/row"');
    metadata.mockClear();
    const sentinel = /hx-get="([^"]*\/sidebar\/rows[^"]*)"/.exec(page)?.[1];
    expect(sentinel).toContain("after=50");
    expect(sentinel).not.toContain("project=");
    expect(page).toContain("Loading more sessions…");
    // Only the sentinel fetches more; each returned row is complete.
    const next = await (
      await app.request((sentinel ?? "").replaceAll("&amp;", "&"))
    ).text();
    expect(next.match(/class="session-row(?: [^"]*)?"/g)).toHaveLength(11);
    expect(metadata).toHaveBeenCalledTimes(11);
    expect(next).toContain("prompt p0");
    expect(next).toContain(
      'class="session-row-folder" title="/repo/folder-0">folder-0<',
    );
    expect(next).toContain("1 msgs");
    expect(next).not.toContain('hx-get="/sessions/p0/row"');
    expect(next).not.toContain('hx-trigger="intersect once"');
    expect(next).not.toContain("Loading more sessions…");
  });

  it("omits unreadable rows but keeps readable untitled and empty sessions", async () => {
    const { app, world } = testApp();
    const original = world.store.get("s1");
    if (!original) throw new Error("missing fixture");
    for (const id of ["untitled-session", "empty-session-long-id"]) {
      const { name: _name, ...summary } = original.summary;
      world.store.set(id, {
        summary: { ...summary, id },
        entries: id.startsWith("empty")
          ? []
          : [userEntry("u", null, "A legitimate first prompt")],
      });
    }
    const read = world.sessions.rowMetadata.bind(world.sessions);
    vi.spyOn(world.sessions, "rowMetadata").mockImplementation((id) =>
      id === "s1" ? Promise.resolve(undefined) : read(id),
    );
    for (const path of [
      "/",
      "/sidebar?project=%2Frepo%2Fone",
      "/sidebar/rows?project=%2Frepo%2Fone",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('id="row-s1"');
      expect(body).toContain("A legitimate first prompt");
      expect(body).toContain('data-title="empty-sessio"');
      expect(body).toContain("0 msgs");
      expect(body).not.toContain('aria-label="Loading..."');
    }
  });

  it("stars an answer, updates the row out of band, and clears again", async () => {
    const { app } = testApp();
    const form = new FormData();
    form.set("entryId", "a1");
    form.set("starred", "true");
    const starred = await (
      await app.request("/sessions/s1/star", { method: "POST", body: form })
    ).text();
    expect(starred).toContain('aria-pressed="true"');
    expect(starred).toContain('hx-swap-oob="true"');
    expect(starred).toContain("1 starred answers");

    const cleared = await (
      await app.request("/sessions/s1/stars/clear", { method: "POST" })
    ).text();
    expect(cleared).not.toContain("1 starred answers");
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('aria-label="Star answer"');
  });

  it("forks a message into a new session with the text as its draft", async () => {
    const { app, world } = testApp();
    const form = new FormData();
    form.set("entryId", "a1");
    const res = await app.request("/sessions/s1/fork", {
      method: "POST",
      body: form,
      headers: { "HX-Request": "true" },
    });
    const id = res.headers.get("hx-push-url")?.split("/").pop() ?? "";
    expect(world.store.has(id)).toBe(true);
    expect(world.store.get(id)?.entries).toHaveLength(2);
  });

  it.each([
    { action: "fork", text: "" },
    { action: "fork", text: "  Explain\n\t<b>this</b>  " },
    { action: "rewind", text: "" },
    { action: "rewind", text: "  Explain\n\t<b>this</b>  " },
  ])(
    "restores images into the $action response with draft '$text' only once",
    async ({ action, text }) => {
      const { app, world } = testApp();
      const stored = world.store.get("s1");
      if (!stored) throw new Error("missing session");
      const prompt = userEntry("u2", "a1", "");
      if (prompt.type !== "message") throw new Error("missing message");
      prompt.message = {
        role: "user",
        timestamp: 3,
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          { type: "image", data: "AAEC/w==", mimeType: "image/png" },
          { type: "image", data: "//79AA==", mimeType: "image/jpeg" },
        ],
      };
      stored.entries.push(prompt, assistantEntry("a2", "u2", "later", 4));
      stored.leafId = "a2";
      const original = structuredClone(stored.entries);
      const form = new FormData();
      form.set("entryId", "u2");
      const res = await app.request(`/sessions/s1/${action}`, {
        method: "POST",
        body: form,
        headers: { "HX-Request": "true" },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `${text.replace("<b>", "&lt;b&gt;").replace("</b>", "&lt;/b&gt;")}</textarea>`,
      );
      expect(html).toContain(
        '<div id="recalled-images" hidden=""><span data-image="AAEC/w==" data-mime="image/png"></span><span data-image="//79AA==" data-mime="image/jpeg"></span></div>',
      );
      expect(html.match(/id="recalled-images"/g)).toHaveLength(1);
      const destination = res.headers.get("hx-push-url") ?? "";
      if (action === "fork") expect(stored.entries).toEqual(original);
      else
        expect(stored.entries.map((entry) => entry.id)).toEqual(["u1", "a1"]);
      const reloaded = await (await app.request(destination)).text();
      expect(reloaded).not.toContain("data-image=");
    },
  );

  it("switches branch read-only and offers to continue from it", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("missing session");
    stored.entries.push(userEntry("u2", "u1", "other branch"));
    stored.leafId = "a1";

    const other = await (await app.request("/sessions/s1?leaf=u2")).text();
    expect(other).toContain("other branch");
    expect(other).toContain("read only");
    expect(other).not.toContain('id="composer"');
    // pi-web has no branch menu in the header: branches are rail marks.
    expect(other).toContain('data-branched="true"');

    const form = new FormData();
    form.set("entryId", "u2");
    const switched = await app.request("/sessions/s1/navigate", {
      method: "POST",
      body: form,
    });
    expect(switched.headers.get("hx-push-url")).toBe("/sessions/s1");
    // The user message came back as the composer draft.
    expect(await switched.text()).toContain("other branch</textarea>");
  });

  it("deletes a session and sends the open page home", async () => {
    const { app, world } = testApp();
    const res = await app.request("/sessions/s1/delete", {
      method: "POST",
      headers: { "HX-Current-URL": "http://localhost/sessions/s1" },
    });
    expect(res.headers.get("hx-redirect")).toBe("/new");
    expect(world.store.has("s1")).toBe(false);
  });

  it("reports a failed action as a toast", async () => {
    const { app } = testApp();
    const form = new FormData();
    form.set("entryId", "u1");
    const res = await app.request("/sessions/s1/star", {
      method: "POST",
      body: form,
    });
    expect(res.headers.get("hx-trigger")).toContain("assistant answer");
    expect(res.headers.get("hx-trigger")).toContain("web-pi:toast");
  });

  it("serves the exported transcript with safe response headers", async () => {
    const { app } = testApp();
    const exported = await app.request("/sessions/s1/export");
    expect(exported.headers.get("content-disposition")).toBe(
      'inline; filename="pi-session-s1.html"',
    );
    expect(exported.headers.get("x-frame-options")).toBe("DENY");
  });

  it("lists built-in and session commands, filtered and badged", async () => {
    const { app } = testApp();
    const all = await (await app.request("/sessions/s1/commands?q=")).text();
    expect(all).toContain("/compact");
    expect(all).toContain("/skill:testing");
    expect(all).toContain("Manual");
    // A stopped session lists extension commands too, as pi-web's does.
    expect(all).toContain("/review");

    const filtered = await (
      await app.request("/sessions/s1/commands?q=comp")
    ).text();
    expect(filtered).toContain("/compact");
    expect(filtered).not.toContain("/clone");
  });

  it("accepts attachments and serves them back from the session file", async () => {
    const { app, world } = testApp();
    const form = new FormData();
    form.set("text", "look at this");
    form.append(
      "images[]",
      new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }),
    );
    expect(
      (await app.request("/sessions/s1/prompt", { method: "POST", body: form }))
        .status,
    ).toBe(204);
    const entry = world.store.get("s1")?.entries.at(-1);
    expect(entry?.type).toBe("message");

    const page = await (await app.request("/sessions/s1")).text();
    const match = /\/sessions\/s1\/entries\/([^/]+)\/image\/0/.exec(page);
    expect(match).not.toBeNull();
    const image = await app.request(match?.[0] ?? "");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/gif");
  });

  it("refuses more than ten attachments", async () => {
    const { app } = testApp();
    const form = new FormData();
    form.set("text", "many");
    for (let index = 0; index < 11; index += 1) {
      form.append(
        "images[]",
        new File([new Uint8Array([1])], "x.png", { type: "image/png" }),
      );
    }
    const res = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form,
    });
    expect(res.headers.get("hx-trigger")).toContain("10 images");
  });

  it("queues a follow-up while a turn runs, then recalls it", async () => {
    const { app } = testApp({ delayMs: 200 });
    const first = new FormData();
    first.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: first });

    const queued = new FormData();
    queued.set("text", "and then this");
    queued.set("behavior", "followUp");
    await app.request("/sessions/s1/prompt", { method: "POST", body: queued });

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Queued · 1");
    expect(page).toContain("follow-up");

    const recalled = await (
      await app.request("/sessions/s1/queue/recall", { method: "POST" })
    ).text();
    expect(recalled).toContain('id="composer-text"');
    expect(recalled).toContain("and then this");
    expect(await (await app.request("/sessions/s1")).text()).not.toContain(
      "Queued ·",
    );
  });

  it("runs a built-in slash command instead of prompting", async () => {
    const { app, world } = testApp();
    const form = new FormData();
    form.set("text", "/name Renamed by command");
    const res = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form,
    });
    expect(res.headers.get("hx-trigger")).toContain("Renamed");
    expect(world.store.get("s1")?.summary.name).toBe("Renamed by command");
  });

  it("renders a persisted compaction summary without a duplicate success notice", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("no session");
    stored.entries.push({
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-09-02T00:00:00.000Z",
      summary: "Preserved compaction summary",
      tokensBefore: 40_000,
      firstKeptEntryId: "u1",
    });
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Conversation compacted: 40k");
    expect(page).toContain("Preserved compaction summary");
    expect(page).not.toContain("tokens (32k saved)");
  });

  it("keeps compaction failures visible", async () => {
    const { app, world } = testApp({ delayMs: 1 });
    const agent = await world.runtime.open({ sessionId: "s1" });
    await agent.compact("fail");
    await expect
      .poll(() => agent.snapshot().status.compactionError)
      .toBe("Compaction failed: the model refused.");
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('role="alert"');
    expect(page).toContain("Compaction failed: the model refused.");
  });

  it("runs a shell command from the composer and shows its output", async () => {
    const { app, world } = testApp({ delayMs: 1 });
    const form = new FormData();
    form.set("text", "!echo hi");
    expect(
      (await app.request("/sessions/s1/prompt", { method: "POST", body: form }))
        .status,
    ).toBe(204);
    const entry = world.store.get("s1")?.entries.at(-1);
    expect(entry?.type === "message" && entry.message.role).toBe(
      "bashExecution",
    );
    expect(await (await app.request("/sessions/s1")).text()).toContain(
      "echo hi: ok",
    );
  });

  it("serves the file index only inside the session's own folder", async () => {
    const { app } = testApp({ files: ["src/main.ts"] });
    const index = await app.request("/sessions/s1/file-index");
    expect(await index.json()).toEqual({
      files: ["src/main.ts"],
      truncated: false,
    });

    // A folder inside the session's own is allowed but still has to exist,
    // and one outside every root is refused before any file system call.
    const missing = await app.request(
      "/sessions/s1/file-index?cwd=%2Frepo%2Fone%2Fsrc&q=main",
    );
    expect(missing.status).toBe(404);
    const outside = await app.request("/sessions/s1/file-index?cwd=%2Fetc");
    expect(outside.status).toBe(403);
  });

  it("keeps path completion inside the session folder", async () => {
    const { app } = testApp({ files: ["src/main.ts"] });
    const res = await app.request("/sessions/s1/file-completion?q=.%2Fsrc");
    expect(await res.json()).toEqual({
      matches: [{ path: "/repo/one/src/main.ts", isDir: false }],
    });
  });

  it("refuses shell output this session never produced", async () => {
    const { app } = testApp();
    const res = await app.request(
      "/sessions/s1/bash-output?path=%2Ftmp%2Fpi-bash-abc.log",
    );
    expect(res.status).toBe(403);
    const wrong = await app.request(
      "/sessions/s1/bash-output?path=%2Fetc%2Fpasswd",
    );
    expect(wrong.status).toBe(403);
  });

  it("tells the browser to re-key its draft once a session exists", async () => {
    const { app } = testApp();
    const form = new FormData();
    form.set("cwd", "/repo/two");
    form.set("text", "hello");
    const res = await app.request("/sessions", {
      method: "POST",
      body: form,
      headers: { "HX-Request": "true" },
    });
    expect(JSON.parse(res.headers.get("HX-Location") ?? "{}")).toMatchObject({
      path: "/sessions/new-1",
      target: "#session-region",
    });
    expect(res.headers.get("hx-trigger")).toContain("web-pi:session-created");
    expect(res.headers.get("hx-trigger")).toContain("/repo/two");
  });

  it("pushes rows and a finished marker on the shared stream", async () => {
    const { app } = testApp({ reply: () => "done" });
    const res = await app.request("/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });

    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("event: finished")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    // Lifecycle changes re-sort the global page, without replacing the picker.
    expect(received).toContain(
      'data: <hx-partial hx-target="#session-list" hx-swap="innerHTML">',
    );
    expect(received).not.toContain('hx-target="#project-picker"');
    expect(received).not.toContain("event: rows");
    expect(received).toContain('id="row-s1"');
    expect(received).toContain('data: {"id":"s1"}');
  });

  it("lists a session Pi has not written to disk yet", async () => {
    // Pi writes a new session's file with its first assistant message, so
    // between the start and the first answer the runtime alone knows it.
    const { app, world } = testApp({ delayMs: 200, reply: () => "done" });
    const res = await app.request("/events?project=%2Frepo%2Fone");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const form = new FormData();
    form.set("cwd", "/repo/one");
    form.set("text", "go");
    const started = await app.request("/sessions", {
      method: "POST",
      body: form,
      headers: { "HX-Request": "true" },
    });
    expect(
      JSON.parse(started.headers.get("HX-Location") ?? "{}"),
    ).toMatchObject({ path: "/sessions/new-1", target: "#session-region" });
    expect(world.store.has("new-1")).toBe(false);

    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    // Creation pushes a complete list, including the unflushed runtime row.
    const list = received.slice(0, received.indexOf("\n\n"));
    expect(list).toContain(
      '<hx-partial hx-target="#session-list" hx-swap="innerHTML">',
    );
    expect(list).toContain('id="row-new-1"');
    const hydrated = await (await app.request("/sessions/new-1/row")).text();
    expect(hydrated).toContain('data-status="Agent running…"');
    expect(list).toContain("Stored one");
    expect(list).toContain("2 msgs");
    expect(list).not.toContain('hx-trigger="intersect once"');
    expect(list).not.toContain('hx-get="/sessions/new-1/row"');
    expect(list).not.toContain('aria-label="Loading..."');
    // The page the browser is sent to, rendered while the turn still runs,
    // shows the same row selected.
    const page = await (await app.request("/sessions/new-1")).text();
    const row = page.slice(page.indexOf('id="row-new-1"'));
    expect(row).toContain("session-row is-selected");
    expect(row).toContain('data-status="Agent running…"');
  });

  it("streams activity from every directory even with old project queries and cookies", async () => {
    // A dialog never answered here: the session in the other project stays
    // running while the stream is read.
    const { app, world } = testApp({
      script: () => [{ dialog: { method: "confirm", title: "Push it?" } }],
    });
    world.store.set("s2", {
      summary: {
        id: "s2",
        cwd: "/repo/two",
        name: "Other project",
        createdAt: "2026-09-03T00:00:00.000Z",
        modifiedAt: "2026-09-03T00:00:00.000Z",
        fileSize: 2,
      },
      entries: [userEntry("v1", null, "second project")],
    });

    // Old project cookies and stream URLs cannot scope the global list.
    const page = await (
      await app.request("/", {
        headers: { cookie: "web-pi-project=/repo/one" },
      })
    ).text();
    expect(page).toContain('hx-sse:connect="/events"');
    expect(page).not.toContain("sse-swap=");
    expect(page).not.toContain('hx-ext="sse"');
    expect(page).not.toContain("hx-params=");

    const res = await app.request("/events?project=%2Frepo%2Fone");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s2/prompt", { method: "POST", body: form });

    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes('data-status="Agent running…"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain('id="row-s2"');
    expect(received).toContain('id="row-s1"');
    expect(received).not.toContain('id="project-picker"');
  });

  it("keeps the sidebar global on pages, refreshes and old project URLs", async () => {
    const { app, world } = testApp();
    world.store.set("s2", {
      summary: {
        id: "s2",
        cwd: "/repo/two",
        name: "Other project",
        createdAt: "2026-09-03T00:00:00.000Z",
        modifiedAt: "2026-09-03T00:00:00.000Z",
        fileSize: 2,
      },
      entries: [userEntry("v1", null, "second project")],
    });

    const first = await (await app.request("/")).text();
    expect(first).toContain('href="/sessions/s2"');
    expect(first).toContain('href="/sessions/s1"');

    const chosen = await app.request("/sidebar?project=%2Frepo%2Fone");
    expect(chosen.headers.get("set-cookie")).toBeNull();
    const nav = await chosen.text();
    expect(nav).toContain('id="session-nav"');
    expect(nav).toContain('href="/sessions/s1"');
    expect(nav).toContain('href="/sessions/s2"');
    expect(nav).toContain("Stored one");
    expect(nav).toContain("2 msgs");
    expect(nav).not.toContain('hx-get="/sessions/s1/row"');

    // Opening a different directory changes context, not list visibility.
    const page = await (
      await app.request("/sessions/s2", {
        headers: { cookie: "web-pi-project=/repo/one" },
      })
    ).text();
    expect(page).toContain('href="/sessions/s2"');
    expect(page).toContain('href="/sessions/s1"');
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
    expect(opened.headers.getSetCookie().join(" ")).not.toContain(
      "web-pi-cwd=",
    );
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

  it("lists subagent runs inline, as pi-web does", async () => {
    const { app, world } = testApp();
    world.store.set("subagent.abc", {
      summary: {
        id: "subagent.abc",
        cwd: "/repo/one",
        createdAt: "2026-09-04T00:00:00.000Z",
        modifiedAt: "2026-09-04T00:00:00.000Z",
        fileSize: 1,
        parentId: "s1",
      },
      entries: [userEntry("g1", null, "explore the repo")],
    });

    const list = await (await app.request("/")).text();
    expect(list).not.toContain("subagent run");
    expect(list).toContain('href="/sessions/subagent.abc"');
  });
});

/** A session long enough to page, with one thinking block per answer. */
function longApp(answers = 60) {
  const entries = [];
  let parent: string | null = null;
  for (let index = 0; index < answers; index += 1) {
    const userId = `u${String(index)}`;
    const answerId = `a${String(index)}`;
    entries.push(userEntry(userId, parent, `question ${String(index)}`));
    const answer = assistantEntry(
      answerId,
      userId,
      `answer ${String(index)}`,
      100,
    );
    if (answer.type === "message" && answer.message.role === "assistant") {
      answer.message.content = [
        { type: "thinking", thinking: "z".repeat(2000) },
        ...answer.message.content,
      ];
    }
    entries.push(answer);
    parent = answerId;
  }
  return testApp({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo/one",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 10,
        },
        entries,
      },
    ],
  });
}

/** A store with several projects, a worktree and enough projects to filter. */
function sidebarApp() {
  const sessions = [
    {
      summary: {
        id: "s1",
        cwd: "/repo/one",
        name: "Stored one",
        createdAt: "2026-09-01T00:00:00.000Z",
        modifiedAt: "2026-09-02T00:00:00.000Z",
        fileSize: 10,
        projectRoot: "/repo/one",
      },
      entries: [
        userEntry("u1", null, "first question"),
        assistantEntry("a1", "u1", "an answer", 40_000),
      ],
    },
    {
      summary: {
        id: "s2",
        cwd: "/repo/one.wt",
        name: "In a worktree",
        createdAt: "2026-09-03T00:00:00.000Z",
        modifiedAt: "2026-09-03T00:00:00.000Z",
        fileSize: 4,
        projectRoot: "/repo/one",
        worktreeBranch: "feature/x",
      },
      entries: [userEntry("u2", null, "worktree question")],
    },
  ];
  // Nine more projects, which is what turns the menu's filter box on.
  for (let index = 0; index < 9; index += 1) {
    sessions.push({
      summary: {
        id: `p${String(index)}`,
        cwd: `/repo/other${String(index)}`,
        name: `Other ${String(index)}`,
        createdAt: "2026-08-01T00:00:00.000Z",
        modifiedAt: `2026-08-0${String(index + 1)}T00:00:00.000Z`,
        fileSize: 1,
        projectRoot: `/repo/other${String(index)}`,
      },
      entries: [userEntry(`o${String(index)}`, null, "question")],
    });
  }
  const world = createFakeWorld({
    delayMs: 2,
    sessions,
    // /repo/one.wt is a worktree of /repo/one, so the two group together.
    projects: (cwd) =>
      cwd.startsWith("/repo/one")
        ? {
            root: "/repo/one",
            branch: cwd === "/repo/one.wt" ? "feature/x" : "main",
            isWorktree: cwd !== "/repo/one",
            isTopLevel: cwd === "/repo/one",
          }
        : { root: cwd, branch: null, isWorktree: false, isTopLevel: true },
  });
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: "/repo/one",
    home: "/repo",
    renderIntervalMs: 1,
  });
  return { app, world };
}

describe("the sidebar", () => {
  it("names the branch in Project Info, the worktree only when it is one", async () => {
    const { app } = sidebarApp();
    const main = await (await app.request("/sessions/s1/stats")).text();
    const worktree = await (await app.request("/sessions/s2/stats")).text();
    // pi-web shows the branch of any checkout, and the Worktree row only for
    // a linked one (AppShell.tsx L2186-L2210).
    expect(main).toContain("Git Branch");
    expect(main).toContain(">main<");
    expect(main).not.toContain("Worktree");
    expect(worktree).toContain(">feature/x<");
    expect(worktree).toContain("Worktree");
    expect(worktree).toContain(">/repo/one.wt<");
  });

  it("offers Stop instead of Activate for an attached session", async () => {
    const { app, world } = sidebarApp();
    await world.runtime.open({ sessionId: "s2" });
    const row = await (await app.request("/sessions/s2/row")).text();
    expect(row).toContain("Session active");
    expect(row).toContain('hx-post="/sessions/s2/stop"');
    expect(row).not.toContain('hx-post="/sessions/s2/activate"');
  });

  it("renders a selected worktree's metadata in the page and row endpoint", async () => {
    const { app } = sidebarApp();
    const html = await (await app.request("/sessions/s2")).text();
    expect(html).toMatch(/id="row-s2"[^>]*class="session-row is-selected"/);
    const loaded = await (await app.request("/sessions/s2/row")).text();
    expect(loaded).toContain("Session stopped");
    expect(loaded).toContain("feature/x");
    expect(loaded).toContain("In a worktree");
    expect(loaded).toContain("1 msgs");
  });

  it("targets the complete row for its available actions", async () => {
    const { app } = sidebarApp();
    const row = await (await app.request("/sessions/s1/row")).text();
    expect(row).toContain('popovertarget="row-menu-s1"');
    expect(row).toContain('hx-post="/sessions/s1/activate"');
    expect(row).toContain('hx-get="/sessions/s1/rename"');
    expect(row).toContain('hx-post="/sessions/s1/delete"');
    expect(row).toContain(
      'hx-confirm="Delete this session and its transcript?"',
    );
    expect(row).toContain('hx-target="#row-s1" hx-swap="outerHTML"');
  });

  it("offers Clear all stars only while a session has stars", async () => {
    const { app } = sidebarApp();
    const before = await (await app.request("/sessions/s1/row")).text();
    expect(before).not.toContain("Clear all stars");
    const form = new FormData();
    form.set("entryId", "a1");
    form.set("starred", "true");
    await app.request("/sessions/s1/star", { method: "POST", body: form });
    const row = await (await app.request("/sessions/s1/row")).text();
    expect(row).toContain("Clear all stars");
    expect(row).toContain("1 starred answers");
  });

  it("swaps the row for an input when Rename is chosen, and back again", async () => {
    const { app } = sidebarApp();
    const renaming = await (await app.request("/sessions/s1/rename")).text();
    expect(renaming).toContain(
      '<form id="row-s1" class="session-row is-renaming"',
    );
    expect(renaming).toContain('name="name" value="Stored one"');
    // Escape asks for the row back.
    expect(renaming).toContain('hx-get="/sessions/s1/row"');

    const posted = new FormData();
    posted.set("name", "Renamed");
    const row = await (
      await app.request("/sessions/s1/rename", {
        method: "POST",
        body: posted,
      })
    ).text();
    expect(row).toContain("Renamed");
    expect(row).toContain('id="row-s1"');
  });

  it("groups the workspace menu by project, with worktrees under it", async () => {
    const { app } = sidebarApp();
    const menu = await (
      await app.request("/sidebar/projects", {
        headers: { "HX-Current-URL": "http://x/sessions/s2" },
      })
    ).text();
    // Eleven projects expose a filter; opening the popover must not focus it.
    expect(menu).toContain("Filter projects…");
    // A plain text box that opens unfocused, as pi-web's does: its autoFocus
    // fires when the sidebar mounts, long before the popover is opened, so
    // the field shows neither a focus ring nor a caret.
    const filter = menu.slice(menu.indexOf('id="project-filter"'));
    expect(filter.slice(0, filter.indexOf(">"))).not.toMatch(
      /autofocus|type="search"/,
    );
    // The project with two folders expands; the others select directly.
    const group = menu.slice(menu.indexOf('data-project-key="/repo/one"'));
    expect(group).toContain('aria-expanded="true"');
    expect(group).toContain(">~/one.wt<");
    // Exactly one row carries the tick, on the folder the sidebar is showing.
    expect([...menu.matchAll(/aria-current="true"/g)]).toHaveLength(1);
    expect(menu).toContain("/new?cwd=%2Frepo%2Fone");
    expect(menu).toContain("Custom path…");
  });

  it("spells out the home folder itself in the workspace menu", async () => {
    // pi-web abbreviates a project path only *below* home, so a session
    // started in the home directory reads "/repo", not "~".
    const world = createFakeWorld({
      delayMs: 2,
      sessions: [
        {
          summary: {
            id: "h1",
            cwd: "/repo",
            name: "At home",
            createdAt: "2026-09-01T00:00:00.000Z",
            modifiedAt: "2026-09-02T00:00:00.000Z",
            fileSize: 10,
            projectRoot: "/repo",
          },
          entries: [userEntry("u1", null, "question")],
        },
      ],
    });
    const app = createWebApp({
      workspace: createWorkspace(world),
      staticRoot: "/nonexistent",
      defaultCwd: "/repo",
      home: "/repo",
      renderIntervalMs: 1,
    });
    const menu = await (await app.request("/sidebar/projects")).text();
    expect(menu).toContain(">/repo<");
    expect(menu).not.toContain(">~<");
  });

  it("drops the filter box when there are few projects", async () => {
    const { app } = testApp();
    const menu = await (await app.request("/sidebar/projects")).text();
    expect(menu).not.toContain('id="project-filter"');
    expect(menu).toContain("Custom path…");
  });

  it("redirects existing folder-selection URLs to the new-session composer", async () => {
    const { app } = sidebarApp();
    const url = "/sidebar?project=%2Frepo%2Fone&cwd=%2Frepo%2Fone.wt";
    const res = await app.request(url);
    expect(res.headers.get("location")).toBe("/new?cwd=%2Frepo%2Fone.wt");
    const fragment = await app.request(url, {
      headers: { "HX-Request": "true" },
    });
    expect(
      JSON.parse(fragment.headers.get("HX-Location") ?? "{}"),
    ).toMatchObject({
      path: "/new?cwd=%2Frepo%2Fone.wt",
      target: "#session-region",
    });
    expect(fragment.headers.get("set-cookie")).toBeNull();
  });
});

describe("the composer, as pi-web draws it", () => {
  /** Menu order determines which choice keyboard navigation reaches first. */
  function order(html: string, markers: string[]): void {
    let at = 0;
    for (const marker of markers) {
      const found = html.indexOf(marker, at);
      expect([marker, found > -1]).toStrictEqual([marker, true]);
      at = found;
    }
  }

  it("groups the slash menu the way pi-web does", async () => {
    const { app } = testApp();
    const menu = await (await app.request("/sessions/s1/commands")).text();
    order(menu, [
      "Built-in",
      "/clone",
      "Extensions",
      "/review",
      "Prompts",
      "/changelog",
      "Skills",
      "/skill:testing",
    ]);
    expect(menu).toContain('data-index="0"');
  });

  it("counts commands until the slash is filtered, then matches", async () => {
    const { app } = testApp();
    const all = await (await app.request("/sessions/s1/commands?q=")).text();
    expect(all).toContain("Slash commands · 9 commands");
    const one = await (
      await app.request("/sessions/s1/commands?q=clone")
    ).text();
    expect(one).toContain("Slash commands · 1 match");
  });

  it("offers every model, grouped by provider, with a filter above eight", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      provider: index < 5 ? "fake" : "other",
      id: `m${String(index)}`,
      name: `Model ${String(index)}`,
      contextWindow: 100_000,
      reasoning: false,
    }));
    const { app } = testApp({ models: many });
    const page = await (await app.request("/sessions/s1")).text();
    const selector = page.slice(page.indexOf('id="model-selector"'));
    expect(selector).toContain('id="model-menu" popover="auto"');
    expect(selector).toContain('placeholder="Filter models…"');
    // Showing a popover focuses the first autofocus element inside it.
    expect(selector).toContain("autofocus");
    expect(selector).toContain('data-provider="fake"');
    expect(selector).toContain('data-provider="other"');
    // A pick is a request of its own: none of the composer's fields ride along.
    expect(selector).toContain('data-request-fields="none"');
    expect(selector).toContain("/sessions/s1/model?model=fake%2Fm0");
    expect(selector).toContain('hx-target="closest .model-selector"');
  });

  it("sorts model choices by display name", async () => {
    const { app } = testApp({
      models: [
        {
          provider: "fake",
          id: "zulu",
          name: "zulu",
          contextWindow: 100_000,
          reasoning: false,
        },
        {
          provider: "fake",
          id: "alpha",
          name: "Alpha via OpenRouter",
          contextWindow: 100_000,
          reasoning: false,
        },
      ],
    });
    const page = await (await app.request("/sessions/s1")).text();
    const selector = page.slice(page.indexOf('id="model-selector"'));
    // pi-web sorts by display name and never hoists the current model.
    order(selector, ["Alpha via OpenRouter", ">zulu<"]);
  });

  it("applies a model pick and answers with the new selector", async () => {
    const { app } = testApp();
    const res = await app.request("/sessions/s1/model?model=fake%2Ffake-1", {
      method: "POST",
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="model-selector"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Change reasoning level");
  });
});

describe("conversation rail, shelf, and written files", () => {
  it("renders a mark per prompt, star, and branch, with previews", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("no session");
    // A second branch off the first question.
    stored.entries.push(userEntry("u2", "u1", "another approach"));
    stored.entries.push(assistantEntry("a2", "u2", "other answer", 41_000));
    stored.leafId = "a1";

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('id="rail"');
    expect(page).toContain('data-branched="true"');
    expect(page).toContain('data-preview="first &lt;b&gt;question&lt;/b&gt;"');
    // The mark on the other branch navigates instead of scrolling.
    expect(page).toContain('data-branch="true"');
    expect(page).toContain('hx-post="/sessions/s1/navigate"');
    expect(page).toContain("minimap-graph");
  });

  it("re-sends the rail out of band when a turn settles", async () => {
    const { app } = testApp({ reply: () => "done" });
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("event: settled")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain('id="rail" class="minimap-layer"');
    expect(received).toContain('hx-swap-oob="true"');
  });

  it("shows extension statuses and widgets in the shelf, ANSI converted", async () => {
    const { app } = testApp({
      script: () => [
        { status: "git", statusText: "\u001B[32mmain\u001B[0m  clean" },
        { status: "lint", statusText: "2 < 3" },
        { widget: "todo", lines: ["\u001B[1mOpen\u001B[0m", "one", "two"] },
        { text: "done" },
      ],
    });
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes("todo")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain(
      '<hx-partial hx-target="#shelf" hx-swap="outerHTML">',
    );
    expect(received).toContain(
      '<span class="extension-status-text"><span style="color:#13703a">main</span> clean · 2 &lt; 3</span>',
    );
    expect(received).toContain('aria-label="main clean · 2 &lt; 3"');
    expect(received).toContain('<span class="terminal-bold">Open</span>');
    expect(received).toMatch(
      /class="extension-widget-trigger"[^>]*aria-expanded="true"/,
    );
    expect(received).not.toContain("\u001B[");
  });

  it("keeps the shelf under the composer on the page itself", async () => {
    // The strip is the last row of the chat column, so the composer sits 36px
    // higher whenever an extension has something to say. A page that dropped
    // it moved every row below the top bar (ui-gaps r2, composer).
    const { app } = testApp({
      script: () => [{ status: "prune", statusText: "on" }, { text: "done" }],
    });
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    // The first shelf event is the empty strip the stream opens with; wait
    // for the one the extension's status filled.
    while (!received.includes("extension-status-text")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    // The page is asked for while the stream is still open: web-pi lets go of
    // a live session once its last reader does.
    const page = await renderedHtml(
      await (await app.request("/sessions/s1")).text(),
    );
    await reader.cancel();
    const surface = page.indexOf('class="composer-surface"');
    // The composer's own "more" popover carries a second copy for phones, so
    // the strip itself is the one the stream swaps, by id.
    const shelf = page.indexOf('id="shelf"');
    const footerEnd = page.indexOf("</footer>", surface);
    expect(surface).toBeGreaterThan(-1);
    expect(shelf).toBeGreaterThan(surface);
    expect(shelf).toBeLessThan(footerEnd);
    expect(page.slice(shelf, footerEnd)).toContain(
      'class="extension-status-shelf has-status"',
    );
    expect(page.slice(shelf, footerEnd)).toContain(
      'class="extension-status-text"',
    );
  });

  it("chips the files a turn wrote and offers them as mentions", async () => {
    const { app } = testApp({
      script: () => [
        {
          tool: "edit",
          arguments: { file_path: "/repo/one/src/answer.ts" },
          result: "edited",
        },
        { text: "changed it" },
      ],
    });
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('aria-label="Files changed"');
    // The chip opens the file panel rather than typing a mention.
    expect(page).toContain('data-file-path="/repo/one/src/answer.ts"');
    expect(page).toContain('title="/repo/one/src/answer.ts"');
  });

  it("keeps a huge tool result off the page and cuts it when opened", async () => {
    const output = "x".repeat(40_000);
    const { app } = testApp({
      script: () => [
        { tool: "grep", arguments: { pattern: "x" }, result: output },
        { text: "found them" },
      ],
    });
    const baseline = await (await app.request("/sessions/s1")).text();
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).not.toContain("xxxxx");
    // Compare the turn's added markup, not the unrelated shell overhead.
    expect(page.length - baseline.length).toBeLessThan(output.length);

    const url = deferredUrl(page);
    const opened = await (await app.request(url)).text();
    expect(opened).toContain("view full output");
    expect(opened.length).toBeLessThan(output.length);
    const full = await (await app.request(`${url}?full=1`)).text();
    expect(full).toContain(output);
    expect(full).not.toContain("view full output");
  });

  it("cuts a diff that is longer than the budget", async () => {
    const hunk = Array.from(
      { length: 300 },
      (_, index) => `-old ${String(index)}\n+new ${String(index)}`,
    ).join("\n");
    const patch = `--- a/x.ts\n+++ b/x.ts\n@@ -1,600 +1,600 @@\n${hunk}\n`;
    const { app } = testApp({
      script: () => [
        {
          tool: "edit",
          arguments: { file_path: "/repo/one/x.ts" },
          details: { patch },
          result: "edited",
        },
        { text: "done" },
      ],
    });
    const form = new FormData();
    form.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const url = deferredUrl(await (await app.request("/sessions/s1")).text());
    const opened = await (await app.request(url)).text();
    expect(opened).toContain("view full output");
    expect(opened).not.toContain("new 299");
    const full = await (await app.request(`${url}?full=1`)).text();
    expect(full).toContain("new 299");
  });
});

describe("transcript rendering", () => {
  it("keeps an extension card's copy button and details toggle on one row", async () => {
    const { app, world } = testApp();
    const stored = world.store.get("s1");
    if (!stored) throw new Error("no session");
    stored.entries.push({
      type: "custom_message",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-09-02T00:00:00.000Z",
      customType: "pi-processes:update",
      content: "process finished",
      display: true,
      details: { exitCode: 0 },
    } as never);

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('class="transcript-details note-details"');
    expect(page).toContain(
      '<span class="note-details-closed">Show details</span>',
    );
    expect(page).toContain(
      '<span class="note-details-open">Hide details</span>',
    );
    expect(page).toContain('data-copy="true" title="Copy message"');
  });

  it("keeps the turn's usage, time and anchor on the answer alone", async () => {
    // One assistant message that reasons and then answers: pi-web splits it
    // around the answer and the process half carries none of the footer.
    const reasoned = assistantEntry("a1", "u1", "the answer", 40_000);
    if (reasoned.type === "message" && reasoned.message.role === "assistant") {
      reasoned.message.content = [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "the answer" },
      ] as never;
    }
    const { app } = testApp({
      sessions: [
        {
          summary: {
            id: "s1",
            cwd: "/repo/one",
            name: "Stored one",
            createdAt: "2026-09-01T00:00:00.000Z",
            modifiedAt: "2026-09-02T00:00:00.000Z",
            fileSize: 10,
          },
          entries: [userEntry("u1", null, "ask"), reasoned],
        },
      ],
    });
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("39,990 in · 10 out");
    expect(page.split("39,990 in · 10 out")).toHaveLength(2);
    // Both halves render, but only the answer answers to the rail.
    expect(page.split('data-role="assistant"')).toHaveLength(3);
    expect(page.split('id="entry-a1"')).toHaveLength(2);
  });

  it("renders a notice as pi-web's shelf card", async () => {
    const { app, world } = testApp();
    await world.runtime.open({ sessionId: "s1" });
    const body = new FormData();
    body.set("cwd", "/repo/one");
    await app.request("/settings/plugins/reload", { method: "POST", body });
    const res = await app.request("/sessions/s1/events");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let received = "";
    const decoder = new TextDecoder();
    while (!received.includes('hx-target="#toasts"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    await reader.cancel();
    expect(received).toContain('hx-target="#toasts"');
    expect(received).toContain("Resources reloaded.");
  });

  it("groups a turn into process details and the answer", async () => {
    const { app, world } = testApp({
      script: (): ScriptedStep[] => [
        { thinking: "checking the file" },
        { tool: "read", arguments: { path: "/repo/one/a.ts" }, result: "ok" },
        { text: "all done" },
      ],
    });
    const form = new FormData();
    form.set("text", "look");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await vi.waitFor(() => {
      expect(world.runtime.get("s1")?.snapshot().status.running).toBe(false);
    });

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Process details · 1 message · 1 tool call");
    expect(page).toContain("checking the file");
    expect(page).toContain("/repo/one/a.ts");
    expect(page).toContain("all done");
  });

  it("serves a reported patch when its card opens", async () => {
    const { app } = testApp({
      script: (): ScriptedStep[] => [
        {
          tool: "edit",
          arguments: { file_path: "/repo/one/a.ts" },
          details: {
            patch:
              "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
          },
        },
        { text: "changed it" },
      ],
    });
    const form = new FormData();
    form.set("text", "edit it");
    await app.request("/sessions/s1/prompt", { method: "POST", body: form });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // A settled card ships a placeholder; the diff arrives when it opens.
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).not.toContain("const a = 1;");
    const body = await (await app.request(deferredUrl(page))).text();
    expect(body).toContain("const a = 1;");
    expect(body).toContain("const a = 2;");
    // Edit tools show the diff instead of repeating their arguments.
    expect(body).not.toContain("&quot;file_path&quot;");
  });

  it("names the running tool while a turn works", async () => {
    // Hold the scripted tool in its progress phase, independent of CI load.
    vi.useFakeTimers();
    try {
      const { app } = testApp({
        delayMs: 40,
        script: (): ScriptedStep[] => [
          {
            tool: "bash",
            arguments: { command: "ls" },
            progress: ["scanning"],
          },
          { text: "done" },
        ],
      });
      const form = new FormData();
      form.set("text", "run it");
      await app.request("/sessions/s1/prompt", { method: "POST", body: form });
      await vi.advanceTimersByTimeAsync(100);
      expect(await (await app.request("/sessions/s1")).text()).toContain(
        "Running bash... scanning",
      );
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a starred answer when the default page opens mid-turn before a later prompt", async () => {
    const { app, world } = testApp();
    await world.sessions.setStar("s1", "a1", true);
    const stored = world.store.get("s1");
    if (!stored) throw new Error("missing session");
    let parent = stored.entries.at(-1)?.id ?? "a1";
    stored.entries.push(userEntry("u2", parent, "Later question"));
    parent = "u2";
    // Including the star entry, the last 50 entries start at a1, not u1.
    for (let index = 0; index < 47; index++) {
      const id = `later-${String(index)}`;
      stored.entries.push(
        assistantEntry(id, parent, `Later answer ${String(index)}`, 4),
      );
      parent = id;
    }
    stored.leafId = parent;

    const response = await app.request("/sessions/s1");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).not.toContain('id="entry-u1"');
    expect(page).toContain("before=a1");
    expect(page).toContain('id="entry-a1"');
    const answer = page.slice(
      page.indexOf('id="entry-a1"'),
      page.indexOf('id="entry-u2"'),
    );
    expect(answer).toContain("<strong>bold</strong>");
    expect(answer).toContain('aria-label="Unstar answer"');
    expect(answer).toContain('aria-pressed="true"');
    expect(page).toContain('id="entry-later-46"');
  });

  it("pages a long transcript and prepends the page before it", async () => {
    const { app } = longApp();
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Scroll up to load earlier messages");
    expect(page).toContain("question 59");
    // The rail carries a preview of every prompt, so only the transcript
    // itself is checked for the messages the page left out.
    expect(page).toContain(">question 59<");
    expect(page).not.toContain(">question 10<");

    const before = /before=([^&"]+)/.exec(page)?.[1] ?? "";
    expect(before).not.toBe("");
    const earlier = await (
      await app.request(`/sessions/s1/earlier?before=${before}`)
    ).text();
    expect(earlier).toContain("question 34");
    expect(earlier).toContain('hx-get="/sessions/s1/earlier?before=');

    const bad = await app.request("/sessions/s1/earlier?before=nope");
    expect(bad.status).toBe(400);
  });

  it("fetches a thinking block the page was too long to carry", async () => {
    const { app } = longApp();
    const page = await (await app.request("/sessions/s1")).text();
    const url = /\/sessions\/s1\/entries\/[^/]+\/thinking\/0/.exec(page)?.[0];
    expect(url).toBeDefined();
    const block = await (await app.request(url ?? "")).text();
    expect(block).toContain("zzz");
    const missing = await app.request("/sessions/s1/entries/nope/thinking/0");
    expect(await missing.text()).toContain("unavailable");
  });
});

describe("phase 8 fixes", () => {
  it("leaves the delivery mode to the hidden field, not to the submitter", async () => {
    const { app } = testApp();
    const page = await (await app.request("/sessions/s1")).text();
    // htmx appends a submitter's own name and value after the form's fields,
    // so a named button would always lose to the hidden field. The primary
    // button carries the mode as data, and the browser copies it across.
    expect(page).toContain('data-behavior="steer"');
    expect(page).not.toMatch(/name="behavior"\s+value="followUp"/);
    expect(page.match(/name="behavior"/g)).toHaveLength(1);
  });

  it("recalls queued images for the composer to put back", async () => {
    const { app } = testApp({ delayMs: 30 });
    const first = new FormData();
    first.set("text", "go");
    await app.request("/sessions/s1/prompt", { method: "POST", body: first });
    const second = new FormData();
    second.set("text", "with a picture");
    second.set("behavior", "followUp");
    second.set(
      "images[]",
      new File([Buffer.from("89504e47", "hex")], "shot.png", {
        type: "image/png",
      }),
    );
    await app.request("/sessions/s1/prompt", { method: "POST", body: second });

    const recalled = await (
      await app.request("/sessions/s1/queue/recall", { method: "POST" })
    ).text();
    expect(recalled).toContain("with a picture");
    expect(recalled).toContain('data-mime="image/png"');
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
      async function compactButton(html: string) {
        const window = new Window();
        try {
          window.document.body.innerHTML = html;
          return (
            window.document.querySelector("#context-compact")?.outerHTML ?? ""
          );
        } finally {
          await window.happyDOM.close();
        }
      }
      try {
        await readUntil('id="context-compact"');
        const form = new FormData();
        form.set("text", "/compact fail");
        const response = await app.request(
          outcome === "success"
            ? "/sessions/s1/compact"
            : "/sessions/s1/prompt",
          { method: "POST", ...(outcome === "failure" ? { body: form } : {}) },
        );
        expect(response.status).toBe(204);
        const running = await compactButton(
          await readUntil('data-compacting="true"'),
        );
        expect(running).toContain('hx-swap-oob="true"');
        expect(running).toContain("disabled");
        expect(running).toContain('aria-busy="true"');
        expect(running).toContain('aria-label="Compacting context…"');
        const revisited = await compactButton(
          await (await app.request("/sessions/s1")).text(),
        );
        expect(revisited).toContain("disabled");
        expect(revisited).toContain('aria-busy="true"');
        const settled = await readUntil(
          outcome === "success"
            ? 'aria-label="Compact context"'
            : "Compaction failed:",
        );
        const restored = await compactButton(settled);
        expect(restored).toContain('aria-label="Compact context"');
        expect(restored).not.toContain("disabled");
        expect(restored).not.toContain('aria-busy="true"');
      } finally {
        await reader.cancel();
      }
    },
  );

  it("keeps the history row while a turn runs, with branching disabled", async () => {
    // pi-web leaves the row rendered and disables only what the turn owns:
    // New branch waits, Rewind goes away, New session stays
    // (ChatWindow.tsx `branchDisabledReason` and `onRewind`).
    const { app, world } = testApp({ delayMs: 1000 });
    const live = await world.runtime.open({ sessionId: "s1" });
    await live.prompt("go");
    const running = await (await app.request("/sessions/s1")).text();
    expect(running).toMatch(/aria-label="New branch"[^>]*disabled/);
    expect(running).toContain(
      "Wait for the current operation to finish before branching",
    );
    expect(running).toContain("New session");
    expect(running).not.toContain('class="message-rewind"');
    await live.abort();
    const settled = await (await app.request("/sessions/s1")).text();
    expect(settled).not.toMatch(/aria-label="New branch"[^>]*disabled/);
    expect(settled).toContain('class="message-rewind"');
  });

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

  it("lists what a subagent run was given, and its progress while it runs", async () => {
    vi.useFakeTimers();
    try {
      const { app } = testApp({
        delayMs: 40,
        script: (): ScriptedStep[] => [
          {
            tool: "subagent",
            arguments: {
              calls: [
                { agent: "explorer", prompt: "look around", model: "fake-1" },
              ],
            },
            progress: ["reading src/"],
            details: {
              kind: "pi-subagent",
              results: [
                {
                  agent: "explorer",
                  exitCode: 0,
                  model: "fake-1",
                  messages: [
                    {
                      role: "assistant",
                      content: [{ type: "text", text: "ok" }],
                    },
                  ],
                },
              ],
            },
          },
          { text: "done" },
        ],
      });
      const form = new FormData();
      form.set("text", "explore");
      await app.request("/sessions/s1/prompt", { method: "POST", body: form });

      // The progress window is only 80–120ms; wall-clock rendering can miss it.
      await vi.advanceTimersByTimeAsync(100);
      const running = await (await app.request("/sessions/s1")).text();
      expect(running).toContain("reading src/");

      await vi.advanceTimersByTimeAsync(150);
      const page = await (await app.request("/sessions/s1")).text();
      expect(page).not.toContain("<dt>Agent</dt>");
      expect(page).toContain("explorer");
      const body = await (await app.request(deferredUrl(page))).text();
      expect(body).toContain("<dl");
      expect(body).toContain("<dt>Agent</dt>");
      expect(body).toContain("look around");
      expect(body).toContain("fake-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the post-compaction estimate on the card", async () => {
    const { app, world } = testApp();
    world.store.set("k1", {
      summary: {
        id: "k1",
        cwd: "/repo/one",
        createdAt: "2026-09-01T00:00:00.000Z",
        modifiedAt: "2026-09-01T00:00:00.000Z",
        fileSize: 2,
      },
      entries: [
        userEntry("u1", null, "question"),
        {
          type: "compaction",
          id: "c1",
          parentId: "u1",
          timestamp: "2026-09-01T00:00:00.000Z",
          summary: "what happened",
          tokensBefore: 40_000,
          firstKeptEntryId: "u1",
        } as never,
      ],
    });
    const page = await (await app.request("/sessions/k1")).text();
    expect(page).toContain("40k → ~");
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
    const html = await (
      await app.request("/settings", {
        headers: { "HX-Current-URL": "http://x/sessions/s1" },
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
    expect(html).not.toContain("/row?active=s1");
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
