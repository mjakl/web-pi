import { pathKey, samePath } from "./path-access.ts";

// Which repository a working folder belongs to. Git forgets a worktree the
// moment it is deleted, so each checkout the adapter resolves is also
// remembered in a map it persists: without it a session whose worktree is
// gone would fall out of its project.

/** `/home/me/x` reads shorter as `~/x`, and the reader knows their own home. */
export function shortPath(path: string, home?: string): string {
  if (home === undefined || home === "" || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  return rest === "" ? "~" : rest.startsWith("/") ? `~${rest}` : path;
}

export type ProjectInfo = {
  /** The folder sessions of this checkout group under. */
  root: string;
  branch: string | null;
  isWorktree: boolean;
  isTopLevel: boolean;
};

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
 * The folder-to-repository map, with the entries this resolution adds. The
 * file is only rewritten when something actually changed, so resolving the
 * same folder twice writes nothing.
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
