import {
  configuredVersion,
  isDisabledPackage,
  isFilteredPackage,
  isPackageAction,
  packageSourceOf,
  packageStatus,
  relativeResource,
  resourceLabel,
  resourceTotals,
  setPackageDisabled,
} from "@core/packages";
import { describe, expect, it } from "vitest";

const disabled = {
  source: "npm:@acme/plugin",
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
};

describe("package entries", () => {
  it("reads the source out of both forms", () => {
    expect(packageSourceOf("npm:x")).toBe("npm:x");
    expect(packageSourceOf({ source: "npm:x" })).toBe("npm:x");
  });

  it("calls an entry disabled only when all four lists are empty", () => {
    expect(isDisabledPackage(disabled)).toBe(true);
    expect(isDisabledPackage({ ...disabled, skills: ["a"] })).toBe(false);
    expect(isDisabledPackage("npm:@acme/plugin")).toBe(false);
  });

  it("calls a partially filtered entry filtered, not disabled", () => {
    expect(isFilteredPackage({ source: "npm:x", extensions: ["a"] })).toBe(
      true,
    );
    expect(isFilteredPackage(disabled)).toBe(false);
    expect(isFilteredPackage("npm:x")).toBe(false);
  });
});

describe("enabling and disabling", () => {
  it("keeps the object form and merges the empty lists in", () => {
    expect(
      setPackageDisabled(
        [{ source: "npm:x", autoload: false, extensions: ["a"] }],
        "npm:x",
        true,
      ),
    ).toEqual([
      {
        source: "npm:x",
        autoload: false,
        extensions: [],
        skills: [],
        prompts: [],
        themes: [],
      },
    ]);
  });

  it("loses per-resource filters when a package is enabled again", () => {
    // Documented, not accidental: enabling writes the plain source back.
    expect(
      setPackageDisabled(
        [{ source: "npm:x", extensions: ["only-this.ts"] }],
        "npm:x",
        false,
      ),
    ).toEqual(["npm:x"]);
  });

  it("reports no match rather than rewriting the whole list", () => {
    expect(setPackageDisabled(["npm:y"], "npm:x", true)).toBe(null);
  });

  it("leaves other entries exactly as they were", () => {
    const other = { source: "git:https://example.com/r", skills: ["a"] };
    const next = setPackageDisabled(["npm:x", other], "npm:x", true);
    expect(next?.[1]).toEqual(other);
  });
});

describe("versions and status", () => {
  it("reads an npm version past a scoped package name", () => {
    expect(configuredVersion("npm:@acme/plugin@1.2.3")).toBe("1.2.3");
    expect(configuredVersion("npm:@acme/plugin")).toBeUndefined();
    expect(configuredVersion("npm:plugin@2.0")).toBe("2.0");
  });

  it("reads a git ref but not an SSH host", () => {
    expect(configuredVersion("git:https://github.com/a/b@v1")).toBe("v1");
    expect(configuredVersion("git@github.com:a/b")).toBeUndefined();
  });

  it("ranks disabled over loaded over installed over missing", () => {
    expect(packageStatus({ disabled: true, resources: 3 })).toBe("disabled");
    expect(
      packageStatus({ disabled: false, resources: 3, installedPath: "/x" }),
    ).toBe("loaded");
    expect(
      packageStatus({ disabled: false, resources: 0, installedPath: "/x" }),
    ).toBe("installed");
    expect(packageStatus({ disabled: false, resources: 0 })).toBe("missing");
  });

  it("only knows the five actions", () => {
    expect(isPackageAction("install")).toBe(true);
    expect(isPackageAction("purge")).toBe(false);
  });
});

describe("resource names", () => {
  it("names a SKILL.md and an index entry after their folder", () => {
    expect(resourceLabel("/p/skills/review/SKILL.md")).toBe("review");
    expect(resourceLabel("/p/extensions/lint/index.ts")).toBe("lint");
    expect(resourceLabel("/p/prompts/release.md")).toBe("release");
  });

  it("shows a path relative to the package, absolute when outside it", () => {
    expect(relativeResource("/p/x/a.ts", "/p/x")).toBe("a.ts");
    expect(relativeResource("/other/a.ts", "/p/x")).toBe("/other/a.ts");
    expect(relativeResource("/other/a.ts", undefined)).toBe("/other/a.ts");
  });

  it("counts resources per kind across every package", () => {
    expect(
      resourceTotals([
        {
          source: "a",
          scope: "user",
          status: "loaded",
          filtered: false,
          disabled: false,
          resources: [
            { kind: "skills", name: "s", relativePath: "s", path: "/s" },
            { kind: "skills", name: "t", relativePath: "t", path: "/t" },
          ],
        },
        {
          source: "b",
          scope: "project",
          status: "loaded",
          filtered: false,
          disabled: false,
          resources: [
            { kind: "extensions", name: "e", relativePath: "e", path: "/e" },
          ],
        },
      ]),
    ).toEqual({ extensions: 1, skills: 2, prompts: 0, themes: 0 });
  });
});
