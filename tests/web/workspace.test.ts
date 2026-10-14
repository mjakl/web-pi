import {
  assistantEntry,
  createFakeWorld,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHtml, required } from "#/web/helpers";

// The picker, trust, read-only mode and the settings pages, against the fake
// world. Folders that have to exist are real temporary ones; nothing here
// reads or writes Pi's own agent directory.

let root: string;
let repo: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-web-"));
  repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function testApp(options: Parameters<typeof createFakeWorld>[0] = {}) {
  const world = createFakeWorld({
    delayMs: 2,
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: repo,
          name: "Live one",
          createdAt: "2026-09-01T00:00:00.000Z",
          modifiedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 10,
        },
        entries: [
          userEntry("u1", null, "a question"),
          assistantEntry("a1", "u1", "an answer", 100),
        ],
      },
    ],
    ...options,
  });
  const app = createWebApp({
    workspace: createWorkspace(world),
    staticRoot: "/nonexistent",
    defaultCwd: repo,
    home: root,
    renderIntervalMs: 1,
  });
  return { app, world };
}

/** A conversation of `turns` questions and answers, longer than a page. */
function conversation(turns: number): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const user = userEntry(
      `u${String(turn)}`,
      entries.at(-1)?.id ?? null,
      `question ${String(turn)}`,
    );
    entries.push(
      user,
      assistantEntry(
        `a${String(turn)}`,
        user.id,
        `answer ${String(turn)}`,
        100,
      ),
    );
  }
  return entries;
}

const historyControl = /hx-post="\/sessions\/s1\/(rewind|navigate|fork)"/;

const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return { method: "POST", body };
};

describe("the directory picker", () => {
  it("browses directory names only, hidden ones included", async () => {
    await mkdir(join(repo, ".hidden"));
    const { app } = testApp();
    const html = await (
      await app.request(`/workspaces/browse?path=${encodeURIComponent(repo)}`)
    ).text();
    expect(html).toContain(".hidden");
    expect(html).toContain("src");
    expect(html).toContain("Select this folder");
  });

  it("shows the error inside the panel and falls back to the home listing", async () => {
    const { app } = testApp();
    const html = await (
      await app.request("/workspaces/browse?path=/definitely/not/here")
    ).text();
    expect(html).toContain("Directory does not exist");
    expect(html).toContain('role="alert"');
    // The whole panel is swapped, so the path form comes back with it.
    expect(html).toContain('id="directory-picker-panel"');
  });

  it("navigates to the chosen folder without committing cookies before the view mounts", async () => {
    const { app } = testApp();
    const res = await app.request("/workspaces/validate", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    expect(JSON.parse(res.headers.get("HX-Location") ?? "{}")).toEqual({
      path: `/new?cwd=${encodeURIComponent(repo)}`,
      source: "#session-region",
      target: "#session-region",
      swap: "outerHTML",
    });
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("reports a folder it cannot use as a toast, not a broken page", async () => {
    const { app } = testApp();
    const res = await app.request("/workspaces/validate", {
      ...form({ cwd: "/definitely/not/here" }),
      headers: { "HX-Request": "true" },
    });
    expect(res.headers.get("HX-Trigger")).toContain("Folder not found");
    expect(res.headers.get("HX-Reswap")).toBe("none");
  });
});

describe("the new-session page", () => {
  it("answers the folder's slash menu and file completion", async () => {
    const { app } = testApp();
    // Validation is what makes the folder reachable.
    await app.request("/workspaces/validate", form({ cwd: repo }));
    const menu = await (
      await app.request(
        `/workspaces/commands?cwd=${encodeURIComponent(repo)}&q=`,
      )
    ).text();
    expect(menu).toContain("changelog");
    const files = await app.request(
      `/workspaces/file-index?cwd=${encodeURIComponent(repo)}&q=`,
    );
    expect(await files.json()).toMatchObject({ truncated: false });
  });

  it("refuses to list a folder nobody validated", async () => {
    const { app } = testApp();
    const res = await app.request(
      `/workspaces/file-index?cwd=${encodeURIComponent(root)}&q=`,
    );
    expect(res.status).toBe(403);
  });

  it("will not start a session in a folder that is gone", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    const body = new FormData();
    body.set("cwd", repo);
    body.set("text", "hello");
    const res = await app.request("/sessions", {
      method: "POST",
      body,
      headers: { "HX-Request": "true" },
    });
    expect(res.headers.get("HX-Trigger")).toContain(
      "Working folder is unavailable",
    );
  });
});

describe("@ completion", () => {
  // The session answers about its own folder whatever the query string
  // names; the folder variant answers about the one it names.
  const urls = {
    session: (endpoint: string, query: string) =>
      `/sessions/s1/${endpoint}?cwd=%2Fetc&q=${encodeURIComponent(query)}`,
    folder: (endpoint: string, query: string) =>
      `/workspaces/${endpoint}?cwd=${encodeURIComponent(repo)}&q=${encodeURIComponent(query)}`,
  };

  it.each(["session", "folder"] as const)(
    "answers for a %s with the same folder, headers and query cap",
    async (scope) => {
      const { app, world } = testApp({ files: ["src/main.ts"] });
      const index = vi.spyOn(world.files, "index");
      const children = vi.spyOn(world.files, "children");
      const listed = await app.request(urls[scope]("file-index", ""));
      expect(listed.headers.get("cache-control")).toBe("no-store");
      expect(await listed.json()).toEqual({
        files: ["src/main.ts"],
        truncated: false,
      });
      expect(index).toHaveBeenCalledWith(repo);
      const long = `./${"s".repeat(600)}`;
      const completed = await app.request(urls[scope]("file-completion", long));
      expect(completed.status).toBe(200);
      expect(completed.headers.get("cache-control")).toBe("no-store");
      expect(children).toHaveBeenCalledWith(long.slice(0, 500), repo);
    },
  );

  it("answers what it cannot list with the file panel's statuses", async () => {
    const { app } = testApp();
    const unknown = await app.request("/sessions/nobody/file-completion?q=");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/workspaces/file-index?q=")).status).toBe(404);
    const outside = await app.request(
      `/workspaces/file-completion?cwd=${encodeURIComponent(root)}&q=.%2F`,
    );
    expect(outside.status).toBe(403);
    expect(await outside.json()).toEqual({ error: "Access denied" });
  });
});

describe("missing-folder read-only mode", () => {
  it("shows the notice and drops the composer, explorer and branch actions", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    const html = await (await app.request("/sessions/s1")).text();
    expect(html).toContain(
      "Working folder is unavailable. This session is read-only.",
    );
    expect(html).not.toContain('id="composer"');
    // Reading, stats and export stay, and so does the file panel: pi-web
    // keeps its toggle on every route (AppShell.tsx L1674).
    expect(html).toContain('id="file-panel-toggle"');
    expect(html).toContain("Full history");
    expect(html).toContain("an answer");
    // pi-web puts the sentence alone in the composer's place, in the class
    // its stylesheet indents and dims (ChatWindow.tsx `chatInputElement`).
    expect(html).toContain(
      '<div role="status" class="project-folder-message">Working folder is unavailable. This session is read-only.</div>',
    );
    expect(html).not.toContain("Read only");
  });

  it("says why the explorer is empty, the way pi-web does", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    const res = await app.request(
      `/files/explorer?cwd=${encodeURIComponent(join(repo, "gone"))}`,
    );
    // htmx swaps nothing on an error status, so the reason is the content.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '<div class="file-tree-body"><div class="file-tree-message is-error">Not found</div></div>',
    );
  });

  it("refuses every mutating route with the same message", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    for (const path of [
      "/sessions/s1/prompt",
      "/sessions/s1/compact",
      "/sessions/s1/activate",
      "/sessions/s1/clone",
    ]) {
      const res = await app.request(path, {
        ...form({ text: "x" }),
        headers: { "HX-Request": "true" },
      });
      expect(res.headers.get("HX-Trigger")).toContain(
        "Working folder is unavailable",
      );
    }
  });

  it("keeps an attached session's chrome, with compacting refused", async () => {
    // pi-web reads the shelf and the gauge off the running agent, and a folder
    // that disappears under it takes neither away: only the actions that would
    // run the agent go (ChatWindow.tsx `compactionControl`, `readOnly`).
    const { app, world } = testApp({
      missingFolders: [repo],
      script: () => [{ status: "prune", statusText: "on" }, { text: "done" }],
    });
    const live = await world.runtime.open({ sessionId: "s1" });
    const settled = new Promise<void>((resolve) => {
      const off = live.subscribe((event) => {
        if (event.type === "turn_done") {
          off();
          resolve();
        }
      });
    });
    await live.prompt("go");
    await settled;
    const page = await (await app.request("/sessions/s1")).text();
    expect(page).toContain(
      "Working folder is unavailable. This session is read-only.",
    );
    expect(page).toContain('<span class="extension-status-text">on</span>');
    expect(page).toContain("data-context-readout");
    expect(page).toMatch(/id="context-compact"[^>]*disabled/);
  });

  it.each([
    ["a writable session", false, "", true],
    ["a session whose folder is gone", true, "", false],
    ["another branch", false, "?leaf=a30", false],
  ])(
    "offers history controls on older pages of %s only while it is writable",
    async (_case, missing, query, controls) => {
      const { app, world } = testApp(missing ? { missingFolders: [repo] } : {});
      required(world.store.get("s1")).entries = conversation(40);
      const page = parseHtml(
        await (await app.request(`/sessions/s1${query}`)).text(),
      );
      const earlier = await app.request(
        required(page.querySelector(".load-earlier")?.getAttribute("hx-get")),
      );
      const html = await earlier.text();
      expect(html).toContain("question 0");
      expect(historyControl.test(html)).toBe(controls);
    },
  );

  it("keeps history controls out of messages the stream appends", async () => {
    const { app, world } = testApp({ missingFolders: [repo] });
    const live = await world.runtime.open({ sessionId: "s1" });
    const reader = required(
      (await app.request("/sessions/s1/events?after=a1")).body?.getReader(),
    );
    await live.prompt("go");
    const decoder = new TextDecoder();
    let received = "";
    try {
      while (!received.includes("event: settled")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }
    expect(received).toContain('hx-target="#messages" hx-swap="beforeend"');
    expect(received).toContain("You said: go");
    expect(received).not.toMatch(historyControl);
  });

  it("still lets a reader stop the session and read its statistics", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    expect((await app.request("/sessions/s1/stats")).status).toBe(200);
    expect(
      (await app.request("/sessions/s1/abort", { method: "POST" })).status,
    ).toBe(204);
  });
});

describe("project trust", () => {
  it("badges an untrusted folder and offers the dialog", async () => {
    const { app } = testApp({ trustRequired: [repo] });
    const page = await (await app.request("/sessions/s1")).text();
    // pi-web puts the warning in the top bar, next to the tabs.
    expect(page).toContain("Restricted mode");
    const dialog = await (
      await app.request(`/workspaces/trust?cwd=${encodeURIComponent(repo)}`)
    ).text();
    expect(dialog).toContain("Trust this project?");
    expect(dialog).toContain("Project resources can run local code.");
  });

  it("grants trust and asks the page to reload", async () => {
    const { app } = testApp({ trustRequired: [repo] });
    const res = await app.request("/workspaces/trust", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    expect(res.headers.get("HX-Refresh")).toBe("true");
    expect(await (await app.request("/sessions/s1")).text()).not.toContain(
      "Restricted mode",
    );
  });

  it("refuses a folder with nothing to trust", async () => {
    const { app } = testApp();
    const res = await app.request("/workspaces/trust", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    expect(res.headers.get("HX-Trigger")).toContain(
      "no resources that require trust",
    );
  });

  it("blocks the change while a session in that folder is working", async () => {
    const { app } = testApp({ trustRequired: [repo] });
    await app.request("/sessions/s1/prompt", form({ text: "run" }));
    const res = await app.request("/workspaces/trust", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    expect(res.headers.get("HX-Trigger")).toContain(
      "Wait for the active session to finish",
    );
  });

  it("stops the folder's sessions so they restart with project resources", async () => {
    const { app, world } = testApp({ trustRequired: [repo] });
    await app.request("/sessions/s1/activate", { method: "POST" });
    expect(world.runtime.get("s1")).toBeDefined();
    await app.request("/workspaces/trust", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    expect(world.runtime.get("s1")).toBeUndefined();
  });
});

describe("the settings page", () => {
  it("remembers the selected settings section", async () => {
    const { app } = testApp();
    const skills = await app.request("/settings?section=skills");
    expect(skills.headers.getSetCookie().join(" ")).toContain(
      "web-pi-settings=skills",
    );
    const remembered = await app.request("/settings", {
      headers: { cookie: "web-pi-settings=skills" },
    });
    expect(await remembered.text()).toContain("Add skill");
  });

  it("groups skills and shows one in detail", async () => {
    const { app } = testApp();
    const html = await (await app.request("/settings?section=skills")).text();
    expect(html).toContain("testing");
    expect(html).toContain("Manual");
    expect(html).toContain("global / skills.sh");
    const detail = await (
      await app.request(
        `/settings/skills/detail?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent("/agent/skills/changelog/SKILL.md")}`,
      )
    ).text();
    expect(detail).toContain("Model-visible");
    expect(detail).toContain("skills.sh/acme/skills/changelog");
  });

  it("toggles a skill and answers with its new state", async () => {
    const { app } = testApp();
    const html = await (
      await app.request(
        "/settings/skills/toggle",
        form({
          cwd: repo,
          path: "/repo/one/.pi/skills/testing/SKILL.md",
          disable: "",
        }),
      )
    ).text();
    expect(html).toContain("Model-visible");
    expect(html).toContain('aria-checked="true"');
  });

  it("searches the registry and reports an install", async () => {
    const { app } = testApp();
    const results = await (
      await app.request(
        "/settings/skills/search",
        form({ cwd: repo, query: "changelog" }),
      )
    ).text();
    expect(results).toContain("acme/skills@changelog");
    expect(results).toContain("1.2K installs");
    const installed = await (
      await app.request(
        "/settings/skills/install",
        form({ cwd: repo, package: "acme/skills@changelog", scope: "global" }),
      )
    ).text();
    expect(installed).toContain("Installed acme/skills@changelog");
  });

  // A project install runs `npx skills add` in the project folder; trust is
  // the only thing between the Settings page and that folder.
  const projectInstall = () =>
    form({ cwd: repo, package: "acme/skills@changelog", scope: "project" });

  it("refuses a project install while the project is untrusted", async () => {
    const { app, world } = testApp({ trustRequired: [repo] });
    const install = vi.spyOn(world.skills, "install");
    const refused = await (
      await app.request("/settings/skills/install", projectInstall())
    ).text();
    expect(refused).toContain(
      "Project resources must be trusted before installing into this project",
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("installs into the project once it is trusted", async () => {
    const { app, world } = testApp({ trustRequired: [repo] });
    const install = vi.spyOn(world.skills, "install");
    await app.request("/workspaces/trust", {
      ...form({ cwd: repo }),
      headers: { "HX-Request": "true" },
    });
    const installed = await (
      await app.request("/settings/skills/install", projectInstall())
    ).text();
    expect(installed).toContain("Installed acme/skills@changelog");
    expect(install).toHaveBeenCalledExactlyOnceWith(
      "acme/skills@changelog",
      "project",
      repo,
    );
  });

  it("lists plugins with their status and flips one off and on", async () => {
    const { app } = testApp();
    const html = await (await app.request("/settings?section=plugins")).text();
    expect(html).toContain("npm:@acme/pi-plugin@1.2.0");
    expect(html).toContain("global");
    expect(html).toContain("review");
    expect(html).toContain("Resolved Resources");
    expect(html).toContain(">extensions/review/index.ts<");
    const disabled = await (
      await app.request(
        "/settings/plugins",
        form({
          cwd: repo,
          action: "disable",
          source: "npm:@acme/pi-plugin@1.2.0",
          scope: "user",
        }),
      )
    ).text();
    expect(disabled).toContain("Package disabled.");
    expect(disabled).toContain("Enable");
    const enabled = await (
      await app.request(
        "/settings/plugins",
        form({
          cwd: repo,
          action: "enable",
          source: "npm:@acme/pi-plugin@1.2.0",
          scope: "user",
        }),
      )
    ).text();
    expect(enabled).toContain("Disable");
  });

  it("shows a failed plugin action as an error toast", async () => {
    const { app, world } = testApp();
    vi.spyOn(world.packages, "run").mockRejectedValue(
      new Error("global settings: EACCES. Check Pi's global settings.json."),
    );
    const res = await app.request(
      "/settings/plugins",
      form({ cwd: repo, action: "install", source: "./plugin", scope: "user" }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers.get("HX-Trigger") ?? "{}")).toEqual({
      "web-pi:toast": {
        level: "error",
        message: "global settings: EACCES. Check Pi's global settings.json.",
      },
    });
  });

  it("refuses an action it does not know", async () => {
    const { app } = testApp();
    const res = await app.request(
      "/settings/plugins",
      form({ cwd: repo, action: "purge", scope: "user" }),
    );
    expect(res.headers.get("HX-Trigger")).toContain("Unsupported action");
  });

  it("says which resources are dormant while a project is untrusted", async () => {
    const { app } = testApp({ trustRequired: [repo] });
    const skills = await (
      await app.request(`/settings?section=skills&cwd=${repo}`)
    ).text();
    expect(skills).toContain("Project skills are not loaded");
    const plugins = await (
      await app.request(`/settings?section=plugins&cwd=${repo}`)
    ).text();
    expect(plugins).toContain("Project plugins are not loaded");
  });
});

describe("pi-web's settings and trust chrome", () => {
  it("disables folder-dependent settings when no folder is available", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    const html = await (await app.request("/settings")).text();
    expect(html).toContain(
      '<button type="button" class="settings-section-tab" disabled',
    );
  });
});

describe("tool definitions and the system prompt", () => {
  /**
   * pi-web resumes a dormant session to answer these two panels — a command
   * that starts no turn (useAgentSession.ts `loadSystemInfo`) — and a folder
   * that is gone cannot be resumed, so that one keeps the empty state.
   */
  it("says nothing has loaded when the session cannot be resumed", async () => {
    const { app } = testApp({ missingFolders: [repo] });
    expect(await (await app.request("/sessions/s1/tools")).text()).toContain(
      "Tool definitions have not loaded yet",
    );
    expect(
      await (await app.request("/sessions/s1/system-prompt")).text(),
    ).toContain("System prompt has not loaded yet");
  });

  it("resumes a stopped session to answer the panels", async () => {
    const { app } = testApp();
    expect(await (await app.request("/sessions/s1/tools")).text()).toContain(
      "tool-definitions-item",
    );
    expect(
      await (await app.request("/sessions/s1/system-prompt")).text(),
    ).toContain("system-prompt-text");
  });

  it("shows the active tools and the prompt of a live session", async () => {
    const { app } = testApp();
    await app.request("/sessions/s1/activate", { method: "POST" });
    const tools = await (await app.request("/sessions/s1/tools")).text();
    expect(tools).toContain("read");
    expect(tools).toContain("Absolute path of the file");
    // An inactive tool cannot be called this turn, so it is not offered.
    expect(tools).not.toContain("legacy");
    const prompt = await (
      await app.request("/sessions/s1/system-prompt")
    ).text();
    expect(prompt).toContain("You are Pi, a coding agent.");
  });
});

describe("the new-session model picker", () => {
  it("shows Model unavailable instead of inventing a reasoning level", async () => {
    const { app } = testApp({ models: [] });
    const page = await (await app.request("/new")).text();
    expect(page).toContain(
      'class="composer-model-detail">Model unavailable</span>',
    );
    expect(page).toContain('<select name="display-thinking" disabled');
    expect(page).toContain(
      '<option value="" selected="">Model unavailable</option>',
    );
    expect(page).not.toContain('<option value="auto"');
  });

  it("shows the effective default and offers only concrete reasoning levels", async () => {
    const { app } = testApp();
    const page = await (await app.request("/new")).text();
    expect(page).not.toContain('<option value="auto"');
    expect(page).toContain(
      '<option value="medium" selected="">balanced</option>',
    );
    expect(page).toContain('name="thinking" value=""');
    // From the catalog's own list for this model, not a hard-coded one.
    expect(page).toContain("balanced");
    expect(page).not.toContain('value="xhigh"');
  });

  /**
   * Before a session exists there is nothing to apply a pick to, so the menu
   * only re-renders itself with the choice recorded in the field the first
   * prompt posts.
   */
  it("records a pick in the field the first prompt carries", async () => {
    const { app } = testApp();
    const page = await (await app.request("/new")).text();
    expect(page).toContain('<input type="hidden" name="model"');
    expect(page).toContain("/workspaces/model-selector?cwd=");

    const html = await (
      await app.request(
        `/workspaces/model-selector?cwd=${encodeURIComponent(repo)}&model=fake%2Ffake-1`,
      )
    ).text();
    expect(html).toContain('value="fake/fake-1"');
    expect(html).toContain('aria-selected="true"');
    // Nothing was started: a pick here is a render, not a command.
    expect(html).not.toContain("hx-post");
  });
});
