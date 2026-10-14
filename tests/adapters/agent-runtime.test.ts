import { createFakeWorld } from "@adapters/fake/index";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import type { LiveSession, RuntimeEvent } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import { STAR_TYPE } from "@core/session-entries";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchMessages,
  CONTEXT_WINDOW,
  createHarness,
  gate,
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

describe("stopped session contract", () => {
  it.each(["SDK", "fake"])(
    "shares Stop and refuses new work in the %s adapter",
    async (adapter) => {
      h = await createHarness();
      const runtime = adapter === "SDK" ? h.runtime : createFakeWorld().runtime;
      const session = await runtime.open({ cwd: h.cwd });
      const events: string[] = [];
      session.subscribe((event) => events.push(event.type));
      const stopping = session.stop();
      expect(session.stop()).toBe(stopping);
      await stopping;
      expect(events.filter((event) => event === "stopped")).toHaveLength(1);
      expect(runtime.get(session.id)).toBeUndefined();
      await expect(session.reload()).rejects.toThrow("stopping or stopped");
      await expect(session.prompt("Late")).rejects.toThrow(
        "stopping or stopped",
      );
      await expect(session.runBash("unused", false)).rejects.toThrow(
        "stopping or stopped",
      );
      await expect(session.compact()).rejects.toThrow("stopping or stopped");
      await expect(session.navigateTree("unused")).rejects.toThrow(
        "stopping or stopped",
      );
      expect(h.calls).toHaveLength(0);
    },
  );
});

it("refuses branch-summary navigation requested by an admitted command after Stop", async () => {
  const entered = gate();
  const navigate = gate();
  const shutdown = gate();
  let result: string | undefined;
  h = await createHarness({
    settings: { branchSummary: { reserveTokens: 1000 } },
    extensions: [
      (pi) => {
        pi.registerCommand("navigate-later", {
          description: "Hold a navigation request",
          handler: async (target, ctx) => {
            entered.open();
            await navigate.wait;
            try {
              await ctx.navigateTree(target, { summarize: true });
              result = "accepted";
            } catch (error) {
              result = String(error);
            }
          },
        });
        pi.on("session_shutdown", async () => {
          await shutdown.wait;
        });
      },
    ],
  });
  const session = await h.open();
  for (const text of ["first", "second"]) {
    h.script(reply(`${text} answer`));
    const done = next(session, "turn_done");
    await session.prompt(text);
    await done;
  }
  const target = session
    .snapshot()
    .branch.find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
  if (!target) throw new Error("Missing navigation target");
  const before = session.snapshot().branch;
  const command = session.prompt(`/navigate-later ${target.id}`);
  await entered.wait;
  const stopping = session.stop();
  const callsBefore = h.calls.length;
  h.script(reply("Unexpected branch summary"));
  navigate.open();
  let callsAfter: number;
  let branchAfter: typeof before;
  try {
    await command;
    callsAfter = h.calls.length;
    branchAfter = session.snapshot().branch;
  } finally {
    shutdown.open();
    await stopping;
  }
  expect(callsAfter).toBe(callsBefore);
  expect(result).toContain("Cannot navigate a stopping or stopped session");
  expect(branchAfter).toEqual(before);
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
      model: { provider: PROVIDER, id: MODEL_2 },
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
      model: { provider: PROVIDER, id: MODEL_ID },
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

  it("starts on the picked model when Pi cannot save it as the default", async () => {
    h = await createHarness();
    await writeFile(join(h.agentDir, "settings.json"), "{");
    const session = await h.open({
      cwd: h.cwd,
      model: { provider: PROVIDER, id: MODEL_2 },
    });
    expect(session.snapshot().status.model?.id).toBe(MODEL_2);
    expect(session.snapshot().status.notices).toEqual([
      {
        level: "warning",
        message: expect.stringContaining(
          "Could not save this choice as Pi's default: global settings:",
        ) as string,
      },
    ]);
  });

  it("saves the picked model as the default beside a damaged project settings file", async () => {
    h = await createHarness();
    await mkdir(join(h.cwd, ".pi"), { recursive: true });
    await writeFile(join(h.cwd, ".pi", "settings.json"), "{");
    await createPiProjectTrust({ agentDir: h.agentDir }).trust(h.cwd);
    const session = await h.open({
      cwd: h.cwd,
      model: { provider: PROVIDER, id: MODEL_2 },
    });
    expect(session.snapshot().status.notices).toEqual([]);
    const settings: unknown = JSON.parse(
      await readFile(join(h.agentDir, "settings.json"), "utf8"),
    );
    expect(settings).toMatchObject({ defaultModel: MODEL_2 });
  });

  it("reopens a stopping session only after its stop has finished writing", async () => {
    const shutdown = gate();
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_shutdown", async () => {
            await shutdown.wait;
            pi.appendEntry("last-word", {});
          });
        },
      ],
    });
    const first = await h.open();
    h.script(reply("answer"));
    let done = next(first, "turn_done");
    await first.prompt("question");
    await done;
    const stopping = first.stop();
    let reopening: Promise<LiveSession>;
    try {
      expect(h.runtime.get(first.id)).toBeUndefined();
      reopening = h.open({ sessionId: first.id });
    } finally {
      shutdown.open();
    }
    const second = await reopening;
    await stopping;
    expect(second).not.toBe(first);
    expect(
      second
        .snapshot()
        .entries.some(
          (entry) =>
            entry.type === "custom" && entry.customType === "last-word",
        ),
    ).toBe(true);
    h.script(reply("again"));
    done = next(second, "turn_done");
    await second.prompt("after reopening");
    await done;
  });

  it("gives up reopening a session whose stop does not finish", async () => {
    const shutdown = gate();
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_shutdown", () => shutdown.wait);
        },
      ],
    });
    const first = await h.open();
    h.script(reply("answer"));
    const done = next(first, "turn_done");
    await first.prompt("question");
    await done;
    const stopping = first.stop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const reopening = expect(h.open({ sessionId: first.id })).rejects.toThrow(
        "Cannot reopen a session that is still stopping.",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await reopening;
    } finally {
      vi.useRealTimers();
      shutdown.open();
      await stopping;
    }
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

  it("runs !cmd in the shell a reload picked up, as the agent's bash does", async () => {
    // Shells that do not exist: nothing is spawned, and the error names the
    // shell Pi looked for.
    const settings = (shellPath: string) => ({
      defaultProvider: PROVIDER,
      defaultModel: MODEL_ID,
      shellPath,
    });
    h = await createHarness({
      localShell: true,
      settings: settings("/nonexistent/first-shell"),
    });
    const session = await h.open();
    await writeFile(
      join(h.agentDir, "settings.json"),
      JSON.stringify(settings("/nonexistent/second-shell")),
    );
    await session.reload();
    let done = next(session, "turn_done");
    await session.runBash("true", true);
    await done;
    h.script((turn) => {
      turn.toolCall("bash", { command: "true" });
      turn.done();
    }, reply("done"));
    done = next(session, "turn_done");
    await session.prompt("run it");
    await done;
    const failures = [
      JSON.stringify(h.calls[1]?.context.messages.at(-1)),
      ...session.snapshot().status.notices.map((notice) => notice.message),
    ];
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure).toContain("/nonexistent/second-shell");
      expect(failure).not.toContain("first-shell");
    }
  });

  it("lists a folder's commands before a session starts as the session then does", async () => {
    const probe = (description: string) => (pi: ExtensionAPI) => {
      pi.registerCommand("probe", {
        description,
        handler: () => Promise.resolve(),
      });
    };
    h = await createHarness({ extensions: [probe("First"), probe("Second")] });
    const before = await h.runtime.resources.commands(h.cwd);
    expect(before).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mcp", source: "extension" }),
        { name: "probe:1", description: "First", source: "extension" },
        { name: "probe:2", description: "Second", source: "extension" },
      ]),
    );
    const session = await h.open();
    expect(session.commands()).toEqual(before);
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
          skillId: join(h.agentDir, "skills", "tidy", "SKILL.md"),
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
    // Nor is a timer kept armed for it once its file exists.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a stop already in progress", () => {
  // The stopping runtime still writes: late tool results, and what its
  // extensions append on session_shutdown. Its shutdown is held until the
  // test releases it, so commands can arrive while it is under way.
  async function stoppingSession(prompts: string[]) {
    const shutdown = gate();
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_shutdown", async () => {
            await shutdown.wait;
            pi.appendEntry("last-word", {});
          });
        },
      ],
    });
    const workspace = createWorkspace({
      ...createFakeWorld(),
      runtime: h.runtime,
      sessions: h.catalog,
    });
    const session = await h.open();
    for (const text of prompts) {
      h.script(reply(`${text} answer`));
      const done = next(session, "turn_done");
      await session.prompt(text);
      await done;
    }
    const stopping = session.stop();
    let asks = 0;
    let onAsk = () => {};
    session.stop = () => {
      asks += 1;
      onAsk();
      return stopping;
    };
    const release = shutdown.open;
    /** Resolves once others have asked the stopping runtime to stop `count` times. */
    const asked = (count: number) =>
      new Promise<void>((resolve) => {
        onAsk = () => {
          if (asks >= count) resolve();
        };
        onAsk();
      });
    /** The same, or 100 ms later for a command the workspace holds back first. */
    const askedOrHeld = (count: number) =>
      Promise.race([
        asked(count),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ]);
    /** Runs a command, letting the stop finish once the command asks for it. */
    const during = async (command: () => Promise<unknown>): Promise<void> => {
      void asked(1).then(release);
      try {
        await command();
      } finally {
        release();
        await stopping;
      }
    };
    return {
      workspace,
      session,
      stopping,
      release,
      asked,
      askedOrHeld,
      during,
    };
  }

  function secondQuestion(session: LiveSession) {
    const second = session
      .snapshot()
      .branch.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )[1];
    if (!second) throw new Error("Missing fixture prompt");
    return second;
  }

  /** Resolves when a turn ends, in whichever runtime. */
  function turnFinished(): Promise<void> {
    return new Promise((resolve) => {
      const off = h.runtime.subscribeAll((event) => {
        if (event.type !== "finished") return;
        off();
        resolve();
      });
    });
  }

  /** The saved file's branch, or undefined when it is not a valid tree. */
  async function savedBranch(sessionId: string) {
    const saved = await h.catalog.readSaved(sessionId);
    return saved.kind === "changed"
      ? branchMessages(saved.snapshot.branch)
      : undefined;
  }

  it("deletes the file only once the stop has finished writing", async () => {
    const { workspace, session, during } = await stoppingSession(["question"]);
    const file = session.snapshot().summary.filePath ?? "";
    await during(() => workspace.remove(session.id));
    expect(existsSync(file)).toBe(false);
  });

  it("rewinds only once the stop has finished writing", async () => {
    const { workspace, session, during } = await stoppingSession([
      "first",
      "second",
    ]);
    const second = secondQuestion(session);
    await during(() => workspace.rewind(session.id, second.id));
    const resumed = h.runtime.get(session.id);
    if (!resumed) throw new Error("Rewind left the session inactive");
    expect(messages(resumed)).toEqual(["user:first", "assistant:first answer"]);
  });

  it("stops a draft that is already stopping instead of refusing it", async () => {
    const { workspace, session, during } = await stoppingSession([]);
    await during(() => workspace.stop(session.id));
    expect(h.runtime.live()).toEqual([]);
  });

  // A command that opens a runtime waits for the stop as well. A rewind or
  // a delete waiting for the same stop must not let that runtime load the
  // file before it is rewritten, or write it after it is gone.

  it("rewinds after a send waiting for the same stop has opened its runtime", async () => {
    const { workspace, session, stopping, release, asked, askedOrHeld } =
      await stoppingSession(["first", "second"]);
    const second = secondQuestion(session);
    h.script(reply("late answer"));
    const finished = turnFinished();
    const sending = workspace.send(session.id, "late question");
    await asked(1);
    const rewinding = workspace.rewind(session.id, second.id);
    await askedOrHeld(2);
    release();
    const sent = await sending.then(
      () => true,
      () => false,
    );
    await Promise.all([rewinding, stopping]);
    if (sent) await finished;
    expect(await savedBranch(session.id)).toEqual([
      "user:first",
      "assistant:first answer",
    ]);
  });

  it("deletes after a send waiting for the same stop has opened its runtime", async () => {
    const { workspace, session, stopping, release, asked, askedOrHeld } =
      await stoppingSession(["question"]);
    const file = session.snapshot().summary.filePath ?? "";
    const sending = workspace.send(session.id, "late question");
    await asked(1);
    const removing = workspace.remove(session.id);
    await askedOrHeld(2);
    release();
    await Promise.allSettled([sending, removing, stopping]);
    expect(h.runtime.live().map((live) => live.id)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it("sends after a rewind waiting for the same stop has rewritten the file", async () => {
    const { workspace, session, stopping, release, asked, askedOrHeld } =
      await stoppingSession(["first", "second"]);
    const second = secondQuestion(session);
    const rewinding = workspace.rewind(session.id, second.id);
    await asked(1);
    h.script(reply("late answer"));
    const finished = turnFinished();
    const sending = workspace.send(session.id, "late question");
    await askedOrHeld(2);
    release();
    await Promise.all([rewinding, sending, stopping, finished]);
    expect(await savedBranch(session.id)).toEqual([
      "user:first",
      "assistant:first answer",
      "user:late question",
      "assistant:late answer",
    ]);
  });

  it("refuses a send waiting for the same stop as a delete", async () => {
    const { workspace, session, stopping, release, asked, askedOrHeld } =
      await stoppingSession(["question"]);
    const file = session.snapshot().summary.filePath ?? "";
    const removing = workspace.remove(session.id);
    await asked(1);
    const sending = workspace.send(session.id, "late question");
    await askedOrHeld(2);
    release();
    await Promise.all([removing, stopping]);
    await expect(sending).rejects.toThrow(`Unknown session ${session.id}`);
    expect(existsSync(file)).toBe(false);
  });

  it("fails a delete whose stop does not finish, and an open queued behind it", async () => {
    const { workspace, session, stopping, release, asked } =
      await stoppingSession(["question"]);
    const file = session.snapshot().summary.filePath ?? "";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const deleteWaits = asked(1);
      const removing = expect(workspace.remove(session.id)).rejects.toThrow(
        "This session is still stopping. Try again once it has stopped.",
      );
      await deleteWaits;
      const activating = expect(workspace.activate(session.id)).rejects.toThrow(
        "Cannot reopen a session that is still stopping.",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await removing;
      // Behind the delete, the open waits for the same stop, as long again.
      await asked(2);
      await vi.advanceTimersByTimeAsync(10_000);
      await activating;
    } finally {
      vi.useRealTimers();
      release();
      await stopping;
    }
    expect(existsSync(file)).toBe(true);
  });
});
