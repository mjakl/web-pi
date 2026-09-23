import {
  clampSearchLimit,
  installFromLock,
  installMessage,
  installSucceeded,
  lookupLockEntry,
  mapSearchResults,
  normalizeSource,
  skillFolder,
  skillGroup,
  skillSlug,
  skillsShUrl,
  updateArgs,
} from "@core/skills";
import { describe, expect, it } from "vitest";

const githubEntry = {
  source: "acme/skills",
  sourceType: "github",
  skillPath: "changelog/SKILL.md",
  skillFolderHash: "a".repeat(40),
  computedHash: "b".repeat(40),
};

describe("install metadata from a lock entry", () => {
  it("names the package after its source and takes the global hash", () => {
    const install = installFromLock("changelog", githubEntry, "global");
    expect(install).toMatchObject({
      package: "acme/skills@changelog",
      source: "acme/skills",
      versionHash: "a".repeat(40),
      skillsShUrl: "https://skills.sh/acme/skills/changelog",
      canCheckForUpdates: true,
    });
  });

  it("takes the computed hash for a project install", () => {
    expect(installFromLock("changelog", githubEntry, "project")).toMatchObject({
      versionHash: "b".repeat(40),
    });
  });

  it("cannot check a project install pinned to a ref", () => {
    // A pinned project install never moves, so there is nothing to compare.
    expect(
      installFromLock("changelog", { ...githubEntry, ref: "v1" }, "project")
        ?.canCheckForUpdates,
    ).toBe(false);
    expect(
      installFromLock("changelog", { ...githubEntry, ref: "v1" }, "global")
        ?.canCheckForUpdates,
    ).toBe(true);
  });

  it("cannot check a source that is not a plain owner/repo", () => {
    expect(
      installFromLock(
        "x",
        { ...githubEntry, source: "https://example.com/x.git" },
        "global",
      )?.canCheckForUpdates,
    ).toBe(false);
  });

  it("gives a local skill no registry link", () => {
    expect(
      installFromLock(
        "x",
        { source: "../shared", sourceType: "local" },
        "global",
      )?.skillsShUrl,
    ).toBeUndefined();
  });

  it("has nothing to say about an entry without a source", () => {
    expect(installFromLock("x", { sourceType: "github" }, "global")).toBe(
      undefined,
    );
  });
});

describe("source spellings", () => {
  it("reduces every GitHub spelling to owner/repo", () => {
    for (const source of [
      "git+https://github.com/acme/skills.git",
      "https://github.com/acme/skills/",
      "git@github.com:acme/skills.git",
    ]) {
      expect(normalizeSource(source, "github")).toBe("acme/skills");
    }
  });

  it("only strips a trailing slash from anything else", () => {
    expect(normalizeSource("https://example.com/x/", "url")).toBe(
      "https://example.com/x",
    );
  });

  it("has no registry page for a URL or SSH source", () => {
    expect(skillsShUrl("https://example.com/x", "y")).toBeUndefined();
    expect(skillsShUrl("git@example.com:x", "y")).toBeUndefined();
  });

  it("percent-encodes every segment of a registry link", () => {
    expect(skillsShUrl("acme/my skills", "a b")).toBe(
      "https://skills.sh/acme/my%20skills/a%20b",
    );
  });
});

describe("addressing a skill", () => {
  it("strips the SKILL.md from the folder", () => {
    expect(skillFolder("changelog/SKILL.md")).toBe("changelog");
    expect(skillFolder("nested\\deep\\skill.md")).toBe("nested/deep");
    expect(skillFolder("SKILL.md")).toBe("");
  });

  it("slugs a display name the way skills.sh addresses it", () => {
    expect(skillSlug("My Great_Skill!")).toBe("my-great-skill");
  });
});

describe("npx arguments", () => {
  it("encodes a ref containing a slash while naming the one skill", () => {
    const install = installFromLock(
      "changelog",
      { ...githubEntry, ref: "release/1.2" },
      "global",
    );
    expect(install && updateArgs(install)).toEqual([
      "skills",
      "add",
      "acme/skills/changelog#release%2F1.2",
      "--skill",
      "changelog",
      "-y",
      "--agent",
      "pi",
      "-g",
    ]);
  });

  it("reads success out of the output, not the exit code", () => {
    expect(installSucceeded("[32mInstallation complete[0m")).toBe(true);
    expect(installSucceeded("Installed 3 skills")).toBe(true);
    expect(installSucceeded("could not resolve")).toBe(false);
  });

  it("keeps the tail of a long log and strips its colours", () => {
    const tail = `${"x".repeat(296)}done`;
    const long = `[31mhead${tail}[0m`;
    expect(installMessage(long, 300)).toBe(tail);
  });
});

describe("registry search", () => {
  it("clamps the limit to 1..50 and defaults to 50", () => {
    expect(clampSearchLimit(undefined)).toBe(50);
    expect(clampSearchLimit("0")).toBe(50);
    expect(clampSearchLimit("7")).toBe(7);
    expect(clampSearchLimit(900)).toBe(50);
  });

  it("sorts by installs, formats counts, and drops unusable rows", () => {
    expect(
      mapSearchResults(
        {
          skills: [
            { name: "small", source: "a/b", id: "a/b", installs: 12 },
            { name: "big", source: "c/d", id: "c/d", installs: 3_400_000 },
            { name: "mid", id: "e/f", installs: 1200 },
            { name: "", source: "g/h", installs: 5 },
            { source: "i/j" },
          ],
        },
        "https://skills.sh",
      ),
    ).toEqual([
      {
        package: "c/d@big",
        installs: "3.4M installs",
        url: "https://skills.sh/c/d",
      },
      {
        package: "e/f@mid",
        installs: "1.2K installs",
        url: "https://skills.sh/e/f",
      },
      {
        package: "a/b@small",
        installs: "12 installs",
        url: "https://skills.sh/a/b",
      },
    ]);
  });

  it("survives a payload that is not a list at all", () => {
    expect(mapSearchResults({ error: "nope" }, "https://skills.sh")).toEqual(
      [],
    );
  });
});

describe("lock lookup and grouping", () => {
  it("matches a differently cased key", () => {
    expect(
      lookupLockEntry({ Changelog: { source: "a/b" } }, "changelog"),
    ).toEqual({ source: "a/b" });
  });

  it("groups registry installs apart from hand-written skills", () => {
    const install = installFromLock("changelog", githubEntry, "global");
    expect(
      skillGroup({
        name: "changelog",
        description: "",
        filePath: "/a",
        baseDir: "/",
        disableModelInvocation: false,
        scope: "global",
        ...(install ? { install } : {}),
      }),
    ).toBe("global-registry");
    expect(
      skillGroup({
        name: "local",
        description: "",
        filePath: "/a",
        baseDir: "/",
        disableModelInvocation: false,
        scope: "path",
      }),
    ).toBe("path");
  });
});
