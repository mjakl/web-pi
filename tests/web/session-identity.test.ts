import { assistantEntry, createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebApp } from "@web/app";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createHarness,
  type Harness,
  MODEL_ID,
  PROVIDER,
} from "#/adapters/pi-harness";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

async function fixture() {
  const manager = SessionManager.create(
    h.cwd,
    join(h.agentDir, "sessions", "old"),
  );
  const image = Buffer.from("saved image bytes");
  manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Saved question" },
      { type: "image", mimeType: "image/png", data: image.toString("base64") },
    ],
    timestamp: 1,
  });
  const answer = assistantEntry("ignored", null, "Saved answer", 100);
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Missing fixture answer");
  manager.appendMessage({
    ...answer.message,
    provider: PROVIDER,
    model: MODEL_ID,
    content: [
      { type: "thinking", thinking: "Saved reasoning" },
      {
        type: "toolCall",
        id: "call-read",
        name: "read",
        arguments: { path: "saved.txt" },
      },
      { type: "text", text: "Saved answer" },
    ],
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read",
    content: [{ type: "text", text: "Saved tool output" }],
    isError: false,
    timestamp: 2,
  });
  manager.appendMessage({
    role: "user",
    content: "Later question",
    timestamp: 3,
  });
  manager.appendMessage({
    ...answer.message,
    provider: PROVIDER,
    model: MODEL_ID,
    content: [{ type: "text", text: "Latest answer" }],
  });
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing fixture file");
  const entries = manager.getEntries().map((entry) => {
    const value = { ...entry } as Record<string, unknown>;
    delete value["id"];
    delete value["parentId"];
    return value;
  });
  writeFileSync(
    file,
    `${[{ ...manager.getHeader(), version: 1 }, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const workspace = createWorkspace({
    ...createFakeWorld(),
    sessions: h.catalog,
    runtime: h.runtime,
  });
  const app = createWebApp({
    workspace,
    staticRoot: h.root,
    defaultCwd: h.cwd,
  });
  const id = manager.getSessionId();
  const saved = await h.catalog.read(id);
  const [question, thinking, result, later, latest] = saved?.entries ?? [];
  if (!question || !thinking || !result || !later || !latest)
    throw new Error("Missing v1 snapshot entries");
  const state = () => ({
    bytes: readFileSync(file),
    mtime: statSync(file, { bigint: true }).mtimeNs,
  });
  const before = state();
  const page = await app.request(`/sessions/${id}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(thinking.id);
  expect(state()).toEqual(before);
  return {
    app,
    workspace,
    id,
    question,
    thinking,
    result,
    later,
    latest,
    image,
    state,
  };
}

function star(entryId: string, starred: boolean) {
  return new URLSearchParams({ entryId, starred: String(starred) });
}

it("branches from an ordinary v1 page through the workspace when opening its writer migrates entry IDs", async () => {
  const f = await fixture();
  expect(h.runtime.get(f.id)).toBeUndefined();
  const response = await f.app.request(`/sessions/${f.id}/navigate`, {
    method: "POST",
    body: new URLSearchParams({ entryId: f.later.id }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("HX-Trigger")).toBeNull();
  const html = await response.text();
  expect(html).not.toContain("not found");
  expect(html).toMatch(/<textarea[^>]*>Later question<\/textarea>/);
  const live = h.runtime.get(f.id);
  expect(live?.snapshot().branch).toHaveLength(3);
  expect(
    live?.snapshot().entries.filter((entry) => entry.type === "message"),
  ).toHaveLength(5);
  expect(
    (await f.workspace.viewSession(f.id, { leaf: f.result.id }))?.otherBranch,
  ).toBe(false);
  expect(h.calls).toHaveLength(0);
});

it.each([false, true])(
  "returns canonical Star markup after v1 migration (runtime active: %s)",
  async (active) => {
    const f = await fixture();
    if (active) await f.workspace.activate(f.id);
    const response = await f.app.request(`/sessions/${f.id}/star`, {
      method: "POST",
      body: star(f.thinking.id, true),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Unstar answer"');
    const canonical = (await h.catalog.read(f.id))?.entries[1]?.id;
    expect(canonical).toBeTruthy();
    expect(canonical).not.toBe(f.thinking.id);
    expect(html).toContain(
      `&quot;entryId&quot;:&quot;${canonical ?? ""}&quot;`,
    );
    expect(html).not.toContain(f.thinking.id);
    // Another mounted page can still submit the old ID after the first toggle.
    const cleared = await f.app.request(`/sessions/${f.id}/star`, {
      method: "POST",
      body: star(f.thinking.id, false),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.text()).toContain('aria-pressed="false"');
    expect(h.calls).toHaveLength(0);
  },
);

it.each([false, true])(
  "keeps saved v1 leaf, cursor and deferred-content links readable after migration (runtime active: %s)",
  async (active) => {
    const f = await fixture();
    if (active) await f.workspace.activate(f.id);
    else await f.workspace.rename(f.id, "Migrated title");
    const before = f.state();
    const writer = vi.spyOn(SessionManager, "open");
    const base = `/sessions/${f.id}`;
    const reads = [
      [`${base}?leaf=${f.thinking.id}`, "Saved answer"],
      [
        `${base}/earlier?before=${f.later.id}&leaf=${f.latest.id}`,
        "Saved answer",
      ],
      [`${base}/entries/${f.thinking.id}/thinking/0`, "Saved reasoning"],
      [
        `${base}/entries/${f.thinking.id}/tool-result/call-read`,
        "Saved tool output",
      ],
      [
        `${base}/entries/${f.result.id}/tool-result/call-read`,
        "Saved tool output",
      ],
    ] as const;
    for (const [url, text] of reads) {
      const response = await f.app.request(url);
      expect(response.status, url).toBe(200);
      const html = await response.text();
      expect(html, url).toContain(text);
      if (url.includes("?leaf=")) expect(html).not.toContain("Latest answer");
    }
    const image = await f.app.request(
      `${base}/entries/${f.question.id}/image/0`,
    );
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(f.image);
    const latest = await f.workspace.viewSession(f.id, { leaf: f.latest.id });
    // Rename appends session_info; resume appends the missing thinking setting.
    // The last saved answer is now before the writer's metadata tip.
    expect(latest?.otherBranch).toBe(true);
    expect(latest?.leaf).toBe((await h.catalog.read(f.id))?.entries[4]?.id);
    expect(latest?.leaf).not.toBe(f.latest.id);
    const through = await f.workspace.viewSession(f.id, {
      tail: 1,
      through: f.question.id,
    });
    expect(
      through?.items.some(
        (item) => item.kind === "user" && item.text === "Saved question",
      ),
    ).toBe(true);
    const after = await f.workspace.viewSession(f.id, { after: f.result.id });
    // A settlement cursor also identifies mounted DOM. Do not normalize it:
    // migration must replace the old transcript with canonical element IDs.
    expect(after?.resetTranscript).toBe(true);
    expect(
      after?.items
        .filter((item) => item.kind === "user")
        .map((item) => item.text),
    ).toEqual(["Saved question", "Later question"]);
    expect(writer).not.toHaveBeenCalled();
    expect(f.state()).toEqual(before);
    expect(h.calls).toHaveLength(0);
  },
);
