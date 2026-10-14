import { pathKey } from "@core/path-access";
import type { ProjectResolver } from "@core/ports";
import {
  plainProject,
  type ProjectInfo,
  projectIdentity,
  rememberProjects,
  removedProject,
} from "@core/workspaces";
import {
  migrateWebState,
  readWebState,
  webStatePath,
  writeWebState,
} from "@adapters/fs/web-state";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

// Which repository a session's working folder belongs to. Sessions of the
// worktrees of one checkout group together under the repository, and sessions
// whose folder is gone stay grouped through the map pi-web leaves behind.

const run = promisify(execFile);
const CACHE_MS = 60_000;
const PROJECTS_FILE = "worktree-projects.json";

/** Never a shell, always the C locale: git output is parsed, not read. */
function git(cwd: string, args: string[]): Promise<string> {
  return run("git", ["-C", cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  }).then((result) => result.stdout.trim());
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseProjects(value: unknown): Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((root) => typeof root === "string")
  ) {
    throw new Error("Invalid project map");
  }
  return value as Record<string, string>;
}

/**
 * The map is consulted once per folder of every sidebar render, and most of
 * a real store's folders are gone, so it is parsed once per file version
 * rather than a few hundred times per render.
 */
const knownByPath = new Map<
  string,
  { stamp: string; projects: Record<string, string> }
>();

function knownProjects(agentDir: string): Record<string, string> {
  const path = webStatePath(agentDir, PROJECTS_FILE);
  let stamp = "-";
  try {
    const info = statSync(path);
    stamp = `${String(info.mtimeMs)}:${String(info.size)}`;
  } catch {
    // Missing: the empty map, until a write gives it a stamp.
  }
  const hit = knownByPath.get(path);
  if (hit?.stamp === stamp) return hit.projects;
  const projects = readWebState(path, parseProjects) ?? {};
  knownByPath.set(path, { stamp, projects });
  return projects;
}

/**
 * Git forgets a worktree the moment it is removed, so the folders it reports
 * are written down. Private and atomic: the reader also edits this directory
 * by hand, and a half-written map would silently ungroup every session.
 */
function remember(agentDir: string, folders: string[], root: string): void {
  const { next, changed } = rememberProjects(
    knownProjects(agentDir),
    folders,
    root,
  );
  if (!changed) return;
  try {
    writeWebState(webStatePath(agentDir, PROJECTS_FILE), next);
  } catch {
    // Grouping is a convenience; a read-only agent directory must not break
    // resolving a folder.
  }
}

function resolveReal(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

export function createPiProjectResolver(options: {
  agentDir: string;
}): ProjectResolver {
  migrateWebState(
    options.agentDir,
    "web-worktree-projects.json",
    PROJECTS_FILE,
    parseProjects,
  );
  const cache = new Map<string, { at: number; project: ProjectInfo }>();

  async function lookAndCache(cwd: string): Promise<ProjectInfo> {
    const project = await look(cwd);
    cache.set(cwd, { at: Date.now(), project });
    return project;
  }

  async function look(cwd: string): Promise<ProjectInfo> {
    try {
      const [paths, bare] = await Promise.all([
        git(cwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
          "--git-dir",
        ]),
        git(cwd, ["rev-parse", "--is-bare-repository"]).catch(() => "false"),
      ]);
      const [commonDir, gitDir] = paths.split("\n");
      if (!commonDir || !gitDir) throw new Error("not a git folder");
      const isBare = bare === "true";
      const root = await resolveReal(isBare ? commonDir : dirname(commonDir));
      const real = await resolveReal(cwd);
      const toplevel =
        isBare && pathKey(real) === pathKey(root)
          ? root
          : await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd);
      const branch = await git(cwd, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]).catch(() => "");
      const project = projectIdentity({
        cwd: real,
        root,
        toplevel,
        gitDir,
        commonDir,
        bare: isBare,
        branch: branch === "" ? null : branch,
      });
      if (project.isTopLevel) {
        remember(options.agentDir, [cwd, real], project.root);
      }
      return project;
    } catch {
      return plainProject(cwd);
    }
  }

  /**
   * Availability is checked before the cache, so it can never be masked. An
   * expired entry is answered as it stands and refreshed behind the reply:
   * a sidebar render resolves every folder at once, and waiting on four git
   * subprocesses per folder every time the minute is up stalls it by a
   * second. A branch switch shows up one render late.
   */
  async function resolve(cwd: string): Promise<ProjectInfo> {
    if (!isDirectory(cwd)) {
      cache.delete(cwd);
      return removedProject(cwd, knownProjects(options.agentDir));
    }
    const hit = cache.get(cwd);
    if (!hit) return lookAndCache(cwd);
    if (Date.now() - hit.at >= CACHE_MS) {
      // Stamped now so concurrent callers share one refresh.
      hit.at = Date.now();
      void lookAndCache(cwd);
    }
    return hit.project;
  }

  return {
    resolve,
    available: (cwd) => Promise.resolve(isDirectory(cwd)),
  };
}
