import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createCoordinator } from "@core/coordinator";
import type { CoordinatorProvider, VoiceEvent } from "@core/coordinator-types";
import { createWorkspace } from "@core/workspace";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

async function fixture(
  names = ["Timer", "Review"],
  prepare?: (workspace: ReturnType<typeof createWorkspace>) => void,
) {
  const world = createFakeWorld({
    delayMs: 2,
    sessions: names.map((name, i) => ({
      summary: {
        id: `task${String(i)}`,
        name,
        cwd: `/repo${String(i)}`,
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
        fileSize: 1,
      },
      entries: [
        userEntry(
          `u${String(i)}`,
          null,
          i ? "Review scheduler changes" : "Fix the timer test",
        ),
        assistantEntry(`a${String(i)}`, `u${String(i)}`, "Old answer", 10),
      ],
    })),
  });
  const workspace = createWorkspace(world);
  await workspace.activate("task0");
  const live = world.runtime.get("task0");
  assert(live);
  let voiceEvent: (event: VoiceEvent) => void = () => {};
  const voice = {
    answer: "answer",
    context: vi.fn(),
    mute: vi.fn(),
    close: vi.fn(() => Promise.resolve(true)),
  };
  const provider: CoordinatorProvider = {
    ready: () => true,
    respond: vi.fn<CoordinatorProvider["respond"]>((input) =>
      Promise.resolve({
        kind: "prompt",
        targetId: input.explicitTargetId ?? input.target?.id ?? null,
        question: null,
        text: "Review this instruction.",
        speech: "Review the instruction below.",
        instruction:
          "Review the timer-test changes in this session. Do not modify code.",
      }),
    ),
    connect: vi.fn<CoordinatorProvider["connect"]>((_offer, callback) => {
      voiceEvent = callback;
      return Promise.resolve(voice);
    }),
  };
  prepare?.(workspace);
  let nextId = 0;
  const coordinator = createCoordinator(workspace, provider, () =>
    String(++nextId),
  );
  const token = await coordinator.begin();
  return {
    world,
    live,
    workspace,
    coordinator,
    provider,
    token,
    voice,
    emit: (event: VoiceEvent) => {
      voiceEvent(event);
    },
  };
}

describe("app-level coordinator", () => {
  it("routes a task choice, pronoun follow-up and session shift from shared history, then pins confirmation", async () => {
    const { coordinator, token, live, provider, workspace, world } =
      await fixture(["Login", "API"]);
    await workspace.activate("task1");
    const other = world.runtime.get("task1");
    assert(other);
    const firstPrompt = vi.spyOn(live, "prompt");
    const otherPrompt = vi.spyOn(other, "prompt");
    const response = {
      kind: "reply" as const,
      targetId: null,
      question: null,
      text: "S1 fixes login; S2 handles the API.",
      speech: "Two sessions.",
      instruction: "",
    };
    vi.mocked(provider.respond).mockResolvedValueOnce(response);
    try {
      await coordinator.request(token, "List the sessions", "");
      vi.mocked(provider.respond).mockResolvedValueOnce({
        ...response,
        kind: "prompt",
        targetId: "task0",
        instruction: "Review the login fix.",
      });
      await coordinator.request(
        token,
        "Ask the login fix we discussed to review its changes",
        "",
      );
      expect(coordinator.state(token).proposal?.target).toBe("task0");
      const pending = coordinator.state(token).proposal;
      vi.mocked(provider.respond).mockResolvedValueOnce({
        ...response,
        kind: "prompt",
        targetId: "task0",
        instruction: "Review the login fix, including tests.",
      });
      await coordinator.request(token, "Ask that one to include tests", "S1");
      const followup = vi.mocked(provider.respond).mock.calls.at(-1)?.[0];
      expect(followup?.proposal).toEqual(pending);
      expect(followup?.target?.id).toBe("task0");
      expect(followup?.conversation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "proposal",
            sessionIds: ["task0"],
            proposal: pending,
          }),
        ]),
      );
      const old = coordinator.state(token).proposal;
      assert(old);
      vi.mocked(provider.respond).mockResolvedValueOnce({
        ...response,
        kind: "prompt",
        targetId: "task1",
        instruction: "Review the API changes.",
      });
      await coordinator.request(
        token,
        "Now ask the API session to review its changes",
        "S1",
      );
      const shifted = coordinator.state(token).proposal;
      assert(shifted);
      expect(coordinator.state(token).target).toBe("S2");
      expect(shifted.target).toBe("task1");
      expect(firstPrompt).not.toHaveBeenCalled();
      expect(otherPrompt).not.toHaveBeenCalled();
      await expect(coordinator.confirm(token, old.id)).rejects.toThrow(
        /expired|changed/,
      );
      await coordinator.confirm(token, shifted.id);
      expect(otherPrompt).toHaveBeenCalledExactlyOnceWith(
        "Review the API changes.",
        { literal: true },
      );
      expect(firstPrompt).not.toHaveBeenCalled();
      expect(coordinator.state(token).conversation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "submission",
            sessionIds: ["task1"],
            proposal: shifted,
          }),
          expect.objectContaining({
            event: "result",
            sessionIds: ["task1"],
            proposal: shifted,
          }),
        ]),
      );
    } finally {
      await coordinator.end(token);
      await live.stop();
      await other.stop();
    }
  });

  it("carries a disambiguation question instead of falling back to the current session", async () => {
    const { coordinator, token, live, provider, workspace } = await fixture([
      "Login",
      "Login",
    ]);
    await workspace.activate("task1");
    const question = "The browser login or the API login?";
    try {
      await coordinator.select(token, "S1");
      vi.mocked(provider.respond).mockResolvedValueOnce({
        kind: "reply",
        targetId: null,
        question,
        text: question,
        speech: question,
        instruction: "",
      });
      await coordinator.request(
        token,
        "Ask the login session to check it",
        "S1",
      );
      expect(coordinator.state(token).proposal).toBeNull();
      expect(coordinator.state(token).question).toBe(question);
      vi.mocked(provider.respond).mockResolvedValueOnce({
        kind: "prompt",
        targetId: "task1",
        question: null,
        text: "API login",
        speech: "Review below",
        instruction: "Check the API login.",
      });
      await coordinator.request(token, "The other one, the API login", "S1");
      expect(vi.mocked(provider.respond).mock.calls.at(-1)?.[0].question).toBe(
        question,
      );
      expect(coordinator.state(token).proposal?.target).toBe("task1");
    } finally {
      await coordinator.end(token);
      await live.stop();
      await workspace.stop("task1");
    }
  });

  it("validates model identities and explicit overrides without trusting the model for access", async () => {
    const { coordinator, token, live, provider } = await fixture();
    const reply = {
      kind: "prompt" as const,
      question: null,
      text: "Review",
      speech: "Review",
      instruction: "Review changes.",
    };
    try {
      await coordinator.select(token, "S1");
      for (const targetId of ["missing", "subagent.child", "task1"]) {
        vi.mocked(provider.respond).mockResolvedValueOnce({
          ...reply,
          targetId,
        });
        await coordinator.request(
          token,
          "Ask the other session to review",
          "S1",
        );
        expect(coordinator.state(token).proposal).toBeNull();
      }
      vi.mocked(provider.respond).mockResolvedValueOnce({
        ...reply,
        targetId: "task0",
      });
      await coordinator.request(token, "Ask S2 to review", "S1");
      expect(
        vi.mocked(provider.respond).mock.calls.at(-1)?.[0].explicitTargetId,
      ).toBe("task1");
      expect(coordinator.state(token).proposal).toBeNull();
      expect(coordinator.state(token).error).toContain("conflicts");
      await coordinator.select(token, "S2");
      await coordinator.request(token, "Ask S1 to review", "S2");
      expect(coordinator.state(token).proposal?.target).toBe("task0");
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });

  it("retains the current task through observation and refresh after a long coding turn", async () => {
    const changed = new Map<string, () => void>();
    const { coordinator, token, live, world, provider } = await fixture(
      ["Timer", "Review"],
      (workspace) => {
        vi.spyOn(workspace, "coordinatorWatch").mockImplementation(
          (id, notify) => {
            changed.set(id, () => {
              notify();
            });
            return Promise.resolve(() => {
              changed.delete(id);
            });
          },
        );
      },
    );
    try {
      const saved = world.store.get("task1");
      assert(saved);
      saved.entries.push(
        userEntry("api-request", "a1", "Fix the API login timeout"),
      );
      saved.leafId = "api-request";
      for (let i = 1; i <= 12; i++) {
        const id = `progress${String(i)}`;
        saved.entries.push(
          assistantEntry(id, saved.leafId, `Progress step ${String(i)}`, 20),
        );
        saved.leafId = id;
      }
      changed.get("task1")?.();
      await vi.waitFor(() => {
        expect(
          coordinator.state(token).sessions.find((s) => s.id === "task1"),
        ).toMatchObject({
          currentRequest: "Fix the API login timeout",
          latestOutcome: "Progress step 12",
        });
      });
      await coordinator.request(token, "Which task is the API login fix?", "");
      const input = vi.mocked(provider.respond).mock.calls.at(-1)?.[0];
      expect(input?.sessions.find((s) => s.id === "task1")).toMatchObject({
        currentRequest: "Fix the API login timeout",
        latestOutcome: "Progress step 12",
      });
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });

  it("rejects a changed candidate even when it was not the current target during reasoning", async () => {
    const { coordinator, token, live, provider, world } = await fixture();
    const pending =
      Promise.withResolvers<
        Awaited<ReturnType<CoordinatorProvider["respond"]>>
      >();
    vi.mocked(provider.respond).mockImplementationOnce(() => pending.promise);
    try {
      const request = coordinator.request(
        token,
        "Ask the API task to review",
        "S1",
      );
      await vi.waitFor(() => {
        expect(provider.respond).toHaveBeenCalledOnce();
      });
      const saved = world.store.get("task1");
      assert(saved);
      saved.entries.push(userEntry("changed", "a1", "A different task now"));
      saved.leafId = "changed";
      pending.resolve({
        kind: "prompt",
        targetId: "task1",
        question: null,
        text: "Old task",
        speech: "Review",
        instruction: "Review the old task.",
      });
      await request;
      expect(coordinator.state(token).proposal).toBeNull();
      expect(coordinator.state(token).error).toContain("session changed");
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });

  it("captures each delegated speech request once and seeds voice restart without replaying work", async () => {
    const { coordinator, token, live, provider, emit } = await fixture();
    const prompt = vi.spyOn(live, "prompt");
    const instruction = `Review the login fix. ${"Preserve this detail. ".repeat(75)} Include the final constraint.`;
    try {
      await coordinator.select(token, "S1");
      await coordinator.connect(token, "offer");
      emit({ type: "input", id: "part1", text: instruction.slice(0, 700) });
      emit({ type: "input", id: "part2", text: instruction.slice(700) });
      expect(provider.respond).not.toHaveBeenCalled();
      emit({ type: "delegate", id: "delegate1" });
      await vi.waitFor(() => {
        expect(coordinator.state(token).proposal).not.toBeNull();
      });
      emit({ type: "delegate", id: "delegate1" });
      emit({ type: "delegate", id: "delegate-with-no-new-words" });
      expect(provider.respond).toHaveBeenCalledTimes(1);
      expect(vi.mocked(provider.respond).mock.calls[0]?.[0].text).toBe(
        instruction,
      );
      expect(
        coordinator.state(token).conversation.filter((m) => m.role === "user"),
      ).toEqual([expect.objectContaining({ text: instruction })]);
      await coordinator.endVoice(token);
      await coordinator.connect(token, "restart");
      const recap = vi.mocked(provider.connect).mock.calls.at(-1)?.[3];
      expect(recap?.target?.id).toBe("task0");
      expect(recap?.sessions).toHaveLength(2);
      expect(recap?.proposal?.target).toBe("task0");
      expect(recap?.conversation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: instruction }),
        ]),
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(provider.respond).toHaveBeenCalledTimes(1);
      emit({
        type: "input",
        id: "new-words",
        text: "Ask that one to include tests",
      });
      emit({ type: "delegate", id: "delegate2" });
      await vi.waitFor(() => {
        expect(provider.respond).toHaveBeenCalledTimes(2);
      });
      expect(vi.mocked(provider.respond).mock.calls[1]?.[0].text).toBe(
        "Ask that one to include tests",
      );
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });
  it("does not exhaust a 90-minute conversation after 40 backend requests", async () => {
    const { coordinator, token, provider, live } = await fixture();
    try {
      for (let i = 0; i < 45; i++) {
        await coordinator.request(token, "Review the code", "S1", "prompt");
      }
      expect(provider.respond).toHaveBeenCalledTimes(45);
      expect(coordinator.state(token).proposal).not.toBeNull();
      expect(
        coordinator.state(token).conversation.filter((m) => m.role === "user"),
      ).toHaveLength(45);
      expect(
        vi.mocked(provider.respond).mock.calls.at(-1)?.[0].conversation.length,
      ).toBeGreaterThan(80);
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });

  it("binds startup answers and off states to the same voice generation", async () => {
    const { coordinator, token, live, emit } = await fixture();
    try {
      const first = await coordinator.connect(token, "offer");
      expect(first).toEqual({ answer: "answer", generation: 1 });
      expect(coordinator.state(token)).toMatchObject({
        voice: "connected",
        voiceGeneration: 1,
      });
      await coordinator.endVoice(token);
      expect(coordinator.state(token)).toMatchObject({
        voice: "off",
        voiceGeneration: 1,
      });
      const next = await coordinator.connect(token, "next offer");
      expect(next).toEqual({ answer: "answer", generation: 3 });
      emit({ type: "closed", confirmed: true });
      expect(coordinator.state(token)).toMatchObject({
        voice: "off",
        voiceGeneration: 3,
      });
    } finally {
      await coordinator.end(token);
      await live.stop();
    }
  });

  it("expires text-only coordination after 90 minutes, not ten", async () => {
    vi.useFakeTimers();
    const { coordinator, token, voice, live } = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(90 * 60_000 - 1);
      expect(coordinator.state(token).enabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(() => coordinator.state(token)).toThrow(/ended/i);
      expect(voice.close).not.toHaveBeenCalled();
    } finally {
      await coordinator.shutdown();
      await live.stop();
      vi.useRealTimers();
    }
  });
  it("starts the 90-minute voice window at the first successful connection and never extends it on restart", async () => {
    vi.useFakeTimers();
    const { coordinator, token, provider, voice, live } = await fixture();
    const starting = Promise.withResolvers<typeof voice>();
    vi.mocked(provider.connect).mockImplementationOnce(() => starting.promise);
    try {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(coordinator.state(token).enabled).toBe(true);
      const connection = coordinator.connect(token, "offer");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      starting.resolve(voice);
      await connection;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(coordinator.state(token).voice).toBe("connected");
      await coordinator.endVoice(token);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await coordinator.connect(token, "another offer");
      await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
      expect(coordinator.state(token).voice).toBe("connected");
      await vi.advanceTimersByTimeAsync(1);
      expect(() => coordinator.state(token)).toThrow(/ended/i);
      expect(voice.close).toHaveBeenCalledTimes(2);
    } finally {
      starting.resolve(voice);
      await coordinator.shutdown();
      await live.stop();
      vi.useRealTimers();
    }
  });
  it("grounds a rewritten proposal in one explicit target, never submits model output without confirmation", async () => {
    const { coordinator, token, live, provider } = await fixture();
    const prompt = vi.spyOn(live, "prompt");
    await coordinator.request(token, "Ask it to review the code", "S1");
    expect(prompt).not.toHaveBeenCalled();
    const input = vi.mocked(provider.respond).mock.calls[0]?.[0];
    expect(input?.target).toMatchObject({
      id: "task0",
      task: "Fix the timer test",
    });
    expect(input?.context?.messages).toHaveLength(2);
    const proposal = coordinator.state(token).proposal;
    assert(proposal);
    expect(proposal.mode).toBe("prompt");
    await coordinator.confirm(token, proposal.id);
    expect(coordinator.state(token).conversation.at(-1)?.text).toBe(
      "S1 — Timer: instruction submitted. This acknowledges admission, not completion.",
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      "Review the timer-test changes in this session. Do not modify code.",
      { literal: true },
    );
    await expect(coordinator.confirm(token, proposal.id)).rejects.toThrow(
      /expired|changed|review/i,
    );
    await coordinator.end(token);
    await live.stop();
  });
  it.each([
    [undefined, "followUp", "will run after current work"],
    ["followUp", "followUp", "will run after current work"],
    ["steer", "steer", "will interrupt current work"],
  ] as const)(
    "requires confirmation for a running target with delivery %s",
    async (mode, expectedMode, acknowledgement) => {
      const { coordinator, token, live, provider } = await fixture();
      vi.useFakeTimers();
      try {
        await live.prompt("Existing work");
        const prompt = vi.spyOn(live, "prompt");
        await coordinator.request(
          token,
          "Ask it to review the code",
          "S1",
          mode,
        );
        expect(
          vi.mocked(provider.respond).mock.calls[0]?.[0].context?.running,
        ).toBe(true);
        const proposal = coordinator.state(token).proposal;
        assert(proposal);
        expect(proposal.mode).toBe(expectedMode);
        expect(prompt).not.toHaveBeenCalled();
        await coordinator.confirm(token, proposal.id);
        expect(prompt).toHaveBeenCalledExactlyOnceWith(proposal.text, {
          literal: true,
          behavior: expectedMode,
        });
        expect(live.snapshot().status.queue).toEqual([
          { text: proposal.text, behavior: expectedMode },
        ]);
        const text = coordinator.state(token).conversation.at(-1)?.text;
        expect(text).toContain(`instruction submitted; ${acknowledgement}`);
        expect(text).toContain("admission, not completion");
        expect(text).not.toMatch(/followUp|steer|prompt/);
      } finally {
        await coordinator.end(token);
        await live.stop();
        vi.useRealTimers();
      }
    },
  );

  it("defaults voice delegation to follow-up for captured running context without admitting it", async () => {
    const { coordinator, token, live, emit } = await fixture();
    vi.useFakeTimers();
    let off = () => {};
    try {
      await live.prompt("Existing work");
      const prompt = vi.spyOn(live, "prompt");
      await coordinator.select(token, "S1");
      await coordinator.connect(token, "offer");
      const proposed = Promise.withResolvers<undefined>();
      off = coordinator.subscribe(token, (state) => {
        if (state.proposal) proposed.resolve(undefined);
      });
      emit({ type: "input", id: "words", text: "Ask it to review the code" });
      emit({ type: "delegate", id: "request" });
      await proposed.promise;
      expect(coordinator.state(token).proposal?.mode).toBe("followUp");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      off();
      await coordinator.end(token);
      await live.stop();
      vi.useRealTimers();
    }
  });

  it("asks rather than guessing for pronouns, duplicate labels and conflicting handles", async () => {
    const { coordinator, token, live } = await fixture(["Timer", "Timer"]);
    for (const text of [
      "Ask it to review",
      "Tell Timer to review",
      "Not S1, use S2 instead",
    ]) {
      await coordinator.request(token, text, "", "prompt");
      expect(coordinator.state(token).proposal).toBeNull();
      expect(coordinator.state(token).conversation.at(-1)?.text).toMatch(
        /session|target/i,
      );
    }
    await coordinator.end(token);
    await live.stop();
  });
  it("invalidates proposals on new speech and never treats delegation or spoken assent as admission", async () => {
    const { coordinator, token, emit, live } = await fixture();
    const prompt = vi.spyOn(live, "prompt");
    await coordinator.connect(token, "offer");
    await coordinator.request(token, "review code", "S1", "prompt");
    emit({ type: "input", id: "i1", text: "No, the other session" });
    expect(coordinator.state(token).proposal).toBeNull();
    emit({ type: "delegate", id: "d1" });
    emit({ type: "delegate", id: "d1" });
    emit({ type: "input", id: "i2", text: " yes" });
    expect(prompt).not.toHaveBeenCalled();
    await coordinator.end(token);
    await live.stop();
  });
  it("allows explicit End to race a stream disconnect without reviving or double-closing voice", async () => {
    const { coordinator, token, voice, live } = await fixture();
    await coordinator.connect(token, "offer");
    const ending = coordinator.end(token);
    const disconnected = coordinator.end(token);
    expect(await ending).toBe(true);
    expect(await disconnected).toBe(true);
    expect(voice.close).toHaveBeenCalledOnce();
    await live.stop();
  });

  it("closes a late connection instead of reviving voice after End voice", async () => {
    const { coordinator, token, provider, voice, live } = await fixture();
    let resolve!: (connection: typeof voice) => void;
    vi.mocked(provider.connect).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const connecting = coordinator.connect(token, "offer");
    await coordinator.endVoice(token);
    resolve(voice);
    await expect(connecting).rejects.toThrow(/ended/);
    expect(voice.close).toHaveBeenCalledOnce();
    expect(coordinator.state(token).voice).toBe("off");
    await coordinator.end(token);
    await live.stop();
  });
  it("does not acknowledge rejected admission or retry a consumed proposal", async () => {
    const { coordinator, token, workspace, live } = await fixture();
    await coordinator.request(token, "Review the code", "S1", "prompt");
    const proposal = coordinator.state(token).proposal;
    assert(proposal);
    const send = vi
      .spyOn(workspace, "coordinatorSend")
      .mockRejectedValue(new Error("Admission failed"));
    await expect(coordinator.confirm(token, proposal.id)).rejects.toThrow(
      "Admission failed",
    );
    expect(
      coordinator
        .state(token)
        .conversation.some((m) => m.text.includes("instruction submitted")),
    ).toBe(false);
    await expect(coordinator.confirm(token, proposal.id)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
    await coordinator.end(token);
    await live.stop();
  });
  it("discards a backend reply when fresh speech corrects its captured context", async () => {
    const { coordinator, token, provider, live, emit } = await fixture();
    await coordinator.connect(token, "offer");
    let resolve!: (
      reply: Awaited<ReturnType<CoordinatorProvider["respond"]>>,
    ) => void;
    vi.mocked(provider.respond).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = coordinator.request(
      token,
      "Review the code",
      "S1",
      "prompt",
    );
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalled();
    });
    emit({ type: "input", id: "correction", text: "No, wait" });
    resolve({
      kind: "prompt",
      targetId: "task0",
      question: null,
      instruction: "Wrong stale instruction",
      speech: "Ready",
      text: "Ready",
    });
    await pending;
    expect(coordinator.state(token).proposal).toBeNull();
    expect(
      coordinator
        .state(token)
        .conversation.some((m) => m.text.includes("Ready")),
    ).toBe(false);
    await coordinator.end(token);
    await live.stop();
  });
  it("discards a response grounded in a writer that was replaced while it was pending", async () => {
    const { coordinator, token, provider, workspace } = await fixture();
    const reply =
      Promise.withResolvers<
        Awaited<ReturnType<CoordinatorProvider["respond"]>>
      >();
    vi.mocked(provider.respond).mockImplementationOnce(() => reply.promise);
    const pending = coordinator.request(
      token,
      "Review the code",
      "S1",
      "prompt",
    );
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalledOnce();
    });
    const revision = vi.mocked(provider.respond).mock.calls[0]?.[0].context
      ?.revision;
    await workspace.stop("task0");
    await workspace.activate("task0");
    await vi.waitFor(() => {
      expect(coordinator.state(token).context?.revision).not.toBe(revision);
    });
    reply.resolve({
      kind: "prompt",
      targetId: "task0",
      question: null,
      text: "Old proposal",
      speech: "Ready",
      instruction: "Review the old branch",
    });
    await pending;
    expect(coordinator.state(token).proposal).toBeNull();
    expect(
      coordinator
        .state(token)
        .conversation.some((m) => m.text.includes("Old proposal")),
    ).toBe(false);
    await coordinator.end(token);
    await workspace.stop("task0");
  });

  it("retains all unsummarized messages when a multi-session summary is superseded", async () => {
    const changed = new Map<string, () => void>();
    const { coordinator, token, provider, world, live } = await fixture(
      ["Timer", "Review", "Docs"],
      (workspace) => {
        vi.spyOn(workspace, "coordinatorWatch").mockImplementation(
          (id, notify) => {
            changed.set(id, () => {
              notify();
            });
            return Promise.resolve(() => {
              changed.delete(id);
            });
          },
        );
      },
    );
    const initial =
      Promise.withResolvers<
        Awaited<ReturnType<CoordinatorProvider["respond"]>>
      >();
    const summary =
      Promise.withResolvers<
        Awaited<ReturnType<CoordinatorProvider["respond"]>>
      >();
    const final = {
      kind: "reply" as const,
      targetId: null,
      question: null,
      text: "A1, A2, A3 and B1",
      speech: "All new results",
      instruction: "",
    };
    vi.mocked(provider.respond)
      .mockResolvedValue(final)
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => summary.promise);
    const pending = coordinator.request(
      token,
      "Read this session",
      "S2",
      "prompt",
    );
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalledOnce();
    });
    const append = (id: string, entry: string, text: string) => {
      const stored = world.store.get(id);
      assert(stored);
      stored.entries.push(
        assistantEntry(
          entry,
          stored.leafId ?? stored.entries.at(-1)?.id ?? null,
          text,
          10,
        ),
      );
      stored.leafId = entry;
      changed.get(id)?.();
    };
    append("task1", "new1", "A1: important result");
    append("task2", "other1", "B1: pending question");
    await vi.waitFor(() => {
      expect(coordinator.state(token).context?.messages.at(-1)?.id).toBe(
        "new1",
      );
    });
    initial.resolve({ ...final, text: "Initial reply" });
    await pending;
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(provider.respond).mock.calls[1]?.[0].text).toContain(
      "B1: pending question",
    );
    append("task1", "new2", "A2: important warning");
    await vi.waitFor(() => {
      expect(coordinator.state(token).context?.messages.at(-1)?.id).toBe(
        "new2",
      );
    });
    append("task1", "new3", "A3: new result");
    await vi.waitFor(() => {
      expect(coordinator.state(token).context?.messages.at(-1)?.id).toBe(
        "new3",
      );
    });
    summary.resolve({ ...final, text: "Superseded summary" });
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalledTimes(3);
    });
    const combined = vi.mocked(provider.respond).mock.calls[2]?.[0].text;
    for (const text of [
      "A1: important result",
      "A2: important warning",
      "A3: new result",
      "B1: pending question",
    ])
      expect(combined).toContain(text);
    await vi.waitFor(() => {
      expect(coordinator.state(token).conversation.at(-1)?.text).toBe(
        final.text,
      );
    });
    expect(
      coordinator
        .state(token)
        .conversation.some((m) => m.text.includes("Superseded summary")),
    ).toBe(false);
    expect(combined).not.toContain("Old answer");
    append("task1", "new4", "x".repeat(7000));
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalledTimes(4);
    });
    expect(
      vi.mocked(provider.respond).mock.calls[3]?.[0].text.length,
    ).toBeLessThanOrEqual(6000);
    expect(coordinator.state(token).error).toContain(
      "update window was exceeded",
    );
    await coordinator.end(token);
    await live.stop();
  });

  it("does not announce historical answers and does announce new assistant text", async () => {
    const { coordinator, token, workspace, provider, live } = await fixture();
    expect(provider.respond).not.toHaveBeenCalled();
    await coordinator.select(token, "S2");
    vi.mocked(provider.respond).mockResolvedValue({
      kind: "reply",
      targetId: "task0",
      question: "Should I switch focus?",
      text: "S1 finished the timer work.",
      speech: "S1 finished the timer work.",
      instruction: "",
    });
    await workspace.send("task0", "continue");
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(coordinator.state(token).busy).toBe(false);
    });
    expect(coordinator.state(token).target).toBe("S2");
    expect(coordinator.state(token).question).toBeNull();
    expect(coordinator.state(token).conversation.at(-1)).toMatchObject({
      event: "update",
      sessionIds: ["task0"],
    });
    const calls = vi.mocked(provider.respond).mock.calls;
    expect(
      calls.every(
        ([input]) =>
          input.purpose === "updates" && !input.text.includes("Old answer"),
      ),
    ).toBe(true);
    await coordinator.end(token);
    await live.stop();
  });
});
