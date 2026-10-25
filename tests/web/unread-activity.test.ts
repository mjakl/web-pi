import { required } from "#/web/helpers";
import type { HTMLElement } from "happy-dom";
import { expect, it, vi } from "vitest";
import { controlledStream, htmxBrowser } from "#/web/htmx4-browser";
import { storedSession, testApp } from "#/web/fixtures/test-app";

it("reading in one browser clears another browser's halo, but later unseen work marks it again", async () => {
  const { app, workspace } = testApp({
    sessions: [storedSession({}, [])],
    reply: () => "done",
  });
  const markup = await (await app.request("/new")).text();
  const a = await htmxBrowser(markup, (request) => app.request(request));
  const b = await htmxBrowser(markup, (request) => app.request(request));
  for (const browser of [a, b])
    await expect
      .poll(() =>
        browser.requests.some((r) => new URL(r.url).pathname === "/events"),
      )
      .toBe(true);
  const unread = () =>
    b.document
      .querySelector("#row-s1 .session-indicator")
      ?.classList.contains("session-indicator-unread");
  await workspace.send("s1", "first");
  await expect.poll(unread).toBe(true);
  a.document.querySelector<HTMLElement>("#row-s1 a")?.click();
  await expect
    .poll(() =>
      a.requests.some((r) => new URL(r.url).pathname === "/sessions/s1/read"),
    )
    .toBe(true);
  await expect.poll(unread).toBe(false);
  // Leave the session in both browsers before the next completion.
  a.window.eval(
    "void htmx.ajax('GET', '/new', {source:'#session-region', target:'#session-region', swap:'outerHTML'})",
  );
  await expect
    .poll(() =>
      a.document.querySelector("main")?.getAttribute("data-session-id"),
    )
    .toBeNull();
  await workspace.send("s1", "new unseen work");
  await expect.poll(unread).toBe(true);
  a.document.querySelector<HTMLElement>("#row-s1 a")?.click();
  await expect
    .poll(
      () =>
        a.requests.filter(
          (r) => new URL(r.url).pathname === "/sessions/s1/read",
        ).length,
    )
    .toBe(2);
  await expect.poll(unread).toBe(false);
  // A completion delivered to the still-open transcript is read too; its
  // receipt must arrive through the session stream, not the global snapshot.
  await workspace.send("s1", "work while reading");
  await expect
    .poll(
      () =>
        a.requests.filter(
          (r) => new URL(r.url).pathname === "/sessions/s1/read",
        ).length,
    )
    .toBe(3);
  await expect.poll(() => workspace.unreadActivity()).toEqual({});
  await expect.poll(unread).toBe(false);
  await workspace.stop("s1");
  expect(workspace.unreadActivity()).toEqual({});
});

it("acknowledges readable activity even when the session's folder has disappeared", async () => {
  const { app, world, workspace } = testApp({
    sessions: [storedSession({}, [])],
  });
  await workspace.send("s1", "done");
  await expect.poll(() => workspace.unreadActivity()["s1"]).toBeTruthy();
  const available = vi
    .spyOn(world.projects, "available")
    .mockResolvedValue(false);
  try {
    const b = await htmxBrowser(
      await (await app.request("/sessions/s1")).text(),
      (request) => app.request(request),
    );
    expect(b.document.querySelector("#composer")).toBeNull();
    await expect.poll(() => workspace.unreadActivity()).toEqual({});
  } finally {
    available.mockRestore();
  }
});

it("returns an error instead of claiming a failed durable read acknowledgment succeeded", async () => {
  const { app, world, workspace } = testApp({
    sessions: [storedSession({}, [])],
  });
  await workspace.send("s1", "done");
  await expect.poll(() => workspace.unreadActivity()["s1"]).toBeTruthy();
  const version = required(workspace.unreadActivity()["s1"]);
  const save = vi.spyOn(world.activity, "save").mockImplementation(() => {
    throw new Error("disk full");
  });
  try {
    const response = await app.request("/sessions/s1/read", {
      method: "POST",
      body: new URLSearchParams({ version }),
    });
    expect(response.status).toBe(500);
    expect(workspace.unreadActivity()).toEqual({ s1: version });
  } finally {
    save.mockRestore();
  }
});

it("reconciles an offline browser on SSE reconnect and a fresh reload", async () => {
  const { app, workspace } = testApp({ sessions: [storedSession({}, [])] });
  await workspace.send("s1", "finish while away");
  await expect.poll(() => workspace.unreadActivity()["s1"]).toBeTruthy();
  const version = required(workspace.unreadActivity()["s1"]);
  const disconnected = controlledStream();
  let connections = 0;
  const markup = await (await app.request("/new")).text();
  const b = await htmxBrowser(
    markup,
    (request) => {
      if (new URL(request.url).pathname === "/events" && ++connections === 1)
        return disconnected.response;
      return app.request(request);
    },
    { instantReconnect: true },
  );
  disconnected.send(JSON.stringify({ s1: version }), "unread");
  const unread = () =>
    b.document
      .querySelector("#row-s1 .session-indicator")
      ?.classList.contains("session-indicator-unread");
  await expect.poll(unread).toBe(true);
  const acknowledged = await app.request("/sessions/s1/read", {
    method: "POST",
    body: new URLSearchParams({ version }),
  });
  expect(acknowledged.status).toBe(204);
  expect(unread()).toBe(true);
  disconnected.end();
  await expect.poll(() => connections).toBe(2);
  await expect.poll(unread).toBe(false);
  const reloaded = await htmxBrowser(
    markup,
    (request) => app.request(request),
    {
      afterMarkup: (window) => {
        window.localStorage.setItem(
          "web-pi:unread",
          JSON.stringify({ s1: "legacy" }),
        );
      },
    },
  );
  await expect
    .poll(() =>
      reloaded.requests.some((r) => new URL(r.url).pathname === "/events"),
    )
    .toBe(true);
  expect(
    reloaded.document
      .querySelector("#row-s1 .session-indicator")
      ?.classList.contains("session-indicator-unread"),
  ).toBe(false);
  expect(reloaded.window.localStorage.getItem("web-pi:unread")).toBeNull();
});
