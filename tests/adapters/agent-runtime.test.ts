import { createFakeWorld } from "@adapters/fake/index";
import type { RuntimeEvent } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import { STAR_TYPE } from "@core/session-entries";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_WINDOW,
  createHarness,
  type Harness,
  messages,
  MODEL_2,
  MODEL_ID,
  next,
  PROVIDER,
  record,
  reply,
} from "./pi-harness.ts";

// The runtime's lifecycle: opening, resuming, the session commands, stopping.
// Every test drives a real AgentSession with scripted provider replies; see
// pi-harness.ts. Each gets its own temp agent directory and working folder.
// What happens inside a turn is in agent-turns.test.ts.

let h: Harness;

afterEach(async () => {
  vi.useRealTimers();
  await h.dispose();
});

describe("opening", () => {
  it("replaces only web-pi's addition at runtime start, retaining Pi and user instructions", async () => {
    h = await createHarness();
    await writeFile(
      join(h.agentDir, "APPEND_SYSTEM.md"),
      "Keep the user's appended instruction.",
    );
    const original = await h.open();
    const defaultAddition =
      "The interface renders Markdown with tables, task lists, links, and fenced code blocks. LaTeX/math typesetting is not supported; use plain text or code for math.";
    expect(original.systemPrompt()).toContain(defaultAddition);
    expect(original.systemPrompt()).toContain(
      "You are an expert coding assistant",
    );
    expect(original.systemPrompt()).toContain(
      "Keep the user's appended instruction.",
    );

    h.webSettings.update({ systemPromptAddition: "Custom web instruction." });
    await original.reload();
    expect(original.systemPrompt()).toContain(defaultAddition);
    expect(original.systemPrompt()).not.toContain("Custom web instruction.");
    const custom = await h.open();
    expect(custom.systemPrompt()).toContain("Custom web instruction.");
    expect(custom.systemPrompt()).not.toContain(defaultAddition);
    expect(custom.systemPrompt()).toContain(
      "You are an expert coding assistant",
    );
    expect(custom.systemPrompt()).toContain(
      "Keep the user's appended instruction.",
    );
    h.script(reply("answer"));
    const done = next(custom, "turn_done");
    await custom.prompt("question");
    await done;
    expect(getCurrentSystemPrompt(h.calls[0]?.context.messages ?? [])).toBe(
      custom.systemPrompt(),
    );
    const capturedPrompt = custom.systemPrompt();
    h.webSettings.update({ systemPromptAddition: "" });
    expect((await h.open({ sessionId: custom.id })).systemPrompt()).toBe(
      capturedPrompt,
    );
    await custom.stop();
    const reopened = await h.open({ sessionId: custom.id });
    expect(reopened.systemPrompt()).not.toContain("Custom web instruction.");
    expect(reopened.systemPrompt()).not.toContain(defaultAddition);
    expect(reopened.systemPrompt()).toContain(
      "You are an expert coding assistant",
    );
    expect(reopened.systemPrompt()).toContain(
      "Keep the user's appended instruction.",
    );
    h.webSettings.update({ systemPromptAddition: null });
    expect((await h.open()).systemPrompt()).toContain(defaultAddition);
  });

  it("starts a new session on the configured model with nothing said yet", async () => {
    h = await createHarness();
    const announced: RuntimeEvent[] = [];
    h.runtime.subscribeAll((event) => announced.push(event));
    const session = await h.open();
    const snapshot = session.snapshot();
    expect(messages(session)).toEqual([]);
    expect(snapshot.turnStart).toBe(snapshot.branch.length);
    expect(snapshot.partial).toBeUndefined();
    expect(snapshot.status.running).toBe(false);
    expect(snapshot.status.model).toMatchObject({
      provider: PROVIDER,
      id: MODEL_ID,
      contextWindow: CONTEXT_WINDOW,
      reasoning: false,
    });
    expect(snapshot.status.thinkingLevels).toEqual([
      { level: "off", label: "off" },
    ]);
    expect(snapshot.summary.cwd).toBe(h.cwd);
    expect(snapshot.summary.live).toBe(true);
    expect(h.runtime.get(session.id)?.id).toBe(session.id);
    expect(announced).toEqual([{ type: "opened", sessionId: session.id }]);
    // The file belongs to the agent directory the runtime was given, not to
    // whatever PI_CODING_AGENT_DIR or ~/.pi/agent says.
    expect(dirname(dirname(snapshot.summary.filePath ?? ""))).toBe(
      join(h.agentDir, "sessions"),
    );
    // Nothing is on disk until Pi persists a message: this is a draft.
    expect(existsSync(snapshot.summary.filePath ?? "")).toBe(false);
  });

  it("starts on the model the reader picked and writes it back as the default", async () => {
    h = await createHarness();
    const announced: RuntimeEvent[] = [];
    const unsubscribe = h.runtime.subscribeAll((event) =>
      announced.push(event),
    );
    const session = await h.open({
      cwd: h.cwd,
      model: { provider: PROVIDER, modelId: MODEL_2 },
      thinkingLevel: "high",
    });
    expect(session.snapshot().status.model?.id).toBe(MODEL_2);
    expect(session.snapshot().status.thinkingLevel).toBe("high");
    const settings: unknown = JSON.parse(
      await readFile(join(h.agentDir, "settings.json"), "utf8"),
    );
    expect(settings).toMatchObject({
      defaultModel: MODEL_2,
      defaultThinkingLevel: "high",
    });
    unsubscribe();

    // Clamped to off on a model that cannot reason: nothing written back.
    const plain = await h.open({
      cwd: h.cwd,
      model: { provider: PROVIDER, modelId: MODEL_ID },
      thinkingLevel: "high",
    });
    expect(plain.snapshot().status.thinkingLevel).toBe("off");
    const again: unknown = JSON.parse(
      await readFile(join(h.agentDir, "settings.json"), "utf8"),
    );
    expect(again).toMatchObject({
      defaultModel: MODEL_ID,
      defaultThinkingLevel: "high",
    });
    expect(announced).toHaveLength(1);
  });

  it("resumes a persisted session and coalesces concurrent opens", async () => {
    h = await createHarness();
    const first = await h.open();
    h.script(reply("answer"));
    const done = next(first, "turn_done");
    await first.prompt("question");
    await done;
    await first.stop();
    expect(h.runtime.get(first.id)).toBeUndefined();

    const announced: RuntimeEvent[] = [];
    h.runtime.subscribeAll((event) => announced.push(event));
    const [a, b] = await Promise.all([
      h.open({ sessionId: first.id }),
      h.open({ sessionId: first.id }),
    ]);
    expect(a.id).toBe(first.id);
    expect(messages(a)).toEqual(["user:question", "assistant:answer"]);
    expect(a.snapshot().turnStart).toBe(a.snapshot().branch.length);
    a.setName("Shared runtime");
    expect(b.snapshot().summary.name).toBe("Shared runtime");
    const again = await h.open({ sessionId: first.id });
    expect(again.snapshot().summary.name).toBe("Shared runtime");
    expect(announced).toEqual([{ type: "opened", sessionId: first.id }]);
    await expect(h.open({ sessionId: "nope" })).rejects.toThrow(
      "Unknown session nope",
    );
    const stopped = next(a, "stopped");
    await b.stop();
    await stopped;
    expect(h.runtime.get(first.id)).toBeUndefined();
    expect(announced).toEqual([
      { type: "opened", sessionId: first.id },
      { type: "stopped", sessionId: first.id },
    ]);
  });
});

describe("session commands", () => {
  it("reopens rewritten history, including an empty branch, without a provider call", async () => {
    h = await createHarness();
    const workspace = createWorkspace({
      ...createFakeWorld(),
      runtime: h.runtime,
      sessions: h.catalog,
    });
    const first = await h.open();
    for (const text of ["first", "second"]) {
      h.script(reply(`${text} answer`));
      const done = next(first, "turn_done");
      await first.prompt(text);
      await done;
    }
    const users = first
      .snapshot()
      .branch.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    for (const index of [1, 0]) {
      const target = users[index];
      if (!target) throw new Error("Missing fixture prompt");
      const draft = await workspace.rewind(first.id, target.id);
      expect(draft.text).toBe(index === 1 ? "second" : "first");
      const resumed = h.runtime.get(first.id);
      if (!resumed) throw new Error("Rewind left the session inactive");
      expect(resumed.snapshot().status.running).toBe(false);
      expect(messages(resumed)).toEqual(
        index === 1 ? ["user:first", "assistant:first answer"] : [],
      );
      expect(h.calls).toHaveLength(2);
    }
  });

  it("names, stars, switches model, and refuses what it cannot", async () => {
    h = await createHarness();
    const session = await h.open();
    h.script(reply("answer"));
    const done = next(session, "turn_done");
    await session.prompt("q");
    await done;
    session.setName("Named");
    expect(session.snapshot().summary.name).toBe("Named");

    const branch = session.snapshot().branch;
    const user = branch.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const answer = branch.find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    session.setStar(answer?.id ?? "", true);
    expect(
      session
        .snapshot()
        .entries.some(
          (entry) => entry.type === "custom" && entry.customType === STAR_TYPE,
        ),
    ).toBe(true);
    expect(() => {
      session.setStar(user?.id ?? "", true);
    }).toThrow("assistant answer");

    // This model cannot reason, so the level is clamped to off...
    session.setThinkingLevel("high");
    expect(session.snapshot().status.thinkingLevel).toBe("off");
    await session.setModel(PROVIDER, MODEL_2);
    expect(session.snapshot().status.model?.id).toBe(MODEL_2);
    // ...and the one that can offers the levels it supports.
    session.setThinkingLevel("high");
    expect(session.snapshot().status.thinkingLevel).toBe("high");
    expect(
      session.snapshot().status.thinkingLevels.map((choice) => choice.level),
    ).toContain("high");
    await expect(session.setModel(PROVIDER, "nope")).rejects.toThrow(
      "Unknown model",
    );

    // Moving the leaf to the question offers its text and drops the answer.
    expect(await session.navigateTree(user?.id ?? "")).toBe("q");
    expect(messages(session)).toEqual([]);
    expect(session.snapshot().turnStart).toBe(session.snapshot().branch.length);
  });

  it("lists commands from extensions, prompts, and skills, and the tools", async () => {
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerCommand("probe", {
            description: "Probe",
            handler: () => Promise.resolve(),
          });
        },
      ],
    });
    await mkdir(join(h.agentDir, "prompts"), { recursive: true });
    await writeFile(
      join(h.agentDir, "prompts", "greet.md"),
      "---\ndescription: Say hi\n---\nHello $1\n",
    );
    await mkdir(join(h.agentDir, "skills", "tidy"), { recursive: true });
    await writeFile(
      join(h.agentDir, "skills", "tidy", "SKILL.md"),
      "---\nname: tidy\ndescription: Tidy up\ndisable-model-invocation: true\n---\nBody\n",
    );
    // ~/.agents/skills is the harness's HOME, not the developer's.
    await mkdir(join(h.root, ".agents", "skills", "home"), { recursive: true });
    await writeFile(
      join(h.root, ".agents", "skills", "home", "SKILL.md"),
      "---\nname: home\ndescription: From home\n---\nBody\n",
    );
    const session = await h.open();
    expect(session.commands()).toEqual(
      expect.arrayContaining([
        { name: "probe", description: "Probe", source: "extension" },
        { name: "greet", description: "Say hi", source: "prompt" },
        {
          name: "skill:tidy",
          description: "Tidy up",
          source: "skill",
          manual: true,
        },
      ]),
    );
    expect(
      session
        .commands()
        .filter((command) => command.source === "skill")
        .map((command) => command.name)
        .toSorted(),
    ).toEqual(["skill:home", "skill:tidy"]);
    const tools = session.toolDefinitions();
    expect(tools.find((tool) => tool.name === "read")).toMatchObject({
      active: true,
    });
    expect(
      tools.find((tool) => tool.name === "read")?.parameters.length,
    ).toBeGreaterThan(0);
    expect(session.snapshot().status.hasActiveTools).toBe(true);
    expect(session.snapshot().status.hasSystemPrompt).toBe(true);
    expect(session.systemPrompt()).toContain("LaTeX/math typesetting");
  });
});

describe("stopping", () => {
  it("disposes the session, tells the runtime, and drops its listeners", async () => {
    h = await createHarness();
    const session = await h.open();
    const announced: RuntimeEvent["type"][] = [];
    h.runtime.subscribeAll((event) => announced.push(event.type));
    const events = record(session);
    await session.stop();
    expect(events).toEqual(["stopped"]);
    expect(announced).toEqual(["stopped"]);
    expect(h.runtime.get(session.id)).toBeUndefined();
    session.setName("after");
    expect(events).toEqual(["stopped"]);
  });

  it("shuts an idle draft down, and at once when the reader stops it", async () => {
    h = await createHarness({ draftIdleMs: 30 });
    const idle = await h.open();
    await next(idle, "stopped");
    expect(h.runtime.get(idle.id)).toBeUndefined();

    const stopped = await h.open();
    await stopped.abort();
    expect(h.runtime.get(stopped.id)).toBeUndefined();

    // A session with a transcript on disk is never shut down for idling.
    const kept = await h.open();
    // SDK loading uses real time. Turn activity resets the idle timeout onto
    // this clock; clearTimeout also clears the timer scheduled during opening.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldClearNativeTimers: true,
    });
    const events = record(kept);
    h.script(reply("answer"));
    const done = next(kept, "turn_done");
    await kept.prompt("q");
    await done;
    expect(existsSync(kept.snapshot().summary.filePath ?? "")).toBe(true);
    await vi.advanceTimersByTimeAsync(120);
    expect(h.runtime.get(kept.id)?.snapshot().status.running).toBe(false);
    expect(events).not.toContain("stopped");
  });
});
