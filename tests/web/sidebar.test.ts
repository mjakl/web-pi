// The sidebar's routes: the session list and its rows, their actions, the
// lifecycle stream, and the folder choices.

import { assistantEntry, userEntry } from "@adapters/fake/index";
import { describe, expect, it, vi } from "vitest";
import { testApp } from "#/web/fixtures/test-app";

it("lists stored sessions with their working folders", async () => {
  const { app } = testApp();
  const res = await app.request("/");
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(html).toContain("repo/one");
  expect(html).toContain('href="/sessions/s1"');
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
    expect(body).toContain(
      '<span class="session-title-text">empty-sessio</span>',
    );
    expect(body).toContain("0 msgs");
    expect(body).not.toContain('aria-label="Loading..."');
  }
});

it("deletes a session and sends the open page home", async () => {
  const { app, world } = testApp();
  const res = await app.request("/sessions/s1/delete", {
    method: "POST",
    headers: { "X-Web-Pi-Session": "s1" },
  });
  expect(res.headers.get("hx-redirect")).toBe("/new");
  expect(world.store.has("s1")).toBe(false);
});

it("reports a folder it cannot use with its name intact", async () => {
  const { app } = testApp();
  const body = new FormData();
  body.set("cwd", "/missing/日本 🦉");
  const res = await app.request("/workspaces/validate", {
    method: "POST",
    body,
    headers: { "HX-Request": "true" },
  });
  expect(res.status).toBe(200);
  expect(JSON.parse(res.headers.get("HX-Trigger") ?? "null")).toEqual({
    "web-pi:toast": {
      level: "error",
      message: "Folder not found: /missing/日本 🦉",
    },
  });
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
  // Pi writes a new session's file with its first user or assistant
  // message, so a session opened with a command such as /name exists in
  // the runtime alone.
  const { app, world } = testApp();
  const res = await app.request("/events?project=%2Frepo%2Fone");
  const reader = res.body?.getReader();
  if (!reader) throw new Error("no body");
  const form = new FormData();
  form.set("cwd", "/repo/one");
  form.set("text", "/name Draft");
  const started = await app.request("/sessions", {
    method: "POST",
    body: form,
    headers: { "HX-Request": "true" },
  });
  expect(JSON.parse(started.headers.get("HX-Location") ?? "{}")).toMatchObject({
    path: "/sessions/new-1",
    target: "#session-region",
  });
  expect(world.store.has("new-1")).toBe(false);

  let received = "";
  const decoder = new TextDecoder();
  while (!received.includes('id="row-new-1"')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value);
  }
  await reader.cancel();
  // Creation pushes a complete list, including the unflushed runtime row.
  const list = received;
  expect(list).toContain(
    '<hx-partial hx-target="#session-list" hx-swap="innerHTML">',
  );
  expect(list).toContain('id="row-new-1"');
  const hydrated = await (await app.request("/sessions/new-1/row")).text();
  expect(hydrated).toContain('data-status="Session active"');
  expect(list).toContain("Stored one");
  expect(list).toContain("2 msgs");
  expect(list).not.toContain('hx-trigger="intersect once"');
  expect(list).not.toContain('hx-get="/sessions/new-1/row"');
  expect(list).not.toContain('aria-label="Loading..."');
  // The page the browser is sent to shows the same row selected.
  const page = await (await app.request("/sessions/new-1")).text();
  const row = page.slice(page.indexOf('id="row-new-1"'));
  expect(row).toContain("session-row is-selected");
  expect(row).toContain('data-status="Session active"');
  expect(world.store.has("new-1")).toBe(false);
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
  return testApp(
    {
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
    },
    { defaultCwd: "/repo/one", home: "/repo" },
  );
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
        headers: { "X-Web-Pi-Session": "s2" },
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
    // The project with two folders opens in place; the others select
    // directly. The one the page shows starts open.
    const group = menu.slice(menu.indexOf('data-project-key="/repo/one"'));
    expect(group).toMatch(
      /^data-project-key="\/repo\/one"><details open=""><summary class="menu-item project-folder-row">/,
    );
    expect(group).toContain(">~/one.wt<");
    // Exactly one row carries the tick, on the folder the sidebar is showing.
    expect([...menu.matchAll(/aria-current="true"/g)]).toHaveLength(1);
    expect(menu).toContain("/new?cwd=%2Frepo%2Fone");
    expect(menu).toContain("Custom path…");
  });

  it("spells out the home folder itself in the workspace menu", async () => {
    // pi-web abbreviates a project path only *below* home, so a session
    // started in the home directory reads "/repo", not "~".
    const { app } = testApp(
      {
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
      },
      { home: "/repo" },
    );
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

  it("redirects bookmarked folder-selection URLs to the new-session composer", async () => {
    const { app } = sidebarApp();
    const res = await app.request(
      "/sidebar?project=%2Frepo%2Fone&cwd=%2Frepo%2Fone.wt",
    );
    expect(res.headers.get("location")).toBe("/new?cwd=%2Frepo%2Fone.wt");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the folder a page shows, as its requests report it", () => {
  const folders = ["/repo/日本", "/repo/zürich", "/repo/100%", "/repo/other"];
  function folderApp() {
    return testApp(
      {
        sessions: folders.map((cwd, index) => ({
          summary: {
            id: `f${String(index)}`,
            cwd,
            name: cwd,
            createdAt: "2026-09-01T00:00:00.000Z",
            modifiedAt: "2026-09-02T00:00:00.000Z",
            fileSize: 1,
            projectRoot: cwd,
          },
          entries: [userEntry(`u${String(index)}`, null, "question")],
        })),
      },
      { defaultCwd: "/repo/other" },
    ).app;
  }

  it.each([
    ["encoded, beyond Latin-1", encodeURIComponent("/repo/日本"), "/repo/日本"],
    ["raw from an older tab", "/repo/zürich", "/repo/zürich"],
    ["raw and not decodable", "/repo/100%", "/repo/100%"],
  ])("reads the folder %s", async (_, header, folder) => {
    const menu = await (
      await folderApp().request("/sidebar/projects", {
        headers: { "X-Web-Pi-Cwd": header },
      })
    ).text();
    expect(/aria-current="true"[^>]*title="([^"]*)"/.exec(menu)?.[1]).toBe(
      folder,
    );
  });

  it("keeps the explorer when a session opens in the folder on screen", async () => {
    const app = folderApp();
    const fragment = async (cwd: string) =>
      (
        await app.request("/sessions/f0", {
          headers: {
            "HX-Request": "true",
            "HX-Target": "div#session-region",
            "X-Web-Pi-Cwd": encodeURIComponent(cwd),
          },
        })
      ).text();
    expect(await fragment("/repo/日本")).not.toContain('id="explorer-section"');
    expect(await fragment("/repo/other")).toContain('id="explorer-section"');
  });
});
