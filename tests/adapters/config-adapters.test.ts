import { createDirectoryBrowser } from "@adapters/fs/browse";
import { createPiPackages } from "@adapters/pi/packages";
import { createPiProjectTrust } from "@adapters/pi/project-trust";
import { createPiProjectResources } from "@adapters/pi/resources";
import { createPiSkills } from "@adapters/pi/skills";
import { SkillFrontmatterError } from "@core/skill-toggle";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempAgent, type TempAgent } from "./temp-agent.ts";

// Everything here writes: settings, trust, skill frontmatter. Each test gets
// its own agent directory and HOME under the system temp folder, so a run can
// never touch the reader's own `~/.pi/agent` or `~/.agents`.

// Native homedir() ignores per-worker HOME changes in the thread pool.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => process.env["HOME"] ?? os.homedir() };
});

let temp: TempAgent;
let agentDir: string;
let project: string;

beforeEach(async () => {
  temp = await createTempAgent("web-pi-config-");
  ({ agentDir, project } = temp);
});

afterEach(async () => {
  await temp.dispose();
});

describe("the directory browser", () => {
  it("lists hidden folders and directory symlinks, never files", async () => {
    await mkdir(join(project, ".config"));
    await mkdir(join(project, "src"));
    await writeFile(join(project, "a.txt"), "a");
    await symlink(join(project, "src"), join(project, "link"));
    await symlink(join(project, "missing"), join(project, "broken"));
    const listing = await createDirectoryBrowser().browse(project);
    expect(listing.directories.map((entry) => entry.name)).toEqual([
      ".config",
      "link",
      "src",
    ]);
    expect(listing.parentPath).not.toBe(null);
  });

  it("refuses a path that is not a directory", async () => {
    await writeFile(join(project, "a.txt"), "a");
    await expect(
      createDirectoryBrowser().browse(join(project, "a.txt")),
    ).rejects.toThrow("Path is not a directory");
    await expect(
      createDirectoryBrowser().browse(join(project, "nope")),
    ).rejects.toThrow("Directory does not exist");
  });

  it("defaults to the isolated home folder", async () => {
    const listing = await createDirectoryBrowser().browse();
    expect(listing.path).toBe(realpathSync(temp.root));
  });
});

describe("project trust", () => {
  it("asks for nothing when the folder has no gated resources", async () => {
    const trust = createPiProjectTrust({ agentDir });
    expect(await trust.status(project)).toEqual({
      requiresTrust: false,
      trusted: true,
    });
    // Trusting a folder with nothing to trust must not write an entry.
    await trust.trust(project);
    await expect(
      readFile(join(agentDir, "trust.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("gates a folder with project extensions until it is trusted", async () => {
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    const trust = createPiProjectTrust({ agentDir });
    expect(await trust.status(project)).toEqual({
      requiresTrust: true,
      trusted: false,
    });
    await trust.trust(project);
    expect(await trust.status(project)).toEqual({
      requiresTrust: true,
      trusted: true,
    });
    // The decision lands in the store Pi's own terminal reads.
    const stored: unknown = JSON.parse(
      await readFile(join(agentDir, "trust.json"), "utf8"),
    );
    expect(Object.values(stored as Record<string, boolean>)).toContain(true);
  });
});

describe("folder commands", () => {
  it("offers extension commands, and only once the project is trusted", async () => {
    const extensions = join(project, ".pi", "extensions");
    await mkdir(extensions, { recursive: true });
    await writeFile(
      join(extensions, "probe.js"),
      'export default (pi) => { pi.registerCommand("probe",' +
        ' { description: "Project probe", handler: async () => {} }); };\n',
    );
    const extensionCommands = async () =>
      // A fresh adapter each time: the answer is cached per folder.
      (await createPiProjectResources({ agentDir }).commands(project)).filter(
        (command) => command.source === "extension",
      );

    expect(await extensionCommands()).toEqual([]);

    await createPiProjectTrust({ agentDir }).trust(project);
    expect(await extensionCommands()).toEqual([
      { name: "probe", description: "Project probe", source: "extension" },
    ]);
  });
});

describe("skills", () => {
  async function writeSkill(
    name: string,
    frontmatter: string,
  ): Promise<string> {
    const dir = join(project, ".pi", "skills", name);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    await writeFile(file, `---\nname: ${name}\n${frontmatter}---\nBody\n`);
    return file;
  }

  it("keeps an untrusted project's skills dormant", async () => {
    // A `.pi/skills` folder is itself what makes the project trust-requiring.
    await writeSkill("testing", "description: how we test\n");
    const listed = await createPiSkills({ agentDir }).list(project);
    expect(listed.projectResourcesLoaded).toBe(false);
    expect(listed.skills.some((skill) => skill.name === "testing")).toBe(false);
  });

  it("lists a project skill with its scope and manual flag", async () => {
    await writeSkill("testing", "description: how we test\n");
    await createPiProjectTrust({ agentDir }).trust(project);
    const listed = await createPiSkills({ agentDir }).list(project);
    const skill = listed.skills.find((entry) => entry.name === "testing");
    expect(skill?.scope).toBe("project");
    expect(skill?.disableModelInvocation).toBe(false);
    expect(listed.projectResourcesLoaded).toBe(true);
  });

  it("rewrites only the one frontmatter line when toggled", async () => {
    const file = await writeSkill(
      "testing",
      "description: how we test\ntags: [a, b]\n",
    );
    await createPiProjectTrust({ agentDir }).trust(project);
    const skills = createPiSkills({ agentDir });
    await skills.setDisabled(file, true);
    const written = await readFile(file, "utf8");
    expect(written).toContain("disable-model-invocation: true");
    expect(written).toContain("tags: [a, b]");
    expect(
      (await skills.list(project)).skills.find(
        (skill) => skill.name === "testing",
      )?.disableModelInvocation,
    ).toBe(true);
    await skills.setDisabled(file, false);
    expect(await readFile(file, "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  it("refuses a flow-mapping toggle without changing the skill's bytes or loadability", async () => {
    const dir = join(agentDir, "skills", "testing");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    const original = Buffer.from(
      '---\r\n# Keep this formatting.\r\n{ name: testing, description: how we test, "disable-model-invocation": false }\r\n---\r\n\r\nBody — unchanged.\r\n',
    );
    await writeFile(file, original);
    const skills = createPiSkills({ agentDir });
    const listed = await skills.list(project);
    expect(listed.diagnostics).toEqual([]);
    expect(listed.skills).toContainEqual(
      expect.objectContaining({
        filePath: file,
        disableModelInvocation: false,
      }),
    );

    await expect(skills.setDisabled(file, true)).rejects.toThrow(
      SkillFrontmatterError,
    );

    expect(await readFile(file)).toEqual(original);
    expect(await skills.list(project)).toEqual(listed);
  });

  it("annotates a skill with what its lock file recorded", async () => {
    await writeSkill("changelog", "description: d\n");
    await createPiProjectTrust({ agentDir }).trust(project);
    await writeFile(
      join(project, "skills-lock.json"),
      JSON.stringify({
        skills: {
          changelog: {
            source: "https://github.com/acme/skills.git",
            sourceType: "github",
            skillPath: "changelog/SKILL.md",
            computedHash: "c".repeat(40),
          },
        },
      }),
    );
    const listed = await createPiSkills({ agentDir }).list(project);
    const install = listed.skills.find(
      (skill) => skill.name === "changelog",
    )?.install;
    expect(install).toMatchObject({
      package: "acme/skills@changelog",
      scope: "project",
      versionHash: "c".repeat(40),
    });
  });
});

describe("extension packages", () => {
  async function writeSettings(scope: "global" | "project", body: unknown) {
    const file =
      scope === "global"
        ? join(agentDir, "settings.json")
        : join(project, ".pi", "settings.json");
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(body, null, 2));
  }

  it("reports a configured but uninstalled package as missing", async () => {
    await writeSettings("global", { packages: ["npm:@acme/pi-plugin@1.0.0"] });
    const view = await createPiPackages({ agentDir }).list(project);
    expect(view.packages).toHaveLength(1);
    expect(view.packages[0]).toMatchObject({
      source: "npm:@acme/pi-plugin@1.0.0",
      scope: "user",
      status: "missing",
      configuredVersion: "1.0.0",
    });
    expect(view.diagnostics.length).toBeGreaterThan(0);
  });

  it("disables and re-enables an entry in Pi's own settings file", async () => {
    await writeSettings("global", { packages: ["npm:@acme/pi-plugin"] });
    const packages = createPiPackages({ agentDir });
    await packages.run("disable", {
      cwd: project,
      scope: "user",
      source: "npm:@acme/pi-plugin",
    });
    const disabled: unknown = JSON.parse(
      await readFile(join(agentDir, "settings.json"), "utf8"),
    );
    expect((disabled as { packages: unknown[] }).packages[0]).toEqual({
      source: "npm:@acme/pi-plugin",
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });
    expect((await packages.list(project)).packages[0]?.status).toBe("disabled");
    await packages.run("enable", {
      cwd: project,
      scope: "user",
      source: "npm:@acme/pi-plugin",
    });
    const enabled: unknown = JSON.parse(
      await readFile(join(agentDir, "settings.json"), "utf8"),
    );
    expect((enabled as { packages: unknown[] }).packages).toEqual([
      "npm:@acme/pi-plugin",
    ]);
  });

  it("refuses to touch project packages while the project is untrusted", async () => {
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    await writeSettings("project", { packages: ["npm:@acme/pi-plugin"] });
    await expect(
      createPiPackages({ agentDir }).run("disable", {
        cwd: project,
        scope: "project",
        source: "npm:@acme/pi-plugin",
      }),
    ).rejects.toThrow("must be trusted");
  });
});
