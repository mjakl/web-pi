import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { encodeSkillPrompt } from "@core/skill-prompt";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { Status } from "@web/views/Status";
import { html } from "@web/routes/shared";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const testing = { id: "/fake/skills/testing/SKILL.md", name: "testing" };
const other = { id: "/fake/skills/other/SKILL.md", name: "other" };
const original = "/skill:testing  keep this request\nexactly  ";
const expanded = encodeSkillPrompt(
  original,
  [testing, other],
  "SECRET INSTRUCTIONS",
);
const windows: Window[] = [];
function documentOf(html: string) {
  const window = new Window();
  windows.push(window);
  window.document.body.innerHTML = html;
  return window.document;
}
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.restoreAllMocks();
});
function fixture(userText = expanded) {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo",
          createdAt: "2026-09-01",
          modifiedAt: "2026-09-01",
          fileSize: 10,
        },
        entries: [
          userEntry("u0", null, "earlier request"),
          assistantEntry("a0", "u0", "answer", 10),
          userEntry("u1", "a0", userText),
        ],
      },
    ],
  });
  world.files.stat = (path) =>
    Promise.resolve(
      path === "/repo"
        ? { size: 0, mtimeMs: 0, isFile: false, isDirectory: true }
        : undefined,
    );
  world.files.realpath = (path) => Promise.resolve(path);
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: "/repo",
    staticRoot: "static",
  });
  return { world, workspace, app };
}
function submission(text: string, skills: unknown = [testing, other]) {
  const body = new FormData();
  body.set("cwd", "/repo");
  body.set("text", text);
  body.set("skills", JSON.stringify(skills));
  body.set("behavior", "followUp");
  return body;
}

describe("skill selection HTTP and display boundary", () => {
  it.each(["/sessions/s1/skills", "/workspaces/skills?cwd=/repo"])(
    "lists discovered manual skills at %s without starting a runtime",
    async (url) => {
      const { app, world } = fixture();
      const document = documentOf(await (await app.request(url)).text());
      const option = document.querySelector("[data-skill-id]");
      expect(option?.getAttribute("data-skill-id")).toBe(testing.id);
      expect(option?.textContent).toContain("Manual");
      expect(world.runtime.live()).toHaveLength(0);
    },
  );

  it.each(["/sessions", "/sessions/s1/prompt"])(
    "passes exact original text, skills, images and delivery mode from %s",
    async (url) => {
      const { app, workspace } = fixture();
      vi.spyOn(workspace, "createSession").mockResolvedValue("s2");
      const send = vi.spyOn(workspace, "send").mockResolvedValue(undefined);
      const body = submission(original);
      body.append(
        "images[]",
        new File(["image bytes"], "example.png", { type: "image/png" }),
      );
      const response = await app.request(url, { method: "POST", body });
      expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
      expect(send).toHaveBeenCalledExactlyOnceWith(
        url === "/sessions" ? "s2" : "s1",
        original,
        {
          skills: [testing, other],
          behavior: "followUp",
          images: [
            {
              data: Buffer.from("image bytes").toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
      );
    },
  );

  it("accepts a skills-only request but not malformed selection data", async () => {
    const { app, workspace } = fixture();
    const send = vi.spyOn(workspace, "send").mockResolvedValue(undefined);
    const response = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: submission(""),
    });
    expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
    for (const invalid of [
      { id: "anything" },
      [{ id: 123, name: "testing" }],
      null,
    ]) {
      const rejected = await app.request("/sessions/s1/prompt", {
        method: "POST",
        body: submission("request", invalid),
      });
      expect(rejected.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(rejected.headers.get("HX-Trigger")).toContain(
        "Invalid skill selection",
      );
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["/reload", "/name changed", "/template request", "!echo hello"])(
    "rejects selected skills with %s before any dispatch",
    async (text) => {
      const { app, workspace } = fixture();
      const create = vi.spyOn(workspace, "createSession");
      const response = await app.request("/sessions", {
        method: "POST",
        body: submission(text),
      });
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toContain("selected skills");
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["", ""],
    ["Context note.\n", ""],
    ["", "\nHook suffix"],
    ["<request>\n", "\n</request>"],
  ])(
    "separates readable transcript and copy from authored history (%j, %j)",
    async (prefix, suffix) => {
      const { app } = fixture(`${prefix}${expanded}${suffix}`);
      const readable = `${prefix}${original}${suffix}`;
      const document = documentOf(
        await (await app.request("/sessions/s1")).text(),
      );
      const message = document.querySelector("#entry-u1");
      const history = message?.querySelector("[data-user-text]");
      expect(history?.textContent).toBe(original);
      expect(
        message?.querySelector(".markdown-user-message")?.textContent,
      ).toContain("keep this request");
      expect(
        JSON.parse(history?.getAttribute("data-user-skills") ?? "null"),
      ).toEqual([testing, other]);
      expect(message?.textContent).toContain("Skills included: testing, other");
      expect(message?.querySelector("[data-copy-source]")?.textContent).toBe(
        `${readable}\n\nSkills included: testing, other`,
      );
      expect(document.querySelector("request")).toBeNull();
      expect(document.body.textContent).not.toContain("SECRET INSTRUCTIONS");
      expect(document.body.textContent).not.toContain(
        "web-pi:skill-selection:v1:",
      );
    },
  );

  it.each(["rewind", "fork", "navigate"])(
    "restores original text and dropdown selections after %s",
    async (action) => {
      const { app } = fixture(`Context note.\n${expanded}\nHook suffix`);
      const body = new FormData();
      body.set("entryId", "u1");
      const response = await app.request(`/sessions/s1/${action}`, {
        method: "POST",
        body,
      });
      const document = documentOf(await response.text());
      const area = document.querySelector("#composer-text");
      expect(area?.textContent).toBe(original);
      expect(
        JSON.parse(area?.getAttribute("data-restored-skills") ?? "null"),
      ).toEqual([testing, other]);
    },
  );

  it.each([false, true])(
    "warns on queue recall only when the later leading skill is uncovered (covered: %j)",
    async (covered) => {
      const { app, workspace, world } = fixture();
      await workspace.activate("s1");
      const live = world.runtime.get("s1");
      if (!live) throw new Error("Missing live fixture");
      vi.spyOn(live, "commands").mockReturnValue(
        [testing, other].map((skill) => ({
          name: `skill:${skill.name}`,
          description: "",
          source: "skill",
          skillId: skill.id,
        })),
      );
      vi.spyOn(live, "clearQueue").mockReturnValue([
        {
          text: `Prefix\n${encodeSkillPrompt(original, covered ? [testing, other] : [testing], "PRIVATE")}\nSuffix`,
          behavior: "steer",
          images: [{ data: "AAAA", mimeType: "image/png" }],
        },
        {
          text: `Prefix\n${encodeSkillPrompt("/skill:other later", [testing], "PRIVATE")}\nSuffix`,
          behavior: "followUp",
        },
      ]);
      const response = await app.request("/sessions/s1/queue/recall", {
        method: "POST",
      });
      const event = response.headers.get("HX-Trigger");
      if (covered) expect(event).toBeNull();
      else
        expect(JSON.parse(event ?? "null")).toEqual({
          "web-pi:toast": {
            level: "warning",
            message: expect.stringContaining(
              "Select other in Skills",
            ) as string,
          },
        });
      const document = documentOf(await response.text());
      expect(document.querySelector("#composer-text")?.textContent).toBe(
        `${original}\n\n/skill:other later`,
      );
      expect(
        document
          .querySelector("#recalled-images [data-image]")
          ?.getAttribute("data-image"),
      ).toBe("AAAA");
      expect(
        JSON.parse(
          document
            .querySelector("#composer-text")
            ?.getAttribute("data-restored-skills") ?? "null",
        ),
      ).toEqual(covered ? [testing, other] : [testing]);
    },
  );

  it("decodes queue previews and delivers combined recall text and selections", async () => {
    const { app, workspace, world } = fixture();
    const queue = [
      {
        text: `Context note.\n${expanded}\nHook suffix`,
        behavior: "steer" as const,
      },
      {
        text: encodeSkillPrompt(
          "second request",
          [other],
          "MORE SECRET INSTRUCTIONS",
        ),
        behavior: "followUp" as const,
      },
    ];
    await workspace.activate("s1");
    const view = await workspace.viewSession("s1");
    if (!view?.status) throw new Error("Missing live fixture");
    view.status.queue = queue;
    const preview = documentOf(await html(<Status view={view} />));
    expect(preview.body.textContent).toContain(
      `Context note.\n${original}\nHook suffix`,
    );
    expect(preview.body.textContent).toContain(
      "Skills included: testing, other",
    );
    expect(preview.body.textContent).not.toContain("SECRET INSTRUCTIONS");
    const live = world.runtime.get("s1");
    if (!live) throw new Error("Missing live fixture");
    vi.spyOn(live, "clearQueue").mockReturnValue(queue);
    const document = documentOf(
      await (
        await app.request("/sessions/s1/queue/recall", { method: "POST" })
      ).text(),
    );
    expect(document.querySelector("#composer-text")?.textContent).toBe(
      `${original}\n\nsecond request`,
    );
    expect(
      JSON.parse(
        document
          .querySelector("#composer-text")
          ?.getAttribute("data-restored-skills") ?? "null",
      ),
    ).toEqual([testing, other]);
  });
});
