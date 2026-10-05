import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The repository root in a checkout, the install root in a package. */
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const CODING_AGENT = "@earendil-works/pi-coding-agent";
const PI_PACKAGES = [
  CODING_AGENT,
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
];

type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};
function manifestAt(file: string): Manifest {
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}
function versionAt(file: string): string {
  const version = manifestAt(file).version;
  if (typeof version !== "string") throw new Error(`${file} has no version`);
  return version;
}

/** This package's own version, for the About line and `--version`. */
export function webPiVersion(): string {
  return versionAt(join(PACKAGE_ROOT, "package.json"));
}

/** Validate the exact dependency edges, not Node's permissive ancestor lookup. */
export function resolveBundledPi(root = PACKAGE_ROOT): {
  version: string;
  codingAgentManifest: string;
} {
  root = realpathSync(root);
  const ownManifest = join(root, "package.json");
  const declared = manifestAt(ownManifest).dependencies;
  const moduleRoots = [join(root, "node_modules")];
  const physicalRoots = [...moduleRoots];
  const parent = dirname(root);
  const store = dirname(dirname(parent));
  // Isolated pnpm installs put declared dependency links beside the package,
  // not inside it. Ordinary ancestor/hidden-hoist directories are not owners.
  if (
    basename(parent) === "node_modules" &&
    basename(store) === ".pnpm" &&
    basename(dirname(store)) === "node_modules"
  ) {
    moduleRoots.push(parent);
    physicalRoots.push(store);
  }
  let version = "";
  let codingAgentManifest = "";
  for (const name of PI_PACKAGES) {
    let file: string | undefined;
    try {
      file = findPackageJSON(name, pathToFileURL(ownManifest));
    } catch {
      // Missing dependencies and a resolvable ancestor must both fail closed.
    }
    const owned =
      file !== undefined &&
      moduleRoots.some(
        (modules) => file === join(modules, name, "package.json"),
      );
    const physical = owned && file !== undefined ? realpathSync(file) : "";
    if (
      !owned ||
      !physicalRoots.some((modules) => physical.startsWith(`${modules}${sep}`))
    ) {
      throw new Error(
        `${name} is missing or not owned by web-pi; reinstall using the documented package layout`,
      );
    }
    const installed = manifestAt(physical);
    if (
      installed.name !== name ||
      typeof installed.version !== "string" ||
      installed.version !== declared?.[name] ||
      (version !== "" && installed.version !== version)
    ) {
      throw new Error(
        `${name} does not match web-pi's exact bundled Pi version; reinstall web-pi`,
      );
    }
    version = installed.version;
    if (name === CODING_AGENT) codingAgentManifest = physical;
  }
  return { version, codingAgentManifest };
}

/** The package-owned SDK, independent of any terminal Pi on PATH. */
export function bundledPiVersion(): string {
  return resolveBundledPi().version;
}
