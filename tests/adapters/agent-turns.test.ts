import type { RuntimeEvent } from "@core/ports";
import { projectTranscript } from "@core/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_WINDOW,
  createHarness,
  gate,
  type Harness,
  lastAssistant,
  messages,
  next,
  record,
  reply,
  type Script,
  until,
} from "./pi-harness.ts";

// One turn of a real AgentSession, fed by scripted provider replies: the
// streaming partial, the queue, abort, tools, failures, and compaction. See
// pi-harness.ts; the runtime's lifecycle is in agent-runtime.test.ts.

let h: Harness;

afterEach(async () => {
  await h.dispose();
});

describe("a turn", () => {
  it("streams a growing partial, then settles the turn once with its usage", async () => {
    h = await createHarness();
    const session = await h.open();
    const announced: RuntimeEvent["type"][] = [];
    h.runtime.subscribeAll((event) => announced.push(event.type));
    const events = record(session);
    const hold = gate();
    h.script(async (turn) => {
      turn.text("Hello");
      await hold.wait;
      turn.text(" world");
      turn.done({ input: 120, output: 5 });
    });
    const before = session.snapshot();
    await session.prompt("hi");
    const streaming = await until(session, (s) =>
      (s.partial?.content ?? []).some(
        (part) => part.type === "text" && part.text === "Hello",
      ),
    );
    expect(streaming.status.running).toBe(true);
    expect(streaming.status.streaming?.tokens).toBeGreaterThan(0);
    // Not half a second in yet: no rate.
    expect(streaming.status.streaming?.tokensPerSecond).toBeNull();
    // Pi may prepend a system snapshot; the raw boundary still follows the
    // prior settled entries, and the live tail must include the prompt.
    expect(streaming.turnStart).toBe(before.branch.length);
    expect(streaming.branch.slice(0, streaming.turnStart)).toEqual(
      before.branch,
    );
    expect(
      projectTranscript(streaming.branch.slice(streaming.turnStart)).items,
    ).toMatchObject([{ kind: "user", text: "hi" }]);
    expect(events).not.toContain("turn_done");

    const done = next(session, "turn_done");
    hold.open();
    await done;
    const settled = session.snapshot();
    expect(messages(session)).toEqual(["user:hi", "assistant:Hello world"]);
    expect(settled.partial).toBeUndefined();
    expect(settled.status.running).toBe(false);
    expect(settled.status.streaming).toBeNull();
    expect(settled.turnStart).toBe(settled.branch.length);
    expect(lastAssistant(session).usage).toMatchObject({
      input: 120,
      output: 5,
    });
    expect(settled.status.contextTokens).toBe(125);
    expect(events.filter((type) => type === "turn_done")).toHaveLength(1);
    expect(events).toContain("completed");
    expect(announced).toEqual(["started", "finished", "completed"]);
    expect(existsSync(settled.summary.filePath ?? "")).toBe(true);
  });

  it("reports a rate once the message has streamed for half a second", async () => {
    h = await createHarness();
    const session = await h.open();
    const hold = gate();
    h.script(async (turn) => {
      turn.text("Some words to count as tokens");
      await hold.wait;
      turn.done();
    });
    await session.prompt("hi");
    await until(session, (s) => s.partial !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 550));
    const rate = session.snapshot().status.streaming;
    expect(rate?.tokens).toBeGreaterThan(0);
    expect(rate?.tokensPerSecond).toBeGreaterThan(0);
    const done = next(session, "turn_done");
    hold.open();
    await done;
  });

  it("queues later prompts as steer or follow-up and hands them back on recall", async () => {
    h = await createHarness();
    const session = await h.open();
    const hold = gate();
    h.script(async (turn) => {
      turn.text("thinking...");
      await hold.wait;
      turn.done();
    });
    await session.prompt("first");
    // Once the partial exists the model call is under way, so what is queued
    // now cannot be picked up by the run's opening poll.
    await until(session, (s) => s.partial !== undefined);
    await session.prompt("later", { behavior: "followUp" });
    await session.prompt("now", {
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    const queued = await until(session, (s) => s.status.queue.length === 2);
    expect(queued.status.queue).toEqual([
      {
        text: "now",
        behavior: "steer",
        images: [{ data: "AAAA", mimeType: "image/png" }],
      },
      { text: "later", behavior: "followUp" },
    ]);
    const recalled = session.clearQueue();
    expect(recalled.map((message) => message.text)).toEqual(["now", "later"]);
    expect(recalled[0]?.images).toHaveLength(1);
    expect(session.snapshot().status.queue).toEqual([]);
    const done = next(session, "turn_done");
    hold.open();
    await done;
    // Nothing was delivered: the model was called once.
    expect(h.calls).toHaveLength(1);
    expect(messages(session)).toEqual(["user:first", "assistant:thinking..."]);
  });

  it("delivers a steer to the model within the same run", async () => {
    h = await createHarness();
    const session = await h.open();
    const hold = gate();
    h.script(async (turn) => {
      turn.text("one");
      await hold.wait;
      turn.done();
    }, reply("two"));
    const events = record(session);
    await session.prompt("first");
    await until(session, (s) => s.partial !== undefined);
    await session.prompt("second");
    await until(session, (s) => s.status.queue.length === 1);
    const done = next(session, "turn_done");
    hold.open();
    await done;
    expect(h.calls).toHaveLength(2);
    expect(messages(session)).toEqual([
      "user:first",
      "assistant:one",
      "user:second",
      "assistant:two",
    ]);
    expect(events.filter((type) => type === "turn_done")).toHaveLength(1);
    expect(session.snapshot().status.queue).toEqual([]);
  });

  it("aborts mid-stream, keeping the aborted message and dropping the partial", async () => {
    h = await createHarness();
    const session = await h.open();
    h.script(async (turn) => {
      turn.text("never fini");
      await new Promise(() => {});
    });
    const events = record(session);
    await session.prompt("hi");
    await until(session, (s) => s.partial !== undefined);
    await session.abort();
    expect(session.snapshot().partial).toBeUndefined();
    expect(session.snapshot().status.running).toBe(false);
    expect(events).toContain("turn_done");
    // The run had started and the session is idle: pi-web notifies here too.
    expect(events).toContain("completed");
    expect(lastAssistant(session).stopReason).toBe("aborted");
    // The file exists, so this was no draft: the session stays open.
    expect(h.runtime.get(session.id)).toBe(session);
  });

  it("runs a shell command as its own turn, without a completion", async () => {
    h = await createHarness({
      bashOperations: {
        exec: async (command, _cwd, options) => {
          await Promise.resolve();
          options.onData(
            Buffer.from(command === "first shell" ? "shell-out" : "started"),
          );
          if (command === "pending shell") {
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener(
                "abort",
                () => {
                  resolve();
                },
                { once: true },
              );
            });
          }
          return { exitCode: 0 };
        },
      },
    });
    const session = await h.open();
    const events = record(session);
    const settled = next(session, "turn_done");
    const admitted = session.runBash("first shell", false);
    expect(session.snapshot().bash).toEqual({
      command: "first shell",
      output: "",
    });
    await admitted;
    await settled;
    const snapshot = session.snapshot();
    expect(snapshot.bash).toBeUndefined();
    expect(events).toContain("turn_done");
    expect(events).not.toContain("completed");
    const items = projectTranscript(snapshot.branch).items;
    expect(items.at(-1)).toMatchObject({
      kind: "bash",
      command: "first shell",
      output: expect.stringContaining("shell-out") as string,
    });

    const stopped = next(session, "turn_done");
    await session.runBash("pending shell", true);
    await until(session, (s) => (s.bash?.output ?? "").includes("started"));
    expect(session.snapshot().status.bashRunning).toBe(true);
    session.abortBash();
    await stopped;
    expect(
      projectTranscript(session.snapshot().branch).items.at(-1),
    ).toMatchObject({ kind: "bash", cancelled: true, excluded: true });
  });
});

describe("tools", () => {
  it("executes a read on a fixture and pairs the result in the transcript", async () => {
    h = await createHarness();
    const session = await h.open();
    await writeFile(join(h.cwd, "note.txt"), "the note\n");
    const hold = gate();
    h.script(async (turn) => {
      turn.text("Reading");
      turn.toolCallStart("read", { path: join(h.cwd, "note.txt") });
      await hold.wait;
      turn.toolCallEnd();
      turn.done({ input: 200, output: 20 });
    }, reply("Read it"));
    await session.prompt("read the note");
    const streaming = await until(session, (s) =>
      Object.values(s.partialArguments ?? {}).some((json) => json !== ""),
    );
    // Half the JSON so far: the card can show what is being generated.
    expect(Object.values(streaming.partialArguments ?? {})[0]).toMatch(
      /^\{"path":/,
    );
    const done = next(session, "turn_done");
    hold.open();
    await done;
    const items = projectTranscript(session.snapshot().branch).items;
    const answer = items.find((item) => item.kind === "assistant");
    const call = answer?.blocks.find((block) => block.kind === "tool");
    expect(call?.kind === "tool" && call.call.name).toBe("read");
    expect(call?.kind === "tool" && call.call.result?.text).toContain(
      "the note",
    );
    expect(items.at(-1)).toMatchObject({ kind: "assistant" });
    expect(session.snapshot().partialArguments).toBeUndefined();
    expect(session.snapshot().status.tools).toEqual([]);
  });

  it("shows a running extension tool with its latest progress line", async () => {
    const hold = gate();
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerTool({
            name: "slow",
            label: "Slow",
            description: "waits",
            parameters: { type: "object", properties: {} },
            async execute(_id, _params, signal, onUpdate) {
              onUpdate?.({
                content: [{ type: "text", text: "step 1\nstep 2\n" }],
                details: {},
              });
              await Promise.race([
                hold.wait,
                new Promise((_, reject) => {
                  signal?.addEventListener("abort", () => {
                    reject(new Error("aborted"));
                  });
                }),
              ]);
              return {
                content: [{ type: "text", text: "slow done" }],
                details: {},
              };
            },
          });
        },
      ],
    });
    const session = await h.open();
    h.script((turn) => {
      turn.toolCall("slow", {});
      turn.done();
    }, reply("ok"));
    await session.prompt("go");
    const running = await until(
      session,
      (s) => s.status.tools[0]?.progress !== undefined,
    );
    expect(running.status.tools[0]).toMatchObject({
      name: "slow",
      progress: "step 2",
    });
    const done = next(session, "turn_done");
    hold.open();
    await done;
    expect(session.snapshot().status.tools).toEqual([]);
    expect(session.toolDefinitions().map((tool) => tool.name)).toContain(
      "slow",
    );
  });
});

describe("failures", () => {
  it("persists a provider error as the answer and still settles the turn", async () => {
    h = await createHarness();
    const session = await h.open();
    const events = record(session);
    h.script((turn) => {
      turn.text("partial");
      turn.error("boom");
    });
    await session.prompt("hi");
    await next(session, "turn_done");
    expect(lastAssistant(session)).toMatchObject({
      stopReason: "error",
      errorMessage: "boom",
    });
    expect(session.snapshot().status.running).toBe(false);
    expect(events.filter((type) => type === "turn_done")).toHaveLength(1);
  });

  it("survives a provider that throws before streaming", async () => {
    h = await createHarness();
    const session = await h.open();
    h.script(() => {
      throw new Error("setup failed");
    });
    await session.prompt("hi");
    await next(session, "turn_done");
    expect(lastAssistant(session)).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("setup failed") as string,
    });
  });

  it("shows Pi's own retry of a transient error, then the answer", async () => {
    h = await createHarness({
      settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
    });
    const session = await h.open();
    h.script((turn) => {
      turn.error("overloaded");
    }, reply("after retry"));
    await session.prompt("hi");
    const retrying = await until(session, (s) => s.status.retry !== null);
    expect(retrying.status.retry).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      message: "overloaded",
    });
    await next(session, "turn_done");
    expect(session.snapshot().status.retry).toBeNull();
    expect(messages(session).at(-1)).toBe("assistant:after retry");
  });

  it("turns a failing extension command into a notice", async () => {
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerCommand("boom", {
            description: "fails",
            handler: () => Promise.reject(new Error("command broke")),
          });
        },
      ],
    });
    const session = await h.open();
    await session.prompt("/boom");
    expect(session.snapshot().status.notices).toEqual([
      { level: "error", message: "command:boom: command broke" },
    ]);
    session.takePending();
    expect(session.snapshot().status.notices).toEqual([]);
  });
});

describe("compaction", () => {
  const settings = {
    compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20 },
  };

  async function talk(
    session: Awaited<ReturnType<Harness["open"]>>,
    text: string,
    script: Script,
  ) {
    h.script(script);
    const done = next(session, "turn_done");
    await session.prompt(text);
    await done;
  }

  it("compacts on request and estimates the rebuilt context until the next answer", async () => {
    h = await createHarness({ settings });
    const session = await h.open();
    await talk(session, "one", reply("first answer ".repeat(20)));
    await talk(session, "two", reply("second answer ".repeat(20)));
    await talk(session, "three", reply("third", { input: 500, output: 5 }));
    expect(session.snapshot().status.contextTokens).toBe(505);

    const hold = gate();
    h.script(async (turn) => {
      turn.text("Summary of it all");
      await hold.wait;
      turn.done({ input: 50, output: 5 });
    });
    const compacting = session.compact();
    const during = await until(session, (s) => s.status.compacting);
    expect(during.status.compaction).toBeNull();
    // A prompt cannot start meanwhile: the refusal is a notice, and the turn
    // that never began still settles so the composer is released.
    const events = record(session);
    await expect(session.prompt("meanwhile")).rejects.toThrow("compaction");
    expect(session.snapshot().status.notices[0]?.message).toContain(
      "compaction",
    );
    expect(events).toContain("turn_done");
    hold.open();
    await compacting;
    const after = session.snapshot();
    expect(after.status.compacting).toBe(false);
    expect(after.status.compaction).toMatchObject({ reason: "manual" });
    expect(after.status.compaction?.tokensBefore).toBeGreaterThan(0);
    expect(after.status.contextTokens).toBe(
      after.status.compaction?.tokensAfter,
    );
    expect(after.status.contextTokensEstimated).toBe(true);
    const compaction = after.branch.find(
      (entry) => entry.type === "compaction",
    );
    expect(compaction?.type === "compaction" && compaction.summary).toContain(
      "Summary of it all",
    );

    await talk(session, "four", reply("fourth", { input: 80, output: 4 }));
    expect(session.snapshot().status.contextTokens).toBe(84);
    // A new prompt clears the success strip.
    expect(session.snapshot().status.compaction).toBeNull();
  });

  it("compacts by itself once a reply reports the window as nearly full", async () => {
    h = await createHarness({ settings });
    const session = await h.open();
    await talk(session, "one", reply("first answer ".repeat(20)));
    h.script(
      reply("big", { input: CONTEXT_WINDOW - 500, output: 10 }),
      reply("Auto summary"),
    );
    const events = record(session);
    const done = next(session, "turn_done");
    await session.prompt("two");
    await done;
    await until(session, (s) => s.status.compaction !== null);
    const status = session.snapshot().status;
    expect(status.compaction?.reason).toBe("threshold");
    expect(status.contextTokens).toBe(status.compaction?.tokensAfter);
    expect(status.contextTokensEstimated).toBe(true);
    expect(
      session.snapshot().branch.some((entry) => entry.type === "compaction"),
    ).toBe(true);
    expect(events).toContain("turn_done");
  });

  it("keeps a failed compaction as an alert and can be aborted", async () => {
    h = await createHarness({ settings });
    const session = await h.open();
    await talk(session, "one", reply("first answer ".repeat(20)));
    await talk(
      session,
      "two",
      reply("second answer ".repeat(20), { input: 500, output: 5 }),
    );
    h.script((turn) => {
      turn.error("summary failed");
    });
    await expect(session.compact()).rejects.toThrow();
    expect(session.snapshot().status.compactionError).toContain(
      "summary failed",
    );
    expect(session.snapshot().status).toMatchObject({
      contextTokens: 505,
      contextTokensEstimated: false,
    });
    expect(session.snapshot().status.compacting).toBe(false);

    h.script(async () => {
      await new Promise(() => {});
    });
    const aborted = session.compact();
    await until(session, (s) => s.status.compacting);
    session.abortCompaction();
    await expect(aborted).rejects.toThrow();
    expect(session.snapshot().status.compacting).toBe(false);
    expect(session.snapshot().status.compaction).toBeNull();
    expect(session.snapshot().status).toMatchObject({
      contextTokens: 505,
      contextTokensEstimated: false,
    });
  });
});
