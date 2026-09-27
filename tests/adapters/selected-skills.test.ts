import { createPiProjectResources } from "@adapters/pi/resources";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { editableUserMessage, rowMetadata } from "@core/session-entries";
import { projectTranscript } from "@core/transcript";
import { decodeSkillPrompt, recallSkillPrompts } from "@core/skill-prompt";
import { conversationRail } from "@core/conversation-rail";
import {
  AgentSession,
  type ExtensionAPI,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  gate,
  type Harness,
  next,
  until,
} from "./pi-harness.ts";

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.dispose();
});

async function skill(name: string, body: string, manual = false) {
  const base = join(h.agentDir, "skills", name);
  const id = join(base, "SKILL.md");
  await mkdir(base, { recursive: true });
  await writeFile(
    id,
    `---\nname: ${name}\ndescription: ${name} workflow\n${manual ? "disable-model-invocation: true\n" : ""}---\n${body}\n`,
  );
  return { id, name };
}

function envelope(selected: { id: string; name: string }, body: string) {
  return `<skill name="${selected.name}" location="${selected.id}">\nReferences are relative to ${dirname(selected.id)}.\n\n${body}\n</skill>`;
}

function userText(session: Awaited<ReturnType<Harness["open"]>>) {
  const entry = session
    .snapshot()
    .branch.find(
      (value) => value.type === "message" && value.message.role === "user",
    );
  if (entry?.type !== "message" || entry.message.role !== "user")
    throw new Error("Missing user message");
  const content = entry.message.content;
  return {
    entry,
    text:
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
  };
}

describe("selected skills through Pi", () => {
  it("sends current instructions through one SDK prompt and input hook, persisting the exact draft and ordered dropdown selections", async () => {
    const inputs: string[] = [];
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("input", (event) => {
            inputs.push(event.text);
            return { action: "continue" };
          });
        },
      ],
    });
    const first = await skill("first", "old instructions");
    const second = await skill("second", "Manual instructions", true);
    const session = await h.open();
    const systemPrompt = session.systemPrompt();
    const settings = await readFile(join(h.agentDir, "settings.json"), "utf8");
    await writeFile(
      first.id,
      "---\nname: first\ndescription: first workflow\n---\nCurrent instructions\n",
    );
    const prompt = vi.spyOn(AgentSession.prototype, "prompt");
    const done = next(session, "turn_done");
    const original = "  explain 🐙\n\nwith spaces  ";
    await session.prompt(original, { skills: [second, first, second] });
    await done;
    const { entry, text } = userText(session);
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      text,
      expect.objectContaining({ expandPromptTemplates: false }),
    );
    expect(inputs).toEqual([text]);
    const file = session.snapshot().summary.filePath;
    if (!file) throw new Error("Missing session file");
    expect(SessionManager.open(file).getEntry(entry.id)).toEqual(entry);
    expect(text).toContain(envelope(second, "Manual instructions"));
    expect(text).toContain("Current instructions");
    expect(text).not.toContain("old instructions");
    expect(session.systemPrompt()).toBe(systemPrompt);
    expect(await readFile(join(h.agentDir, "settings.json"), "utf8")).toBe(
      settings,
    );
    expect(text.match(/<skill name=/g)).toHaveLength(2);
    expect(text.indexOf('name="second"')).toBeLessThan(
      text.indexOf('name="first"'),
    );
    expect(text.endsWith(original)).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(
      session
        .snapshot()
        .branch.filter(
          (value) => value.type === "message" && value.message.role === "user",
        ),
    ).toHaveLength(1);
    expect(editableUserMessage(entry)).toEqual({
      text: original,
      skills: [second, first],
      images: [],
    });
    expect(projectTranscript(session.snapshot().branch).items[0]).toMatchObject(
      { kind: "user", text: original, skills: [second, first] },
    );
    expect(
      rowMetadata(session.snapshot().branch, { modifiedAt: "", fileSize: 0 })
        .firstMessage,
    ).toBe("explain 🐙 with spaces");
    expect(
      conversationRail(session.snapshot().branch, entry.id)[0]?.preview,
    ).toBe("explain 🐙 with spaces");
  });

  it("deduplicates a recognized leading skill by identity and preserves its arguments without adding it to dropdown provenance", async () => {
    h = await createHarness();
    const first = await skill("first", "First instructions");
    const second = await skill("second", "Second instructions");
    const session = await h.open();
    for (const skills of [[first, second, first], [second]]) {
      const original = "/skill:first keep  exact\nargs  ";
      const done = next(session, "turn_done");
      await session.prompt(original, { skills });
      await done;
      const lastUser = session
        .snapshot()
        .branch.findLast(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      expect(lastUser && editableUserMessage(lastUser)).toEqual({
        text: original,
        skills: skills.length === 1 ? [second] : [first, second],
        images: [],
      });
      const sent = h.calls
        .at(-1)
        ?.context.messages.filter((message) => message.role === "user")
        .at(-1)?.content;
      const text =
        typeof sent === "string"
          ? sent
          : sent
              ?.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      expect(text?.match(/<skill name=/g)).toHaveLength(2);
      expect(text?.endsWith("keep  exact\nargs  ")).toBe(true);
    }
  });

  it("rejects unavailable identities and unreadable files before admission, including during a run", async () => {
    h = await createHarness();
    const valid = await skill("valid", "Valid instructions");
    const missing = await skill("missing", "Missing instructions");
    const session = await h.open();
    await rm(missing.id);
    const arbitrary = join(h.root, "private.md");
    await writeFile(arbitrary, "Must not be read as a skill");
    for (const bad of [{ id: arbitrary, name: "arbitrary" }, missing]) {
      await expect(
        session.prompt("request", { skills: [valid, bad] }),
      ).rejects.toThrow(
        bad.name === "missing"
          ? /Could not read selected skill/
          : /unavailable/,
      );
      expect(
        session
          .snapshot()
          .branch.filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          ),
      ).toHaveLength(0);
      expect(session.snapshot().status.queue).toEqual([]);
    }
    expect(h.calls).toHaveLength(0);
    const hold = gate();
    h.script(async (turn) => {
      turn.text("busy");
      await hold.wait;
      turn.done();
    });
    await session.prompt("ordinary");
    await until(session, (snapshot) => snapshot.partial !== undefined);
    await expect(
      session.prompt("request", {
        skills: [valid, missing],
        behavior: "followUp",
      }),
    ).rejects.toThrow(/Could not read selected skill/);
    expect(session.snapshot().status.queue).toEqual([]);
    const done = next(session, "turn_done");
    hold.open();
    await done;
  });

  it("rejects a skill discovered in a different folder instead of treating its ID as read authority", async () => {
    h = await createHarness();
    const other = join(h.root, "other-project");
    const id = join(other, ".pi", "skills", "private", "SKILL.md");
    await mkdir(dirname(id), { recursive: true });
    await writeFile(
      id,
      "---\nname: private\ndescription: Other project instructions\n---\nPrivate instructions\n",
    );
    await createPiProjectTrust({ agentDir: h.agentDir }).trust(other);
    const commands = await createPiProjectResources({
      agentDir: h.agentDir,
    }).commands(other);
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "skill:private", skillId: id }),
      ]),
    );
    const session = await h.open();
    await expect(
      session.prompt("request", { skills: [{ id, name: "private" }] }),
    ).rejects.toThrow(/unavailable/);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects other slash commands with selections but leaves the unselected Pi dispatch path unchanged", async () => {
    let commands = 0;
    const inputs: string[] = [];
    h = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerCommand("probe", {
            handler: () => {
              commands += 1;
              return Promise.resolve();
            },
          });
          pi.on("input", (event) => {
            inputs.push(event.text);
            return { action: "continue" };
          });
        },
      ],
    });
    const selected = await skill("first", "Instructions");
    await mkdir(join(h.agentDir, "prompts"), { recursive: true });
    await writeFile(join(h.agentDir, "prompts", "greet.md"), "Hello $1");
    const session = await h.open();
    for (const text of [
      "/probe",
      "/greet world",
      "/unknown",
      "/skill:unknown",
      "  /probe",
    ]) {
      await expect(
        session.prompt(text, { skills: [selected] }),
      ).rejects.toThrow(/another slash command/);
    }
    expect(commands).toBe(0);
    expect(inputs).toEqual([]);
    expect(h.calls).toHaveLength(0);
    await session.prompt("/probe");
    expect(commands).toBe(1);
    for (const [text, expected] of [
      ["/greet world", "Hello world"],
      ["/skill:first  args  ", `${envelope(selected, "Instructions")}\n\nargs`],
    ]) {
      const done = next(session, "turn_done");
      await session.prompt(text ?? "");
      await done;
      const lastUser = session
        .snapshot()
        .branch.findLast(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      if (lastUser?.type !== "message" || lastUser.message.role !== "user")
        throw new Error("Missing user message");
      expect(lastUser.message.content).toEqual([
        { type: "text", text: expected },
      ]);
    }
    expect(inputs).toEqual(["/greet world", "/skill:first  args  "]);
  });

  it("lists manual skills from live and folder resources even when command discovery is disabled", async () => {
    h = await createHarness({ settings: { enableSkillCommands: false } });
    const selected = await skill("manual", "Manual instructions", true);
    const session = await h.open();
    const resources = createPiProjectResources({ agentDir: h.agentDir });
    const expected = {
      name: "skill:manual",
      source: "skill",
      manual: true,
      skillId: selected.id,
    };
    expect(session.commands()).toEqual(
      expect.arrayContaining([expect.objectContaining(expected)]),
    );
    expect(await resources.commands(h.cwd)).toEqual(
      expect.arrayContaining([expect.objectContaining(expected)]),
    );
  });

  it.each([
    ["Context note.\n", ""],
    ["", "\nHook suffix"],
    ["<request>\n", "\n</request>"],
  ])(
    "keeps wrapped queue text, selections and images in both delivery modes (%j, %j)",
    async (prefix, suffix) => {
      const inputs: { text: string; mode: string | undefined }[] = [];
      const transformedImage = {
        type: "image" as const,
        data: "BBBB",
        mimeType: "image/png",
      };
      h = await createHarness({
        extensions: [
          (pi: ExtensionAPI) => {
            pi.on("input", (event) => {
              if (!event.text.startsWith("<!-- web-pi:skill-selection:"))
                return { action: "continue" };
              inputs.push({ text: event.text, mode: event.streamingBehavior });
              return {
                action: "transform",
                text: `${prefix}${event.text}${suffix}`,
                images: [transformedImage],
              };
            });
          },
        ],
      });
      const first = await skill("first", "First instructions");
      const second = await skill("second", "Second instructions");
      const session = await h.open();
      const hold = gate();
      h.script(async (turn) => {
        turn.text("busy");
        await hold.wait;
        turn.done();
      });
      await session.prompt("ordinary");
      await until(session, (snapshot) => snapshot.partial !== undefined);
      for (const [skills, behavior] of [
        [[first], "steer"],
        [[second], "followUp"],
      ] as const) {
        await session.prompt("same text", {
          skills: [...skills],
          behavior,
          images: [{ data: "AAAA", mimeType: "image/png" }],
        });
      }
      expect(inputs.map((input) => input.mode)).toEqual(["steer", "followUp"]);
      const queued = session.snapshot().status.queue;
      expect(queued).toHaveLength(2);
      expect(queued[0]?.text).not.toBe(queued[1]?.text);
      expect(
        queued.every(
          (item) => item.text.startsWith(prefix) && item.text.endsWith(suffix),
        ),
      ).toBe(true);
      const recalled = session.clearQueue();
      expect(recalled).toHaveLength(2);
      expect(recalled.map((item) => item.images)).toEqual([
        [{ data: "BBBB", mimeType: "image/png" }],
        [{ data: "BBBB", mimeType: "image/png" }],
      ]);
      expect(recallSkillPrompts(recalled)).toEqual({
        text: `${prefix}same text${suffix}\n\n${prefix}same text${suffix}`,
        skills: [first, second],
        images: [
          { data: "BBBB", mimeType: "image/png" },
          { data: "BBBB", mimeType: "image/png" },
        ],
      });
      expect(session.snapshot().status.queue).toEqual([]);
      const done = next(session, "turn_done");
      hold.open();
      await done;
      expect(h.calls).toHaveLength(1);
    },
  );

  it.each([
    ["", ""],
    ["Context note.\n", ""],
    ["", "\nHook suffix"],
    ["<request>\n", "\n</request>"],
  ])(
    "restores retained provenance and images through persistence, tree navigation, fork and rewind (%j, %j)",
    async (prefix, suffix) => {
      h = await createHarness({
        extensions: [
          (pi: ExtensionAPI) => {
            pi.on("input", (event) => ({
              action: "transform",
              text: `${prefix}${event.text}${suffix}`,
            }));
          },
        ],
      });
      const selected = await skill("first", "Instructions");
      const session = await h.open();
      const image = {
        data: (await readFile("static/icons/favicon-light.png")).toString(
          "base64",
        ),
        mimeType: "image/png",
      };
      const original = "  original\n\trequest  ";
      const restored = `${prefix}${original}${suffix}`;
      const done = next(session, "turn_done");
      await session.prompt(original, { skills: [selected], images: [image] });
      await done;
      const { entry } = userText(session);
      const file = session.snapshot().summary.filePath;
      if (!file) throw new Error("Missing session file");
      expect(await readFile(file, "utf8")).toContain(
        "web-pi:skill-selection:v1:",
      );
      expect(
        (await h.catalog.rowMetadata(session.id))?.metadata.firstMessage,
      ).toBe(restored.replaceAll(/\s+/g, " ").trim());
      expect(
        projectTranscript(session.snapshot().branch).items[0],
      ).toMatchObject({ kind: "user", text: restored, skills: [selected] });
      const persisted = SessionManager.open(file).getEntry(entry.id);
      expect(persisted && editableUserMessage(persisted)).toEqual({
        text: restored,
        skills: [selected],
        images: [image],
      });
      expect(
        decodeSkillPrompt((await session.navigateTree(entry.id)) ?? ""),
      ).toEqual({ text: restored, skills: [selected] });
      await session.stop();
      expect(await h.catalog.fork(session.id, entry.id)).toMatchObject({
        text: restored,
        skills: [selected],
        images: [image],
      });
      expect(await h.catalog.rewind(session.id, entry.id)).toEqual({
        text: restored,
        skills: [selected],
        images: [image],
      });
    },
  );
});
