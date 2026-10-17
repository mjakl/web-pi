import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import type { LiveEvent, LiveSnapshot } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HTMLDetailsElement } from "happy-dom";
import { onTestFinished } from "vitest";
import { nextEvent, required } from "#/web/helpers";
import { htmxBrowser } from "#/web/htmx4-browser";

/** Manually advanced snapshots, real workspace projections and HTTP routes. */
export async function streamingFixture(renderIntervalMs = 1) {
  const world = createFakeWorld();
  const workspace = createWorkspace(world);
  const id = await workspace.createSession("/fixture");
  const live = world.runtime.get(id);
  if (!live) throw new Error("Missing fixture runtime");
  let snapshot = live.snapshot();
  let pendingNotices = [...snapshot.status.notices];
  let pendingEditorText = [...snapshot.status.editorText];
  let snapshotReads = 0;
  const listeners = new Set<(event: LiveEvent) => void>();
  const currentSnapshot = (): LiveSnapshot => ({
    ...snapshot,
    status: {
      ...snapshot.status,
      notices: [...pendingNotices],
      editorText: [...pendingEditorText],
    },
  });
  live.snapshot = () => {
    snapshotReads += 1;
    return currentSnapshot();
  };
  live.takePending = () => {
    pendingNotices = [];
    pendingEditorText = [];
  };
  live.subscribe = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const app = createWebApp({
    workspace,
    defaultCwd: "/fixture",
    staticRoot: "static",
    renderIntervalMs,
  });
  const emit = (type: LiveEvent["type"] = "activity") => {
    for (const listener of listeners) listener({ type });
  };
  const update = (change: Partial<LiveSnapshot>, event?: LiveEvent["type"]) => {
    snapshot = { ...snapshot, ...change };
    if (change.status) {
      pendingNotices = [...change.status.notices];
      pendingEditorText = [...change.status.editorText];
    }
    if (event) emit(event);
  };
  const injectPending = (notice: string, editorText: string) => {
    pendingNotices.push({ level: "info", message: notice });
    pendingEditorText.push(editorText);
  };
  let sequence = 0;
  const finish = (text: string, notify = true) => {
    sequence += 1;
    const user = userEntry(
      `u${String(sequence)}`,
      snapshot.branch.at(-1)?.id ?? null,
      `question ${String(sequence)}`,
    );
    const answer = assistantEntry(`a${String(sequence)}`, user.id, text, 100);
    const branch = [...snapshot.branch, user, answer];
    update({
      branch,
      entries: branch,
      turnStart: branch.length,
      partial: undefined,
      status: { ...snapshot.status, running: false, tools: [] },
    });
    if (notify) emit("turn_done");
  };
  const richRunningTools = (bodyChars = 24_000) => {
    const body = "z".repeat(bodyChars);
    const user = userEntry(
      "rich-user",
      snapshot.branch.at(-1)?.id ?? null,
      "exercise deferred tools",
    );
    const assistant = assistantEntry("rich-tools", user.id, "", 100);
    if (assistant.type !== "message" || assistant.message.role !== "assistant")
      throw new Error("Invalid rich assistant fixture");
    assistant.message.content = [
      { type: "thinking", thinking: "settled setup reasoning" },
      {
        type: "toolCall",
        id: "call-rich-ordinary",
        name: "read",
        arguments: {
          path: "large.txt",
          payload: `ordinary-input-body:${body}`,
        },
      },
      {
        type: "toolCall",
        id: "call-rich-subagent",
        name: "subagent",
        arguments: {
          calls: [
            {
              agent: "explore",
              prompt: `subagent-raw-prompt:${body}`,
              cwd: "/fixture",
            },
            { agent: "reviewer", prompt: "check the result" },
          ],
        },
      },
      {
        type: "toolCall",
        id: "call-rich-unfinished",
        name: "bash",
        arguments: { command: "still-running" },
      },
    ];
    const ordinaryResult: SessionEntry = {
      type: "message",
      id: "rich-ordinary-result",
      parentId: assistant.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-rich-ordinary",
        toolName: "read",
        content: [{ type: "text", text: `ordinary-output-body:${body}` }],
        isError: false,
        timestamp: Date.now(),
      },
    };
    const subagentResult: SessionEntry = {
      type: "message",
      id: "rich-subagent-result",
      parentId: ordinaryResult.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-rich-subagent",
        toolName: "subagent",
        content: [{ type: "text", text: `subagent-raw-result:${body}` }],
        details: {
          kind: "pi-subagent",
          results: [
            {
              agent: "explore",
              exitCode: 0,
              model: "fixture/explorer",
              session: { cwd: "/fixture" },
              messages: [
                {
                  role: "assistant",
                  content: [
                    { type: "text", text: `subagent-run-output:${body}` },
                  ],
                },
              ],
            },
            {
              agent: "reviewer",
              exitCode: 1,
              processError: true,
              stderr: "representative failure",
              messages: [],
            },
          ],
        },
        isError: false,
        timestamp: Date.now(),
      },
    };
    const branch = [
      ...snapshot.branch,
      user,
      assistant,
      ordinaryResult,
      subagentResult,
    ];
    const partial = assistantEntry("unused", subagentResult.id, "", 100);
    if (partial.type !== "message" || partial.message.role !== "assistant")
      throw new Error("Invalid rich partial fixture");
    partial.message.content = [
      { type: "thinking", thinking: "partial thinking" },
      { type: "text", text: "partial answer text" },
    ];
    update({
      branch,
      entries: branch,
      partial: partial.message,
      status: {
        ...snapshot.status,
        running: true,
        tools: [{ id: "call-rich-unfinished", name: "bash" }],
      },
    });
  };
  const alternateCompletedTools = () => {
    const root = userEntry("branch-root", null, "choose a branch");
    const tools = assistantEntry("alternate-tools", root.id, "", 100);
    if (tools.type !== "message" || tools.message.role !== "assistant")
      throw new Error("Invalid alternate tool fixture");
    tools.message.content = [
      {
        type: "toolCall",
        id: "call-alternate-ordinary",
        name: "read",
        arguments: { path: "alternate.txt" },
      },
      {
        type: "toolCall",
        id: "call-alternate-subagent",
        name: "subagent",
        arguments: {
          calls: [{ agent: "explore", prompt: "alternate prompt" }],
        },
      },
    ];
    const ordinaryResult: SessionEntry = {
      type: "message",
      id: "alternate-ordinary-result",
      parentId: tools.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-alternate-ordinary",
        toolName: "read",
        content: [{ type: "text", text: "alternate ordinary body" }],
        isError: false,
        timestamp: Date.now(),
      },
    };
    const subagentResult: SessionEntry = {
      type: "message",
      id: "alternate-subagent-result",
      parentId: ordinaryResult.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-alternate-subagent",
        toolName: "subagent",
        content: [{ type: "text", text: "alternate raw subagent result" }],
        details: {
          kind: "pi-subagent",
          results: [
            {
              agent: "explore",
              exitCode: 0,
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "alternate subagent body" }],
                },
              ],
            },
          ],
        },
        isError: false,
        timestamp: Date.now(),
      },
    };
    const active = assistantEntry(
      "active-answer",
      root.id,
      "active branch",
      100,
    );
    const entries = [root, tools, ordinaryResult, subagentResult, active];
    update({
      branch: [root, active],
      entries,
      turnStart: 2,
      partial: undefined,
      status: { ...snapshot.status, running: false, tools: [] },
    });
    return { entries, leaf: subagentResult.id };
  };
  const persistAndStop = async () => {
    world.store.set(id, {
      summary: snapshot.summary,
      entries: [...snapshot.entries],
      leafId: snapshot.branch.at(-1)?.id ?? null,
    });
    await live.stop();
  };
  const completeRichUnfinished = () => {
    const result: SessionEntry = {
      type: "message",
      id: "rich-unfinished-result",
      parentId: snapshot.branch.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-rich-unfinished",
        toolName: "bash",
        content: [{ type: "text", text: "unfinished tool completed" }],
        isError: false,
        timestamp: Date.now(),
      },
    };
    const branch = [...snapshot.branch, result];
    update({
      branch,
      entries: branch,
      status: { ...snapshot.status, running: true, tools: [] },
    });
  };
  const runningTools = () => {
    const user = userEntry(
      "running-user",
      snapshot.branch.at(-1)?.id ?? null,
      "run tools",
    );
    const assistant = assistantEntry("tools", user.id, "", 100);
    if (assistant.type !== "message" || assistant.message.role !== "assistant")
      throw new Error("Invalid assistant fixture");
    assistant.message.content = [
      {
        type: "toolCall",
        id: "call-complete",
        name: "read",
        arguments: { path: "large.txt" },
      },
      {
        type: "toolCall",
        id: "call-changing",
        name: "read",
        arguments: { path: "next.txt" },
      },
    ];
    const result: SessionEntry = {
      type: "message",
      id: "tool-result",
      parentId: assistant.id,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "call-complete",
        toolName: "read",
        content: [{ type: "text", text: "selectable output\n".repeat(2000) }],
        isError: false,
        timestamp: Date.now(),
      },
    };
    const branch = [...snapshot.branch, user, assistant, result];
    const partial = assistantEntry("unused", result.id, "streaming text", 100);
    if (partial.type !== "message" || partial.message.role !== "assistant")
      throw new Error("Invalid partial fixture");
    update({
      branch,
      entries: branch,
      partial: partial.message,
      status: {
        ...snapshot.status,
        running: true,
        tools: [{ id: "call-changing", name: "read" }],
      },
    });
  };
  /**
   * The running turn as an agent loop: one finished model call per entry of
   * `reasoning`, each reasoning that many characters, writing a line and
   * reading a file whose result is in, then a partial message streaming.
   * Ids have a fixed width, so runs of any length render alike per round.
   */
  const agentRun = (reasoning: number[], partialReasoning = 20) => {
    const settled = snapshot.branch.slice(0, snapshot.turnStart);
    const branch = [
      ...settled,
      userEntry("run-user", settled.at(-1)?.id ?? null, "start a long run"),
    ];
    reasoning.forEach((chars, round) => {
      const key = String(round).padStart(4, "0");
      const call = assistantEntry(
        `round-${key}`,
        branch.at(-1)?.id ?? null,
        "",
        100,
      );
      if (call.type !== "message" || call.message.role !== "assistant")
        throw new Error("Invalid round fixture");
      call.message.content = [
        { type: "thinking", thinking: `reasoning ${key} ${"r".repeat(chars)}` },
        { type: "text", text: `Step ${key}` },
        {
          type: "toolCall",
          id: `call-${key}`,
          name: "read",
          arguments: { path: `src/file-${key}.ts` },
        },
      ];
      branch.push(call, {
        type: "message",
        id: `result-${key}`,
        parentId: call.id,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: `call-${key}`,
          toolName: "read",
          content: [{ type: "text", text: `contents of file ${key}` }],
          isError: false,
          timestamp: Date.now(),
        },
      });
    });
    const partial = assistantEntry("unused", null, "", 100);
    if (partial.type !== "message" || partial.message.role !== "assistant")
      throw new Error("Invalid partial fixture");
    partial.message.content = [
      {
        type: "thinking",
        thinking: `partial reasoning ${"p".repeat(partialReasoning)}`,
      },
      { type: "text", text: "streaming answer" },
    ];
    update({
      branch,
      entries: branch,
      partial: partial.message,
      status: { ...snapshot.status, running: true, tools: [] },
    });
  };
  return {
    app,
    world,
    workspace,
    id,
    live,
    emit,
    update,
    finish,
    agentRun,
    runningTools,
    richRunningTools,
    alternateCompletedTools,
    persistAndStop,
    completeRichUnfinished,
    injectPending,
    resetSnapshotReads() {
      snapshotReads = 0;
    },
    get snapshot() {
      return currentSnapshot();
    },
    get snapshotReads() {
      return snapshotReads;
    },
    get subscribers() {
      return listeners.size;
    },
  };
}

/**
 * The fixture's session page, which reconnects at once, and its first live
 * frame, awaited by tests that must act after the initial render.
 */
export async function open(
  f: Awaited<ReturnType<typeof streamingFixture>>,
  markup?: string,
  transport = (request: Request) => f.app.request(request),
  options: { clock?: boolean } = {},
) {
  let firstFrame: Promise<unknown> | undefined;
  const browser = await htmxBrowser(
    markup ?? (await (await f.app.request(`/sessions/${f.id}`)).text()),
    (request) =>
      new URL(request.url).pathname === "/events"
        ? new Response("")
        : transport(request),
    {
      ...options,
      instantReconnect: true,
      afterMarkup: (window) => {
        firstFrame = nextEvent(window.document, "htmx:sse:after:message");
      },
    },
  );
  return { ...browser, firstFrame: required(firstFrame) };
}

/**
 * One stream connection's frames as the server writes them, without a
 * browser: each call resolves with the next whole frame. The connection
 * closes when the test finishes.
 */
export async function rawFrames(
  f: Awaited<ReturnType<typeof streamingFixture>>,
  query = "after=",
  init?: RequestInit,
) {
  const response = await f.app.request(
    `/sessions/${f.id}/events?${query}`,
    init,
  );
  const reader = required(response.body?.getReader());
  onTestFinished(() => reader.cancel());
  const decoder = new TextDecoder();
  let received = "";
  return async (): Promise<string> => {
    while (!received.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("The stream ended");
      received += decoder.decode(chunk.value, { stream: true });
    }
    const end = received.indexOf("\n\n") + 2;
    const frame = received.slice(0, end);
    received = received.slice(end);
    return frame;
  };
}

/** Every render starts with the frame that carries the settled cursor. */
export function renderStart(frame: string): boolean {
  return /^id: settled=/m.test(frame);
}

export function toggleDetails(card: HTMLDetailsElement) {
  card.open = !card.open;
  const view = required(card.ownerDocument.defaultView);
  card.dispatchEvent(new view.Event("toggle"));
}

export function openDetails(card: HTMLDetailsElement) {
  if (!card.open) toggleDetails(card);
}
