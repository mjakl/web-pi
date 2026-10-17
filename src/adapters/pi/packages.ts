import {
  configuredVersion,
  isDisabledPackage,
  isFilteredPackage,
  type PackageDiagnostic,
  type PackageInfo,
  type PackageResource,
  packageSourceOf,
  packageStatus,
  type PackagesView,
  relativeResource,
  resourceLabel,
  resourceTotals,
  setPackageDisabled,
} from "@core/packages";
import type { Packages } from "@core/ports";
import {
  DefaultPackageManager,
  type PackageSource,
  type ResolvedResource,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPiProjectTrust } from "./project-trust.ts";
import { checkSettingsErrors } from "./settings-errors.ts";

// Extension packages. Pi's settings hold the list, the SDK's package manager
// owns the install roots, and the only rules here are which SDK call an
// action maps to.

const KINDS = ["extensions", "skills", "prompts", "themes"] as const;

/** The `name` and `version` of the package.json next to an install. */
function manifest(installedPath: string): {
  packageName?: string;
  version?: string;
} {
  for (const candidate of [
    join(installedPath, "package.json"),
    join(dirname(installedPath), "package.json"),
  ]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as { name?: unknown; version?: unknown };
      return {
        ...(typeof record.name === "string"
          ? { packageName: record.name }
          : {}),
        ...(typeof record.version === "string"
          ? { version: record.version }
          : {}),
      };
    } catch {
      // Not every package ships a manifest; the source string still names it.
    }
  }
  return {};
}

export function createPiPackages(options: { agentDir: string }): Packages {
  const trust = createPiProjectTrust({ agentDir: options.agentDir });

  async function managerFor(cwd: string): Promise<{
    manager: DefaultPackageManager;
    settings: SettingsManager;
    trusted: boolean;
  }> {
    const { trusted } = await trust.status(cwd);
    const settings = SettingsManager.create(cwd, options.agentDir, {
      projectTrusted: trusted,
    });
    return {
      settings,
      trusted,
      manager: new DefaultPackageManager({
        cwd,
        agentDir: options.agentDir,
        settingsManager: settings,
      }),
    };
  }

  function scopedPackages(
    settings: SettingsManager,
    scope: "user" | "project",
  ): PackageSource[] {
    const settingsOf =
      scope === "project"
        ? settings.getProjectSettings()
        : settings.getGlobalSettings();
    return settingsOf.packages ?? [];
  }

  return {
    async list(cwd) {
      const { manager, settings, trusted } = await managerFor(cwd);
      checkSettingsErrors(settings);
      const diagnostics: PackageDiagnostic[] = [];
      let resolved: Partial<
        Record<(typeof KINDS)[number], ResolvedResource[]>
      > = {};
      try {
        resolved = await manager.resolve((source) => {
          // Nothing is installed behind the reader's back: a configured but
          // missing package is reported and skipped.
          diagnostics.push({
            type: "warning",
            message: "Package is configured but not installed yet.",
            source,
          });
          return Promise.resolve("skip");
        });
      } catch (error) {
        diagnostics.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const byPackage = new Map<string, PackageResource[]>();
      for (const kind of KINDS) {
        for (const resource of resolved[kind] ?? []) {
          if (!resource.enabled || resource.metadata.origin !== "package") {
            continue;
          }
          const key = `${resource.metadata.scope} ${resource.metadata.source}`;
          const list = byPackage.get(key) ?? [];
          list.push({
            kind,
            name: resourceLabel(resource.path),
            relativePath: relativeResource(
              resource.path,
              resource.metadata.baseDir,
            ),
            path: resource.path,
          });
          byPackage.set(key, list);
        }
      }
      const entries = [
        ...scopedPackages(settings, "user").map((entry) => ({
          entry,
          scope: "user" as const,
        })),
        ...scopedPackages(settings, "project").map((entry) => ({
          entry,
          scope: "project" as const,
        })),
      ];
      const packages = entries.map(({ entry, scope }): PackageInfo => {
        const source = packageSourceOf(entry);
        const disabled = isDisabledPackage(entry);
        const installedPath = manager.getInstalledPath(source, scope);
        const resources = byPackage.get(`${scope} ${source}`) ?? [];
        if (installedPath === undefined) {
          diagnostics.push({
            type: "warning",
            message: "Configured package path was not found.",
            source,
          });
        }
        const version = configuredVersion(source);
        return {
          source,
          scope,
          disabled,
          filtered: isFilteredPackage(entry),
          status: packageStatus({
            disabled,
            resources: resources.length,
            ...(installedPath === undefined ? {} : { installedPath }),
          }),
          ...(installedPath === undefined
            ? {}
            : { installedPath, ...manifest(installedPath) }),
          ...(version === undefined ? {} : { configuredVersion: version }),
          resources,
        };
      });
      return {
        packages,
        totals: resourceTotals(packages),
        diagnostics,
        projectResourcesLoaded: trusted,
      } satisfies PackagesView;
    },

    async run(action, request) {
      const { manager, settings, trusted } = await managerFor(request.cwd);
      const local = request.scope === "project";
      if (local && !trusted) {
        throw new Error(
          "Project resources must be trusted before modifying project plugins",
        );
      }
      if (action === "update") {
        await manager.update(request.source);
        return;
      }
      const source = request.source;
      if (source === undefined || source === "") {
        throw new Error("A package source is required");
      }
      if (action === "install") {
        await manager.installAndPersist(source, { local });
      } else if (action === "remove") {
        if (!(await manager.removeAndPersist(source, { local })))
          throw new Error("No matching package");
      } else {
        const next = setPackageDisabled(
          scopedPackages(settings, request.scope),
          source,
          action === "disable",
        );
        // No entry matched: the list on screen is stale, and writing the
        // unchanged array back would only churn the file.
        if (next === null) return;
        if (local) settings.setProjectPackages(next);
        else settings.setPackages(next);
      }
      await settings.flush();
      checkSettingsErrors(settings, local ? "project" : "global");
    },
  };
}
