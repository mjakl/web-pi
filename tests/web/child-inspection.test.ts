import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import type { SessionSummary } from "@core/sessions";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { describe, expect, it, vi } from "vitest";

const children: SessionSummary[] = [
  {
    id: "subagent.abc123",
    cwd: "/repo",
    createdAt: "2026-09-01T00:00:00.000Z",
    modifiedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 100,
  },
  {
    id: "11111111-1111-4111-8111-111111111111",
    cwd: "/repo",
    createdAt: "2026-09-01T00:00:00.000Z",
    modifiedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 100,
    inspectionOnly: true,
    delegation: { parentSessionId: "parent", agent: "coder", handle: "task" },
  },
];

function fixture(summary: SessionSummary, missingFolders: string[] = []) {
  const answer = assistantEntry("a1", "u1", "Saved answer", 100);
  if (answer.type === "message" && answer.message.role === "assistant") {
    answer.message.content = [
      { type: "thinking", thinking: "Saved reasoning" },
      {
        type: "toolCall",
        id: "call-read",
        name: "read",
        arguments: { path: "saved.txt" },
      },
      { type: "text", text: "Saved answer" },
    ];
  }
  const world = createFakeWorld({
    missingFolders,
    sessions: [
      {
        summary,
        entries: [
          userEntry("u1", null, "Saved question", 1),
          answer,
          {
            type: "message",
            id: "result",
            parentId: "a1",
            timestamp: "2026-09-01T00:00:00.000Z",
            message: {
              role: "toolResult",
              toolCallId: "call-read",
              toolName: "read",
              content: [{ type: "text", text: "Saved tool output" }],
              isError: false,
              timestamp: 0,
            },
          },
          userEntry("u2", "result", "Next question"),
          assistantEntry("a2", "u2", "Latest saved answer", 100),
        ],
      },
    ],
  });
  const open = vi.spyOn(world.runtime, "open");
  const models = vi.spyOn(world.models, "list");
  const resources = vi.spyOn(world.resources, "commands");
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
  });
  return { app, world, open, models, resources };
}

describe.each(children)("inspection-only child $id", (summary) => {
  it("renders saved content without controls, runtime, models, or a session stream", async () => {
    const { app, open, models, resources } = fixture(summary);
    for (const headers of [
      new Headers(),
      new Headers({ "HX-Target": "div#session-region" }),
    ]) {
      const response = await app.request(`/sessions/${summary.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      const region = html.slice(html.indexOf('id="session-region"'));
      expect(region).toContain("inspection only");
      expect(region).toContain("Saved question");
      expect(region).toContain("Latest saved answer");
      expect(region).toContain('data-copy="true"');
      expect(region).toContain('id="page-refresh"');
      for (const forbidden of [
        "composer-surface",
        "drop-zone",
        "hx-sse:connect=",
        "answer-star-toggle",
        "Continue from here",
        "data-top-panel=",
        'id="extension-dialog"',
        'id="custom-ui"',
        'id="editor-insert"',
        "/navigate",
        "/fork",
        "/rewind",
        "/export",
        "/compact",
        "/system-prompt",
        "/tools",
        "/model-selector",
      ]) {
        expect(region, forbidden).not.toContain(forbidden);
      }
    }
    expect(open).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(resources).not.toHaveBeenCalled();
  });

  it("keeps pagination, copy, reasoning and saved images readable without runtime", async () => {
    const { app, open, models } = fixture(summary);
    const base = `/sessions/${summary.id}`;
    const earlier = await app.request(`${base}/earlier?before=u2`);
    expect(earlier.status).toBe(200);
    const html = await earlier.text();
    expect(html).toContain("Saved answer");
    expect(html).not.toContain("answer-star-toggle");
    expect(html).not.toContain("/fork");
    expect(html).not.toContain("/rewind");
    const copy = await app.request(`${base}/last-assistant-text`);
    expect(copy.status).toBe(200);
    expect(await copy.text()).toBe("Latest saved answer");
    const thinking = await app.request(`${base}/entries/a1/thinking/0`);
    expect(thinking.status).toBe(200);
    expect(await thinking.text()).toContain("Saved reasoning");
    const image = await app.request(`${base}/entries/u1/image/0`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/gif");
    const tool = await app.request(
      `${base}/entries/result/tool-result/call-read`,
    );
    expect(tool.status).toBe(200);
    expect(await tool.text()).toContain("Saved tool output");
    expect(open).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
  });

  it("keeps saved branch marks readable without branch mutation controls", async () => {
    const { app, world } = fixture(summary);
    const stored = world.store.get(summary.id);
    if (!stored) throw new Error("Expected the saved child fixture");
    stored.entries.push(
      userEntry("branch-user", "a1", "Alternate saved question"),
      assistantEntry(
        "branch-answer",
        "branch-user",
        "Alternate saved answer",
        100,
      ),
    );
    const response = await app.request(`/sessions/${summary.id}?leaf=a2`, {
      headers: { "HX-Target": "div#session-region" },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Latest saved answer");
    expect(html).toContain('data-entry-id="u1"');
    expect(html).not.toContain("Continue from here");
    expect(html).not.toContain("/navigate");
    expect(html).not.toContain("answer-star-toggle");
  });

  it("does not label a saved delegation call without a result as running", async () => {
    const { app, world } = fixture(summary);
    const stored = world.store.get(summary.id);
    if (!stored) throw new Error("Expected the saved child fixture");
    const pending = assistantEntry("pending-call", "a2", "", 100);
    if (pending.type === "message" && pending.message.role === "assistant") {
      pending.message.content = [
        {
          type: "toolCall",
          id: "child-call",
          name: "subagent",
          arguments: { calls: [{ agent: "coder", prompt: "nested task" }] },
        },
      ];
    }
    stored.entries.push(pending);
    const html = await (
      await app.request(`/sessions/${summary.id}`, {
        headers: { "HX-Target": "div#session-region" },
      })
    ).text();
    expect(html).toContain("No result");
    expect(html).not.toContain("subagent-status-running");
    expect(html).not.toContain("chat-activity-label");
  });

  it.each([
    ["GET", "events"],
    ["GET", "commands"],
    ["GET", "model-selector"],
    ["GET", "tools"],
    ["GET", "system-prompt"],
    ["GET", "export"],
    ["GET", "rename"],
    ["POST", "rename"],
    ["POST", "delete"],
    ["POST", "clone"],
    ["POST", "stop"],
    ["POST", "activate"],
    ["POST", "stars/clear"],
    ["POST", "prompt"],
    ["POST", "abort"],
    ["POST", "compact"],
    ["POST", "compact/abort"],
    ["POST", "queue/recall"],
    ["POST", "model"],
    ["POST", "star"],
    ["POST", "fork"],
    ["POST", "navigate"],
    ["POST", "rewind"],
    ["POST", "ui/dialog"],
    ["POST", "ui/dialog/input"],
  ])(
    "refuses %s %s before any runtime or model access",
    async (method, action) => {
      const { app, world, open, models, resources } = fixture(summary);
      const before = structuredClone(world.store.get(summary.id));
      const response = await app.request(`/sessions/${summary.id}/${action}`, {
        method,
        ...(method === "POST"
          ? {
              body: new URLSearchParams({
                text: "hello",
                entryId: "u1",
                name: "changed",
                data: "x",
              }),
            }
          : {}),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type") ?? "").not.toContain(
        "text/event-stream",
      );
      expect(world.store.get(summary.id)).toEqual(before);
      expect(open).not.toHaveBeenCalled();
      expect(models).not.toHaveBeenCalled();
      expect(resources).not.toHaveBeenCalled();
    },
  );
});

it("keeps ordinary saved sessions writable in the rendered page", async () => {
  const summary = children[0];
  if (!summary) throw new Error("Expected the legacy child fixture");
  const { app } = fixture({ ...summary, id: "ordinary" });
  const html = await (
    await app.request("/sessions/ordinary", {
      headers: { "HX-Target": "div#session-region" },
    })
  ).text();
  expect(html).toContain("composer-surface");
  expect(html).toContain('data-saved-session="/sessions/ordinary/saved"');
  expect(html).toContain('data-live-events="/sessions/ordinary/events"');
  expect(html).not.toContain('hx-sse:connect="/sessions/ordinary/events');
  expect(html).toContain('hx-post="/sessions/ordinary/prompt"');
  expect(html).toContain("answer-star-toggle");
  expect(html).not.toContain("inspection only");
});

it("preserves ordinary missing-folder read-only history controls", async () => {
  const summary = children[0];
  if (!summary) throw new Error("Expected the legacy child fixture");
  const { app } = fixture({ ...summary, id: "ordinary" }, [summary.cwd]);
  const response = await app.request("/sessions/ordinary", {
    headers: { "HX-Target": "div#session-region" },
  });
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Saved answer");
  expect(html).not.toContain("answer-star-toggle");
  expect(html).not.toContain('hx-post="/sessions/ordinary/star"');
  expect(html).not.toContain("/fork");
  expect(html).not.toContain("/rewind");
  expect(html).not.toContain("composer-surface");
  expect(html).not.toContain("inspection only");
});
