import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createCoordinator } from "@core/coordinator";
import type {
  CoordinatorProvider,
  CoordinatorReply,
  VoiceEvent,
} from "@core/coordinator-types";
import { createWorkspace } from "@core/workspace";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

const reply = (
  overrides: Partial<CoordinatorReply> = {},
): CoordinatorReply => ({
  kind: "reply",
  targetId: null,
  question: null,
  text: "Current tasks.",
  speech: "Current tasks.",
  instruction: "",
  ...overrides,
});
const instruction = (targetId = "task0", text = "Review the timer fix.") =>
  reply({ kind: "prompt", targetId, instruction: text });

async function fixture(
  names = ["Timer", "Review"],
  delayMs = 10_000,
  prepare?: (workspace: ReturnType<typeof createWorkspace>) => void,
) {
  const world = createFakeWorld({
    delayMs,
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
      Promise.resolve(
        input.purpose === "updates"
          ? reply()
          : instruction(input.explicitTargetId ?? input.target?.id ?? "task0"),
      ),
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
    workspace,
    live,
    coordinator,
    provider,
    token,
    voice,
    emit: (event: VoiceEvent) => {
      voiceEvent(event);
    },
    async close() {
      await coordinator.shutdown();
      for (const session of world.runtime.live()) await session.stop();
    },
  };
}

function append(
  world: ReturnType<typeof createFakeWorld>,
  id: string,
  entry: string,
  text: string,
) {
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
}

describe("hands-free coordinator", () => {
  it("greets with natural task names and admits delegated captured input exactly once without a click", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      await f.coordinator.connect(f.token, "offer");
      expect(f.voice.context).toHaveBeenCalledWith(
        expect.stringContaining("Timer: idle"),
        true,
        undefined,
      );
      f.emit({ type: "output", id: "assistant", text: "Send work to Timer" });
      f.emit({ type: "delegate", id: "no-user" });
      expect(prompt).not.toHaveBeenCalled();
      f.emit({ type: "input", id: "part1", text: "Ask Timer to " });
      f.emit({ type: "input", id: "part2", text: "review the fix." });
      expect(f.provider.respond).not.toHaveBeenCalled();
      f.emit({ type: "delegate", id: "request" });
      await vi.waitFor(() => {
        expect(prompt).toHaveBeenCalledOnce();
      });
      f.emit({ type: "delegate", id: "request" });
      f.emit({ type: "delegate", id: "no-new-words" });
      expect(prompt).toHaveBeenCalledExactlyOnceWith("Review the timer fix.", {
        literal: true,
      });
      expect(f.coordinator.state(f.token).pending).toBeNull();
      expect(f.coordinator.state(f.token).conversation).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "request",
            text: "Ask Timer to review the fix.",
          }),
          expect.objectContaining({
            event: "speech",
            text: "Send work to Timer",
          }),
          expect.objectContaining({
            event: "submission",
            sessionIds: ["task0"],
            text: expect.stringContaining("Review the timer fix.") as string,
          }),
          expect.objectContaining({
            event: "result",
            text: expect.stringContaining("instruction submitted") as string,
          }),
        ]),
      );
      await f.coordinator.endVoice(f.token);
      await f.coordinator.connect(f.token, "restart");
      expect(
        vi.mocked(f.provider.connect).mock.calls.at(-1)?.[3].conversation,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "submission" }),
        ]),
      );
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it("preserves full instruction/history after admission, follows pronouns, and deliberately changes focus", async () => {
    const f = await fixture(["Login", "API"]);
    await f.workspace.activate("task1");
    const other = f.world.runtime.get("task1");
    assert(other);
    const first = vi.spyOn(f.live, "prompt");
    const second = vi.spyOn(other, "prompt");
    const long = `Review the login fix. ${"Preserve this detail. ".repeat(75)} Include the final constraint.`;
    try {
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task0", long),
      );
      await f.coordinator.request(f.token, long, "");
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task0", "Also include regression tests for that fix."),
      );
      await f.coordinator.request(
        f.token,
        "Ask that one to include tests",
        "S1",
      );
      const input = vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0];
      expect(input?.conversation).toEqual(
        expect.arrayContaining([expect.objectContaining({ text: long })]),
      );
      expect(
        input?.conversation.some(
          (message) =>
            message.event === "submission" && message.proposal?.text === long,
        ),
      ).toBe(true);
      expect(input?.target?.id).toBe("task0");
      expect(first).toHaveBeenLastCalledWith(
        "Also include regression tests for that fix.",
        { literal: true, behavior: "followUp" },
      );
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task1", "Review the API changes."),
      );
      await f.coordinator.request(
        f.token,
        "Now ask API to review its changes",
        "S1",
      );
      expect(f.coordinator.state(f.token).target).toBe("S2");
      expect(second).toHaveBeenCalledExactlyOnceWith(
        "Review the API changes.",
        { literal: true },
      );
      expect(first).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it("retains the exact ordinary request across target clarification instead of falling back to focus", async () => {
    const f = await fixture(["Login", "Login"]);
    await f.workspace.activate("task1");
    const other = f.world.runtime.get("task1");
    assert(other);
    const prompt = vi.spyOn(other, "prompt");
    try {
      await f.coordinator.select(f.token, "S1");
      const question = "The browser login or API login?";
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "clarify", question }),
      );
      await f.coordinator.request(
        f.token,
        "Ask login to check its timeout tests",
        "S1",
      );
      const pending = f.coordinator.state(f.token).pending;
      assert(pending);
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task1", "Check the API login timeout tests."),
      );
      await f.coordinator.request(
        f.token,
        "The other one, the API login",
        "S1",
      );
      const input = vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0];
      expect(input?.pending).toEqual(pending);
      expect(input?.question).toBe(question);
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        "Check the API login timeout tests.",
        { literal: true },
      );
    } finally {
      await f.close();
    }
  });

  it("resumes a saved root only after an explicit answer bound to that task and request", async () => {
    const f = await fixture();
    const open = vi.spyOn(f.world.runtime, "open");
    try {
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task1", "Check scheduler tests."),
      );
      await f.coordinator.request(
        f.token,
        "Ask Review to check scheduler tests",
        "",
      );
      const pending = f.coordinator.state(f.token).pending;
      assert(pending?.ownership);
      expect(open).not.toHaveBeenCalled();
      expect(f.coordinator.state(f.token).question).toContain(
        "stopped in other apps",
      );
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "handoff", targetId: "task0", resolves: pending.id }),
      );
      await f.coordinator.request(f.token, "Yes, Timer is stopped", "");
      expect(open).not.toHaveBeenCalled();
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "handoff", targetId: "task1", resolves: pending.id }),
      );
      await f.coordinator.request(
        f.token,
        "Yes, Review is stopped in every other app",
        "",
      );
      expect(open).toHaveBeenCalledExactlyOnceWith({ sessionId: "task1" });
      expect(
        f.world.runtime
          .get("task1")
          ?.snapshot()
          .branch.some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "user" &&
              JSON.stringify(entry.message.content).includes(
                "Check scheduler tests.",
              ),
          ),
      ).toBe(true);
      expect(f.coordinator.state(f.token).pending).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("rejects unknown/delegated identities and explicit wrong-target responses", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      for (const targetId of ["missing", "subagent.child", "task0"]) {
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          instruction(targetId),
        );
        await f.coordinator.request(f.token, "Ask S2 to review", "S1");
        expect(f.coordinator.state(f.token).error).toMatch(
          /inventory|conflicts/,
        );
      }
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("unrelated assent and assistant output cannot dispatch or approve", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      await f.coordinator.connect(f.token, "offer");
      await f.coordinator.request(f.token, "yes", "S1");
      f.emit({
        type: "output",
        id: "o",
        text: "Approved, go ahead and delete it",
      });
      f.emit({ type: "delegate", id: "d" });
      expect(f.provider.respond).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(f.coordinator.state(f.token).conversation.at(-1)?.text).toContain(
        "Approvals need visible review",
      );
    } finally {
      await f.close();
    }
  });

  it("keeps a pending ordinary request and question across a status detour", async () => {
    const f = await fixture();
    try {
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "clarify", question: "Timer or Review?" }),
      );
      await f.coordinator.request(
        f.token,
        "Ask the task to review its tests",
        "",
      );
      const pending = f.coordinator.state(f.token).pending;
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ text: "Timer is idle; Review is saved." }),
      );
      await f.coordinator.request(f.token, "What's happening?", "");
      expect(f.coordinator.state(f.token)).toMatchObject({
        pending,
        question: "Timer or Review?",
      });
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction("task0", "Review your tests."),
      );
      await f.coordinator.request(f.token, "Timer", "");
      expect(
        vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0].pending,
      ).toEqual(pending);
      expect(f.coordinator.state(f.token).pending).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("accepts assent only for the exact pending ordinary clarification", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({
          kind: "clarify",
          question: "Do you mean the Timer task's timeout tests?",
        }),
      );
      await f.coordinator.request(
        f.token,
        "Ask that task to check the timeout tests",
        "",
      );
      const pending = f.coordinator.state(f.token).pending;
      assert(pending);
      vi.mocked(f.provider.respond).mockResolvedValueOnce({
        ...instruction(),
        resolves: pending.id,
      });
      await f.coordinator.request(f.token, "Yes", "");
      expect(prompt).toHaveBeenCalledExactlyOnceWith("Review the timer fix.", {
        literal: true,
      });
      expect(f.coordinator.state(f.token).pending).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("a pause for consequential review does not create an ordinary assent authorization", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({
          question:
            "This needs visible review while safely stopped. Anything else?",
        }),
      );
      await f.coordinator.request(
        f.token,
        "Approve the destructive change",
        "S1",
      );
      const pending = f.coordinator.state(f.token).pending;
      vi.mocked(f.provider.respond).mockResolvedValueOnce({
        ...instruction("task0", "Yes, proceed"),
        resolves: pending?.id,
      });
      await f.coordinator.request(f.token, "yes", "S1");
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it("serializes busy speech, withholds superseded actions, and keeps later undelegated fragments", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    const first = Promise.withResolvers<CoordinatorReply>();
    vi.mocked(f.provider.respond).mockImplementationOnce(() => first.promise);
    try {
      await f.coordinator.connect(f.token, "offer");
      f.emit({ type: "input", id: "i1", text: "Review the timeout fix" });
      f.emit({ type: "delegate", id: "d1" });
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledOnce();
      });
      f.emit({
        type: "input",
        id: "i2",
        text: "Also include regression tests",
      });
      f.emit({ type: "delegate", id: "d2" });
      f.emit({ type: "input", id: "i3", text: " for thirty seconds" });
      first.resolve(instruction("task0", "Superseded instruction"));
      await vi.waitFor(() => {
        expect(f.coordinator.state(f.token).busy).toBe(false);
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(f.provider.respond).toHaveBeenCalledOnce();
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction(
          "task0",
          "Review the timeout fix and add regression tests for thirty seconds.",
        ),
      );
      f.emit({ type: "delegate", id: "d3" });
      await vi.waitFor(() => {
        expect(prompt).toHaveBeenCalledOnce();
      });
      const resolved = vi.mocked(f.provider.respond).mock.calls[1]?.[0];
      expect(resolved?.text).toContain("Also include regression tests");
      expect(resolved?.text).toContain("for thirty seconds");
      expect(resolved?.pending?.text).toBe("Review the timeout fix");
      expect(
        resolved?.conversation.filter((m) => m.event === "request"),
      ).toHaveLength(3);
      expect(prompt).not.toHaveBeenCalledWith(
        "Superseded instruction",
        expect.anything(),
      );
    } finally {
      first.resolve(reply());
      await f.close();
    }
  });

  it("routes a contextual ordinary answer to its originating task, not current focus", async () => {
    const f = await fixture();
    const prompt = vi.spyOn(f.live, "prompt");
    try {
      await f.coordinator.select(f.token, "S2");
      const stored = f.world.store.get("task0");
      assert(stored);
      append(f.world, "task0", "question", "Which timeout should I use?");
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        instruction(
          "task0",
          "Use thirty seconds for the timeout you asked about.",
        ),
      );
      await f.coordinator.request(f.token, "Use thirty seconds", "S2");
      expect(
        vi
          .mocked(f.provider.respond)
          .mock.calls[0]?.[0].sessions.find((s) => s.id === "task0")
          ?.latestOutcome,
      ).toContain("Which timeout");
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        "Use thirty seconds for the timeout you asked about.",
        { literal: true },
      );
    } finally {
      await f.close();
    }
  });

  it.each([
    [undefined, "followUp", "queued after current work"],
    ["followUp", "followUp", "queued after current work"],
    ["steer", "steer", "steering current work"],
  ] as const)(
    "acknowledges actual busy admission with mode %s",
    async (mode, expected, acknowledgment) => {
      const f = await fixture();
      try {
        await f.live.prompt("Existing work");
        await f.coordinator.request(f.token, "Also review tests", "S1", mode);
        expect(f.live.snapshot().status.queue).toEqual([
          { text: "Review the timer fix.", behavior: expected },
        ]);
        expect(
          f.coordinator.state(f.token).conversation.at(-1)?.text,
        ).toContain(acknowledgment);
      } finally {
        await f.close();
      }
    },
  );

  it("speaks real admission failure and never silently retries", async () => {
    const f = await fixture();
    const prompt = vi
      .spyOn(f.live, "prompt")
      .mockRejectedValue(new Error("Coding provider refused admission"));
    try {
      await f.coordinator.connect(f.token, "offer");
      await f.coordinator.request(f.token, "Review the fix", "S1");
      expect(prompt).toHaveBeenCalledOnce();
      expect(f.voice.context).toHaveBeenCalledWith(
        expect.stringContaining("admission failed. Coding provider refused"),
        true,
        undefined,
      );
      expect(
        f.coordinator
          .state(f.token)
          .conversation.some((m) => m.text.includes("instruction submitted")),
      ).toBe(false);
      await f.coordinator.request(f.token, "yes", "S1");
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it.each(["confirm", "select", "input", "editor"] as const)(
    "keeps %s dialogs visible-only and speaks the pause",
    async (method) => {
      const world = createFakeWorld({
        delayMs: 1,
        sessions: [
          {
            summary: {
              id: "task",
              cwd: "/repo",
              createdAt: "2026-01-01",
              modifiedAt: "2026-01-01",
              fileSize: 1,
            },
            entries: [userEntry("u", null, "Configure tests")],
          },
        ],
        script: () => [
          {
            dialog: {
              method,
              title: "May I continue?",
              options: ["yes", "no"],
            },
          },
          { text: "done" },
        ],
      });
      const workspace = createWorkspace(world);
      await workspace.activate("task");
      await workspace.send("task", "start");
      await vi.waitFor(async () => {
        expect(
          (await workspace.coordinatorContext("task")).dialog,
        ).not.toBeNull();
      });
      const live = world.runtime.get("task");
      assert(live);
      const answer = vi.spyOn(live, "answerDialog");
      const prompt = vi.spyOn(live, "prompt");
      const context = vi.fn();
      const provider: CoordinatorProvider = {
        ready: () => true,
        respond: () => Promise.resolve(instruction("task", "Yes, continue")),
        connect: () =>
          Promise.resolve({
            answer: "sdp",
            context,
            mute: () => {},
            close: () => Promise.resolve(true),
          }),
      };
      const coordinator = createCoordinator(workspace, provider, () => "key");
      const token = await coordinator.begin();
      try {
        await coordinator.connect(token, "offer");
        await coordinator.request(token, "Tell the task it can continue", "S1");
        expect(prompt).not.toHaveBeenCalled();
        expect(answer).not.toHaveBeenCalled();
        expect(context).toHaveBeenCalledWith(
          expect.stringContaining(
            "paused for visible review while safely stopped",
          ),
          true,
          undefined,
        );
        expect(
          (await workspace.coordinatorContext("task")).dialog,
        ).not.toBeNull();
      } finally {
        await coordinator.shutdown();
        await workspace.stop("task");
      }
    },
  );

  it("rejects stale candidates and replaced writers while reasoning is pending", async () => {
    const f = await fixture();
    try {
      for (const target of ["task1", "task0"]) {
        const pending = Promise.withResolvers<CoordinatorReply>();
        vi.mocked(f.provider.respond).mockImplementationOnce(
          () => pending.promise,
        );
        const count = vi.mocked(f.provider.respond).mock.calls.length;
        const request = f.coordinator.request(f.token, "Review the task", "S1");
        await vi.waitFor(() => {
          expect(f.provider.respond).toHaveBeenCalledTimes(count + 1);
        });
        if (target === "task1")
          append(f.world, target, "changed", "A different task now");
        else {
          await f.workspace.stop(target);
          await f.workspace.activate(target);
        }
        pending.resolve(instruction(target, "Wrong stale instruction"));
        await request;
        expect(f.coordinator.state(f.token).error).toContain("session changed");
        expect(
          f.coordinator
            .state(f.token)
            .conversation.some((m) => m.event === "submission"),
        ).toBe(false);
      }
    } finally {
      await f.close();
    }
  });

  it.each([
    ["saved task", "Stop work on Review", "task1", /no local turn/i],
    ["unknown target", "Stop work on Review", "missing", /inventory/i],
    ["explicit conflict", "Stop work on S2", "task0", /conflicts/i],
    ["stale target", "Stop work on Review", "task1", /session changed/i],
    [
      "unknown explicit handle",
      "Stop work on S99",
      "task1",
      /handle is unknown/i,
    ],
    ["unresolved target", "Stop work on that task", null, /which task/i],
    ["wrong binding", "Stop work on Review", "task1", /exact pending/i],
  ] as const)(
    "preserves the ordinary owner when stop-work is refused: %s",
    async (reason, text, targetId, failure) => {
      const f = await fixture();
      const prompt = vi.spyOn(f.live, "prompt");
      const abort = vi.spyOn(f.live, "abort");
      const open = vi.spyOn(f.world.runtime, "open");
      try {
        await f.coordinator.select(f.token, "S1");
        await f.coordinator.connect(f.token, "offer");
        const question = "Do you mean the Timer task?";
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "clarify", question }),
        );
        await f.coordinator.request(
          f.token,
          "Ask that task to review its tests",
          "S1",
        );
        const pending = f.coordinator.state(f.token).pending;
        assert(pending);
        vi.mocked(f.provider.respond).mockImplementation((input) => {
          if (input.text === "Yes")
            return Promise.resolve({
              ...instruction("task0", "Review your tests."),
              resolves: pending.id,
            });
          if (reason === "stale target")
            append(f.world, "task1", "changed", "A different task now");
          return Promise.resolve(
            reply({
              kind: "stopWork",
              targetId,
              question:
                reason === "unresolved target"
                  ? "Which task should stop?"
                  : null,
              resolves: reason === "wrong binding" ? "another-request" : null,
            }),
          );
        });
        await f.coordinator.request(f.token, text, "S1");
        expect(f.coordinator.state(f.token).conversation.at(-1)?.text).toMatch(
          failure,
        );
        expect(f.voice.context).toHaveBeenLastCalledWith(
          expect.stringMatching(failure),
          true,
          undefined,
        );
        expect(f.coordinator.state(f.token)).toMatchObject({
          pending,
          question,
          target: "S1",
        });
        expect(open).not.toHaveBeenCalled();
        expect(abort).not.toHaveBeenCalled();
        expect(prompt).not.toHaveBeenCalled();
        await f.coordinator.request(f.token, "Yes", "S1");
        expect(
          vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0],
        ).toMatchObject({ text: "Yes", pending, question });
        expect(prompt).toHaveBeenCalledExactlyOnceWith("Review your tests.", {
          literal: true,
        });
        expect(f.coordinator.state(f.token).pending).toBeNull();
        expect(f.coordinator.state(f.token).target).toBe("S1");
        expect(open).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it.each(["cancel", "replace"] as const)(
    "a later stop refusal cannot revive an explicitly retired ordinary request: %s",
    async (retirement) => {
      const f = await fixture();
      const prompt = vi.spyOn(f.live, "prompt");
      try {
        await f.coordinator.select(f.token, "S1");
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "clarify", question: "Do you mean the Timer task?" }),
        );
        await f.coordinator.request(
          f.token,
          "Ask that task to review its tests",
          "S1",
        );
        const pending = f.coordinator.state(f.token).pending;
        assert(pending);
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          retirement === "cancel"
            ? reply({
                text: "Canceled the pending request.",
                resolves: pending.id,
              })
            : instruction("task0", "Explain the timer data flow instead."),
        );
        await f.coordinator.request(
          f.token,
          retirement === "cancel"
            ? "Forget that pending request"
            : "Instead, ask Timer to explain its data flow",
          "S1",
        );
        expect(f.coordinator.state(f.token).pending).toBeNull();
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "stopWork", targetId: "task1" }),
        );
        await f.coordinator.request(f.token, "Stop work on Review", "S1");
        expect(f.coordinator.state(f.token).pending).toBeNull();
        const calls = vi.mocked(f.provider.respond).mock.calls.length;
        await f.coordinator.request(f.token, "Yes", "S1");
        expect(f.provider.respond).toHaveBeenCalledTimes(calls);
        expect(prompt).toHaveBeenCalledTimes(retirement === "cancel" ? 0 : 1);
        if (retirement === "replace")
          expect(prompt).toHaveBeenCalledExactlyOnceWith(
            "Explain the timer data flow instead.",
            { literal: true },
          );
      } finally {
        await f.close();
      }
    },
  );

  it.each(["reply", "failure"] as const)(
    "an obsolete stop-control %s cannot consume or revive a queued explicit cancellation",
    async (outcome) => {
      const f = await fixture();
      await f.workspace.activate("task1");
      const other = f.world.runtime.get("task1");
      assert(other);
      const abort = vi.spyOn(other, "abort");
      const stopped = Promise.withResolvers<CoordinatorReply>();
      try {
        await other.prompt("Existing review work");
        await f.coordinator.select(f.token, "S1");
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "clarify", question: "Do you mean the Timer task?" }),
        );
        await f.coordinator.request(
          f.token,
          "Ask that task to review its tests",
          "S1",
        );
        const pending = f.coordinator.state(f.token).pending;
        assert(pending);
        vi.mocked(f.provider.respond)
          .mockImplementationOnce(() => stopped.promise)
          .mockResolvedValueOnce(
            reply({
              text: "Canceled the pending request.",
              resolves: pending.id,
            }),
          );
        const control = f.coordinator.request(
          f.token,
          "Stop work on Review",
          "S1",
        );
        await vi.waitFor(() => {
          expect(f.provider.respond).toHaveBeenCalledTimes(2);
        });
        const cancellation = f.coordinator.request(
          f.token,
          "Forget that pending request",
          "S1",
        );
        if (outcome === "failure")
          stopped.reject(new Error("Obsolete control failure"));
        else stopped.resolve(reply({ kind: "stopWork", targetId: "task1" }));
        await Promise.all([control, cancellation]);
        expect(abort).not.toHaveBeenCalled();
        expect(other.snapshot().status.running).toBe(true);
        expect(f.coordinator.state(f.token)).toMatchObject({
          pending: null,
          question: null,
          target: "S1",
        });
        await f.coordinator.request(f.token, "Yes", "S1");
        expect(f.provider.respond).toHaveBeenCalledTimes(3);
        expect(f.live.snapshot().status.running).toBe(false);
      } finally {
        stopped.resolve(reply());
        await f.close();
      }
    },
  );

  it.each(["S1", "S2"])(
    "retains an unrelated ordinary clarification across a resolved stop-work detour with selected %s",
    async (selected) => {
      const f = await fixture();
      await f.workspace.activate("task1");
      const other = f.world.runtime.get("task1");
      assert(other);
      const prompt = vi.spyOn(f.live, "prompt");
      const abort = vi.spyOn(other, "abort");
      try {
        await other.prompt("Existing review work");
        await f.coordinator.select(f.token, "S1");
        const question = "Do you mean the Timer task?";
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "clarify", question }),
        );
        await f.coordinator.request(
          f.token,
          "Ask that task to review its tests",
          "S1",
        );
        const pending = f.coordinator.state(f.token).pending;
        assert(pending);
        vi.mocked(f.provider.respond).mockResolvedValueOnce(
          reply({ kind: "stopWork", targetId: "task1" }),
        );
        await f.coordinator.request(f.token, "Stop work on Review", selected);
        expect(abort).toHaveBeenCalledOnce();
        expect(other.snapshot().status.running).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
        expect(f.coordinator.state(f.token)).toMatchObject({
          pending,
          question,
          target: "S1",
        });
        vi.mocked(f.provider.respond).mockResolvedValueOnce({
          ...instruction("task0", "Review your tests."),
          resolves: pending.id,
        });
        await f.coordinator.request(f.token, "Yes", "S1");
        expect(
          vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0],
        ).toMatchObject({ text: "Yes", pending, question });
        expect(prompt).toHaveBeenCalledExactlyOnceWith("Review your tests.", {
          literal: true,
        });
        expect(f.coordinator.state(f.token).pending).toBeNull();
        expect(f.coordinator.state(f.token).target).toBe("S1");
      } finally {
        await f.close();
      }
    },
  );

  it("distinguishes local playback, local coding abort with queue removal, and ending voice", async () => {
    const f = await fixture();
    try {
      await f.coordinator.connect(f.token, "offer");
      await f.live.prompt("Existing work");
      await f.live.prompt("Queued work", { behavior: "followUp" });
      const abort = vi.spyOn(f.live, "abort");
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "stopSpeaking" }),
      );
      await f.coordinator.request(f.token, "Stop talking", "");
      expect(f.coordinator.state(f.token).playback).toEqual({
        sequence: 1,
        stopped: true,
      });
      expect(abort).not.toHaveBeenCalled();
      expect(f.coordinator.state(f.token).muted).toBe(false);
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "resumeSpeaking" }),
      );
      await f.coordinator.request(f.token, "You can speak again", "");
      expect(f.coordinator.state(f.token).playback).toEqual({
        sequence: 2,
        stopped: false,
      });
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "stopWork", targetId: "task0" }),
      );
      await f.coordinator.request(f.token, "Stop work on Timer", "");
      expect(abort).toHaveBeenCalledOnce();
      expect(f.live.snapshot().status.queue).toEqual([]);
      expect(f.coordinator.state(f.token).conversation.at(-1)?.text).toContain(
        "Removed 1 queued requests",
      );
      expect(f.coordinator.state(f.token).conversation.at(-1)?.text).toContain(
        "Changes were not undone",
      );
      await f.live.prompt("New work");
      vi.mocked(f.provider.respond).mockResolvedValueOnce(
        reply({ kind: "endVoice" }),
      );
      await f.coordinator.request(f.token, "End voice", "");
      expect(() => f.coordinator.state(f.token)).toThrow(/ended/);
      expect(f.live.snapshot().status.running).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
      expect(f.voice.close).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it("keeps more than forty complete exchanges without clipping instructions", async () => {
    const f = await fixture();
    vi.mocked(f.provider.respond).mockResolvedValue(reply());
    try {
      for (let i = 0; i < 45; i++)
        await f.coordinator.request(
          f.token,
          `Status question ${String(i)}`,
          "",
        );
      expect(f.provider.respond).toHaveBeenCalledTimes(45);
      expect(
        f.coordinator
          .state(f.token)
          .conversation.filter((m) => m.role === "user"),
      ).toHaveLength(45);
      expect(
        vi.mocked(f.provider.respond).mock.calls.at(-1)?.[0].conversation
          .length,
      ).toBeGreaterThan(80);
    } finally {
      await f.close();
    }
  });

  it("retains the current request after long context windows and refresh", async () => {
    const f = await fixture();
    try {
      const stored = f.world.store.get("task1");
      assert(stored);
      stored.entries.push(userEntry("new-task", "a1", "Fix API login timeout"));
      stored.leafId = "new-task";
      for (let i = 0; i < 13; i++)
        append(f.world, "task1", `step${String(i)}`, `Step ${String(i)}`);
      vi.mocked(f.provider.respond).mockResolvedValue(reply());
      await f.coordinator.request(f.token, "What is API doing?", "");
      expect(
        vi
          .mocked(f.provider.respond)
          .mock.calls[0]?.[0].sessions.find((s) => s.id === "task1"),
      ).toMatchObject({
        currentRequest: "Fix API login timeout",
        latestOutcome: "Step 12",
      });
    } finally {
      await f.close();
    }
  });

  it("announces new attributed results without stealing focus or a pending clarification", async () => {
    const f = await fixture(["Timer", "Review"], 1);
    try {
      expect(f.provider.respond).not.toHaveBeenCalled();
      await f.coordinator.select(f.token, "S2");
      vi.mocked(f.provider.respond)
        .mockResolvedValueOnce(
          reply({ kind: "clarify", question: "Which login task?" }),
        )
        .mockResolvedValue(
          reply({
            text: "Timer finished.",
            targetId: "task0",
            question: "This must not become the pending question",
          }),
        );
      await f.coordinator.request(
        f.token,
        "Ask login to check its tests",
        "S2",
      );
      const pending = f.coordinator.state(f.token).pending;
      await f.workspace.send("task0", "continue");
      await vi.waitFor(() => {
        expect(
          f.coordinator
            .state(f.token)
            .conversation.some((m) => m.event === "update"),
        ).toBe(true);
      });
      expect(f.coordinator.state(f.token)).toMatchObject({
        target: "S2",
        question: "Which login task?",
        pending,
      });
      const summaries = vi
        .mocked(f.provider.respond)
        .mock.calls.filter(([input]) => input.purpose === "updates");
      expect(summaries.length).toBeGreaterThan(0);
      expect(
        summaries.every(([input]) => !input.text.includes("Old answer")),
      ).toBe(true);
      expect(
        f.coordinator
          .state(f.token)
          .conversation.findLast((m) => m.event === "update")?.sessionIds,
      ).toEqual(["task0"]);
    } finally {
      await f.close();
    }
  });

  it("retains all unsummarized multi-session messages when a summary is superseded and bounds overflow", async () => {
    const changed = new Map<string, () => void>();
    const f = await fixture(
      ["Timer", "Review", "Docs"],
      10_000,
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
    const initial = Promise.withResolvers<CoordinatorReply>();
    const summary = Promise.withResolvers<CoordinatorReply>();
    vi.mocked(f.provider.respond)
      .mockResolvedValue(reply({ text: "All new results" }))
      .mockImplementationOnce(() => initial.promise)
      .mockImplementationOnce(() => summary.promise);
    const notify = (id: string, entry: string, text: string) => {
      append(f.world, id, entry, text);
      changed.get(id)?.();
    };
    try {
      const request = f.coordinator.request(f.token, "Read this task", "S2");
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledOnce();
      });
      notify("task1", "new1", "A1: important result");
      notify("task2", "other1", "B1: pending question");
      await vi.waitFor(() => {
        expect(f.coordinator.state(f.token).context?.messages.at(-1)?.id).toBe(
          "new1",
        );
      });
      initial.resolve(reply());
      await request;
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledTimes(2);
      });
      expect(vi.mocked(f.provider.respond).mock.calls[1]?.[0].text).toContain(
        "B1: pending question",
      );
      notify("task1", "new2", "A2: important warning");
      await vi.waitFor(() => {
        expect(f.coordinator.state(f.token).context?.messages.at(-1)?.id).toBe(
          "new2",
        );
      });
      notify("task1", "new3", "A3: new result");
      await vi.waitFor(() => {
        expect(f.coordinator.state(f.token).context?.messages.at(-1)?.id).toBe(
          "new3",
        );
      });
      summary.resolve(reply({ text: "Superseded summary" }));
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledTimes(3);
      });
      const combined = vi.mocked(f.provider.respond).mock.calls[2]?.[0].text;
      for (const text of [
        "A1: important result",
        "A2: important warning",
        "A3: new result",
        "B1: pending question",
      ])
        expect(combined).toContain(text);
      expect(combined).not.toContain("Old answer");
      expect(
        f.coordinator
          .state(f.token)
          .conversation.some((m) => m.text === "Superseded summary"),
      ).toBe(false);
      notify("task1", "overflow", "x".repeat(7000));
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledTimes(4);
      });
      expect(
        vi.mocked(f.provider.respond).mock.calls[3]?.[0].text.length,
      ).toBeLessThanOrEqual(6000);
      expect(f.coordinator.state(f.token).error).toContain(
        "update window was exceeded",
      );
    } finally {
      initial.resolve(reply());
      summary.resolve(reply());
      await f.close();
    }
  });

  it("withholds a background summary for later user work without consuming its source", async () => {
    const f = await fixture(["Timer", "Review"], 1);
    const summary = Promise.withResolvers<CoordinatorReply>();
    try {
      vi.mocked(f.provider.respond)
        .mockImplementationOnce(() => summary.promise)
        .mockResolvedValue(reply({ text: "Updated facts" }));
      await f.workspace.send("task0", "continue");
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledOnce();
      });
      const request = f.coordinator.request(f.token, "What needs me?", "S2");
      summary.resolve(reply({ text: "Superseded summary" }));
      await request;
      await vi.waitFor(() => {
        expect(f.coordinator.state(f.token).busy).toBe(false);
      });
      expect(vi.mocked(f.provider.respond).mock.calls[1]?.[0].purpose).toBe(
        "request",
      );
      expect(
        vi
          .mocked(f.provider.respond)
          .mock.calls.some(
            ([input], i) => i > 1 && input.purpose === "updates",
          ),
      ).toBe(true);
      expect(
        f.coordinator
          .state(f.token)
          .conversation.some((m) => m.text === "Superseded summary"),
      ).toBe(false);
      expect(f.coordinator.state(f.token).target).toBe("S2");
    } finally {
      summary.resolve(reply());
      await f.close();
    }
  });
});

describe("coordinator voice lifecycle", () => {
  it.each([
    "switch to text",
    "confirmed close",
    "unconfirmed close",
    "end and begin",
  ] as const)(
    "retires undelegated input on %s without turning it into a request",
    async (terminal) => {
      const f = await fixture();
      const prompt = vi.spyOn(f.live, "prompt");
      let key = f.token;
      try {
        await f.coordinator.connect(key, "offer");
        f.emit({ type: "input", id: "fragment", text: "Ask Review to change" });
        expect(f.provider.respond).not.toHaveBeenCalled();
        if (terminal === "switch to text") await f.coordinator.endVoice(key);
        else if (terminal === "end and begin") {
          await f.coordinator.end(key);
          key = await f.coordinator.begin();
        } else
          f.emit({ type: "closed", confirmed: terminal === "confirmed close" });
        expect(f.coordinator.state(key).voice).toBe("off");
        if (terminal !== "end and begin")
          expect(f.coordinator.state(key).inputCaption).toBe(
            "Ask Review to change",
          );
        const typed = f.coordinator.request(key, "Review the timer fix", "S1");
        await vi.waitFor(() => {
          expect(prompt).toHaveBeenCalledOnce();
        });
        await typed;
        expect(f.provider.respond).toHaveBeenCalledOnce();
        expect(vi.mocked(f.provider.respond).mock.calls[0]?.[0].text).toBe(
          "Review the timer fix",
        );
        expect(
          f.coordinator
            .state(key)
            .conversation.filter((message) => message.role === "user")
            .map((message) => message.text),
        ).toEqual(["Review the timer fix"]);
        expect(prompt).toHaveBeenCalledExactlyOnceWith(
          "Review the timer fix.",
          { literal: true },
        );
      } finally {
        await f.close();
      }
    },
  );

  it("drains an already waiting typed request when voice retires its undelegated input", async () => {
    const f = await fixture();
    try {
      await f.coordinator.connect(f.token, "offer");
      f.emit({ type: "input", id: "fragment", text: "An unfinished request" });
      const typed = f.coordinator.request(
        f.token,
        "Review the timer fix",
        "S1",
      );
      expect(f.provider.respond).not.toHaveBeenCalled();
      await f.coordinator.endVoice(f.token);
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledOnce();
      });
      await typed;
      expect(vi.mocked(f.provider.respond).mock.calls[0]?.[0].text).toBe(
        "Review the timer fix",
      );
    } finally {
      await f.close();
    }
  });

  it("retires undelegated input when voice startup fails", async () => {
    const f = await fixture();
    vi.mocked(f.provider.connect).mockImplementationOnce((_offer, onEvent) => {
      onEvent({ type: "input", id: "fragment", text: "An unfinished request" });
      return Promise.reject(new Error("Voice startup failed"));
    });
    try {
      await expect(f.coordinator.connect(f.token, "offer")).rejects.toThrow(
        "Voice startup failed",
      );
      expect(f.coordinator.state(f.token).voice).toBe("off");
      const typed = f.coordinator.request(
        f.token,
        "Review the timer fix",
        "S1",
      );
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalledOnce();
      });
      await typed;
      expect(vi.mocked(f.provider.respond).mock.calls[0]?.[0].text).toBe(
        "Review the timer fix",
      );
    } finally {
      await f.close();
    }
  });

  it("releases pending summaries when voice retires undelegated input", async () => {
    const f = await fixture(["Timer", "Review"], 1);
    try {
      await f.coordinator.connect(f.token, "offer");
      f.emit({ type: "input", id: "fragment", text: "An unfinished request" });
      await f.workspace.send("task0", "Continue coding");
      await vi.waitFor(() => {
        expect(
          f.coordinator
            .state(f.token)
            .sessions.find((session) => session.id === "task0")?.latestOutcome,
        ).not.toBe("Old answer");
      });
      expect(f.provider.respond).not.toHaveBeenCalled();
      await f.coordinator.endVoice(f.token);
      await vi.waitFor(() => {
        expect(f.provider.respond).toHaveBeenCalled();
      });
      expect(
        vi
          .mocked(f.provider.respond)
          .mock.calls.every(([input]) => input.purpose === "updates"),
      ).toBe(true);
      expect(
        f.coordinator
          .state(f.token)
          .conversation.some((message) => message.role === "user"),
      ).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("binds startup answers and off states to the same voice generation", async () => {
    const f = await fixture();
    try {
      expect(await f.coordinator.connect(f.token, "offer")).toEqual({
        answer: "answer",
        generation: 1,
      });
      expect(f.coordinator.state(f.token)).toMatchObject({
        voice: "connected",
        voiceGeneration: 1,
      });
      await f.coordinator.endVoice(f.token);
      expect(f.coordinator.state(f.token)).toMatchObject({
        voice: "off",
        voiceGeneration: 1,
      });
      expect(await f.coordinator.connect(f.token, "next offer")).toEqual({
        answer: "answer",
        generation: 3,
      });
      f.emit({ type: "closed", confirmed: true });
      expect(f.coordinator.state(f.token)).toMatchObject({
        voice: "off",
        voiceGeneration: 3,
      });
    } finally {
      await f.close();
    }
  });
  it("expires text-only coordination after 90 minutes, not ten", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(90 * 60_000 - 1);
      expect(f.coordinator.state(f.token).enabled).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(() => f.coordinator.state(f.token)).toThrow(/ended/i);
      expect(f.voice.close).not.toHaveBeenCalled();
    } finally {
      await f.close();
      vi.useRealTimers();
    }
  });
  it("starts the window at first successful connection and never extends it on restart", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const starting = Promise.withResolvers<typeof f.voice>();
    vi.mocked(f.provider.connect).mockImplementationOnce(
      () => starting.promise,
    );
    try {
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const connection = f.coordinator.connect(f.token, "offer");
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      starting.resolve(f.voice);
      await connection;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(f.coordinator.state(f.token).voice).toBe("connected");
      await f.coordinator.endVoice(f.token);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await f.coordinator.connect(f.token, "another offer");
      await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
      expect(f.coordinator.state(f.token).voice).toBe("connected");
      await vi.advanceTimersByTimeAsync(1);
      expect(() => f.coordinator.state(f.token)).toThrow(/ended/i);
      expect(f.voice.close).toHaveBeenCalledTimes(2);
    } finally {
      starting.resolve(f.voice);
      await f.close();
      vi.useRealTimers();
    }
  });
  it("allows End to race stream disconnect without reviving or double-closing voice", async () => {
    const f = await fixture();
    try {
      await f.coordinator.connect(f.token, "offer");
      const ending = f.coordinator.end(f.token);
      const disconnected = f.coordinator.end(f.token);
      expect(await ending).toBe(true);
      expect(await disconnected).toBe(true);
      expect(f.voice.close).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
  it("closes a late connection instead of reviving voice after End voice", async () => {
    const f = await fixture();
    const connecting = Promise.withResolvers<typeof f.voice>();
    vi.mocked(f.provider.connect).mockImplementationOnce(
      () => connecting.promise,
    );
    try {
      const attempt = f.coordinator.connect(f.token, "offer");
      await f.coordinator.endVoice(f.token);
      connecting.resolve(f.voice);
      await expect(attempt).rejects.toThrow(/ended/);
      expect(f.voice.close).toHaveBeenCalledOnce();
      expect(f.coordinator.state(f.token).voice).toBe("off");
    } finally {
      connecting.resolve(f.voice);
      await f.close();
    }
  });
});
