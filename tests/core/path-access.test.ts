import {
  directoryWithin,
  documentFilePath,
  isBashOutputPath,
  localFilePath,
  resolveUnder,
  parentPath,
  referencesPath,
  samePath,
  withinAny,
} from "@core/path-access";
import { describe, expect, it } from "vitest";

describe("directoryWithin", () => {
  it("accepts the root itself and anything under it", () => {
    expect(directoryWithin("/repo", "/repo")).toBe(true);
    expect(directoryWithin("/repo", "/repo/src/web")).toBe(true);
    expect(directoryWithin("/repo/", "/repo/src/")).toBe(true);
  });

  it("rejects siblings, escapes, and relative paths", () => {
    expect(directoryWithin("/repo", "/repo-other")).toBe(false);
    expect(directoryWithin("/repo", "/repo/../etc")).toBe(false);
    expect(directoryWithin("/repo", "/etc/passwd")).toBe(false);
    expect(directoryWithin("/repo", "repo/src")).toBe(false);
    expect(directoryWithin("repo", "/repo/src")).toBe(false);
  });

  it("normalises Windows separators and drive roots", () => {
    expect(directoryWithin("C:/repo", "C:\\repo\\src")).toBe(true);
    expect(directoryWithin("C:/repo", "D:/repo/src")).toBe(false);
  });
});

describe("isBashOutputPath", () => {
  it("only accepts Pi's capture files directly in the temp directory", () => {
    expect(isBashOutputPath("/tmp", "/tmp/pi-bash-abc123.log")).toBe(true);
    expect(isBashOutputPath("/tmp", "/tmp/nested/pi-bash-a.log")).toBe(false);
    expect(isBashOutputPath("/tmp", "/tmp/other.log")).toBe(false);
    expect(isBashOutputPath("/tmp", "/tmp/pi-bash-../../etc/passwd")).toBe(
      false,
    );
    expect(isBashOutputPath("/tmp", "/var/pi-bash-a.log")).toBe(false);
  });
});

describe("withinAny and parentPath", () => {
  it("accepts a path under any one root", () => {
    expect(withinAny(["/a", "/b"], "/b/c")).toBe(true);
    expect(withinAny(["/a", "/b"], "/c")).toBe(false);
    expect(withinAny([], "/a")).toBe(false);
  });

  it("names the folder a missing file would live in", () => {
    expect(parentPath("/repo/src/new.ts")).toBe("/repo/src");
    expect(parentPath("/repo/src/")).toBe("/repo");
    expect(parentPath("/top")).toBe("/");
  });
});

describe("samePath", () => {
  it("compares segments, case-sensitively outside Windows", () => {
    expect(samePath("/a/b", "/a/./b")).toBe(true);
    expect(samePath("/a/b", "/a/B")).toBe(false);
    expect(samePath("C:/a/b", "c:\\A\\B")).toBe(true);
    expect(samePath("/a/b", "C:/a/b")).toBe(false);
  });
});

describe("referencesPath", () => {
  const text =
    'read /repo/src/main.ts:12 and file:///other/notes.md plus "/x/y.txt"';

  it("accepts a whole token, a line suffix, and a file URL", () => {
    expect(referencesPath(text, "/repo/src/main.ts")).toBe(true);
    expect(referencesPath(text, "/other/notes.md")).toBe(true);
    expect(referencesPath(text, "/x/y.txt")).toBe(true);
  });

  it("refuses a prefix, a suffix, and a longer path", () => {
    expect(referencesPath(text, "/repo/src/main.t")).toBe(false);
    expect(referencesPath(text, "/repo/src")).toBe(false);
    expect(referencesPath(text, "/repo/src/main.tsx")).toBe(false);
    expect(referencesPath("see main.ts", "/repo/src/main.ts")).toBe(false);
  });

  it("finds a percent-encoded mention", () => {
    expect(referencesPath("href=/repo/a%20b.txt", "/repo/a b.txt")).toBe(true);
  });
});

describe("localFilePath", () => {
  it("accepts absolute, file:, and contained relative paths", () => {
    expect(localFilePath("/etc/hosts", "/repo")).toBe("/etc/hosts");
    expect(localFilePath("file:///repo/a.ts", "/repo")).toBe("/repo/a.ts");
    expect(localFilePath("src/a.ts:12", "/repo")).toBe("/repo/src/a.ts");
  });

  it("rejects other schemes, protocol-relative, and escapes", () => {
    expect(localFilePath("https://x.dev/a", "/repo")).toBeNull();
    expect(localFilePath("//x.dev/a", "/repo")).toBeNull();
    expect(localFilePath("../../etc/passwd", "/repo")).toBeNull();
    expect(localFilePath("just words", "/repo")).toBeNull();
  });
});

describe("documentFilePath", () => {
  it("decodes absolute and file URL paths exactly once, without decoding the document path", () => {
    expect(
      documentFilePath("/repo/space%20name.md#heading", "/repo/docs/guide.md"),
    ).toBe("/repo/space name.md");
    expect(
      documentFilePath(
        "file:///repo/literal%2520name.md",
        "/repo/docs/guide.md",
      ),
    ).toBe("/repo/literal%20name.md");
    expect(
      documentFilePath("./name%3A12.md", "/repo/docs%20literal/guide.md"),
    ).toBe("/repo/docs%20literal/name:12.md");
  });

  it.each([
    "./bad%escape.md",
    "./bad%FF.md",
    "file:///repo/bad%ZZ.md",
    "//host/file.md",
    "https://host/file.md",
    "javascript:alert(1)",
    "data:text/plain,x",
    "#heading",
    "?q=1",
  ])("does not turn %s into a local file", (href) => {
    expect(documentFilePath(href, "/repo/docs/guide.md")).toBeNull();
  });

  it("does not change conversation-relative path acceptance or literal path resolution", () => {
    expect(localFilePath("../README.md", "/repo/docs")).toBeNull();
    expect(localFilePath("./space%20name.md", "/repo")).toBe(
      "/repo/space%20name.md",
    );
    expect(resolveUnder("/repo", "./space%20name.md")).toBe(
      "/repo/space%20name.md",
    );
  });
});

describe("resolveUnder", () => {
  it("joins a relative path onto the folder and collapses dots", () => {
    expect(resolveUnder("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
    expect(resolveUnder("/repo", "./src/../a.ts")).toBe("/repo/a.ts");
    expect(resolveUnder("/repo", "/tmp/a.ts")).toBe("/tmp/a.ts");
  });
});
