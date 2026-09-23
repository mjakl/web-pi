import { createPiProjectResolver } from "@adapters/pi/projects";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real git in a temporary checkout: the identity rules only mean anything
// against the paths git actually prints.

const run = promisify(execFile);

let root: string;
let agentDir: string;
let repo: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-projects-"));
  agentDir = join(root, "agent");
  repo = join(root, "repo");
  await run("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "a\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "first");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project identity against a real checkout", () => {
  it("reports the checkout itself as the project root", async () => {
    const resolver = createPiProjectResolver({ agentDir });
    const project = await resolver.resolve(repo);
    expect(project.isTopLevel).toBe(true);
    expect(project.isWorktree).toBe(false);
    expect(project.branch).toBe("main");
    // The temporary directory may be a symlink (/tmp on macOS), so only the
    // basename is stable.
    expect(project.root.endsWith("/repo")).toBe(true);
  });

  it("answers an expired entry as it stands and refreshes it behind the reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const resolver = createPiProjectResolver({ agentDir });
      expect((await resolver.resolve(repo)).branch).toBe("main");
      await git(repo, "checkout", "-b", "feature");
      expect((await resolver.resolve(repo)).branch).toBe("main");
      vi.setSystemTime(Date.now() + 61_000);
      // The stale answer comes back at once; the next one is fresh.
      expect((await resolver.resolve(repo)).branch).toBe("main");
      await expect
        .poll(async () => (await resolver.resolve(repo)).branch)
        .toBe("feature");
    } finally {
      vi.useRealTimers();
    }
  });

  it("groups a linked worktree under the main checkout", async () => {
    const wt = join(root, "wt");
    await git(repo, "worktree", "add", "-b", "feature", wt);
    const resolver = createPiProjectResolver({ agentDir });
    const project = await resolver.resolve(wt);
    expect(project.isWorktree).toBe(true);
    expect(project.branch).toBe("feature");
    expect(project.root.endsWith("/repo")).toBe(true);
  });

  it("gives a subdirectory its own identity", async () => {
    // Sessions started in a subtree are not the repository's: the agent only
    // ever sees that subtree.
    const sub = join(repo, "src");
    await mkdir(sub);
    const project = await createPiProjectResolver({ agentDir }).resolve(sub);
    expect(project.isTopLevel).toBe(false);
    expect(project.root).toBe(sub);
  });

  it("treats a folder git knows nothing about as its own project", async () => {
    const plain = join(root, "notes");
    await mkdir(plain);
    const project = await createPiProjectResolver({ agentDir }).resolve(plain);
    expect(project).toEqual({
      root: plain,
      branch: null,
      isWorktree: false,
      isTopLevel: false,
    });
  });

  it("lists every worktree once, with its branch", async () => {
    const wt = join(root, "wt");
    await git(repo, "worktree", "add", "-b", "feature", wt);
    const listing = await createPiProjectResolver({ agentDir }).worktrees(repo);
    expect(listing.isGit).toBe(true);
    expect(
      listing.worktrees
        .map((tree) => tree.branch)
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["feature", "main"]);
  });

  it("writes the folder-to-repository map privately and only once", async () => {
    const wt = join(root, "wt");
    await git(repo, "worktree", "add", "-b", "feature", wt);
    const resolver = createPiProjectResolver({ agentDir });
    await resolver.worktrees(repo);
    const file = join(agentDir, "web-pi", "worktree-projects.json");
    const written: unknown = JSON.parse(await readFile(file, "utf8"));
    const canonicalRepo = await realpath(repo);
    expect(written).toMatchObject({
      [canonicalRepo]: canonicalRepo,
      [await realpath(wt)]: canonicalRepo,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(agentDir, "web-pi"))).mode & 0o777).toBe(0o700);
    // A fixed old timestamp detects same-content rewrites without a sleep.
    await utimes(file, new Date(0), new Date(0));
    const before = await stat(file);
    await resolver.worktrees(repo);
    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
  });

  it("keeps a deleted worktree grouped under the repository", async () => {
    const wt = join(root, "wt");
    await git(repo, "worktree", "add", "-b", "feature", wt);
    const resolver = createPiProjectResolver({ agentDir });
    await resolver.worktrees(repo);
    await rm(wt, { recursive: true, force: true });
    expect(await resolver.available(wt)).toBe(false);
    const project = await createPiProjectResolver({ agentDir }).resolve(wt);
    expect(project.isWorktree).toBe(true);
    expect(project.root).toBe(await realpath(repo));
  });

  it("still lists the repository's worktrees when the folder is gone", async () => {
    const wt = join(root, "wt");
    await git(repo, "worktree", "add", "-b", "feature", wt);
    const resolver = createPiProjectResolver({ agentDir });
    await resolver.worktrees(repo);
    await rm(wt, { recursive: true, force: true });
    const listing = await resolver.worktrees(wt);
    expect(listing.worktrees.map((tree) => tree.branch)).toEqual(["main"]);
  });
});
