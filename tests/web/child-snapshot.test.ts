import { assistantEntry, createFakeWorld } from "@adapters/fake/index";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import { DELEGATION_TYPE } from "@core/session-delegation";
import { createWorkspace } from "@core/workspace";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createWebApp } from "@web/app";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "web-pi-child-snapshot-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function diskState() {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .sort()
    .map((name) => {
      const path = join(root, name);
      const stat = statSync(path, { bigint: true });
      return {
        name,
        mtime: stat.mtimeNs,
        bytes: stat.isFile() ? readFileSync(path) : undefined,
      };
    });
}

it.each([
  { id: "11111111-1111-4111-8111-111111111111", version: 3 },
  { id: "subagent.legacy1", version: 1 },
])(
  "inspects real saved child $id without writing or consulting a runtime",
  async ({ id, version }) => {
    const manager = SessionManager.create(
      root,
      join(root, "sessions", "demo"),
      { id },
    );
    const image = Buffer.from("saved image bytes");
    manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Saved question" },
        {
          type: "image",
          mimeType: "image/png",
          data: image.toString("base64"),
        },
      ],
      timestamp: 1,
    });
    const answer = assistantEntry("ignored", null, "Saved answer", 100);
    if (answer.type !== "message" || answer.message.role !== "assistant")
      throw new Error("Missing fixture answer");
    manager.appendMessage({
      ...answer.message,
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
    const result = manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      content: [{ type: "text", text: "Saved tool output" }],
      isError: false,
      timestamp: 2,
    });
    // v1 is linear; newer formats also retain a non-selected saved branch.
    if (version !== 1) {
      manager.appendMessage({
        role: "user",
        content: "Alternate saved question",
        timestamp: 3,
      });
      manager.branch(result);
    }
    manager.appendMessage({
      role: "user",
      content: "Next question",
      timestamp: 4,
    });
    manager.appendMessage({
      ...answer.message,
      content: [{ type: "text", text: "Latest saved answer" }],
    });
    if (version === 3) {
      manager.appendCustomEntry(DELEGATION_TYPE, {
        version: 1,
        childSessionId: id,
        parentSessionId: "parent",
        agent: "coder-senior",
        handle: "topic",
      });
    }
    manager.appendSessionInfo("Saved child title");
    const file = manager.getSessionFile();
    if (!file) throw new Error("Missing fixture file");
    const entries = manager.getEntries().map((entry) => {
      const value = { ...entry } as Record<string, unknown>;
      if (version === 1) {
        delete value["id"];
        delete value["parentId"];
      }
      return value;
    });
    writeFileSync(
      file,
      `${[{ ...manager.getHeader(), version }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );
    appendFileSync(file, '{"type":"message","id":');
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(file, old, old);
    const before = diskState();
    const writerOpen = vi.spyOn(SessionManager, "open");
    const writerCreate = vi.spyOn(SessionManager, "create");
    const world = createFakeWorld();
    world.sessions = createPiSessionCatalog({ agentDir: root });
    const open = vi.spyOn(world.runtime, "open");
    const get = vi.spyOn(world.runtime, "get");
    const app = createWebApp({
      workspace: createWorkspace(world),
      staticRoot: "/nonexistent",
      defaultCwd: root,
    });
    // Resolve migrated v1 IDs through the same saved snapshot used by the workspace.
    const saved = await world.sessions.read(id);
    expect(saved?.summary.inspectionOnly).toBe(true);
    const messages =
      saved?.branch.filter((entry) => entry.type === "message") ?? [];
    const [question, thinking, tool, next, latest] = messages;
    if (!question || !thinking || !tool || !next || !latest)
      throw new Error("Missing saved messages");
    const base = `/sessions/${id}`;
    const reads = [
      [base, "Latest saved answer"],
      [`${base}/earlier?before=${next.id}`, "Saved answer"],
      [`${base}/entries/${tool.id}/tool-result/call-read`, "Saved tool output"],
    ];
    // Exercise each read family once on the real catalog. Legacy v1 only
    // repeats the routes needed to resolve in-memory migrated entry IDs.
    if (version === 3) {
      reads.push(
        [`${base}/entries/${thinking.id}/thinking/0`, "Saved reasoning"],
        [`${base}/last-assistant-text`, "Latest saved answer"],
        [`${base}/row`, "Saved child title"],
        ["/sidebar", "Saved child title"],
        [`${base}/stats`, "Tokens"],
      );
    }
    const alternate = saved?.entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "Alternate saved question",
    );
    if (version !== 1) {
      if (!alternate) throw new Error("Missing saved alternate branch");
      reads.push([`${base}?leaf=${alternate.id}`, "Alternate saved question"]);
    }
    for (const [url, content] of reads) {
      if (!url || !content) throw new Error("Missing read expectation");
      const response = await app.request(url);
      expect(response.status, url).toBe(200);
      const html = await response.text();
      expect(html, url).toContain(content);
      if (url.includes("?leaf="))
        expect(html, url).not.toContain("Latest saved answer");
      expect(diskState(), url).toEqual(before);
      expect(open, url).not.toHaveBeenCalled();
      expect(
        get.mock.calls.filter(([sessionId]) => sessionId === id),
        url,
      ).toEqual([]);
    }
    const response = await app.request(
      `${base}/entries/${question.id}/image/0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
    expect(diskState()).toEqual(before);
    expect(open).not.toHaveBeenCalled();
    expect(writerOpen).not.toHaveBeenCalled();
    expect(writerCreate).not.toHaveBeenCalled();
    expect(get.mock.calls.filter(([sessionId]) => sessionId === id)).toEqual(
      [],
    );
  },
);
