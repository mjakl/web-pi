import { createWebSettingsStore } from "@adapters/fs/web-settings";
import { createPiAgentRuntime } from "@adapters/pi/agent-runtime";
import { createPiSessionCatalog } from "@adapters/pi/session-catalog";
import type {
  AgentRuntime,
  LiveEvent,
  LiveSession,
  LiveSnapshot,
} from "@core/ports";
import { contentParts } from "@core/transcript";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type TranscriptContext,
  type JsonObject,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type {
  BashOperations,
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempAgent } from "./temp-agent.ts";

// A real AgentSession driven offline: an inline extension registers a provider
// whose streamSimple() plays scripted replies, so every SDK event the adapter
// choreographs — partials, tool execution, compaction, abort — is the SDK's
// own. Each harness owns a temp agent directory, working folder and HOME;
// nothing here can reach ~/.pi/agent or ~/.agents.

export const PROVIDER = "scripted";
export const MODEL_ID = "scripted-1";
/** A second model on the same provider, for switching; this one reasons. */
export const MODEL_2 = "scripted-2";
export const CONTEXT_WINDOW = 4000;

/** One provider call under the test's control. */
export type Turn = {
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
  text(delta: string): void;
  /** Streams the arguments as two JSON halves, then finishes the call. */
  toolCall(name: string, args: JsonObject): void;
  /** Starts a tool call and leaves its arguments half streamed. */
  toolCallStart(name: string, args: JsonObject): void;
  toolCallEnd(): void;
  done(usage?: { input?: number; output?: number }): void;
  error(message: string): void;
};

export type Script = (turn: Turn) => void | Promise<void>;

/** A reply of plain text, optionally reporting usage. */
export function reply(
  text: string,
  usage?: { input?: number; output?: number },
): Script {
  return (turn) => {
    turn.text(text);
    turn.done(usage);
  };
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

let callCounter = 0;

function playTurn(
  model: Model<string>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  script: Script,
) {
  const stream = createAssistantMessageEventStream();
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  let started = false;
  let finished = false;
  let text: { type: "text"; text: string } | undefined;
  let pendingCall: { index: number; call: ToolCall; rest: string } | undefined;
  const start = () => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial });
  };
  const endText = () => {
    if (!text) return;
    const contentIndex = partial.content.indexOf(text);
    stream.push({
      type: "text_end",
      contentIndex,
      content: text.text,
      partial,
    });
    text = undefined;
  };
  const finish = (
    stopReason: "stop" | "toolUse" | "error" | "aborted",
    errorMessage?: string,
  ) => {
    if (finished) return;
    finished = true;
    options?.signal?.removeEventListener("abort", onAbort);
    partial.stopReason = stopReason;
    if (stopReason === "stop" || stopReason === "toolUse") {
      stream.push({ type: "done", reason: stopReason, message: partial });
    } else {
      partial.errorMessage = errorMessage;
      stream.push({ type: "error", reason: stopReason, error: partial });
    }
    stream.end();
  };
  function onAbort(): void {
    finish("aborted", "Request was aborted");
  }
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  const turn: Turn = {
    context,
    options,
    text(delta) {
      if (finished) return;
      start();
      if (!text) {
        text = { type: "text", text: "" };
        partial.content.push(text);
        stream.push({
          type: "text_start",
          contentIndex: partial.content.length - 1,
          partial,
        });
      }
      text.text += delta;
      stream.push({
        type: "text_delta",
        contentIndex: partial.content.indexOf(text),
        delta,
        partial,
      });
    },
    toolCallStart(name, args) {
      if (finished) return;
      start();
      endText();
      callCounter += 1;
      const call: ToolCall = {
        type: "toolCall",
        id: `call-${String(callCounter)}`,
        name,
        arguments: {},
      };
      partial.content.push(call);
      const index = partial.content.length - 1;
      const json = JSON.stringify(args);
      const half = Math.ceil(json.length / 2);
      pendingCall = { index, call, rest: json.slice(half) };
      stream.push({ type: "toolcall_start", contentIndex: index, partial });
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: json.slice(0, half),
        partial,
      });
      call.arguments = args;
    },
    toolCallEnd() {
      if (finished || !pendingCall) return;
      stream.push({
        type: "toolcall_delta",
        contentIndex: pendingCall.index,
        delta: pendingCall.rest,
        partial,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: pendingCall.index,
        toolCall: pendingCall.call,
        partial,
      });
      pendingCall = undefined;
    },
    toolCall(name, args) {
      turn.toolCallStart(name, args);
      turn.toolCallEnd();
    },
    done(usage) {
      if (finished) return;
      start();
      endText();
      turn.toolCallEnd();
      const input = usage?.input ?? 0;
      const output = usage?.output ?? 0;
      partial.usage = {
        ...zeroUsage(),
        input,
        output,
        totalTokens: input + output,
      };
      finish(
        partial.content.some((block) => block.type === "toolCall")
          ? "toolUse"
          : "stop",
      );
    },
    error(message) {
      if (finished) return;
      start();
      finish("error", message);
    },
  };
  // The agent reads the stream after streamSimple() returns; a script that
  // throws before its first event is a provider failing during setup.
  void Promise.resolve()
    .then(() => script(turn))
    .catch((error: unknown) => {
      finish("error", error instanceof Error ? error.message : String(error));
    });
  return stream;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(
  options: {
    extensions?: InlineExtension[];
    settings?: Record<string, unknown>;
    bashOperations?: BashOperations;
    draftIdleMs?: number;
  } = {},
) {
  const temp = await createTempAgent("web-pi-agent-");
  const { root, agentDir, project: cwd } = temp;
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: PROVIDER,
      defaultModel: MODEL_ID,
      ...options.settings,
    }),
  );
  const scripts: Script[] = [];
  const calls: {
    context: TranscriptContext;
    options: SimpleStreamOptions | undefined;
  }[] = [];
  const provider: InlineExtension = {
    name: "scripted-provider",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.registerProvider(PROVIDER, {
        name: "Scripted",
        api: "scripted",
        baseUrl: "http://scripted.invalid",
        apiKey: "scripted",
        streamSimple: (model, context, streamOptions) => {
          calls.push({ context, options: streamOptions });
          const script = scripts.shift() ?? reply("(unscripted reply)");
          return playTurn(model, context, streamOptions, script);
        },
        models: [MODEL_ID, MODEL_2].map((id) => ({
          id,
          name: `Scripted ${id.slice(-1)}`,
          reasoning: id === MODEL_2,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: CONTEXT_WINDOW,
          maxTokens: 1000,
        })),
      });
    },
  };
  const catalog = createPiSessionCatalog({ agentDir });
  const webSettings = createWebSettingsStore(agentDir);
  const runtime: AgentRuntime = createPiAgentRuntime({
    webSettings,
    agentDir,
    catalog,
    extensions: [provider, ...(options.extensions ?? [])],
    bashOperations: options.bashOperations ?? {
      exec: () =>
        Promise.reject(
          new Error("Unexpected shell execution in an offline test"),
        ),
    },
    ...(options.draftIdleMs === undefined
      ? {}
      : { draftIdleMs: options.draftIdleMs }),
  });
  return {
    root,
    agentDir,
    cwd,
    runtime,
    catalog,
    webSettings,
    /** Provider calls so far: what the SDK sent, in order. */
    calls,
    /** Queues replies for the next provider calls. */
    script(...next: Script[]): void {
      scripts.push(...next);
    },
    async open(
      target: Parameters<AgentRuntime["open"]>[0] = { cwd },
    ): Promise<LiveSession> {
      return runtime.open(target);
    },
    async dispose(): Promise<void> {
      for (const session of runtime.live()) {
        if (runtime.get(session.id)) await session.stop();
      }
      await temp.dispose();
    },
  };
}

/** Non-system message entries on the branch, as `role:text`. */
export function messages(session: LiveSession): string[] {
  return session.snapshot().branch.flatMap((entry) => {
    if (
      entry.type !== "message" ||
      entry.message.role === "system" ||
      !("content" in entry.message)
    ) {
      return [];
    }
    const text = contentParts(entry.message.content)
      .map((part) =>
        part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
      )
      .join("");
    return [`${entry.message.role}:${text}`];
  });
}

/** The last assistant message the session persisted. */
export function lastAssistant(
  session: LiveSession,
): Extract<AgentMessage, { role: "assistant" }> {
  for (const entry of session.snapshot().branch.toReversed()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      return entry.message;
    }
  }
  throw new Error("no assistant message");
}

/** Every event a session emits from now on, in order. */
export function record(session: LiveSession): LiveEvent["type"][] {
  const types: LiveEvent["type"][] = [];
  session.subscribe((event) => types.push(event.type));
  return types;
}

/** Resolves when the snapshot satisfies the predicate; fails after `timeout`. */
export function until(
  session: LiveSession,
  predicate: (snapshot: LiveSnapshot) => boolean,
  timeout = 5000,
): Promise<LiveSnapshot> {
  return new Promise((resolve, reject) => {
    const first = session.snapshot();
    if (predicate(first)) {
      resolve(first);
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("until: condition not met in time"));
    }, timeout);
    const unsubscribe = session.subscribe(() => {
      const snapshot = session.snapshot();
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

/** Resolves on the next event of the given type. */
export function next(
  session: LiveSession,
  type: LiveEvent["type"],
  timeout = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`next: no ${type} event in time`));
    }, timeout);
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== type) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** A promise the test resolves to let a script continue mid-stream. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
