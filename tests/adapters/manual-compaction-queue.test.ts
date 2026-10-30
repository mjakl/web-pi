import { createFakeWorld } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { editableUserMessage } from "@core/session-entries";
import { recoverSkillPrompt } from "@core/skill-prompt";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createHarness,
  gate,
  messages,
  next,
  reply,
  until,
  type Harness,
} from "./pi-harness.ts";

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h.dispose();
});

async function seeded(options: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness({
    ...options,
    settings: {
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 20 },
      ...options.settings,
    },
  });
  const session = await h.open();
  for (const text of ["one", "two"]) {
    h.script(reply(`${text} answer `.repeat(20)));
    const done = next(session, "turn_done");
    await session.prompt(text);
    await done;
  }
  return session;
}

it("accepts and displays manual-compaction submissions, then dispatches steering before follow-ups", async () => {
  const session = await seeded();
  const hold = gate();
  h.script(
    async (turn) => {
      turn.text("Summary");
      await hold.wait;
      turn.done();
    },
    reply("Steering answer"),
    reply("Follow-up answer"),
  );
  const compacting = session.compact();
  void compacting.catch(() => {});
  await until(session, (s) => s.status.compacting);
  const workspace = createWorkspace({
    ...createFakeWorld(),
    runtime: h.runtime,
    sessions: h.catalog,
  });
  const app = createWebApp({
    workspace,
    defaultCwd: h.cwd,
    staticRoot: "static",
  });
  for (const [text, behavior] of [
    ["later", "followUp"],
    ["first", "steer"],
  ] as const) {
    const response = await app.request(`/sessions/${session.id}/prompt`, {
      method: "POST",
      body: new URLSearchParams({ text, behavior }),
    });
    expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
  }
  expect(session.snapshot().status.queue).toEqual([
    { text: "first", behavior: "steer", images: [] },
    { text: "later", behavior: "followUp", images: [] },
  ]);
  const page = await (await app.request(`/sessions/${session.id}`)).text();
  expect(page).toContain("first");
  expect(page).toContain("later");
  expect(h.calls).toHaveLength(3);
  hold.open();
  await compacting;
  await until(
    session,
    (s) =>
      !s.status.running &&
      messages(session).includes("assistant:Follow-up answer"),
  );
  expect(messages(session).filter((text) => text.startsWith("user:"))).toEqual([
    "user:one",
    "user:two",
    "user:first",
    "user:later",
  ]);
  expect(session.snapshot().status.queue).toEqual([]);
});

it("refuses manual compaction while a prompt is waiting in an input hook", async () => {
  const entered = gate();
  const hold = gate();
  const session = await seeded({
    extensions: [
      (pi) => {
        pi.on("input", async (event) => {
          if (event.text === "delayed") {
            entered.open();
            await hold.wait;
          }
        });
      },
    ],
  });
  h.script(reply("Answer"));
  const prompt = session.prompt("delayed");
  await entered.wait;
  try {
    await expect(session.compact()).rejects.toThrow("idle");
  } finally {
    hold.open();
    await prompt;
  }
});

it("preserves selected skills, exact text and attachments through dispatch and recall", async () => {
  const session = await seeded();
  const id = join(h.agentDir, "skills", "check", "SKILL.md");
  await mkdir(join(h.agentDir, "skills", "check"), { recursive: true });
  await writeFile(
    id,
    "---\nname: check\ndescription: Check things\n---\nRead carefully.",
  );
  await session.reload();
  const selected = { id, name: "check" };
  const images = [
    {
      data: (await readFile("static/icons/favicon-light.png")).toString(
        "base64",
      ),
      mimeType: "image/png",
    },
  ];
  const text = "  request 🐙\n\nwith spaces  ";
  const hold = gate();
  h.script(
    async (turn) => {
      turn.text("Summary");
      await hold.wait;
      turn.done();
    },
    reply("Turn prefix summary"),
    reply("Answer"),
  );
  const compacting = session.compact();
  await session.prompt(text, {
    skills: [selected],
    images,
    behavior: "followUp",
  });
  const queued = session.snapshot().status.queue[0];
  expect(queued?.images).toEqual(images);
  expect(recoverSkillPrompt(queued?.text ?? "")).toMatchObject({
    text,
    skills: [selected],
  });
  const answered = next(session, "turn_done");
  hold.open();
  await compacting;
  await answered;
  expect(messages(session).at(-1)).toBe("assistant:Answer");
  const entry = session
    .snapshot()
    .branch.findLast(
      (value) => value.type === "message" && value.message.role === "user",
    );
  if (!entry) throw new Error("Missing request");
  expect(editableUserMessage(entry)).toEqual({
    text,
    skills: [selected],
    images,
  });

  const again = gate();
  h.script(async (turn) => {
    turn.text("Another summary");
    await again.wait;
    turn.done();
  });
  const compactingAgain = session.compact();
  void compactingAgain.catch(() => {});
  await session.prompt(text, { skills: [selected], images });
  await session.prompt(text, {
    skills: [selected],
    images: [{ data: "b3RoZXI=", mimeType: "image/png" }],
  });
  const recalled = session.clearQueue();
  expect(recalled).toHaveLength(2);
  expect(recalled.map((message) => message.images?.[0]?.data)).toEqual([
    images[0]?.data,
    "b3RoZXI=",
  ]);
  expect(
    recalled.map((message) => recoverSkillPrompt(message.text)?.text),
  ).toEqual([text, text]);
  again.open();
  await compactingAgain;
  expect(session.snapshot().status.queue).toEqual([]);
});

it.each(["cancel", "stop", "failure"])(
  "keeps queued messages recallable after %s",
  async (action) => {
    const session = await seeded();
    const started = gate();
    const hold = gate();
    h.script(async (turn) => {
      started.open();
      await hold.wait;
      if (action === "failure") turn.error("summary failed");
      else turn.done();
    });
    const compacting = session.compact();
    const outcome = compacting.catch((error: unknown) => error);
    await started.wait;
    const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
    await session.prompt("Keep me", { behavior: "followUp", images });
    if (action === "cancel") session.abortCompaction();
    if (action === "stop") await session.abort();
    hold.open();
    await outcome;
    expect(session.snapshot().status.queue).toEqual([
      { text: "Keep me", behavior: "followUp", images },
    ]);
    expect(
      session
        .snapshot()
        .status.notices.filter((notice) =>
          notice.message.includes("Recall the queue"),
        ),
    ).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
    expect(session.clearQueue()).toEqual([
      { text: "Keep me", behavior: "followUp", images },
    ]);
    expect(session.snapshot().status.queue).toEqual([]);
  },
);

it("resumes a parked queue in order when the reader sends a new message", async () => {
  const session = await seeded();
  const entered = gate();
  h.script(() => {
    entered.open();
  });
  const compacting = session.compact().catch((error: unknown) => error);
  await entered.wait;
  await session.prompt("parked");
  session.abortCompaction();
  await compacting;
  h.script(reply("Resumed"), reply("Next"));
  await session.prompt("new message");
  await until(
    session,
    (snapshot) =>
      !snapshot.status.running &&
      messages(session).includes("user:new message"),
  );
  expect(messages(session).filter((text) => text.startsWith("user:"))).toEqual([
    "user:one",
    "user:two",
    "user:parked",
    "user:new message",
  ]);
  expect(session.snapshot().status.queue).toEqual([]);
});

it("reserves compaction before its SDK event and honors cancellation in that gap", async () => {
  const session = await seeded();
  const compacting = session.compact();
  const outcome = compacting.catch((error: unknown) => error);
  await session.prompt("Keep me");
  await expect(session.compact()).rejects.toThrow("idle");
  session.abortCompaction();
  await outcome;
  expect(session.snapshot().status.queue).toEqual([
    { text: "Keep me", behavior: "steer" },
  ]);
  expect(h.calls).toHaveLength(2);
});

it("retains unaccepted deferred dispatch failures but does not replay accepted run failures", async () => {
  const session = await seeded();
  const hold = gate();
  h.script(async (turn) => {
    turn.text("Summary");
    await hold.wait;
    turn.done();
  });
  const compacting = session.compact();
  await until(session, (s) => s.status.compacting);
  await session.prompt("Keep me");
  const prompt = vi
    .spyOn(AgentSession.prototype, "prompt")
    .mockRejectedValueOnce(new Error("dispatch unavailable"));
  hold.open();
  await compacting;
  await until(session, (s) =>
    s.status.notices.some((notice) =>
      notice.message.includes("Recall the queue"),
    ),
  );
  expect(session.clearQueue()).toEqual([
    { text: "Keep me", behavior: "steer" },
  ]);
  prompt.mockRestore();
  h.script(new Error("provider failed"));
  const done = next(session, "turn_done");
  await session.prompt("Keep me");
  await done;
  expect(session.snapshot().status.queue).toEqual([]);
  const failed = session
    .snapshot()
    .branch.findLast((entry) => entry.type === "message");
  expect(failed?.type === "message" ? failed.message : undefined).toMatchObject(
    {
      role: "assistant",
      errorMessage: "provider failed",
    },
  );
});

it.each(["recall", "stop"])(
  "does not run deferred work after %s during its input hook",
  async (action) => {
    const entered = gate();
    const holdInput = gate();
    const session = await seeded({
      extensions: [
        (pi) => {
          pi.on("input", async (event) => {
            if (event.text === "delayed") {
              entered.open();
              await holdInput.wait;
            }
          });
        },
      ],
    });
    const holdSummary = gate();
    h.script(async (turn) => {
      turn.text("Summary");
      await holdSummary.wait;
      turn.done();
    });
    const compacting = session.compact();
    await session.prompt("delayed");
    holdSummary.open();
    await compacting;
    await entered.wait;
    if (action === "recall")
      expect(session.clearQueue()).toEqual([
        { text: "delayed", behavior: "steer" },
      ]);
    else await session.abort();
    const callsBefore = h.calls.length;
    const done = next(session, "turn_done");
    holdInput.open();
    await done;
    expect(h.calls).toHaveLength(callsBefore);
    expect(session.snapshot().status.queue).toEqual(
      action === "recall" ? [] : [{ text: "delayed", behavior: "steer" }],
    );
  },
);

it("preserves the SDK queue when Stop races a deferred queue admission", async () => {
  const input = gate();
  const releaseInput = gate();
  const ending = gate();
  const releaseEnd = gate();
  const summary = gate();
  const providerStarted = gate();
  let holdEnd = false;
  const session = await seeded({
    extensions: [
      (pi) => {
        pi.on("session_before_compact", async (event) => {
          await summary.wait;
          return {
            compaction: {
              summary: "Summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
        pi.on("input", async (event) => {
          if (event.text === "second") await providerStarted.wait;
          if (event.text === "third") {
            input.open();
            await releaseInput.wait;
          }
        });
        pi.on("agent_end", async () => {
          if (holdEnd) {
            ending.open();
            await releaseEnd.wait;
          }
        });
      },
    ],
  });
  h.script(() => {
    providerStarted.open();
  });
  const compacting = session.compact();
  await session.prompt("first");
  await session.prompt("second");
  await session.prompt("third");
  summary.open();
  await compacting;
  await input.wait;
  holdEnd = true;
  const aborting = session.abort();
  await ending.wait;
  releaseInput.open();
  try {
    await vi.waitFor(() => {
      expect(session.snapshot().status.queue.map((item) => item.text)).toEqual([
        "second",
        "third",
      ]);
    });
  } finally {
    releaseEnd.open();
    await aborting;
  }
  expect(session.clearQueue().map((item) => item.text)).toEqual([
    "second",
    "third",
  ]);
});

it("keeps accepted messages recoverable when Stop reaches an unwritten session", async () => {
  h = await createHarness();
  const session = await h.open();
  const compacting = session.compact().catch((error: unknown) => error);
  await session.prompt("Keep this draft");
  await compacting;
  await session.abort();
  expect(h.runtime.get(session.id)).toBe(session);
  expect(session.clearQueue()).toEqual([
    { text: "Keep this draft", behavior: "steer" },
  ]);
  expect(h.calls).toHaveLength(0);
});

it("keeps manual ownership until failure hooks settle", async () => {
  const entered = gate();
  const finish = gate();
  const session = await seeded({
    extensions: [
      (pi) => {
        pi.on("session_compact_failed", async () => {
          entered.open();
          await finish.wait;
        });
      },
    ],
  });
  h.script((turn) => {
    turn.error("summary failed");
  });
  const compacting = session.compact().catch((error: unknown) => error);
  await entered.wait;
  expect(session.snapshot().status.compacting).toBe(true);
  await session.prompt("during failure cleanup");
  await expect(session.compact()).rejects.toThrow("idle");
  expect(session.snapshot().status.queue).toEqual([
    { text: "during failure cleanup", behavior: "steer" },
  ]);
  finish.open();
  await compacting;
  expect(session.snapshot().status.compacting).toBe(false);
  expect(session.clearQueue()).toHaveLength(1);
});

it("continues to use the SDK queue during automatic compaction", async () => {
  const session = await seeded({
    settings: {
      compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 20 },
    },
  });
  const entered = gate();
  const hold = gate();
  h.script(
    reply("Full", { input: 3500, output: 10 }),
    async (turn) => {
      entered.open();
      await hold.wait;
      turn.text("Automatic summary");
      turn.done();
    },
    reply("Turn prefix summary"),
    reply("Queued answer"),
  );
  await session.prompt("fill context");
  await entered.wait;
  await session.prompt("during automatic compaction", { behavior: "followUp" });
  expect(session.snapshot().status.queue).toEqual([
    { text: "during automatic compaction", behavior: "followUp" },
  ]);
  const done = next(session, "turn_done");
  hold.open();
  await done;
  expect(messages(session).at(-1)).toBe("assistant:Queued answer");
  expect(session.snapshot().status.queue).toEqual([]);
});
