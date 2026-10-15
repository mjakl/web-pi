import { Composer } from "@web/views/Composer";
import { describe, expect, it, vi } from "vitest";
import { area, blockStorage, byId, field, mount, render } from "./helpers.ts";

// An unsent prompt survives a reload: text only, keyed by the session, or by
// the folder until the server names the session.

async function load(sessionId: string | null, cwd: string | null, draft = "") {
  mount(`<textarea id="composer-text">${draft}</textarea>`);
  const { setUpDrafts } = await import("@web/client/drafts");
  const editor = await import("@web/client/editor");
  return setUpDrafts(sessionId, cwd, editor.textarea);
}

describe("drafts", () => {
  it("restores a stored draft into an empty composer", async () => {
    localStorage.setItem("web-pi:draft:s1", "half a thought");
    await load("s1", "/repo");
    expect(area().value).toBe("half a thought");
  });

  it("lets a server-rendered draft outrank the stored one", async () => {
    localStorage.setItem("web-pi:draft:s1", "old");
    await load("s1", "/repo", "from a rewind");
    expect(area().value).toBe("from a rewind");
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("from a rewind");
  });

  it("writes after a pause and removes an emptied draft", async () => {
    const drafts = await load("s1", "/repo");
    drafts.save("typing");
    expect(localStorage.getItem("web-pi:draft:s1")).toBeNull();
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBe("typing");
    drafts.save("");
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBeNull();
  });

  it("clears at once and cancels a pending write", async () => {
    const drafts = await load("s1", "/repo");
    drafts.save("gone");
    drafts.clear();
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBeNull();
  });

  it("keys a new session by its folder and moves the draft to the real id", async () => {
    const drafts = await load(null, "/repo/new");
    drafts.save("first prompt");
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:new:/repo/new")).toBe(
      "first prompt",
    );
    document.body.dispatchEvent(
      new CustomEvent("web-pi:session-created", {
        detail: { cwd: "/repo/other", id: "x" },
      }),
    );
    expect(localStorage.getItem("web-pi:draft:new:/repo/new")).toBe(
      "first prompt",
    );
    document.body.dispatchEvent(
      new CustomEvent("web-pi:session-created", {
        detail: { cwd: "/repo/new", id: "s7" },
      }),
    );
    expect(localStorage.getItem("web-pi:draft:new:/repo/new")).toBeNull();
    expect(localStorage.getItem("web-pi:draft:s7")).toBe("first prompt");
    drafts.save("second");
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s7")).toBe("second");
  });

  it("does not resurrect a sent draft when session-created follows request completion", async () => {
    const drafts = await load(null, "/repo/new");
    drafts.save("sent prompt");
    vi.advanceTimersByTime(300);
    drafts.save("pending write");
    drafts.clear();
    document.body.dispatchEvent(
      new CustomEvent("web-pi:session-created", {
        detail: { cwd: "/repo/new", id: "s7" },
      }),
    );
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:new:/repo/new")).toBeNull();
    expect(localStorage.getItem("web-pi:draft:s7")).toBeNull();
    drafts.save("next prompt");
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s7")).toBe("next prompt");
  });

  it.each([
    ["a session", "s1"],
    ["a folder", null],
  ])(
    "restores the text and skills stored for %s by an earlier page",
    async (_, sessionId) => {
      const key = sessionId ?? "new:/repo";
      const alpha = { id: "/repo/.agents/skills/alpha/SKILL.md", name: "a" };
      localStorage.setItem(`web-pi:draft:${key}`, "half a thought");
      localStorage.setItem(
        `web-pi:draft-skills:${key}`,
        JSON.stringify([alpha]),
      );
      mount(
        render(Composer({ ...(sessionId ? { sessionId } : {}), cwd: "/repo" })),
      );
      const { setUpComposer } = await import("@web/client/composer");
      setUpComposer();
      expect(area().value).toBe("half a thought");
      expect(JSON.parse(field("#composer-skills").value)).toEqual([alpha]);
      expect(byId("skills-label").textContent).toBe("Skills (1)");
    },
  );

  it("survives a browser that refuses storage", async () => {
    blockStorage();
    const drafts = await load("s1", "/repo");
    drafts.save("lost on reload");
    vi.advanceTimersByTime(300);
    expect(area().value).toBe("");
  });
});
