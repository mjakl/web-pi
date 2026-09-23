import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { createPiSkills } from "@adapters/pi/skills";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempAgent, type TempAgent } from "./temp-agent.ts";

// The registry and update paths of the skills adapter, with fetch and npx
// answered by the test: nothing here reaches skills.sh, GitHub, or npm, and
// the global lock file is redirected through XDG_STATE_HOME into the temp
// directory, which is also HOME. Listing and the frontmatter toggle live in
// config-adapters.

let temp: TempAgent;
let root: string;
let agentDir: string;
let project: string;
const env = { ...process.env };

beforeEach(async () => {
  temp = await createTempAgent("web-pi-skills-");
  ({ root, agentDir, project } = temp);
  process.env["XDG_STATE_HOME"] = join(root, "state");
  delete process.env["SKILLS_API_URL"];
  delete process.env["GITHUB_TOKEN"];
  delete process.env["GH_TOKEN"];
});

afterEach(async () => {
  await temp.dispose();
  process.env = { ...env };
});

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

/** A JSON answer with the given status. */
function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch that answers from a URL-substring table and records the calls. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const http: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    const route = Object.entries(routes).find(([key]) => url.includes(key));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(route[1]());
  };
  return { http, calls };
}

async function writeSkill(
  scope: "global" | "home" | "project",
  name: string,
): Promise<void> {
  const dir =
    scope === "global"
      ? join(agentDir, "skills", name)
      : scope === "home"
        ? join(root, ".agents", "skills", name)
        : join(project, ".pi", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`,
  );
}

async function writeLock(
  scope: "global" | "project",
  skills: Record<string, unknown>,
): Promise<void> {
  const file =
    scope === "global"
      ? join(root, "state", "skills", ".skill-lock.json")
      : join(project, "skills-lock.json");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify({ skills }));
}

const githubEntry = {
  source: "acme/skills",
  sourceType: "github",
  skillPath: "changelog/SKILL.md",
  skillFolderHash: HASH_A,
};

describe("listing", () => {
  it("reads ~/.agents/skills from the test's HOME, never the developer's", async () => {
    await writeSkill("global", "changelog");
    await writeSkill("home", "from-home");
    const listed = await createPiSkills({ agentDir }).list(project);
    expect(
      listed.skills.filter((s) => s.scope === "global").map((s) => s.name),
    ).toEqual(["changelog", "from-home"]);
  });

  it("annotates a global skill from the lock file XDG_STATE_HOME points at", async () => {
    await writeSkill("global", "changelog");
    await writeLock("global", { Changelog: githubEntry });
    const listed = await createPiSkills({ agentDir }).list(project);
    expect(listed.skills.find((s) => s.name === "changelog")).toMatchObject({
      scope: "global",
      install: {
        package: "acme/skills@changelog",
        scope: "global",
        versionHash: HASH_A,
      },
    });
  });

  it("keeps valid skills visible with a broken lock and reports malformed skills", async () => {
    await writeSkill("global", "plain");
    await mkdir(join(root, "state", "skills"), { recursive: true });
    await writeFile(join(root, "state", "skills", ".skill-lock.json"), "{");
    // A skill the loader cannot take is reported, not silently dropped.
    await mkdir(join(agentDir, "skills", "broken"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "broken", "SKILL.md"),
      "no frontmatter\n",
    );
    const listed = await createPiSkills({ agentDir }).list(project);
    const plain = listed.skills.find((s) => s.name === "plain");
    expect(plain).toMatchObject({ name: "plain", scope: "global" });
    expect(plain?.install).toBeUndefined();
    expect(listed.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("search", () => {
  it("queries the registry and returns its mapped response", async () => {
    const { http, calls } = fakeFetch({
      "/api/search": () =>
        answer({
          skills: [{ id: "a/x/one", name: "one", source: "a/x", installs: 5 }],
        }),
    });
    const hits = await createPiSkills({ agentDir, fetch: http }).search(
      "changelog tool",
      2,
    );
    expect(hits).toEqual([
      {
        package: "a/x@one",
        installs: "5 installs",
        url: "https://skills.sh/a/x/one",
      },
    ]);
    expect(calls[0]?.url).toBe(
      "https://skills.sh/api/search?q=changelog%20tool&limit=2",
    );
  });

  it("reports a registry failure instead of guessing, and honours SKILLS_API_URL", async () => {
    process.env["SKILLS_API_URL"] = "http://registry.test";
    const { http, calls } = fakeFetch({
      "/api/search": () => answer({}, 503),
    });
    await expect(
      createPiSkills({ agentDir, fetch: http }).search("x", 0),
    ).rejects.toThrow("skills.sh answered 503");
    expect(calls[0]?.url).toBe("http://registry.test/api/search?q=x&limit=50");
  });
});

describe("install", () => {
  it("runs npx skills add and returns what it printed", async () => {
    const npx = vi.fn().mockResolvedValue({
      stdout: "[32mInstalled 1 skill[0m\n",
      stderr: "",
      failed: false,
    });
    const skills = createPiSkills({ agentDir, npx });
    expect(
      await skills.install("acme/skills@changelog", "project", project),
    ).toBe("Installed 1 skill");
    expect(npx).toHaveBeenCalledWith(
      ["skills", "add", "acme/skills@changelog", "-y", "--agent", "pi"],
      { timeout: 60_000, cwd: project },
    );
    await skills.install("acme/skills@changelog", "global", project);
    expect(npx).toHaveBeenLastCalledWith(
      ["skills", "add", "acme/skills@changelog", "-y", "--agent", "pi", "-g"],
      { timeout: 60_000 },
    );
  });

  it("requires reported success even after a zero exit, and supplies a silent-failure message", async () => {
    const npx = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "not found",
      failed: false,
    });
    await expect(
      createPiSkills({ agentDir, npx }).install("x@y", "global", project),
    ).rejects.toThrow("not found");
    const silent = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      failed: true,
    });
    await expect(
      createPiSkills({ agentDir, npx: silent }).install(
        "x@y",
        "global",
        project,
      ),
    ).rejects.toThrow("Install failed");
  });
});

describe("check", () => {
  it("compares a global skill's folder hash with GitHub's tree", async () => {
    await writeSkill("global", "changelog");
    await writeSkill("global", "readme");
    await writeLock("global", {
      changelog: githubEntry,
      readme: {
        ...githubEntry,
        skillPath: "SKILL.md",
        skillFolderHash: HASH_B,
      },
    });
    const { http, calls } = fakeFetch({
      "/git/trees/": () =>
        answer({
          sha: HASH_B,
          tree: [{ path: "changelog", type: "tree", sha: HASH_A }],
        }),
    });
    const updates = await createPiSkills({ agentDir, fetch: http }).check(
      project,
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        {
          package: "acme/skills@changelog",
          scope: "global",
          state: "up-to-date",
          currentVersion: HASH_A,
          latestVersion: HASH_A,
        },
        {
          package: "acme/skills@readme",
          scope: "global",
          state: "up-to-date",
          currentVersion: HASH_B,
          latestVersion: HASH_B,
        },
      ]),
    );
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/acme/skills/git/trees/HEAD?recursive=1",
    );
    expect(calls[0]?.init?.headers).not.toHaveProperty("Authorization");
  });

  it("sends the GitHub token, follows the lock's ref, and reports a new hash", async () => {
    process.env["GITHUB_TOKEN"] = "tok";
    await writeSkill("global", "changelog");
    await writeLock("global", {
      changelog: { ...githubEntry, ref: "v2" },
    });
    const { http, calls } = fakeFetch({
      "/git/trees/v2": () =>
        answer({ tree: [{ path: "changelog", type: "tree", sha: HASH_B }] }),
    });
    const [update] = await createPiSkills({ agentDir, fetch: http }).check(
      project,
      { package: "acme/skills@changelog", scope: "global" },
    );
    expect(update).toMatchObject({
      state: "update-available",
      currentVersion: HASH_A,
      latestVersion: HASH_B,
    });
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer tok",
    });
  });

  it("isolates a missing folder from a successful check and reports GitHub failures", async () => {
    await writeSkill("global", "changelog");
    await writeSkill("global", "gone");
    await writeLock("global", {
      changelog: githubEntry,
      gone: { ...githubEntry, skillPath: "gone/SKILL.md" },
    });
    const { http } = fakeFetch({
      "/git/trees/": () =>
        answer({ tree: [{ path: "changelog", type: "tree", sha: HASH_A }] }),
    });
    const updates = await createPiSkills({ agentDir, fetch: http }).check(
      project,
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          package: "acme/skills@changelog",
          state: "up-to-date",
          latestVersion: HASH_A,
        }),
        expect.objectContaining({
          package: "acme/skills@gone",
          state: "error",
          message: "No tree entry for gone",
        }),
      ]),
    );

    const failing = fakeFetch({ "/git/trees/": () => answer({}, 500) });
    const [failed] = await createPiSkills({
      agentDir,
      fetch: failing.http,
    }).check(project, { package: "acme/skills@changelog", scope: "global" });
    expect(failed).toMatchObject({
      state: "error",
      message: "GitHub answered 500",
    });
  });

  it("asks skills.sh for a project skill's hash", async () => {
    await writeSkill("project", "changelog");
    await createPiProjectTrust({ agentDir }).trust(project);
    await writeLock("project", {
      changelog: { ...githubEntry, computedHash: HASH_A },
    });
    const { http, calls } = fakeFetch({
      "/api/download/": () => answer({ hash: HASH_B }),
    });
    const [update] = await createPiSkills({ agentDir, fetch: http }).check(
      project,
    );
    expect(update).toMatchObject({
      package: "acme/skills@changelog",
      scope: "project",
      state: "update-available",
      latestVersion: HASH_B,
    });
    expect(calls[0]?.url).toBe(
      "https://skills.sh/api/download/acme/skills/changelog",
    );

    const noHash = fakeFetch({ "/api/download/": () => answer({}) });
    const [missing] = await createPiSkills({
      agentDir,
      fetch: noHash.http,
    }).check(project);
    expect(missing?.message).toBe("skills.sh did not return a version hash.");
    const down = fakeFetch({ "/api/download/": () => answer({}, 404) });
    const [failed] = await createPiSkills({
      agentDir,
      fetch: down.http,
    }).check(project);
    expect(failed?.message).toBe("skills.sh answered 404");
  });

  it("marks an entry it cannot check, and refuses an unknown target", async () => {
    await writeSkill("global", "local");
    await writeLock("global", {
      local: { source: "/home/me/skills", sourceType: "local" },
    });
    const skills = createPiSkills({ agentDir });
    expect(await skills.check(project)).toEqual([
      {
        package: "/home/me/skills@local",
        scope: "global",
        state: "unsupported",
        message: "This lock entry cannot be checked automatically.",
      },
    ]);
    await expect(
      skills.check(project, { package: "nope@x", scope: "global" }),
    ).rejects.toThrow("Installed skill not found");
  });
});

describe("update", () => {
  it("re-adds the exact folder and ref the lock recorded", async () => {
    await writeSkill("global", "changelog");
    await writeLock("global", { changelog: { ...githubEntry, ref: "v2" } });
    const npx = vi.fn().mockResolvedValue({
      stdout: "Installation complete",
      stderr: "",
      failed: false,
    });
    const message = await createPiSkills({ agentDir, npx }).update(
      project,
      "acme/skills@changelog",
      "global",
    );
    expect(message).toBe("Installation complete");
    expect(npx).toHaveBeenCalledWith(
      [
        "skills",
        "add",
        "acme/skills/changelog#v2",
        "--skill",
        "changelog",
        "-y",
        "--agent",
        "pi",
        "-g",
      ],
      { timeout: 60_000 },
    );
  });

  it("throws the log when the update failed, and refuses what it cannot update", async () => {
    await writeSkill("global", "changelog");
    await writeSkill("global", "local");
    await writeLock("global", {
      changelog: githubEntry,
      local: { source: "/home/me/skills", sourceType: "local" },
    });
    const npx = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "network down",
      failed: true,
    });
    const skills = createPiSkills({ agentDir, npx });
    await expect(
      skills.update(project, "acme/skills@changelog", "global"),
    ).rejects.toThrow("network down");
    await expect(
      skills.update(project, "/home/me/skills@local", "global"),
    ).rejects.toThrow("cannot be updated automatically");
    await expect(skills.update(project, "nope@x", "global")).rejects.toThrow(
      "Installed skill not found",
    );
  });
});
