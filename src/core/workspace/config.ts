import {
  BUILTIN_COMMANDS,
  rankCommands,
  type SlashCommand,
} from "@core/composer";
import { initialModel, type StartupChoice } from "@core/models";
import { modelSettingsEdit } from "@core/model-settings";
import type { PackagesView, PackageScope } from "@core/packages";
import { FileAccessError, isAbsolutePath, samePath } from "@core/path-access";
import type {
  SkillInfo,
  SkillScope,
  SkillSearchHit,
  SkillUpdate,
} from "@core/skills";
import type { Shared } from "./deps.ts";
import type { FolderChoice, NewSessionView } from "./views.ts";

// Everything before and around a session: choosing a folder, what `/new`
// offers there, project trust, skills and extension packages.

export function configUseCases({
  deps,
  authorize,
  folderAvailable,
  inspectionOnly,
  modelsFor,
  projectRootOf,
  validatedRoots,
}: Shared) {
  /**
   * Installing into a project writes into a repository whose own code the
   * agent will load. An untrusted one is refused, not silently redirected to
   * the global scope.
   */
  async function requireTrustedProject(
    cwd: string,
    project: boolean,
  ): Promise<void> {
    if (!project) return;
    const status = await deps.trust.status(cwd);
    if (!status.trusted) {
      throw new FileAccessError(
        "Project resources must be trusted before installing into this project",
        403,
      );
    }
  }

  /**
   * A folder the reader picked. Validating it is what makes it reachable;
   * the set is in memory, so a restart forgets it, as pi-web does.
   */
  async function validateFolder(
    path: string,
  ): Promise<{ cwd: string; projectRoot: string }> {
    if (!isAbsolutePath(path)) {
      throw new FileAccessError(`Not an absolute path: ${path}`, 400);
    }
    const info = await deps.files.stat(path);
    if (info === undefined) {
      throw new FileAccessError(`Folder not found: ${path}`, 404);
    }
    if (!info.isDirectory) {
      throw new FileAccessError(`Not a folder: ${path}`, 400);
    }
    const cwd = (await deps.files.realpath(path)) ?? path;
    validatedRoots.add(cwd);
    const projectRoot = (await projectRootOf(cwd)) ?? cwd;
    validatedRoots.add(projectRoot);
    return { cwd, projectRoot };
  }

  async function writableRuntimes(cwd: string) {
    const sessions = deps.runtime
      .live()
      .filter((session) => samePath(session.snapshot().summary.cwd, cwd));
    const writable = await Promise.all(
      sessions.map(async (session) => !(await inspectionOnly(session.id))),
    );
    return sessions.filter((_session, index) => writable[index]);
  }

  return {
    validateFolder,
    modelSettings: (cwd: string) => deps.models.settings(cwd),
    saveModelSettings: (cwd: string, selected: unknown, patterns: unknown) =>
      deps.models.saveSettings(cwd, modelSettingsEdit(selected, patterns)),
    webSettings: () => deps.webSettings.get(),
    updateWebSettings: (
      patch: Partial<import("@core/web-settings").WebSettings>,
    ) => deps.webSettings.update(patch),

    // --- Workspace selection ---------------------------------------------

    /** Directory names only, for the picker's browse pane. */
    browse(path?: string) {
      return deps.browser.browse(path);
    },

    /**
     * One project row of the picker: its worktrees, freshly probed. Probing
     * runs git in the folder, so the folder has to be one this reader may
     * already reach; the worktrees it reports join the allowed roots, which is
     * how a session in a sibling worktree stays readable after a restart.
     */
    async folders(cwd: string): Promise<FolderChoice> {
      const available = await folderAvailable(cwd);
      // A folder that is gone is never probed, so there is nothing to gate;
      // one that is there has git run in it, and that needs a folder this
      // reader may already reach.
      if (available) await authorize(cwd, { listing: true });
      const listing = await deps.projects.worktrees(cwd);
      const worktrees =
        listing.worktrees.length > 0
          ? listing.worktrees
          : available
            ? [{ path: cwd, branch: listing.project.branch }]
            : [];
      for (const tree of worktrees) validatedRoots.add(tree.path);
      return {
        cwd,
        available,
        project: listing.project,
        isGit: listing.isGit,
        worktrees,
        current:
          worktrees.find((tree) => samePath(tree.path, cwd))?.path ?? null,
      };
    },

    /** What `/new` renders: models and trust for the chosen folder. */
    async newSession(
      cwd: string,
      choice: StartupChoice = {},
    ): Promise<NewSessionView> {
      const [available, trust] = await Promise.all([
        folderAvailable(cwd),
        deps.trust.status(cwd).catch(() => ({
          requiresTrust: false,
          trusted: true,
        })),
      ]);
      // Validation is what makes a folder reachable, so it is also what
      // decides whether the composer may complete paths in it.
      let usable = false;
      if (available) {
        try {
          await validateFolder(cwd);
          usable = true;
        } catch {
          usable = false;
        }
      }
      const listing = usable
        ? await modelsFor(cwd)
        : { models: [], warnings: [] };
      const candidates =
        usable && choice.model
          ? await deps.models.listAvailable(cwd).catch(() => listing.models)
          : listing.models;
      const model =
        candidates.find(
          (option) =>
            option.provider === choice.model?.provider &&
            option.id === choice.model?.modelId,
        ) ?? initialModel(listing.models, listing.preferred);
      return {
        cwd,
        available,
        usable,
        models: listing.models,
        modelWarnings: listing.warnings,
        model,
        ...(model
          ? {
              thinkingLevel: await deps.models.resolveThinking(
                cwd,
                model,
                choice.thinkingLevel,
              ),
            }
          : {}),
        trust,
      };
    },

    /** The slash menu before a session exists: prompts and skills of a folder. */
    async folderCommands(cwd: string, query: string): Promise<SlashCommand[]> {
      await authorize(cwd, { listing: true });
      const listed = await deps.resources
        .commands(cwd)
        .catch(() => [] as SlashCommand[]);
      return rankCommands([...BUILTIN_COMMANDS, ...listed], query, {
        running: false,
      });
    },

    // --- Project trust ----------------------------------------------------

    trustStatus(cwd: string) {
      return deps.trust.status(cwd);
    },

    /**
     * Granting trust rebuilds the folder's sessions: a session started while
     * the project was untrusted is running without its extensions, and only a
     * restart can load them. A session mid-turn blocks the change.
     */
    async trustProject(cwd: string): Promise<void> {
      const status = await deps.trust.status(cwd);
      if (!status.requiresTrust) {
        throw new Error("This project has no resources that require trust");
      }
      const running = await writableRuntimes(cwd);
      if (running.some((live) => live.snapshot().status.running)) {
        throw new Error(
          "Wait for the active session to finish before trusting this project",
        );
      }
      await deps.trust.trust(cwd);
      deps.models.invalidate(cwd);
      // Stopped here, reopened on the next use, with project resources loaded.
      for (const live of running) await live.stop();
    },

    // --- Skills -----------------------------------------------------------

    skills(cwd: string): Promise<{
      skills: SkillInfo[];
      diagnostics: string[];
      projectResourcesLoaded: boolean;
    }> {
      return deps.skills.list(cwd);
    },

    /**
     * The skill file is the reader's own Markdown; only the one frontmatter
     * line changes. It may sit outside every allowed root, because global
     * skills live in Pi's agent directory.
     */
    async toggleSkill(
      cwd: string,
      filePath: string,
      disable: boolean,
    ): Promise<SkillInfo | undefined> {
      const { skills } = await deps.skills.list(cwd);
      const known = skills.some((skill) => skill.filePath === filePath);
      if (!known) throw new FileAccessError("Unknown skill", 404);
      await deps.skills.setDisabled(filePath, disable);
      const refreshed = await deps.skills.list(cwd);
      return refreshed.skills.find((skill) => skill.filePath === filePath);
    },

    searchSkills(query: string, limit: number): Promise<SkillSearchHit[]> {
      return deps.skills.search(query, limit);
    },

    async installSkill(
      cwd: string,
      pkg: string,
      scope: SkillScope,
    ): Promise<string> {
      await requireTrustedProject(cwd, scope === "project");
      return deps.skills.install(pkg, scope, cwd);
    },

    checkSkills(
      cwd: string,
      target?: { package: string; scope: SkillScope },
    ): Promise<SkillUpdate[]> {
      return deps.skills.check(cwd, target);
    },

    updateSkill(cwd: string, pkg: string, scope: SkillScope): Promise<string> {
      return deps.skills.update(cwd, pkg, scope);
    },

    // --- Extension packages ----------------------------------------------

    plugins(cwd: string): Promise<PackagesView> {
      return deps.packages.list(cwd);
    },

    /** Every action re-reads the list, so the page always shows Pi's truth. */
    async runPluginAction(
      action: "install" | "remove" | "update" | "enable" | "disable",
      request: { cwd: string; source?: string; scope: PackageScope },
    ): Promise<PackagesView> {
      await requireTrustedProject(request.cwd, request.scope === "project");
      await deps.packages.run(action, request);
      deps.models.invalidate(request.cwd);
      return deps.packages.list(request.cwd);
    },

    /**
     * Reload the resources of every live session in a folder. A plugin change
     * reaches a running session no other way: its extensions were built when
     * it started.
     */
    async reloadFolder(cwd: string): Promise<number> {
      const live = await writableRuntimes(cwd);
      for (const session of live) await session.reload();
      return live.length;
    },
  };
}
