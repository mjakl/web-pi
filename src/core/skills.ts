import { stripAnsi } from "./ansi.ts";
import { preview } from "./transcript.ts";

// What a skill is, and everything `npx skills` and skills.sh need spelled
// out. Only rules here: reading lock files, running npx and talking to
// skills.sh belong to the adapter.

export type SkillScope = "global" | "project";

/** Where a skill came from, as its lock file recorded the install. */
export type SkillInstall = {
  /** `<source>@<skill name>`: what an install or update is asked for. */
  package: string;
  scope: SkillScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  /** An automatic update check is possible for this entry. */
  canCheckForUpdates: boolean;
};

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  /** `user`, `project`, or a bare path Pi was pointed at. */
  scope: "global" | "project" | "path";
  install?: SkillInstall;
};

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export type SkillUpdate = {
  package: string;
  scope: SkillScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
};

export const SKILLS_HOME = "https://skills.sh";

export const UNSUPPORTED_CHECK_MESSAGE =
  "This lock entry cannot be checked automatically.";

/** A GitHub source is `owner/repo` and nothing else. */
function isGitHubSource(source: string, sourceType?: string): boolean {
  return sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(source);
}

/** The spelling skills.sh and `npx skills` both accept. */
export function normalizeSource(source: string, sourceType?: string): string {
  let value = source.trim().replace(/\/+$/, "");
  if (sourceType === "github") {
    value = value
      .replace(/^git\+/, "")
      .replace(/^https?:\/\/github\.com\//, "")
      .replace(/^git@github\.com:/, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  }
  return value;
}

/** The registry page for a skill, when it has one. */
export function skillsShUrl(source: string, name: string): string | undefined {
  if (source === "" || source.includes("://") || source.includes("git@")) {
    return undefined;
  }
  const path = source
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${SKILLS_HOME}/${path}/${encodeURIComponent(name)}`;
}

/** The folder inside the repository a skill lives in. */
export function skillFolder(skillPath: string): string {
  return skillPath
    .replaceAll("\\", "/")
    .replace(/\/?(SKILL|skill)\.md$/, "")
    .replace(/\/+$/, "");
}

/** skills.sh addresses a skill by a slug, not by its display name. */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** One `{ skills: { name: entry } }` lock entry, as install metadata. */
export function installFromLock(
  name: string,
  entry: Readonly<Record<string, unknown>>,
  scope: SkillScope,
): SkillInstall | undefined {
  const rawSource = entry["source"];
  if (typeof rawSource !== "string" || rawSource.trim() === "")
    return undefined;
  const sourceType =
    typeof entry["sourceType"] === "string" ? entry["sourceType"] : undefined;
  const source = normalizeSource(rawSource, sourceType);
  const skillPath =
    typeof entry["skillPath"] === "string" ? entry["skillPath"] : undefined;
  const ref = typeof entry["ref"] === "string" ? entry["ref"] : undefined;
  const hashKey = scope === "global" ? "skillFolderHash" : "computedHash";
  const versionHash =
    typeof entry[hashKey] === "string" ? entry[hashKey] : undefined;
  const url = sourceType === "local" ? undefined : skillsShUrl(source, name);
  return {
    package: `${source}@${name}`,
    scope,
    source,
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(url === undefined ? {} : { skillsShUrl: url }),
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(ref === undefined ? {} : { ref }),
    ...(versionHash === undefined ? {} : { versionHash }),
    canCheckForUpdates:
      isGitHubSource(source, sourceType) &&
      skillPath !== undefined &&
      versionHash !== undefined &&
      (scope === "global" || ref === undefined),
  };
}

/** Lock files key entries by name; a differently cased key still matches. */
export function lookupLockEntry(
  skills: Readonly<Record<string, unknown>>,
  name: string,
): Record<string, unknown> | undefined {
  const exact = skills[name];
  if (typeof exact === "object" && exact !== null) {
    return exact as Record<string, unknown>;
  }
  const folded = name.toLowerCase();
  for (const [key, value] of Object.entries(skills)) {
    if (key.toLowerCase() !== folded) continue;
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

export function searchUrl(base: string, query: string, limit: number): string {
  return `${base}/api/search?q=${encodeURIComponent(query)}&limit=${String(limit)}`;
}

/** 1..50, defaulting to 50: the registry is not a paging API. */
export function clampSearchLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(50, Math.max(1, parsed));
}

export type SkillSearchHit = {
  package: string;
  installs: string;
  url: string;
};

function installCount(value: unknown): string {
  const count = typeof value === "number" && Number.isFinite(value) ? value : 0;
  if (count <= 0) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M installs`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K installs`;
  return `${String(count)} install${count === 1 ? "" : "s"}`;
}

/** skills.sh search results, most installed first. */
export function mapSearchResults(
  payload: unknown,
  base: string,
): SkillSearchHit[] {
  // The registry answers `{ skills: [...] }`; a bare array and `results`
  // are accepted too, because neither costs anything to allow.
  const body = typeof payload === "object" && payload !== null ? payload : {};
  const rows = Array.isArray(payload)
    ? payload
    : ((body as { skills?: unknown; results?: unknown }).skills ??
      (body as { results?: unknown }).results ??
      []);
  if (!Array.isArray(rows)) return [];
  const hits: { hit: SkillSearchHit; installs: number }[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"] : "";
    const source =
      typeof record["source"] === "string" ? record["source"] : undefined;
    const id = typeof record["id"] === "string" ? record["id"] : undefined;
    const owner = source ?? id;
    if (name === "" || owner === undefined || owner === "") continue;
    const installs =
      typeof record["installs"] === "number" ? record["installs"] : 0;
    hits.push({
      installs,
      hit: {
        package: `${owner}@${name}`,
        installs: installCount(installs),
        url: id === undefined ? "" : `${base}/${id}`,
      },
    });
  }
  return hits.sort((a, b) => b.installs - a.installs).map((entry) => entry.hit);
}

/** `npx skills add <package> -y --agent pi [-g]`. */
export function installArgs(pkg: string, scope: SkillScope): string[] {
  const args = ["skills", "add", pkg, "-y", "--agent", "pi"];
  if (scope === "global") args.push("-g");
  return args;
}

/**
 * An update re-adds the exact folder and ref the lock recorded, naming the
 * skill so a repository holding several is not reinstalled wholesale.
 */
export function updateArgs(install: SkillInstall): string[] {
  const folder = install.skillPath ? skillFolder(install.skillPath) : "";
  const ref = install.ref ? `#${encodeURIComponent(install.ref)}` : "";
  const target = `${install.source}${folder === "" ? "" : `/${folder}`}${ref}`;
  const name = install.package.slice(install.package.lastIndexOf("@") + 1);
  const args = [
    "skills",
    "add",
    target,
    "--skill",
    name,
    "-y",
    "--agent",
    "pi",
  ];
  if (install.scope === "global") args.push("-g");
  return args;
}

const INSTALLED = /Installation complete|Installed \d+ skill/;

/** `npx skills` reports success in prose; the exit code alone is not enough. */
export function installSucceeded(output: string): boolean {
  return INSTALLED.test(stripAnsi(output));
}

/** What the panel shows of a long install log: its end, where the outcome is. */
export function installMessage(output: string, limit = 300): string {
  return preview(stripAnsi(output), -limit);
}

/** Grouped exactly as pi-web's skill sidebar groups them. */
export const SKILL_GROUPS = [
  { key: "project-registry", label: "project / skills.sh" },
  { key: "project", label: "project" },
  { key: "global-registry", label: "global / skills.sh" },
  { key: "global", label: "global" },
  { key: "path", label: "path" },
] as const;

export type SkillGroupKey = (typeof SKILL_GROUPS)[number]["key"];

export function skillGroup(skill: SkillInfo): SkillGroupKey {
  if (skill.scope === "path") return "path";
  const registry = skill.install?.skillsShUrl !== undefined;
  if (skill.scope === "project") {
    return registry ? "project-registry" : "project";
  }
  return registry ? "global-registry" : "global";
}
