// Pages, the top-bar panels, settings, extension dialogs, trust, push,
// and the installable-app files. The shell area owns this module.

import { isPushPresence, isPushSubscription } from "@core/push";
import { webSettingsPatch } from "@core/web-settings";
import {
  CWD_COOKIE,
  SESSION_COOKIE,
  SETTINGS_COOKIE,
  SKILL_COOKIE,
} from "@core/cookies";
import { type DialogAnswer } from "@core/extension-ui";
import { type PackageScope, isPackageAction } from "@core/packages";
import { InspectionOnlySession } from "@core/workspace";
import { Partial } from "@web/views/Partial";
import { ExplorerSection } from "@web/views/Files";
import {
  type SkillScope,
  type SkillUpdate,
  clampSearchLimit,
} from "@core/skills";
import { OFFLINE_URL, manifest, offlinePage, serviceWorker } from "@web/pwa";
import { SystemPromptPanel, ToolsPanel } from "@web/views/Panels";
import { NewSessionPage } from "@web/views/SessionPage";
import {
  GeneralSettings,
  SettingsDialog,
  type SettingsSection,
  resolveSection,
} from "@web/views/Settings";
import { ModelSettings } from "@web/views/ModelSettings";
import { PluginsSection } from "@web/views/PluginSettings";
import { SkillSearchResults, SkillsSection } from "@web/views/SkillSettings";
import { StatsPanel } from "@web/views/Stats";
import { TrustDialog } from "@web/views/Dialogs";
import { type Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import {
  type RouteContext,
  type WebApp,
  currentSessionId,
  displayedCwd,
  errorText,
  field,
  hxTrigger,
  rawField,
  requireWritable,
  toastHeader,
} from "./shared.ts";

export function shellRoutes(app: WebApp, ctx: RouteContext): void {
  const {
    deps,
    assets,
    sidebarOf,
    remember,
    newCwd,
    currentCwd,
    sessionPage,
    guard,
  } = ctx;

  // The tools and system-prompt panels refuse an inspection-only session in
  // their own guard; the dialog answers have none, so they need this one.
  requireWritable(app, ctx, ["ui/:requestId", "ui/:requestId/input"]);

  // Same-folder navigation retains the expanded tree. File requests use the
  // displayed session header, so its authorization context still changes.
  function navigationContext(c: Context, cwd: string, activeId?: string) {
    if (displayedCwd(c) === cwd) return null;
    return (
      <Partial target="#explorer-section" swap="outerHTML">
        <ExplorerSection cwd={cwd} sessionId={activeId} />
      </Partial>
    );
  }

  /** The landing page always offers a new session, including folder recovery. */
  app.get("/", async (c) => {
    const sidebar = await sidebarOf();
    const cwd = newCwd(c);
    const view = await deps.workspace.newSession(cwd);
    // The index is no session, so the panels and settings opened from here
    // are no session either.
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.render(
      <NewSessionPage sidebar={sidebar} view={view} home={deps.home} />,
    );
  });

  app.get("/new", async (c) => {
    const fragment = c.req.header("HX-Target") === "div#session-region";
    const sidebar = fragment ? undefined : await sidebarOf();
    const cwd = newCwd(c);
    const view = await deps.workspace.newSession(cwd);
    if (!fragment) {
      if (view.available) remember(c, CWD_COOKIE, cwd);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
    }
    if (fragment && c.req.header("HX-History-Restore-Request") !== "true")
      c.header("HX-Push-Url", `/new?cwd=${encodeURIComponent(cwd)}`);
    const page = (
      <NewSessionPage
        sidebar={sidebar}
        fragment={fragment}
        view={view}
        draft={c.req.query("text")}
        home={deps.home}
      />
    );
    return fragment
      ? c.html(
          <>
            {page}
            {navigationContext(c, view.cwd)}
          </>,
        )
      : c.render(page);
  });

  // The two panels the top bar opens before there is a session to ask: the
  // same empty states a stopped session shows.
  app.get("/panels/system", (c) => c.html(<SystemPromptPanel />));
  app.get("/panels/tools", (c) => c.html(<ToolsPanel />));

  app.get("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const through = c.req.query("through");
    const options = {
      ...(c.req.query("leaf") === undefined
        ? {}
        : { leaf: c.req.query("leaf") }),
      ...(through === undefined ? {} : { through }),
    };
    const fragment = c.req.header("HX-Target") === "div#session-region";
    const [sidebar, view] = await Promise.all([
      fragment ? undefined : sidebarOf(id),
      deps.workspace.viewSession(id, options).catch(() => undefined),
    ]);
    if (!view) return c.notFound();
    if (!fragment) remember(c, SESSION_COOKIE, id);
    const page = await sessionPage(view, { sidebar, fragment });
    return fragment
      ? c.html(
          <>
            {page}
            {navigationContext(c, view.summary.cwd, id)}
          </>,
        )
      : c.render(page);
  });

  app.get("/sessions/:id/stats", async (c) => {
    const id = c.req.param("id");
    const found = await deps.workspace.sessionStats(id);
    if (!found) return c.notFound();
    return c.html(<StatsPanel {...found} />);
  });

  // --- Project trust --------------------------------------------------------

  app.get("/workspaces/trust", (c) => {
    const cwd = c.req.query("cwd") ?? "";
    if (cwd === "") return c.text("cwd is required", 400);
    return c.html(<TrustDialog cwd={cwd} />);
  });

  app.post("/workspaces/trust", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    return guard(c, async () => {
      await deps.workspace.trustProject(cwd);
      toastHeader(
        c,
        "Project trusted. Its sessions restart on next use.",
        "info",
      );
      c.header("HX-Refresh", "true");
      return c.body(null, 200);
    });
  });

  // --- Settings ------------------------------------------------------------

  /**
   * One section of the settings page. Skills and plugins need a folder;
   * general does not. A section that cannot load says so: falling back to
   * general would quietly show the wrong page under the right tab.
   */
  async function settingsBody(
    section: SettingsSection,
    cwd: string,
    options: { selected?: string; sessionId?: string },
  ) {
    const failed = (error: unknown) => (
      <div role="alert" class="config-empty-state">
        {errorText(error)}
      </div>
    );
    if (section === "general")
      return <GeneralSettings settings={deps.workspace.webSettings()} />;
    if (section === "skills")
      return skillsSection(
        cwd,
        options.selected === undefined ? {} : { selected: options.selected },
      ).catch(failed);
    if (section === "models")
      return deps.workspace
        .modelSettings(cwd, options.sessionId)
        .then(
          (view) => (
            <ModelSettings
              cwd={cwd}
              view={view}
              sessionId={options.sessionId}
            />
          ),
          failed,
        );
    return deps.workspace
      .plugins(cwd)
      .then(
        (view) => <PluginsSection cwd={cwd} view={view} home={deps.home} />,
        failed,
      );
  }

  app.get("/settings/web", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(deps.workspace.webSettings());
  });
  app.post("/settings/web", async (c) => {
    let patch;
    try {
      patch = webSettingsPatch(await c.req.json());
    } catch {
      return c.json(
        {
          error:
            "Use a positive safe integer threshold, light/dark/auto theme, and boolean sound.",
        },
        400,
      );
    }
    return c.json(deps.workspace.updateWebSettings(patch));
  });

  app.post("/settings/models", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const sessionId = field(form, "sessionId") || undefined;
    let message = "Selection saved.";
    let failed = false;
    try {
      const selection: unknown =
        form.get("defaults") === "1"
          ? null
          : form.getAll("model").map((value) => {
              if (typeof value !== "string")
                throw new Error("Expected a model identity");
              return JSON.parse(value) as unknown;
            });
      await deps.workspace.saveModelSettings(
        cwd,
        selection,
        JSON.parse(field(form, "patterns")) as unknown,
        sessionId,
      );
      hxTrigger(c, { "models-changed": {} });
    } catch (error) {
      failed = true;
      message = `Could not save models: ${errorText(error)}`;
    }
    try {
      return await c.html(
        <ModelSettings
          cwd={cwd}
          view={await deps.workspace.modelSettings(cwd, sessionId)}
          sessionId={sessionId}
          message={message}
          failed={failed}
        />,
      );
    } catch (error) {
      return c.html(
        <div role="alert" class="config-empty-state">
          Could not load Models: {errorText(error)}. Repair Pi settings and
          reload.
        </div>,
      );
    }
  });

  /**
   * Settings opens over the workspace as the reader left it, the open session
   * or else the new-session view, because pi-web opens it over the live
   * workspace rather than on a page of its own (SettingsPanel.tsx).
   */
  app.get("/settings", async (c) => {
    const id = currentSessionId(c);
    const settingsDialog = async () => {
      const cwd = await currentCwd(c);
      const usable = (await deps.workspace.folderAvailable(cwd)) ? cwd : "";
      const section = resolveSection(
        c.req.query("section") ?? getCookie(c, SETTINGS_COOKIE),
        usable !== "",
      );
      remember(c, SETTINGS_COOKIE, section);
      const remembered = rememberedSkill(c, usable);
      const body = await settingsBody(section, usable, {
        ...(id ? { sessionId: id } : {}),
        ...(remembered === undefined ? {} : { selected: remembered }),
      });
      return {
        cwd,
        overlay: (
          <SettingsDialog
            section={section}
            cwd={usable}
            back={id === undefined ? "/" : `/sessions/${id}`}
          >
            {body}
          </SettingsDialog>
        ),
      };
    };
    const [sidebar, view, { cwd, overlay }] = await Promise.all([
      sidebarOf(id),
      id === undefined
        ? undefined
        : deps.workspace.viewSession(id).catch(() => undefined),
      settingsDialog(),
    ]);
    if (view) return c.render(await sessionPage(view, { sidebar, overlay }));
    return c.render(
      <NewSessionPage
        sidebar={sidebar}
        view={await deps.workspace.newSession(cwd)}
        home={deps.home}
        overlay={overlay}
      />,
    );
  });

  /** The skill this folder was last looking at, when it still belongs to it. */
  function rememberedSkill(c: Context, cwd: string): string | undefined {
    const [folder, path] = (getCookie(c, SKILL_COOKIE) ?? "").split("|");
    if (folder === undefined || path === undefined || path === "") {
      return undefined;
    }
    return decodeURIComponent(folder) === cwd
      ? decodeURIComponent(path)
      : undefined;
  }

  /**
   * The whole Skills section, for the page and for every swap inside it,
   * around the skill selected. pi-web paints the selected row and its badges
   * from the same state as the detail pane, so a swap has to carry both.
   */
  async function skillsSection(
    cwd: string,
    options: {
      selected?: string;
      add?: boolean;
      update?: SkillUpdate;
      updates?: SkillUpdate[];
      message?: string;
    } = {},
  ) {
    const listed = await deps.workspace.skills(cwd);
    return (
      <SkillsSection
        view={{
          cwd,
          ...listed,
          ...(options.updates === undefined
            ? {}
            : { updates: options.updates }),
        }}
        selected={options.selected}
        add={options.add}
        update={options.update}
        message={options.message}
        home={deps.home}
      />
    );
  }

  /** One skill's detail pane, and the toggle that rewrites its frontmatter. */
  app.get("/settings/skills/detail", async (c) => {
    const cwd = c.req.query("cwd") ?? "";
    const path = c.req.query("path") ?? "";
    const add = c.req.query("add") !== undefined;
    if (!add) {
      remember(
        c,
        SKILL_COOKIE,
        `${encodeURIComponent(cwd)}|${encodeURIComponent(path)}`,
      );
    }
    return guard(c, async () =>
      c.html(await skillsSection(cwd, { selected: path, add })),
    );
  });

  app.post("/settings/skills/toggle", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const path = field(form, "path");
    return guard(c, async () => {
      await deps.workspace.toggleSkill(
        cwd,
        path,
        field(form, "disable") !== "",
      );
      return c.html(await skillsSection(cwd, { selected: path }));
    });
  });

  app.post("/settings/skills/search", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const query = field(form, "query");
    if (query === "") {
      return c.html(
        <SkillSearchResults
          hits={[]}
          cwd={cwd}
          message="Type something to search skills.sh."
        />,
      );
    }
    try {
      const hits = await deps.workspace.searchSkills(
        query,
        clampSearchLimit(field(form, "limit")),
      );
      return await c.html(<SkillSearchResults hits={hits} cwd={cwd} />);
    } catch (error) {
      return c.html(
        <SkillSearchResults hits={[]} cwd={cwd} message={errorText(error)} />,
      );
    }
  });

  app.post("/settings/skills/install", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const scope: SkillScope =
      field(form, "scope") === "project" ? "project" : "global";
    let message: string;
    try {
      message = await deps.workspace.installSkill(
        cwd,
        field(form, "package"),
        scope,
      );
    } catch (error) {
      message = errorText(error);
    }
    return c.html(<SkillSearchResults hits={[]} cwd={cwd} message={message} />);
  });

  /**
   * With a package the check is one skill's detail pane; without one it is
   * the whole section, so the list can carry its update markers.
   */
  app.post("/settings/skills/check", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const pkg = field(form, "package");
    const scope: SkillScope =
      field(form, "scope") === "project" ? "project" : "global";
    return guard(c, async () => {
      const updates = await deps.workspace.checkSkills(
        cwd,
        pkg === "" ? undefined : { package: pkg, scope },
      );
      const path = field(form, "path");
      const update = updates[0];
      return c.html(
        await skillsSection(cwd, {
          updates,
          ...(pkg === "" ? {} : { selected: path }),
          ...(pkg === "" || update === undefined ? {} : { update }),
        }),
      );
    });
  });

  app.post("/settings/skills/update", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const path = field(form, "path");
    const scope: SkillScope =
      field(form, "scope") === "project" ? "project" : "global";
    return guard(c, async () => {
      let message: string;
      try {
        message = await deps.workspace.updateSkill(
          cwd,
          field(form, "package"),
          scope,
        );
      } catch (error) {
        message = errorText(error);
      }
      return c.html(await skillsSection(cwd, { selected: path, message }));
    });
  });

  /** Rebuilds the extensions of every live session in this folder. */
  app.post("/settings/plugins/reload", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    return guard(c, async () => {
      const reloaded = await deps.workspace.reloadFolder(cwd);
      const view = await deps.workspace.plugins(cwd);
      return c.html(
        <PluginsSection
          cwd={cwd}
          view={view}
          message={
            reloaded === 0
              ? "No session of this folder is running."
              : `Reloaded ${String(reloaded)} session${reloaded === 1 ? "" : "s"}.`
          }
          home={deps.home}
        />,
      );
    });
  });

  app.get("/settings/plugins", async (c) => {
    const cwd = c.req.query("cwd") ?? "";
    const selected = c.req.query("selected");
    const add = c.req.query("add") !== undefined;
    return guard(c, async () => {
      const view = await deps.workspace.plugins(cwd);
      return c.html(
        <PluginsSection
          cwd={cwd}
          view={view}
          selected={selected}
          add={add}
          home={deps.home}
        />,
      );
    });
  });

  /** Every action answers with the freshly re-read list: Pi is the truth. */
  app.post("/settings/plugins", async (c) => {
    const form = await c.req.formData();
    const cwd = field(form, "cwd");
    const action = field(form, "action");
    const selected = field(form, "selected");
    const source = field(form, "source");
    const scope: PackageScope =
      field(form, "scope") === "project" ? "project" : "user";
    if (!isPackageAction(action)) {
      toastHeader(c, `Unsupported action: ${action}`);
      c.header("HX-Reswap", "none");
      return c.body(null, 200);
    }
    let message: string | undefined;
    let view;
    try {
      view = await deps.workspace.runPluginAction(action, {
        cwd,
        scope,
        ...(source === "" ? {} : { source }),
      });
      message = `Package ${action}d.`;
    } catch (error) {
      // A toast, because the add panel that a first install leaves has no
      // room for the detail pane's message.
      toastHeader(c, errorText(error));
      view = await deps.workspace.plugins(cwd);
    }
    return c.html(
      <PluginsSection
        cwd={cwd}
        view={view}
        message={message}
        selected={selected || undefined}
        home={deps.home}
      />,
    );
  });

  // --- Session inspection ---------------------------------------------------

  app.get("/sessions/:id/tools", async (c) => {
    const id = c.req.param("id");
    return guard(c, async () => {
      const tool = c.req.query("tool");
      const tools = await deps.workspace
        .toolDefinitions(id)
        .catch((error: unknown) => {
          if (error instanceof InspectionOnlySession) throw error;
          return undefined;
        });
      return c.html(
        <ToolsPanel sessionId={id} tools={tools} selected={tool} />,
      );
    });
  });

  app.get("/sessions/:id/system-prompt", async (c) => {
    const id = c.req.param("id");
    return guard(c, async () => {
      const prompt = await deps.workspace
        .systemPrompt(id)
        .catch((error: unknown) => {
          if (error instanceof InspectionOnlySession) throw error;
          return undefined;
        });
      return c.html(<SystemPromptPanel prompt={prompt} />);
    });
  });

  /**
   * An answer to an extension dialog. The first tab to get here resolves the
   * extension's promise; a second one finds the request gone and says so,
   * rather than pretending it answered.
   */
  app.post("/sessions/:id/ui/:requestId", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    // The value is passed on verbatim: an editor's text keeps its leading
    // whitespace and its trailing newline, and a select option still matches
    // the string the extension offered.
    const answer: DialogAnswer =
      field(form, "cancelled") !== ""
        ? { cancelled: true }
        : form.has("confirmed")
          ? { confirmed: field(form, "confirmed") !== "" }
          : form.has("value")
            ? { value: rawField(form, "value") }
            : { cancelled: true };
    const answered = await deps.workspace.answerDialog(
      id,
      c.req.param("requestId"),
      answer,
    );
    if (!answered) toastHeader(c, "That dialog is already closed.", "info");
    c.header("HX-Reswap", "none");
    return c.body(null, 200);
  });

  /** One keystroke or paste for an extension's custom UI. */
  app.post("/sessions/:id/ui/:requestId/input", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    const data = form.get("data");
    if (typeof data !== "string" || data === "") return c.body(null, 204);
    await deps.workspace.customInput(id, c.req.param("requestId"), data);
    return c.body(null, 204);
  });

  // --- Installable app --------------------------------------------------

  app.get("/manifest.webmanifest", (c) => {
    c.header("Content-Type", "application/manifest+json");
    c.header("Cache-Control", "no-cache");
    return c.body(JSON.stringify(manifest()));
  });

  /**
   * Served from the root so its scope covers the whole app. Never cached by
   * the browser itself: the registration asks for it fresh every time, and a
   * stale worker would keep serving a stale build's assets.
   */
  app.get("/sw.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("Service-Worker-Allowed", "/");
    return c.body(serviceWorker(assets));
  });

  app.get(OFFLINE_URL, (c) => c.html(offlinePage(assets)));

  /** The key a browser needs before it can subscribe; the private one stays. */
  app.get("/push/config", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ publicKey: deps.workspace.pushKey() });
  });

  app.post("/push/:action", async (c) => {
    const action = c.req.param("action");
    if (action === "presence") {
      const presence: unknown = await c.req.json().catch(() => undefined);
      c.header("Cache-Control", "no-store");
      if (!isPushPresence(presence))
        return c.json({ error: "Invalid push presence" }, 400);
      deps.workspace.reportPushPresence(presence);
      return c.json({ ok: true });
    }
    if (!["subscribe", "unsubscribe", "status"].includes(action))
      return c.notFound();
    const body: unknown = await c.req.json().catch(() => undefined);
    const subscription =
      typeof body === "object" && body !== null && "subscription" in body
        ? (body as { subscription?: unknown }).subscription
        : undefined;
    if (!isPushSubscription(subscription)) {
      return c.json({ error: "Invalid push subscription" }, 400);
    }
    c.header("Cache-Control", "no-store");
    if (action === "status")
      return c.json({ subscribed: deps.workspace.hasPush(subscription) });
    if (action === "unsubscribe") deps.workspace.unsubscribePush(subscription);
    else {
      if (
        (body as { publicKey?: unknown }).publicKey !== deps.workspace.pushKey()
      )
        return c.json(
          {
            error:
              "Server identity changed. Reload settings before subscribing.",
          },
          409,
        );
      deps.workspace.subscribePush({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      });
    }
    return c.json({ ok: true });
  });
}
