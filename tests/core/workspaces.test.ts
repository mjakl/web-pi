import {
  parseWorktreeList,
  projectIdentity,
  rememberProjects,
  removedProject,
  selectableWorktrees,
  shortPath,
} from "@core/workspaces";
import { describe, expect, it } from "vitest";

/** `git worktree list --porcelain -z` writes NUL after every field. */
function porcelain(...fields: string[]): string {
  return fields.map((field) => `${field}\0`).join("");
}

describe("worktree list parsing", () => {
  it("starts a record per worktree and strips the branch prefix", () => {
    const records = parseWorktreeList(
      porcelain(
        "worktree /repo",
        "HEAD abc",
        "branch refs/heads/main",
        "",
        "worktree /repo/wt",
        "HEAD def",
        "branch refs/heads/feature/x",
      ),
    );
    expect(records).toEqual([
      { path: "/repo", branch: "main", bare: false, prunable: false },
      { path: "/repo/wt", branch: "feature/x", bare: false, prunable: false },
    ]);
  });

  it("marks bare and prunable records and keeps a detached head branchless", () => {
    const records = parseWorktreeList(
      porcelain(
        "worktree /repo.git",
        "bare",
        "",
        "worktree /repo/gone",
        "HEAD abc",
        "detached",
        "prunable gitdir file points to non-existent location",
      ),
    );
    expect(records[0]?.bare).toBe(true);
    expect(records[1]?.prunable).toBe(true);
    expect(records[1]?.branch).toBe(null);
  });

  it("offers neither bare, prunable, nor missing folders", () => {
    const records = parseWorktreeList(
      porcelain(
        "worktree /repo.git",
        "bare",
        "",
        "worktree /repo/gone",
        "prunable stale",
        "",
        "worktree /repo/main",
        "branch refs/heads/main",
        "",
        "worktree /repo/deleted",
        "branch refs/heads/old",
      ),
    );
    expect(
      selectableWorktrees(records, (path) => path !== "/repo/deleted"),
    ).toEqual([{ path: "/repo/main", branch: "main" }]);
  });
});

describe("project identity", () => {
  const base = {
    cwd: "/repo",
    root: "/repo",
    toplevel: "/repo",
    gitDir: "/repo/.git",
    commonDir: "/repo/.git",
    bare: false,
    branch: "main",
  };

  it("treats the main checkout as top level but not a worktree", () => {
    expect(projectIdentity(base)).toEqual({
      root: "/repo",
      branch: "main",
      isWorktree: false,
      isTopLevel: true,
    });
  });

  it("calls a linked worktree one: its gitdir is its own", () => {
    expect(
      projectIdentity({
        ...base,
        cwd: "/repo/wt",
        toplevel: "/repo/wt",
        gitDir: "/repo/.git/worktrees/wt",
        branch: "feature",
      }),
    ).toEqual({
      root: "/repo",
      branch: "feature",
      isWorktree: true,
      isTopLevel: true,
    });
  });

  it("gives a subdirectory its own identity", () => {
    // The agent only ever sees that subtree, so its sessions are not the
    // repository's.
    expect(projectIdentity({ ...base, cwd: "/repo/src" })).toEqual({
      root: "/repo/src",
      branch: "main",
      isWorktree: false,
      isTopLevel: false,
    });
  });

  it("reports a bare directory branchless", () => {
    expect(
      projectIdentity({
        cwd: "/repo.git",
        root: "/repo.git",
        toplevel: "/somewhere/else",
        gitDir: "/repo.git",
        commonDir: "/repo.git",
        bare: true,
        branch: "main",
      }),
    ).toEqual({
      root: "/repo.git",
      branch: null,
      isWorktree: false,
      isTopLevel: true,
    });
  });
});

describe("the remembered project map", () => {
  it("places a deleted worktree under the repository it belonged to", () => {
    expect(removedProject("/repo/wt", { "/repo/wt": "/repo" })).toEqual({
      root: "/repo",
      branch: null,
      isWorktree: true,
      isTopLevel: true,
    });
  });

  it("leaves an unknown folder standalone rather than guessing", () => {
    expect(removedProject("/repo/wt", {})).toEqual({
      root: "/repo/wt",
      branch: null,
      isWorktree: false,
      isTopLevel: false,
    });
  });

  it("reports nothing changed when every folder is already recorded", () => {
    const known = { "/repo": "/repo", "/repo/wt": "/repo" };
    expect(rememberProjects(known, ["/repo", "/repo/wt"], "/repo")).toEqual({
      next: known,
      changed: false,
    });
  });

  it("adds folders and normalises the key", () => {
    const { next, changed } = rememberProjects({}, ["/repo/wt/"], "/repo");
    expect(changed).toBe(true);
    expect(next).toEqual({ "/repo/wt": "/repo" });
  });
});

describe("shortPath", () => {
  it("writes the home folder as a tilde, and leaves everything else", () => {
    expect(shortPath("/home/me/code/app", "/home/me")).toBe("~/code/app");
    expect(shortPath("/home/me", "/home/me")).toBe("~");
    expect(shortPath("/srv/app", "/home/me")).toBe("/srv/app");
    // A sibling folder that merely starts with the same characters is not in it.
    expect(shortPath("/home/meade/app", "/home/me")).toBe("/home/meade/app");
    expect(shortPath("/home/me/app")).toBe("/home/me/app");
  });
});
