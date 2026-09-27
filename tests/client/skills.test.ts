import type { SkillSelection } from "@core/ports";
import { userEntry } from "@adapters/fake/index";
import { encodeSkillPrompt, recallSkillPrompts } from "@core/skill-prompt";
import { projectTranscript } from "@core/transcript";
import { UserMessage } from "@web/views/transcript/user";
import { CommandMenu, Composer, ComposerText } from "@web/views/Composer";
import { SkillsMenu } from "@web/views/Skills";
import { describe, expect, it, vi } from "vitest";
import {
  area,
  byId,
  click,
  field,
  flush,
  htmxEvent,
  keydown,
  mockFetch,
  mount,
  query,
  render,
  text,
  type,
} from "./helpers.ts";

const alpha = { id: "/repo/.agents/skills/alpha/SKILL.md", name: "alpha" };
const beta = { id: "/home/user/.agents/skills/beta/SKILL.md", name: "beta" };
const menu = render(
  SkillsMenu({
    commands: [
      {
        source: "skill",
        name: "skill:alpha",
        description: "Review code",
        skillId: alpha.id,
      },
      {
        source: "skill",
        name: "skill:beta",
        description: "Explain tests",
        manual: true,
        skillId: beta.id,
      },
    ],
  }),
);

function page({
  sessionId = "s1",
  draft,
  skills,
  history = [],
}: {
  sessionId?: string | null;
  draft?: string;
  skills?: SkillSelection[];
  history?: { text: string; skills?: SkillSelection[] }[];
} = {}) {
  const content = history
    .map((entry) => {
      const node = document.createElement("div");
      node.dataset["userText"] = "";
      if (entry.skills)
        node.dataset["userSkills"] = JSON.stringify(entry.skills);
      node.textContent = entry.text;
      return node.outerHTML;
    })
    .join("");
  mount(
    `<main data-session-id="${sessionId ?? ""}" data-cwd="/repo"><div id="toasts"></div>${content}${render(Composer({ ...(sessionId ? { sessionId } : {}), cwd: "/repo", ...(draft === undefined ? {} : { draft }), ...(skills === undefined ? {} : { skills }) }))}</main>`,
  );
  const submits: SubmitEvent[] = [];
  byId("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    submits.push(event);
  });
  return { submits };
}
async function setup() {
  const { setUpComposer } = await import("@web/client/composer");
  setUpComposer();
}
async function open() {
  byId("skills-menu").showPopover();
  await flush();
}
function selected(): SkillSelection[] {
  return JSON.parse(field("#composer-skills").value) as SkillSelection[];
}
function option(id: string): HTMLElement {
  const row = [
    ...document.querySelectorAll<HTMLElement>("[data-skill-id]"),
  ].find((entry) => entry.dataset["skillId"] === id);
  if (!row) throw new Error(`Missing skill ${id}`);
  return row;
}
function accepted() {
  const ctx = {
    response: {
      status: 200,
      headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
    },
  };
  htmxEvent(byId("composer"), "htmx:before:request", { ctx });
  htmxEvent(byId("composer"), "htmx:before:response", { ctx });
}

describe("skill selection", () => {
  it.each(["s1", null])(
    "searches and multi-selects discovered and manual skills in %s composer",
    async (sessionId) => {
      const fetch = mockFetch(() => text(menu));
      const { submits } = page({ sessionId });
      await setup();
      await open();
      expect(String(fetch.mock.calls[0]?.[0])).toBe(
        sessionId ? "/sessions/s1/skills" : "/workspaces/skills?cwd=%2Frepo",
      );
      expect(document.activeElement).toBe(field("#skills-filter"));
      type(field("#skills-filter"), "explain");
      expect(option(alpha.id).hidden).toBe(true);
      expect(option(beta.id).hidden).toBe(false);
      keydown(field("#skills-filter"), "ArrowDown");
      expect(document.activeElement).toBe(option(beta.id));
      click(option(beta.id));
      type(field("#skills-filter"), "");
      click(option(alpha.id));
      expect(selected()).toEqual([beta, alpha]);
      expect(byId("skills-label").textContent).toBe("Skills (2)");
      expect(byId("skills-trigger").getAttribute("aria-label")).toBe(
        "Skills (2)",
      );
      expect(option(beta.id).getAttribute("aria-selected")).toBe("true");
      expect(
        byId("composer").querySelector(".composer-image-preview"),
      ).toBeNull();
      expect(area().value).toBe("");
      expect(
        (query(".composer-action-primary") as HTMLButtonElement).disabled,
      ).toBe(false);
      keydown(area(), "Enter");
      expect(submits).toHaveLength(1);
    },
  );

  it.each([
    {},
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { shiftKey: true },
  ])(
    "cancels implicit search submission without changing the draft or selection (%j)",
    async (modifiers) => {
      mockFetch(() => text(menu));
      const { submits } = page({
        draft: "unfinished request",
        skills: [alpha],
      });
      await setup();
      await open();
      type(field("#skills-filter"), "beta");
      const event = keydown(field("#skills-filter"), "Enter", modifiers);
      expect(event.defaultPrevented).toBe(true);
      expect(submits).toHaveLength(0);
      expect(area().value).toBe("unfinished request");
      expect(selected()).toEqual([alpha]);
      expect(field("#skills-filter").value).toBe("beta");
      expect(document.activeElement).toBe(field("#skills-filter"));
    },
  );

  it("keeps the dropdown usable for steer and follow-up during a running turn", async () => {
    mockFetch(() => text(menu));
    page();
    await setup();
    byId("status").innerHTML =
      '<span id="session-state" data-running="true"></span>';
    htmxEvent(byId("status"), "htmx:after:settle");
    await open();
    expect((byId("skills-trigger") as HTMLButtonElement).disabled).toBe(false);
    click(option(beta.id));
    expect(query(".composer-action-primary").getAttribute("data-action")).toBe(
      "steer",
    );
    keydown(document.body, "Alt", { altKey: true });
    expect(query(".composer-action-primary").getAttribute("data-action")).toBe(
      "followup",
    );
  });

  it("keeps selections during activity, clears only accepted submissions, and preserves later selection edits", async () => {
    mockFetch(() => text(menu));
    page();
    await setup();
    await open();
    click(option(alpha.id));
    htmxEvent(byId("status"), "htmx:after:settle");
    expect(selected()).toEqual([alpha]);
    const ctx = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx });
    click(option(alpha.id));
    click(option(alpha.id));
    htmxEvent(byId("composer"), "htmx:before:response", { ctx });
    expect(selected()).toEqual([alpha]);
    accepted();
    expect(selected()).toEqual([]);
    expect(byId("skills-label").textContent).toBe("Skills");
    expect(byId("skills-trigger").getAttribute("aria-label")).toBe("Skills");
  });

  it("removes only submitted choices when another skill is added before acceptance", async () => {
    mockFetch(() => text(menu));
    page();
    await setup();
    await open();
    click(option(alpha.id));
    const ctx = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx });
    click(option(beta.id));
    htmxEvent(byId("composer"), "htmx:before:response", { ctx });
    expect(selected()).toEqual([beta]);
    expect(byId("skills-label").textContent).toBe("Skills (1)");
  });

  it("allows a leading skill command with independent selections, but rejects other commands", async () => {
    mockFetch(() => text(menu));
    const { submits } = page();
    await setup();
    await open();
    click(option(alpha.id));
    type(area(), "/skill:alpha explain this");
    keydown(area(), "Enter");
    expect(submits).toHaveLength(1);
    expect(area().value).toBe("/skill:alpha explain this");
    expect(selected()).toEqual([alpha]);
    expect(byId("skills-label").textContent).toBe("Skills (1)");
    for (const command of ["/session", "/name reply", "!ls"]) {
      type(area(), command);
      expect(keydown(area(), "Enter").defaultPrevented).toBe(true);
      expect(submits).toHaveLength(1);
      expect(selected()).toEqual([alpha]);
    }
  });

  it("completes a skill token before sending, without changing dropdown selections", async () => {
    mockFetch((url) =>
      text(
        url.includes("/commands?")
          ? render(
              CommandMenu({
                commands: [
                  {
                    name: "skill:alpha",
                    source: "skill",
                    description: "Review code",
                  },
                ],
              }),
            )
          : menu,
      ),
    );
    const { submits } = page();
    await setup();
    await open();
    click(option(alpha.id));
    type(area(), "/skill:alpha");
    await vi.advanceTimersByTimeAsync(80);
    await flush();
    expect(byId("slash-menu").hidden).toBe(false);
    keydown(area(), "Enter");
    expect(submits).toHaveLength(0);
    expect(area().value).toBe("/skill:alpha ");
    expect(selected()).toEqual([alpha]);
    expect(byId("skills-label").textContent).toBe("Skills (1)");
    keydown(area(), "Enter");
    expect(submits).toHaveLength(1);
    expect(selected()).toEqual([alpha]);
    click(query(".composer-action-primary"));
    expect(submits).toHaveLength(2);
  });

  it("retains choices on rejected and ambiguous sends", async () => {
    mockFetch(() => text(menu));
    page();
    await setup();
    await open();
    click(option(alpha.id));
    type(area(), "prompt");
    keydown(area(), "Enter");
    const rejected = { response: { status: 500, headers: new Headers() } };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: rejected });
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: rejected });
    expect(selected()).toEqual([alpha]);
  });

  it("treats history and queue recalls as new ownership even for the same selected identity", async () => {
    page({
      skills: [alpha],
      history: [{ text: "older prompt", skills: [alpha] }],
    });
    await setup();
    const first = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: first });
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("older prompt");
    expect(selected()).toEqual([alpha]);
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: first });
    expect(selected()).toEqual([alpha]);
    const second = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: second });
    area().outerHTML = render(
      ComposerText({ draft: "recalled prompt", skills: [alpha] }),
    );
    htmxEvent(query(".composer-surface"), "htmx:after:settle");
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: second });
    expect(selected()).toEqual([alpha]);
    expect(byId("skills-label").textContent).toBe("Skills (1)");
  });

  it("updates the new owner's Send state when an old form's submission is accepted", async () => {
    page({ skills: [alpha] });
    await setup();
    const previous = byId("composer");
    const ctx = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(previous, "htmx:before:request", { ctx });
    htmxEvent(previous, "htmx:before:cleanup");
    previous.outerHTML = render(Composer({ sessionId: "s1", cwd: "/repo" }));
    htmxEvent(byId("composer"), "htmx:after:process");
    expect(selected()).toEqual([alpha]);
    expect(
      (query(".composer-action-primary") as HTMLButtonElement).disabled,
    ).toBe(false);
    htmxEvent(document.body, "htmx:before:response", { ctx });
    expect(selected()).toEqual([]);
    expect(
      (query(".composer-action-primary") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("restores selections across reload, empty server override, and new-session promotion", async () => {
    mockFetch(() => text(menu));
    page({ sessionId: null });
    await setup();
    await open();
    click(option(alpha.id));
    vi.advanceTimersByTime(300);
    expect(
      JSON.parse(localStorage.getItem("web-pi:draft-skills:new:/repo") ?? "[]"),
    ).toEqual([alpha]);
    document.body.dispatchEvent(
      new CustomEvent("web-pi:session-created", {
        detail: { cwd: "/repo", id: "s7" },
      }),
    );
    expect(localStorage.getItem("web-pi:draft-skills:new:/repo")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("web-pi:draft-skills:s7") ?? "[]"),
    ).toEqual([alpha]);
    // A navigation remount reads the promoted draft, without relying on the menu request.
    htmxEvent(byId("composer"), "htmx:before:cleanup");
    byId("composer").outerHTML = render(
      Composer({ sessionId: "s7", cwd: "/repo" }),
    );
    htmxEvent(byId("composer"), "htmx:after:process");
    expect(selected()).toEqual([alpha]);
    htmxEvent(byId("composer"), "htmx:before:cleanup");
    byId("composer").outerHTML = render(
      Composer({ sessionId: "s7", cwd: "/repo", skills: [] }),
    );
    htmxEvent(byId("composer"), "htmx:after:process");
    expect(selected()).toEqual([]);
    expect(localStorage.getItem("web-pi:draft-skills:s7")).toBeNull();
  });

  it("keeps unavailable prior selections removable after a failed fetch, and honors old plain-text drafts", async () => {
    localStorage.setItem("web-pi:draft:s1", "unfinished");
    localStorage.setItem("web-pi:draft-skills:s1", JSON.stringify([alpha]));
    mockFetch(() => text("error", 500));
    page();
    await setup();
    await open();
    expect(area().value).toBe("unfinished");
    expect(option(alpha.id).textContent).toContain("Unavailable");
    click(option(alpha.id));
    expect(selected()).toEqual([]);
    expect(byId("skills-results").textContent).toContain(
      "Could not load skills",
    );
  });

  it("restores exact authored history without hook additions and protects recovered draft ownership", async () => {
    mockFetch(() => text(menu));
    page();
    const original = "/skill:alpha  keep 🦉\n  ";
    const encoded = encodeSkillPrompt(original, [beta], "PRIVATE");
    const item = projectTranscript([
      userEntry("u1", null, `Prefix\n${encoded}\nSuffix`),
    ]).items[0];
    if (item?.kind !== "user") throw new Error("Missing user item");
    query("main").insertAdjacentHTML(
      "afterbegin",
      render(UserMessage({ item })),
    );
    await setup();
    keydown(area(), "ArrowUp");
    expect(area().value).toBe(original);
    expect(selected()).toEqual([beta]);
    const failed = { response: { status: 500, headers: new Headers() } };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: failed });
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: failed });
    expect(area().value).toBe(original);
    expect(selected()).toEqual([beta]);
    const pending = {
      response: {
        status: 200,
        headers: new Headers({ "X-Web-Pi-Submission": "accepted" }),
      },
    };
    htmxEvent(byId("composer"), "htmx:before:request", { ctx: pending });
    type(area(), "newer draft");
    await open();
    click(option(alpha.id));
    htmxEvent(byId("composer"), "htmx:before:response", { ctx: pending });
    expect(area().value).toBe("newer draft");
    expect(selected()).toEqual([alpha]);
  });

  it("announces the queue recall warning through the existing visible status shelf", async () => {
    page();
    const { setUpToasts } = await import("@web/client/toasts");
    setUpToasts();
    const recalled = recallSkillPrompts(
      [
        { text: "prose first", behavior: "steer" },
        {
          text: encodeSkillPrompt("/skill:alpha later", [beta], "PRIVATE"),
          behavior: "followUp",
        },
      ],
      [alpha, beta],
    );
    document.body.dispatchEvent(
      new CustomEvent("web-pi:toast", {
        detail: { level: "warning", message: recalled.warning },
      }),
    );
    const notice = query(".notice-shelf-item.is-warning");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("Select alpha in Skills");
    expect(notice.hidden).toBe(false);
    expect(query(".notice-shelf-text").tabIndex).toBe(0);
  });

  it("restores text and skill payload through history, recall, and a replaced textarea", async () => {
    page({
      history: [
        { text: "same", skills: [alpha] },
        { text: "same", skills: [beta] },
        { text: "old" },
      ],
    });
    await setup();
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("old");
    expect(selected()).toEqual([]);
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("same");
    expect(selected()).toEqual([beta]);
    keydown(area(), "ArrowUp");
    expect(area().value).toBe("same");
    expect(selected()).toEqual([alpha]);
    const previous = area();
    previous.outerHTML = render(ComposerText({ draft: "rewind", skills: [] }));
    htmxEvent(query(".composer-surface"), "htmx:after:settle");
    expect(selected()).toEqual([]);
    area().outerHTML = render(
      ComposerText({ draft: "recalled text", skills: [beta] }),
    );
    htmxEvent(query(".composer-surface"), "htmx:after:settle");
    expect(selected()).toEqual([beta]);
  });
});
