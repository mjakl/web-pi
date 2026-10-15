// The composer's routes: prompts and commands, attachments, the queue, the
// model, the @ menu, shell output, and the session's own event stream.

import { describe, expect, it } from "vitest";
import { testApp } from "#/web/fixtures/test-app";
import { parseHtml } from "#/web/helpers";

function renderedHtml(html: string): string {
  const document = parseHtml(html);
  for (const template of document.querySelectorAll("template")) {
    template.remove();
  }
  return document.body.innerHTML;
}

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
  const rendered = renderedHtml(received.replaceAll(/^data: /gm, ""));
  expect(rendered).toContain(clear);
  expect(rendered.indexOf(clear)).toBeLessThan(
    rendered.indexOf("event: settled\n"),
  );
  expect(received).toContain("event: settled\ndata: s1");
  expect(received).not.toMatch(
    /event: (turn|status|shelf|dialog|custom|editor|notice)\n/,
  );
  expect(received).not.toContain("Estimated token count while streaming");
  expect(received).not.toContain(" t/s");
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

  // The button posts the draft in the composer, which stays after the
  // queued text.
  const draft = new FormData();
  draft.set("text", "  my draft\n");
  const recalled = await (
    await app.request("/sessions/s1/queue/recall", {
      method: "POST",
      body: draft,
    })
  ).text();
  expect(recalled).toContain('id="composer-text"');
  expect(recalled).toContain(">and then this\n\n  my draft\n</textarea>");
  expect(await (await app.request("/sessions/s1")).text()).not.toContain(
    "Queued ·",
  );

  // Already sent: the composer and its draft stay as they are.
  const drained = await app.request("/sessions/s1/queue/recall", {
    method: "POST",
    body: draft,
  });
  expect(drained.status).toBe(204);
  expect(drained.headers.get("HX-Reswap")).toBe("none");
  expect(JSON.parse(drained.headers.get("HX-Trigger") ?? "null")).toEqual({
    "web-pi:toast": {
      level: "info",
      message: "The queued messages were already sent.",
    },
  });
  expect(await drained.text()).toBe("");
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

it("confirms a rename whose name is not Latin-1, through an ASCII header", async () => {
  const { app, world } = testApp();
  const form = new FormData();
  form.set("text", "/name Fix the “quotes” bug");
  const res = await app.request("/sessions/s1/prompt", {
    method: "POST",
    body: form,
  });
  expect(res.status).toBe(200);
  const trigger = res.headers.get("HX-Trigger") ?? "";
  // htmx reads the header with JSON.parse, which restores the escapes.
  expect(trigger).toMatch(/^[\x20-\x7e]*$/);
  expect(JSON.parse(trigger)).toEqual({
    "web-pi:toast": {
      level: "info",
      message: 'Renamed to "Fix the “quotes” bug".',
    },
  });
  expect(world.store.get("s1")?.summary.name).toBe("Fix the “quotes” bug");
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
  expect(entry?.type === "message" && entry.message.role).toBe("bashExecution");
  expect(await (await app.request("/sessions/s1")).text()).toContain(
    "echo hi: ok",
  );
});

it("serves the file index of the session's own folder", async () => {
  const { app } = testApp({ files: ["src/main.ts"] });
  const index = await app.request("/sessions/s1/file-index");
  expect(await index.json()).toEqual({
    files: ["src/main.ts"],
    truncated: false,
  });
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
  expect(await res.text()).toBe("This session did not produce that file");
  const wrong = await app.request(
    "/sessions/s1/bash-output?path=%2Fetc%2Fpasswd",
  );
  expect(wrong.status).toBe(403);
  expect(await wrong.text()).toBe("Not a shell output file");
});

it.each(["/repo/two", "/repo/日本"])(
  "tells the browser to re-key its draft once a session exists in %s",
  async (cwd) => {
    const { app } = testApp();
    const form = new FormData();
    form.set("cwd", cwd);
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
    expect(JSON.parse(res.headers.get("HX-Trigger") ?? "null")).toEqual({
      "web-pi:session-created": { cwd, id: "new-1" },
    });
  },
);

it("keeps a built-in's toast beside the new session's trigger", async () => {
  const { app } = testApp();
  const form = new FormData();
  form.set("cwd", "/repo/日本");
  form.set("text", "/name Café “one”");
  const res = await app.request("/sessions", {
    method: "POST",
    body: form,
    headers: { "HX-Request": "true" },
  });
  expect(JSON.parse(res.headers.get("HX-Trigger") ?? "null")).toEqual({
    "web-pi:toast": { level: "info", message: 'Renamed to "Café “one”".' },
    "web-pi:session-created": { cwd: "/repo/日本", id: "new-1" },
  });
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
  const page = renderedHtml(await (await app.request("/sessions/s1")).text());
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
