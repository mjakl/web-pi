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
    respond: vi.fn<CoordinatorProvider["respond"]>(() =>
      Promise.resolve({
        kind: "prompt",
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
  it("does not exhaust a 90-minute conversation after 40 backend requests", async () => {
    const { coordinator, token, provider, live } = await fixture();
    try {
      for (let i = 0; i < 45; i++) {
        await coordinator.request(token, "Review the code", "S1", "prompt");
      }
      expect(provider.respond).toHaveBeenCalledTimes(45);
      expect(coordinator.state(token).proposal).not.toBeNull();
      expect(coordinator.state(token).conversation.length).toBeLessThanOrEqual(
        16,
      );
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
    await coordinator.request(
      token,
      "Ask it to review the code",
      "S1",
      "prompt",
    );
    expect(prompt).not.toHaveBeenCalled();
    const input = vi.mocked(provider.respond).mock.calls[0]?.[0];
    expect(input?.target).toMatchObject({
      id: "task0",
      task: "Fix the timer test",
    });
    expect(input?.context?.messages).toHaveLength(2);
    const proposal = coordinator.state(token).proposal;
    assert(proposal);
    await coordinator.confirm(token, proposal.id);
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
        .conversation.some((m) => m.text.includes("instruction accepted")),
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
    vi.mocked(provider.respond).mockResolvedValue({
      kind: "reply",
      text: "S1 finished the timer work.",
      speech: "S1 finished the timer work.",
      instruction: "",
    });
    await workspace.send("task0", "continue");
    await vi.waitFor(() => {
      expect(provider.respond).toHaveBeenCalled();
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
