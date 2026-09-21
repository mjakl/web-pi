import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HTMLDetailsElement, HTMLElement } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";

const browsers: Awaited<ReturnType<typeof htmxBrowser>>[] = [];
const stopRuntimes: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  } finally {
    await Promise.all(stopRuntimes.splice(0).map((stop) => stop()));
  }
});
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing saved-session fixture element");
  return value;
}
function result(
  id: string,
  parentId: string,
  call: string,
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: call,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  };
}
function tool(id: string, parent: string, call: string) {
  const entry = assistantEntry(id, parent, "", 100);
  if (entry.type === "message" && entry.message.role === "assistant") {
    entry.message.content = [
      { type: "thinking", thinking: `Reasoning for ${id}` },
      {
        type: "toolCall",
        id: call,
        name: "read",
        arguments: { path: "README.md" },
      },
    ];
  }
  return entry;
}
function fixture(child: boolean, entries: SessionEntry[]) {
  const id = child ? "subagent.abc123" : "saved-main";
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id,
          cwd: "/repo",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-01T00:00:00.000Z",
          fileSize: 100,
        },
        entries,
      },
    ],
  });
  const open = vi.spyOn(world.runtime, "open");
  const models = vi.spyOn(world.models, "list");
  const workspace = createWorkspace(world);
  if (!child) stopRuntimes.push(() => workspace.stop(id));
  const app = createWebApp({
    workspace,
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
  });
  return {
    id,
    world,
    workspace,
    app,
    open,
    models,
    stored: required(world.store.get(id)),
  };
}

it("propagates the saved content cursor through page metadata and HTTP observation", async () => {
  const f = fixture(false, [
    userEntry("u1", null, "Saved question"),
    tool("a1", "u1", "read-one"),
    result("saved-result", "a1", "read-one", "Saved output"),
    {
      type: "session_info",
      id: "metadata",
      parentId: "saved-result",
      timestamp: "2026-09-01T00:00:00.000Z",
      name: "Saved name",
    },
  ]);
  const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
  expect(markup).toContain('data-saved-leaf="metadata"');
  expect(markup).toContain('data-saved-content-leaf="saved-result"');
  const view = required(await f.workspace.viewSession(f.id));
  const observe = vi
    .spyOn(f.workspace, "observeSavedSession")
    .mockResolvedValue({
      kind: "changed",
      view: {
        ...view,
        savedObservation: {
          revision: "new revision",
          leaf: "next metadata",
          contentLeaf: "next result",
        },
      },
    });
  const query = new URLSearchParams({
    revision: "old revision",
    leaf: "metadata",
    contentLeaf: "saved-result",
    through: "u1",
  });
  const changed = await f.app.request(
    `/sessions/${f.id}/saved?${query.toString()}`,
  );
  expect(observe).toHaveBeenLastCalledWith(f.id, {
    revision: "old revision",
    leaf: "metadata",
    contentLeaf: "saved-result",
    through: "u1",
  });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("X-Web-Pi-Content-Leaf")).toBe("next%20result");
  expect(changed.headers.get("X-Web-Pi-Leaf")).toBe("next%20metadata");
  observe.mockResolvedValue({
    kind: "unavailable",
    revision: "checked revision",
  });
  const unavailable = await f.app.request(
    `/sessions/${f.id}/saved?${query.toString()}`,
  );
  expect(unavailable.status).toBe(204);
  expect(unavailable.headers.get("X-Web-Pi-Revision")).toBe(
    "checked%20revision",
  );
  expect(unavailable.headers.get("X-Web-Pi-Content-Leaf")).toBeNull();
  expect(unavailable.headers.get("X-Web-Pi-Leaf")).toBeNull();
  query.set("contentLeaf", "");
  await f.app.request(`/sessions/${f.id}/saved?${query.toString()}`);
  expect(observe).toHaveBeenLastCalledWith(f.id, {
    revision: "old revision",
    leaf: "metadata",
    contentLeaf: null,
    through: "u1",
  });
  observe.mockClear();
  query.delete("contentLeaf");
  expect(
    (await f.app.request(`/sessions/${f.id}/saved?${query.toString()}`)).status,
  ).toBe(400);
  expect(observe).not.toHaveBeenCalled();
});

it.each([false, true])(
  "refreshes saved content and preserves loaded history and disclosures (child: %s)",
  async (child) => {
    const entries: SessionEntry[] = [
      userEntry("u0", null, "Oldest question"),
      tool("a0", "u0", "old-call"),
      result("r0", "a0", "old-call", "Previously loaded output"),
    ];
    for (let i = 1; i <= 40; i += 1) {
      const parent = required(entries.at(-1)).id;
      const answer = assistantEntry(
        `a${String(i)}`,
        `u${String(i)}`,
        `Answer ${String(i)}`,
        100,
      );
      if (
        i === 1 &&
        answer.type === "message" &&
        answer.message.role === "assistant"
      )
        answer.message.content.unshift({
          type: "thinking",
          thinking: "Later reasoning ".repeat(1500),
        });
      entries.push(
        userEntry(`u${String(i)}`, parent, `Question ${String(i)}`),
        answer,
      );
    }
    entries.push(
      userEntry("latest-user", "a40", "Read another file"),
      tool("pending", "latest-user", "pending-call"),
    );
    const initialIds = entries.map((entry) => entry.id);
    const f = fixture(child, entries);
    const markup = await (await f.app.request(`/sessions/${f.id}`)).text();
    const browser = await htmxBrowser(markup, (request) =>
      f.app.request(request),
    );
    browsers.push(browser);
    const { document, window, requests } = browser;
    const owner = required(document.querySelector("main[data-saved-session]"));
    expect(owner.hasAttribute("hx-sse:connect")).toBe(false);
    f.models.mockClear();
    const sentinel = required(document.querySelector(".load-earlier"));
    await window.eval(
      `htmx.ajax('GET', ${JSON.stringify(required(sentinel.getAttribute("hx-get")))}, {target:'.load-earlier', swap:'outerHTML'})`,
    );
    await expect.poll(() => document.querySelector("#entry-u0")).not.toBeNull();
    const oldest = required(document.querySelector("#entry-u0"));
    expect(
      document.querySelector("#thinking-body-a0-0")?.getAttribute("hx-get"),
    ).toContain("/thinking/0");
    const disclosures = [
      "#process-u0",
      "#thinking-a0-0",
      "#tool-old-call",
      "#process-latest-user",
      "#tool-pending-call",
    ];
    for (const selector of disclosures) {
      const card = required(
        document.querySelector<HTMLDetailsElement>(selector),
      );
      card.open = true;
      card.dispatchEvent(new window.Event("toggle"));
    }
    await expect
      .poll(() => document.querySelector("#tool-old-call")?.textContent)
      .toContain("Previously loaded output");
    await expect
      .poll(() => document.querySelector("#thinking-a0-0")?.textContent)
      .toContain("Reasoning for a0");
    const deferredRequests = () =>
      requests.filter(
        (request) =>
          /\/(thinking|tool-result)\//.test(request.url) &&
          !request.url.includes("pending-call"),
      ).length;
    const loadedRequests = deferredRequests();
    expect(loadedRequests).toBe(2);
    // Paging may enrich the ordinary session; observation itself must not.
    f.models.mockClear();
    const itemCount = document.querySelectorAll(
      "#messages .message-row",
    ).length;
    expect(itemCount).toBeGreaterThan(0);
    f.stored.entries.push(
      result(
        "pending-result",
        "pending",
        "pending-call",
        "Newly completed tool output",
      ),
    );
    await expect
      .poll(() => document.querySelector("#tool-pending-call")?.textContent, {
        timeout: 4000,
      })
      .toContain("Newly completed tool output");
    expect(document.querySelectorAll("#messages .message-row")).toHaveLength(
      itemCount,
    );
    f.stored.entries.push(
      assistantEntry(
        "completed",
        "pending-result",
        "Completed answer [local](http://htmx.test/sessions/other) [external](https://example.com/docs)",
        100,
      ),
    );
    await expect
      .poll(() => document.querySelector("#entry-completed")?.textContent, {
        timeout: 4000,
      })
      .toContain("Completed answer");
    expect(
      document
        .querySelector(
          '#entry-completed a[href="http://htmx.test/sessions/other"]',
        )
        ?.getAttribute("target"),
    ).toBe("_self");
    expect(
      document
        .querySelector('#entry-completed a[href="https://example.com/docs"]')
        ?.getAttribute("target"),
    ).toBe("_blank");
    expect(document.querySelector("#entry-u0")).toBe(oldest);
    for (const selector of disclosures)
      expect(
        required(document.querySelector<HTMLDetailsElement>(selector)).open,
      ).toBe(true);
    expect(document.querySelector("#tool-old-call")?.textContent).toContain(
      "Previously loaded output",
    );
    expect(document.querySelector("#thinking-a0-0")?.textContent).toContain(
      "Reasoning for a0",
    );
    expect(deferredRequests()).toBe(loadedRequests);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.models).not.toHaveBeenCalled();
    expect(
      requests.some(
        (request) =>
          new URL(request.url).pathname === `/sessions/${f.id}/events`,
      ),
    ).toBe(false);
    expect(f.stored.entries.map((entry) => entry.id)).toEqual([
      ...initialIds,
      "pending-result",
      "completed",
    ]);
    if (child) {
      expect(document.querySelector("#composer")).toBeNull();
      expect(document.querySelector("#messages [hx-post]")).toBeNull();
    }
  },
  10000,
);

it("uses fresh streams for repeated ownership and resumes saved observation after each stop", async () => {
  const f = fixture(false, [userEntry("u1", null, "Saved question")]);
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    (request) => f.app.request(request),
  );
  browsers.push(browser);
  browser.window.eval(
    'window.savedTransfers = []; document.addEventListener("web-pi:saved", event => window.savedTransfers.push(JSON.parse(event.detail.data)))',
  );
  const sessionStreams = () =>
    browser.requests.filter(
      (request) => new URL(request.url).pathname === `/sessions/${f.id}/events`,
    );
  expect(sessionStreams()).toHaveLength(0);
  expect(f.open).not.toHaveBeenCalled();
  await f.workspace.activate(f.id);
  await expect.poll(() => sessionStreams().length, { timeout: 4000 }).toBe(1);
  expect(
    new URL(required(sessionStreams()[0]).url).searchParams.get("saved"),
  ).toBe("1");
  const firstStream = required(
    browser.document.querySelector("main [hx-sse\\:connect]"),
  );
  expect(firstStream.hasAttribute("hidden")).toBe(true);
  expect(firstStream.getAttribute("hx-sse:close")).toBe("web-pi:saved");
  await f.workspace.stop(f.id);
  await expect.poll(() => firstStream.isConnected).toBe(false);
  expect(browser.window.eval("window.savedTransfers[0].contentLeaf")).toBe(
    "u1",
  );
  expect(
    browser.document
      .querySelector("main")
      ?.getAttribute("data-saved-content-leaf"),
  ).toBe("u1");
  f.open.mockClear();
  const stored = required(f.world.store.get(f.id));
  stored.entries.push(
    assistantEntry(
      "external-one",
      required(stored.entries.at(-1)).id,
      "External answer one",
      100,
    ),
  );
  await expect
    .poll(
      () => browser.document.querySelector("#entry-external-one")?.textContent,
      { timeout: 4000 },
    )
    .toContain("External answer one");
  expect(f.open).not.toHaveBeenCalled();
  await f.workspace.activate(f.id);
  await expect.poll(() => sessionStreams().length, { timeout: 4000 }).toBe(2);
  const secondStream = required(
    browser.document.querySelector("main [hx-sse\\:connect]"),
  );
  expect(secondStream).not.toBe(firstStream);
  const secondRequest = required(sessionStreams()[1]);
  expect(secondRequest.headers.get("Last-Event-ID")).toBeNull();
  expect(new URL(secondRequest.url).searchParams.get("through")).toBe("u1");
  await f.workspace.stop(f.id);
  await expect.poll(() => secondStream.isConnected).toBe(false);
  expect(browser.window.eval("window.savedTransfers[1].contentLeaf")).toBe(
    "external-one",
  );
  expect(
    browser.document
      .querySelector("main")
      ?.getAttribute("data-saved-content-leaf"),
  ).toBe("external-one");
  f.open.mockClear();
  const saved = required(f.world.store.get(f.id));
  saved.entries.push(
    userEntry(
      "external-two",
      required(saved.entries.at(-1)).id,
      "External question two",
    ),
  );
  await expect
    .poll(
      () => browser.document.querySelector("#entry-external-two")?.textContent,
      { timeout: 4000 },
    )
    .toContain("External question two");
  expect(f.open).not.toHaveBeenCalled();
  expect(sessionStreams()).toHaveLength(2);
}, 10000);

it("resets a saved window absent from the owned branch without losing pending notices", async () => {
  const f = fixture(false, [
    userEntry("old-user", null, "Old branch question"),
    assistantEntry("old-answer", "old-user", "Old branch answer", 100),
    userEntry("active-user", null, "Active branch question"),
    assistantEntry("active-answer", "active-user", "Active branch answer", 100),
  ]);
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}?leaf=old-answer`)).text(),
    (request) => f.app.request(request),
  );
  browsers.push(browser);
  const oldLog = required(browser.document.querySelector("#log"));
  expect(browser.document.querySelector("#entry-old-answer")).not.toBeNull();
  expect(browser.document.querySelector("#entry-active-answer")).toBeNull();
  await f.workspace.activate(f.id);
  await f.workspace.reload(f.id);
  await expect
    .poll(() => browser.document.querySelector("#entry-active-answer"), {
      timeout: 4000,
    })
    .not.toBeNull();
  expect(browser.document.querySelector("#entry-old-answer")).toBeNull();
  expect(browser.document.querySelector("#log")).not.toBe(oldLog);
  await expect
    .poll(() => browser.document.querySelector("#toasts")?.textContent)
    .toContain("Resources reloaded.");
  expect(browser.document.querySelector("#toasts")?.textContent).not.toContain(
    "Live updates failed",
  );
}, 10000);

it("returns to saved observation when ownership ends before the stream connects", async () => {
  const f = fixture(false, [userEntry("u1", null, "Saved question")]);
  let stoppedBeforeConnect = false;
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    async (request) => {
      if (new URL(request.url).pathname === `/sessions/${f.id}/events`) {
        await f.workspace.stop(f.id);
        stoppedBeforeConnect = true;
      }
      return f.app.request(request);
    },
  );
  browsers.push(browser);
  await f.workspace.activate(f.id);
  await expect.poll(() => stoppedBeforeConnect, { timeout: 4000 }).toBe(true);
  await expect
    .poll(() => browser.document.querySelector("main [hx-sse\\:connect]"))
    .toBeNull();
  f.open.mockClear();
  const stored = required(f.world.store.get(f.id));
  stored.entries.push(
    assistantEntry(
      "external-race",
      required(stored.entries.at(-1)).id,
      "External answer after race",
      100,
    ),
  );
  await expect
    .poll(
      () => browser.document.querySelector("#entry-external-race")?.textContent,
      { timeout: 4000 },
    )
    .toContain("External answer after race");
  expect(f.open).not.toHaveBeenCalled();
}, 10000);

it("observes an empty saved session and keeps its last good content when the file disappears", async () => {
  const f = fixture(false, []);
  let unavailable = false;
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    async (request) => {
      const response = await f.app.request(request);
      if (response.headers.get("X-Web-Pi-Saved") === "unavailable") {
        expect(response.status).toBe(204);
        unavailable = true;
      }
      return response;
    },
  );
  browsers.push(browser);
  const { document } = browser;
  expect(
    document.querySelector("main")?.getAttribute("data-saved-content-leaf"),
  ).toBe("");
  f.models.mockClear();
  f.stored.entries.push(userEntry("first", null, "First saved message"));
  await expect
    .poll(() => document.querySelector("#entry-first")?.textContent, {
      timeout: 4000,
    })
    .toContain("First saved message");
  const owner = required(
    document.querySelector<HTMLElement>("main[data-saved-session]"),
  );
  expect(owner.dataset["savedContentLeaf"]).toBe("first");
  f.world.store.delete(f.id);
  const response = await f.app.request(
    `/sessions/${f.id}/saved?${new URLSearchParams({ revision: owner.dataset["savedRevision"] ?? "", contentLeaf: owner.dataset["savedContentLeaf"] ?? "" }).toString()}`,
  );
  expect(response.status).toBe(204);
  expect(response.headers.get("X-Web-Pi-Saved")).toBe("unavailable");
  await expect.poll(() => unavailable, { timeout: 4000 }).toBe(true);
  expect(document.querySelector("#entry-first")?.textContent).toContain(
    "First saved message",
  );
  expect(f.open).not.toHaveBeenCalled();
  expect(f.models).not.toHaveBeenCalled();
}, 10000);
