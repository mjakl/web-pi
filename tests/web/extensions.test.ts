import { createFakeWorld, userEntry } from "@adapters/fake/index";
import type { DialogSpec, FrameComponent } from "@core/extension-ui";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ARROW_UP = "\u001B[A";

/** A counter, the smallest component that proves input reaches a frame. */
function counter(): FrameComponent {
  let count = 0;
  return {
    render: () => [`count ${String(count)}`],
    handleInput(data: string) {
      if (data === ARROW_UP) count += 1;
    },
  };
}

function testApp(
  script: (prompt: string) => {
    dialog?: DialogSpec;
    custom?: FrameComponent;
    text?: string;
    title?: string;
    insert?: string;
  }[],
) {
  const world = createFakeWorld({
    delayMs: 1,
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
        entries: [userEntry("u1", null, "hello")],
      },
    ],
    script: script as never,
  });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
    renderIntervalMs: 1,
  });
  return { app, workspace, world };
}

async function send(app: ReturnType<typeof testApp>["app"], text: string) {
  const body = new FormData();
  body.append("text", text);
  await app.request("/sessions/s1/prompt", { method: "POST", body });
}

/** Keystrokes reach the server the way the client bundle sends them. */
function input(
  app: ReturnType<typeof testApp>["app"],
  requestId: string,
  data: string,
  sessionId = "s1",
) {
  return app.request(`/sessions/${sessionId}/ui/${requestId}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data }).toString(),
  });
}

/** The scripted turn runs on timers; give it a tick to reach the dialog. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function status(world: ReturnType<typeof testApp>["world"]) {
  const live = world.runtime.get("s1");
  expect(live).toBeDefined();
  return live?.snapshot().status;
}

describe("extension dialogs", () => {
  it("shows the pending dialog on the session page and answers it", async () => {
    const { app, world } = testApp(() => [
      { dialog: { method: "select", title: "Pick one", options: ["a", "b"] } },
    ]);
    await send(app, "go");
    await settle();

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("Pick one");
    expect(page).toContain('value="a"');
    const dialog = status(world)?.dialog;
    expect(dialog?.method).toBe("select");

    const body = new FormData();
    body.append("value", "b");
    const answered = await app.request(`/sessions/s1/ui/${dialog?.id ?? ""}`, {
      method: "POST",
      body,
    });
    expect(answered.status).toBe(200);
    await settle();
    expect(status(world)?.dialog).toBeNull();
  });

  it("treats a second answer for the same dialog as already closed", async () => {
    const { app, world } = testApp(() => [
      { dialog: { method: "input", title: "Name it" } },
    ]);
    await send(app, "go");
    await settle();
    const id = status(world)?.dialog?.id ?? "";

    const answer = () => {
      const body = new FormData();
      body.append("value", "x");
      return app.request(`/sessions/s1/ui/${id}`, { method: "POST", body });
    };
    await answer();
    const second = await answer();
    expect(second.headers.get("HX-Trigger")).toContain("already closed");
  });

  it("reads a cancel as no answer at all", async () => {
    const { app, world } = testApp(() => [
      { dialog: { method: "confirm", title: "Push?", message: "Sure?" } },
    ]);
    await send(app, "go");
    await settle();
    const id = status(world)?.dialog?.id ?? "";
    const body = new FormData();
    body.append("cancelled", "1");
    await app.request(`/sessions/s1/ui/${id}`, { method: "POST", body });
    await settle();
    expect(status(world)?.dialog).toBeNull();
  });

  it("hands an editor's answer to the extension exactly as typed", async () => {
    const { app, world } = testApp(() => [
      { dialog: { method: "editor", title: "Message" } },
    ]);
    await send(app, "go");
    await settle();
    const id = status(world)?.dialog?.id ?? "";
    const body = new FormData();
    // Leading spaces and the trailing newline are content in an editor, and
    // a select option with spaces has to match what the extension offered.
    body.append("value", "  keep\n  the newline\n");
    await app.request(`/sessions/s1/ui/${id}`, { method: "POST", body });
    await settle();
    // (multipart normalises the line endings themselves; nothing is trimmed)
    const answered = status(world)?.notices[0]?.message ?? "";
    expect(answered).toContain('{"value":"  keep');
    expect(answered.endsWith('the newline\\r\\n"}')).toBe(true);
  });

  it("renders the editor dialog with its prefill", async () => {
    const { app } = testApp(() => [
      { dialog: { method: "editor", title: "Message", prefill: "Fix it" } },
    ]);
    await send(app, "go");
    await settle();
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("<textarea");
    expect(page).toContain("Fix it");
  });

  it.each([
    ["input", "Submit"],
    ["editor", "Submit"],
    ["confirm", "Confirm"],
    ["select", "Local preview"],
  ] as const)(
    "puts the %s answer before cancel, so Enter answers",
    async (method, label) => {
      const { app } = testApp(() => [
        { dialog: { method, title: "Name it", options: ["Local preview"] } },
      ]);
      await send(app, "go");
      await settle();
      const page = await (await app.request("/sessions/s1")).text();
      const form = /<form[^>]*\/ui\/[\S\s]*?<\/form>/.exec(page)?.[0] ?? "";
      expect(form).not.toBe("");
      // Implicit submission picks the first submit button in the document.
      const buttons = [...form.matchAll(/<button\b([^>]*)>([^<]+)<\/button>/g)];
      expect(buttons.map((button) => button[2])).toEqual([label, "Cancel"]);
      expect(buttons[0]?.[1]).toContain('type="submit"');
      expect(buttons[0]?.[1]).not.toContain('name="cancelled"');
      expect(buttons[1]?.[1]).toContain('name="cancelled"');
      expect(buttons[1]?.[1]).toContain('value="1"');
    },
  );

  it("forwards keystrokes to the custom UI and redraws the frame", async () => {
    const { app, world } = testApp(() => [{ custom: counter() }]);
    await send(app, "go");
    await settle();

    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain("count 0");
    const id = status(world)?.custom?.id ?? "";
    expect(id).not.toBe("");

    expect((await input(app, id, ARROW_UP)).status).toBe(204);
    expect(status(world)?.custom?.lines).toEqual(["count 1"]);

    // A bare carriage return is what Enter sends; it has to survive the body.
    await input(app, id, "\r");
    expect(status(world)?.custom).toBeNull();
  });

  it("refuses input for an unknown session", async () => {
    const { app } = testApp(() => []);
    const posted = await input(app, "c1", "x", "not a session");
    expect(posted.status).toBe(404);
  });

  it("cancels every waiting dialog when the session is stopped", async () => {
    const { app, world } = testApp(() => [
      { dialog: { method: "input", title: "Name it" } },
    ]);
    await send(app, "go");
    await settle();
    expect(status(world)?.dialog).not.toBeNull();
    await app.request("/sessions/s1/stop", { method: "POST" });
    expect(world.runtime.get("s1")).toBeUndefined();
  });
});

describe("extension page bridge", () => {
  it("shows a title an extension set, for the browser tab", async () => {
    const { app } = testApp(() => [{ title: "Reviewing" }, { text: "done" }]);
    await send(app, "go");
    await settle();
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain('id="extension-title"');
    expect(page).toContain("Reviewing");
  });

  it("leaves composer text pending until a delivery view claims it", async () => {
    const { app, workspace, world } = testApp(() => [
      { insert: "git log --oneline" },
      { text: "done" },
    ]);
    const live = await world.runtime.open({ sessionId: "s1" });
    await live.prompt("go");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A sidebar row reads the same session and must not swallow it.
    await workspace.row("s1");
    expect(live.snapshot().status.editorText).toEqual(["git log --oneline"]);
    const view = await workspace.viewSession("s1");
    expect(view?.status?.editorText).toEqual(["git log --oneline"]);
    expect(live.snapshot().status.editorText).toEqual(["git log --oneline"]);
    await app.request("/sessions/s1");
    expect(live.snapshot().status.editorText).toEqual(["git log --oneline"]);
    const delivery = await workspace.viewSession("s1", {
      consumePending: true,
    });
    expect(delivery?.status?.editorText).toEqual(["git log --oneline"]);
    expect(live.snapshot().status.editorText).toEqual([]);
  });
});

describe("installable app", () => {
  it("serves a manifest naming the icons", async () => {
    const { app } = testApp(() => []);
    const response = await app.request("/manifest.webmanifest");
    expect(response.headers.get("Content-Type")).toContain(
      "application/manifest+json",
    );
    const manifest = (await response.json()) as {
      start_url: string;
      icons: { src: string }[];
    };
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.map((icon) => icon.src)).toContain(
      "/static/icons/icon-192.png",
    );
  });

  it("serves a root-scoped uncached worker that leaves event streams to the network", async () => {
    const { app } = testApp(() => []);
    const response = await app.request("/sw.js");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Service-Worker-Allowed")).toBe("/");
    const handlers = new Map<string, (event: unknown) => void>();
    const fetch = vi.fn(() => Promise.resolve(new Response("network")));
    runInNewContext(await response.text(), {
      URL,
      fetch,
      self: {
        location: new URL("https://web.example/sw.js"),
        addEventListener: (name: string, handler: (event: unknown) => void) =>
          handlers.set(name, handler),
      },
    });
    const onFetch = handlers.get("fetch");
    expect(onFetch).toBeDefined();
    for (const path of ["/events", "/sessions/s1/events"]) {
      const respondWith = vi.fn();
      onFetch?.({
        request: {
          url: `https://web.example${path}`,
          method: "GET",
          mode: "navigate",
          headers: new Headers(),
        },
        respondWith,
      });
      expect(respondWith, path).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
    // A normal navigation exercises the same registered handler and uses the network.
    const respondWith = vi.fn();
    onFetch?.({
      request: {
        url: "https://web.example/sessions/s1",
        method: "GET",
        mode: "navigate",
        headers: new Headers(),
      },
      respondWith,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(respondWith).toHaveBeenCalledOnce();
    const network = await (respondWith.mock.calls[0]?.[0] as Promise<Response>);
    expect(await network.text()).toBe("network");
  });

  it("serves an offline page the worker can precache", async () => {
    const { app } = testApp(() => []);
    const html = await (await app.request("/offline.html")).text();
    expect(html).toContain("web-pi is offline");
  });

  it("links the manifest from every page", async () => {
    const { app } = testApp(() => []);
    const html = await (await app.request("/sessions/s1")).text();
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('data-sw-src="/sw.js?v=');
  });
});

describe("web push routes", () => {
  it("hands out the public key", async () => {
    const { app } = testApp(() => []);
    const body = (await (await app.request("/push/config")).json()) as {
      publicKey: string;
    };
    expect(Buffer.from(body.publicKey, "base64url")).toHaveLength(65);
  });

  it("stores a valid subscription", async () => {
    const { app, world } = testApp(() => []);
    const response = await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://push.example/one",
          keys: { p256dh: "p", auth: "a" },
          expirationTime: null,
        },
        publicKey: world.push.publicKey(),
      }),
    });
    expect(response.status).toBe(200);
    // Only what the server needs is kept; the rest of the browser's JSON is not.
    await world.push.send({
      title: "t",
      body: "b",
      url: "/",
      tag: "tag",
    });
    expect(world.push.sent).toHaveLength(1);
  });

  it("checks enrollment and deletes only a matching record, not other browsers or keys", async () => {
    const { app, world } = testApp(() => []);
    const one = {
      endpoint: "https://push.example/one",
      keys: { p256dh: "p", auth: "a" },
    };
    const two = { ...one, endpoint: "https://push.example/two" };
    const request = (
      action: string,
      subscription: unknown,
      publicKey = world.push.publicKey(),
    ) =>
      app.request(`/push/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription, publicKey }),
      });
    expect(await (await request("status", one)).json()).toEqual({
      subscribed: false,
    });
    expect((await request("subscribe", one, "stale-key")).status).toBe(409);
    await request("subscribe", one);
    await request("subscribe", two);
    expect(await (await request("status", one)).json()).toEqual({
      subscribed: true,
    });
    await request("unsubscribe", {
      ...one,
      keys: { p256dh: "wrong", auth: "wrong" },
    });
    expect(world.push.has(one)).toBe(true);
    await request("unsubscribe", one);
    expect(world.push.has(one)).toBe(false);
    expect(world.push.has(two)).toBe(true);
    expect(
      (await (await app.request("/push/config")).json()) as unknown,
    ).toEqual({ publicKey: world.push.publicKey() });
  });

  it("refuses a subscription without https or keys", async () => {
    const { app } = testApp(() => []);
    const bad = async (subscription: unknown) =>
      (
        await app.request("/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription }),
        })
      ).status;
    expect(await bad({ endpoint: "http://push.example", keys: {} })).toBe(400);
    expect(
      await bad({ endpoint: "https://push.example", keys: { p256dh: "p" } }),
    ).toBe(400);
    expect(await bad(undefined)).toBe(400);
  });

  it("pushes when a run finishes, and not when nobody subscribed", async () => {
    const { app, world } = testApp(() => [{ text: "done" }]);
    await send(app, "go");
    await settle();
    expect(world.push.sent).toEqual([]);

    await app.request("/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://push.example/one",
          keys: { p256dh: "p", auth: "a" },
        },
        publicKey: world.push.publicKey(),
      }),
    });
    await send(app, "again");
    await settle();
    expect(world.push.sent.at(-1)).toMatchObject({
      title: "Stored one",
      body: "Task finished.",
      url: "/sessions/s1",
    });
  });
});
