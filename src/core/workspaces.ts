import { pathKey, samePath } from "./path-access.ts";

// Which repository a working folder belongs to, and which sibling worktrees
// it has. Git forgets a worktree the moment it is deleted, so the folders it
// reports are also remembered in a map the adapter persists: without it a
// session whose worktree is gone would fall out of its project.

/** `/home/me/x` reads shorter as `~/x`, and the reader knows their own home. */
export function shortPath(path: string, home?: string): string {
  if (home === undefined || home === "" || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === "" ? "~" : rest.startsWith("/") ? `~${rest}` : path;
}

export type ProjectInfo = {
  /** The folder sessions of this checkout group under. */
  root: string;
  /** Canonical repository root, including when cwd is a checkout subdirectory. */
  repositoryRoot?: string;
  branch: string | null;
  isWorktree: boolean;
  isTopLevel: boolean;
};

export type WorktreeInfo = { path: string; branch: string | null };

/** One record of `git worktree list --porcelain`, flags included. */
export type WorktreeRecord = WorktreeInfo & {
  bare: boolean;
  prunable: boolean;
};

/**
 * `git worktree list --porcelain -z`: NUL-separated `key value` fields, a
 * `worktree <path>` line starting each record. Paths are used as git prints
 * them; web-pi runs on POSIX hosts, where that is already the native
 * spelling.
 */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const field of stdout.split("\0")) {
    const text = field.trim();
    if (text === "") continue;
    const space = text.indexOf(" ");
    const key = space === -1 ? text : text.slice(0, space);
    const value = space === -1 ? "" : text.slice(space + 1);
    const current = records.at(-1);
    if (key === "worktree") {
      records.push({ path: value, branch: null, bare: false, prunable: false });
      continue;
    }
    if (!current) continue;
    if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "prunable") current.prunable = true;
  }
  return records;
}

/**
 * Identity of a folder from what `git rev-parse` reported. A subdirectory of
 * a checkout keeps its own identity: sessions started there are not the
 * repository's, because the agent only ever sees that subtree.
 */
export function projectIdentity(git: {
  /** The folder itself, symlinks resolved. */
  cwd: string;
  /** realpath of the bare common dir, or of its parent. */
  root: string;
  toplevel: string;
  gitDir: string;
  commonDir: string;
  bare: boolean;
  branch: string | null;
}): ProjectInfo {
  const bareDirectory = git.bare && samePath(git.cwd, git.root);
  const toplevel = bareDirectory ? git.root : git.toplevel;
  const isTopLevel = samePath(toplevel, git.cwd);
  return {
    root: isTopLevel ? git.root : git.cwd,
    repositoryRoot: git.root,
    branch: bareDirectory ? null : git.branch,
    // A linked worktree has a gitdir of its own; the main checkout shares it.
    isWorktree: isTopLevel && !samePath(git.gitDir, git.commonDir),
    isTopLevel,
  };
}

/** A folder that is no longer on disk, placed by what was remembered of it. */
export function removedProject(
  cwd: string,
  known: Readonly<Record<string, string>>,
): ProjectInfo {
  const root = known[pathKey(cwd)];
  return {
    root: root ?? cwd,
    branch: null,
    // An unknown folder stays standalone: a repository is never guessed from
    // a folder name.
    isWorktree: root !== undefined && !samePath(root, cwd),
    isTopLevel: root !== undefined,
  };
}

/** A folder that never was a git checkout. */
export function plainProject(cwd: string): ProjectInfo {
  return { root: cwd, branch: null, isWorktree: false, isTopLevel: false };
}

/**
 * The folder-to-repository map, with the entries this discovery adds. The
 * file is only rewritten when something actually changed, so a picker that
 * lists the same worktrees twice writes nothing.
 */
export function rememberProjects(
  known: Readonly<Record<string, string>>,
  folders: readonly string[],
  root: string,
): { next: Record<string, string>; changed: boolean } {
  const next = { ...known };
  let changed = false;
  for (const folder of folders) {
    const key = pathKey(folder);
    if (key === "" || next[key] === root) continue;
    next[key] = root;
    changed = true;
  }
  return { next, changed };
}

/** The message every read-only route and the page itself answer with. */
export function unavailableFolderMessage(cwd: string): string {
  return `Working folder is unavailable. This session is read-only: ${cwd}`;
}

/** Worktrees a picker may offer: neither bare, prunable, nor gone. */
export function selectableWorktrees(
  records: readonly WorktreeRecord[],
  available: (path: string) => boolean,
): WorktreeInfo[] {
  return records
    .filter(
      (record) => !record.bare && !record.prunable && available(record.path),
    )
    .map((record) => ({ path: record.path, branch: record.branch }));
}

/** Which listed worktree the folder on screen is, if any. */
export function currentWorktree(
  worktrees: readonly WorktreeInfo[],
  cwd: string,
): string | null {
  return worktrees.find((tree) => samePath(tree.path, cwd))?.path ?? null;
}
