import { assistantEntry, createFakeWorld } from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { createWorkspace } from "@core/workspace";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebApp } from "@web/app";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A stopped session's images, thinking blocks and transcript references,
// served from the real catalog: one parse of the file between them, and a
// fresh one as soon as the file changes.

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-pi-session-reads-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function answer(thinking: string) {
  const entry = assistantEntry("ignored", null, "", 100);
  if (entry.type !== "message" || entry.message.role !== "assistant")
    throw new Error("Expected an answer");
  return {
    ...entry.message,
    content: [
      { type: "thinking" as const, thinking },
      { type: "text" as const, text: "answer" },
    ],
  };
}

function fixture() {
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const outside = join(root, "elsewhere", "notes.txt");
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(outside, "named in the transcript\n");
  const manager = SessionManager.create(cwd, join(root, "sessions", "demo"));
  const question = manager.appendMessage({
    role: "user",
    content: [
      { type: "text", text: `Look at ${outside}` },
      { type: "image", mimeType: "image/png", data: "AAEC" },
      { type: "image", mimeType: "image/png", data: "AwQF" },
    ],
    timestamp: 1,
  });
  const first = manager.appendMessage(answer("first reasoning"));
  const world = createFakeWorld();
  world.sessions = createPiSessionCatalog({ agentDir: root });
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: cwd,
  });
  const parses = vi.spyOn(SessionManager, "inMemory");
  const base = `/sessions/${manager.getSessionId()}`;
  return { app, manager, parses, base, question, first, outside };
}

it("parses a stopped session once for a page's images and thinking", async () => {
  const { app, parses, base, question, first } = fixture();
  const urls = [
    `${base}/entries/${question}/image/0`,
    `${base}/entries/${question}/image/1`,
    `${base}/entries/${first}/thinking/0`,
  ];
  const responses = await Promise.all(
    urls.map(async (url) => app.request(url)),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(
    Buffer.from(await required(responses[1]).arrayBuffer()).toString("base64"),
  ).toBe("AwQF");
  expect(await required(responses[2]).text()).toContain("first reasoning");
  expect(
    (await app.request(`${base}/entries/${question}/image/0`)).status,
  ).toBe(200);
  expect(parses).toHaveBeenCalledOnce();
});

it("reads a changed file again instead of serving the kept parse", async () => {
  const { app, manager, parses, base, first } = fixture();
  await app.request(`${base}/entries/${first}/thinking/0`);
  const later = manager.appendMessage(answer("later reasoning"));
  const response = await app.request(`${base}/entries/${later}/thinking/0`);
  expect(await response.text()).toContain("later reasoning");
  expect(parses).toHaveBeenCalledTimes(2);
});

it("checks a transcript reference against the same kept parse", async () => {
  const { app, parses, base, outside } = fixture();
  const id = base.slice("/sessions/".length);
  const view = `/files/view?session=${id}&path=${encodeURIComponent(outside)}`;
  for (const url of [view, view]) {
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("named in the transcript");
  }
  expect(parses).toHaveBeenCalledOnce();
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}
