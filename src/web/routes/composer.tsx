// Everything the composer sends and everything it needs to offer: prompts,
// commands, the queue, the model, and the session's own event stream. The
// composer area owns this module.

import { bashCommand } from "@core/composer";
import { isThinkingLevel } from "@core/models";
import { FileAccessError } from "@core/path-access";
import { isSessionId } from "@core/sessions";
import { ForbiddenPath } from "@core/workspace";
import {
  CommandMenu,
  ComposerText,
  ModelSelector,
  modelPick,
  RecalledImages,
  Toasts,
} from "@web/views/Composer";
import {
  CustomFrameBody,
  CustomPanelBody,
  ExtensionDialogBody,
  customSignature,
  dialogSignature,
} from "@web/views/Extensions";
import { type ItemActions, Items, TurnFragment } from "@web/views/Items";
import { Partial } from "@web/views/Partial";
import { Rail } from "@web/views/Rail";
import { ShelfBody, changedWidgets, shelfSignature } from "@web/views/Shelf";
import { Status, turnBusy } from "@web/views/Status";
import { Transcript } from "@web/views/Transcript";
import { type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type RouteContext,
  type WebApp,
  disposition,
  errorText,
  field,
  html,
  readSubmission,
  sessionLocation,
  sleep,
  toastHeader,
} from "./shared.ts";

export function composerRoutes(app: WebApp, ctx: RouteContext): void {
  const { deps, renderIntervalMs, warnTokens, guard } = ctx;

  app.post("/sessions", (c) => submit(c));
  app.post("/sessions/:id/prompt", (c) => {
    const id = c.req.param("id");
    return isSessionId(id) ? submit(c, id) : c.notFound();
  });

  function reject(c: Context, message: string): Response {
    toastHeader(c, message);
    return c.body(null, 200);
  }

  /** Classify before creating a session; both forms then use the same dispatch. */
  async function submit(c: Context, existingId?: string): Promise<Response> {
    const form = await c.req.formData();
    const submission = await readSubmission(form);
    if ("error" in submission) return reject(c, submission.error);
    const { text, images, behavior } = submission;
    const cwd = field(form, "cwd");
    if (existingId === undefined && !cwd) {
      return reject(c, "Choose a working folder first.");
    }
    if (!text && images.length === 0) return reject(c, "Type a request first.");
    // An explicit local-only command must never become a model prompt, even
    // when attachments would otherwise cancel shell mode.
    if (text.startsWith("!!") && images.length > 0) {
      return reject(c, "Remove attachments to run a local-only shell command.");
    }
    const shell = images.length === 0 ? bashCommand(text) : null;
    if (images.length === 0 && text.startsWith("!") && !shell) {
      return reject(c, "Type a shell command after ! or !!.");
    }
    const builtin =
      images.length === 0
        ? /^\/(compact|reload|name|clone|session|copy)(?:\s+([\s\S]*))?$/.exec(
            text,
          )
        : null;
    const name = builtin?.[1];
    const argument = builtin?.[2]?.trim() ?? "";
    if (name === "name" && !argument)
      return reject(c, "Usage: /name <session name>");
    if (name === "session" || name === "copy") {
      return reject(c, `Use /${name} in an open session's composer.`);
    }
    if (existingId === undefined && (name === "compact" || name === "clone")) {
      return reject(
        c,
        `/${name} needs an existing conversation. Send a request first.`,
      );
    }
    const [provider, ...rest] = field(form, "model").split("/");
    const modelId = rest.join("/");
    const thinking = field(form, "thinking");
    return guard(c, async () => {
      const id =
        existingId ??
        (await deps.workspace.createSession(cwd, {
          ...(provider && modelId ? { model: { provider, modelId } } : {}),
          ...(isThinkingLevel(thinking) ? { thinkingLevel: thinking } : {}),
        }));
      let response: Response;
      if (shell) {
        await deps.workspace.runBash(id, shell.command, shell.excluded);
        response = c.body(null, 204);
      } else if (name) {
        response = await runBuiltin(c, id, name, argument);
      } else {
        await deps.workspace.send(id, text, { images, behavior });
        response = c.body(null, 204);
      }
      // A 2xx toast can still reject input. Only completed dispatch grants
      // acceptance, before HTMX follows a redirect or promotes the draft key.
      c.header("X-Web-Pi-Submission", "accepted");
      if (existingId !== undefined) {
        response.headers.set("X-Web-Pi-Submission", "accepted");
        return response;
      }
      if (c.req.header("HX-Request") !== "true")
        return c.redirect(`/sessions/${id}`, 303);
      const triggers = JSON.parse(
        response.headers.get("HX-Trigger") ?? "{}",
      ) as Record<string, unknown>;
      c.header(
        "HX-Trigger",
        JSON.stringify({ ...triggers, "web-pi:session-created": { cwd, id } }),
      );
      sessionLocation(c, `/sessions/${id}`);
      return c.body(null, 200);
    });
  }

  async function runBuiltin(
    c: Context,
    id: string,
    name: string,
    argument: string | undefined,
  ): Promise<Response> {
    const argumentText = argument?.trim() ?? "";
    switch (name) {
      case "compact":
        await deps.workspace.compact(
          id,
          argumentText === "" ? undefined : argumentText,
        );
        return c.body(null, 204);
      case "reload":
        await deps.workspace.reload(id);
        toastHeader(c, "Extensions, skills, and prompts reloaded.", "info");
        return c.body(null, 200);
      case "name":
        await deps.workspace.rename(id, argumentText);
        toastHeader(c, `Renamed to "${argumentText}".`, "info");
        return c.body(null, 200);
      default: {
        const cloned = await deps.workspace.clone(id);
        sessionLocation(c, `/sessions/${cloned}`);
        return c.body(null, 200);
      }
    }
  }

  app.get("/sessions/:id/commands", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const query = c.req.query("q") ?? "";
    const commands = await deps.workspace.commands(id, query);
    return c.html(<CommandMenu commands={commands} query={query} />);
  });

  app.post("/sessions/:id/compact", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return guard(c, async () => {
      await deps.workspace.compact(id);
      return c.body(null, 204);
    });
  });

  app.post("/sessions/:id/compact/abort", (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    deps.workspace.abortCompaction(id);
    return c.body(null, 204);
  });

  /**
   * Recall answers with the composer's textarea holding the queued texts, and
   * the images those messages carried riding along out of band for the client
   * bundle to put back into the attachment strip.
   */
  app.post("/sessions/:id/queue/recall", (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const recalled = deps.workspace.recallQueue(id);
    return c.html(
      <>
        <ComposerText draft={recalled.text} />
        <RecalledImages images={recalled.images} />
      </>,
    );
  });

  /** The two JSON endpoints of this phase: a menu cannot be a round trip. */
  app.get("/sessions/:id/file-index", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return files(c, () =>
      deps.workspace.fileIndex(
        id,
        c.req.query("cwd"),
        (c.req.query("q") ?? "").slice(0, 500),
      ),
    );
  });

  app.get("/sessions/:id/file-completion", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return files(c, async () => ({
      matches: await deps.workspace.fileCompletion(
        id,
        (c.req.query("q") ?? "").slice(0, 500),
        c.req.query("cwd"),
      ),
    }));
  });

  async function files(
    c: Context,
    action: () => Promise<unknown>,
  ): Promise<Response> {
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await action());
    } catch (error) {
      if (error instanceof ForbiddenPath) return c.json({ error: "" }, 403);
      if (error instanceof FileAccessError) {
        return c.json({ error: "" }, error.status);
      }
      return c.json({ error: "Cannot list that directory" }, 404);
    }
  }

  app.get("/sessions/:id/bash-output", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const path = c.req.query("path") ?? "";
    const download = c.req.query("download") === "1";
    try {
      const output = await deps.workspace.bashOutput(id, path);
      return c.text(output, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(download
          ? { "Content-Disposition": disposition("bash-output.log", true) }
          : {}),
      });
    } catch (error) {
      if (error instanceof ForbiddenPath) return c.text(errorText(error), 403);
      // Too large to read is not "missing": the reader is told the size and
      // the cap rather than being sent looking for a file that is right there.
      if (error instanceof FileAccessError) {
        return c.text(errorText(error), error.status);
      }
      return c.text("Cannot read that output file", 404);
    }
  });

  app.post("/sessions/:id/abort", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    await deps.workspace.abort(id);
    return c.body(null, 204);
  });

  /**
   * The composer's model menu. The pick rides in the query so the request
   * carries none of the composer form it was clicked inside, and the answer
   * is the re-rendered selector, which is what closes the popover and shows
   * the new name.
   */
  app.get("/sessions/:id/model-selector", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const view = await deps.workspace.viewSession(id, warnTokens(c));
    return view
      ? c.html(<ModelSelector pick={modelPick(view)} />)
      : c.notFound();
  });

  app.post("/sessions/:id/model", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    const [provider, ...rest] = (c.req.query("model") ?? "").split("/");
    const modelId = rest.join("/");
    // Only the reasoning select posts a body; the option buttons send none.
    const thinking = await c.req
      .formData()
      .then((form) => field(form, "thinking"))
      .catch(() => "");
    if (!provider || !modelId) return c.text("model is required", 400);
    try {
      await deps.workspace.setModel(id, {
        provider,
        modelId,
        ...(isThinkingLevel(thinking) ? { thinkingLevel: thinking } : {}),
      });
    } catch (error) {
      return c.text(errorText(error), 400);
    }
    const view = await deps.workspace.viewSession(id, warnTokens(c));
    if (!view) return c.notFound();
    return c.html(<ModelSelector pick={modelPick(view)} />);
  });

  /**
   * The same menu before a session exists: nothing is applied, the pick is
   * only recorded in the hidden field the first prompt posts.
   */
  app.get("/workspaces/model-selector", async (c) => {
    const cwd = c.req.query("cwd") ?? "";
    const picked = c.req.query("model") ?? "";
    const thinking = c.req.query("thinking") ?? "";
    return guard(c, async () => {
      const [provider, ...rest] = picked.split("/");
      const modelId = rest.join("/");
      const thinkingOverride = isThinkingLevel(thinking) ? thinking : undefined;
      const view = await deps.workspace.newSession(cwd, {
        ...(provider && modelId ? { model: { provider, modelId } } : {}),
        ...(thinkingOverride === undefined
          ? {}
          : { thinkingLevel: thinkingOverride }),
      });
      const chosen =
        view.model && `${view.model.provider}/${view.model.id}` === picked;
      const level = view.thinkingLevel;
      return c.html(
        <ModelSelector
          pick={{
            explicitModel: !!chosen,
            ...(thinkingOverride === undefined ? {} : { thinkingOverride }),
            models: view.models,
            current: view.model ?? null,
            levels: view.model?.thinkingLevels ?? [],
            ...(level === undefined ? {} : { level }),
            cwd: view.cwd,
          }}
        />,
      );
    });
  });

  // --- Composer menus before a session exists ------------------------------

  app.get("/workspaces/commands", async (c) => {
    const cwd = c.req.query("cwd") ?? "";
    return guard(c, async () => {
      const query = c.req.query("q") ?? "";
      const commands = await deps.workspace.folderCommands(cwd, query);
      return c.html(<CommandMenu commands={commands} query={query} />);
    });
  });

  for (const [path, isPath] of [
    ["file-index", false],
    ["file-completion", true],
  ] as const) {
    app.get(`/workspaces/${path}`, async (c) => {
      const cwd = c.req.query("cwd") ?? "";
      try {
        return c.json(
          await deps.workspace.folderFiles(cwd, c.req.query("q") ?? "", isPath),
        );
      } catch (error) {
        const status = error instanceof FileAccessError ? error.status : 400;
        return c.json({ error: errorText(error) }, status);
      }
    });
  }

  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.notFound();
    return streamSSE(c, async (stream) => {
      const ended = Promise.withResolvers<undefined>();
      // The shelf holds open panels, so it is only re-sent when an extension
      // actually changed a status or a widget.
      let shelf = "";
      // Prompts and branch activation can change the rail before settlement.
      // Keep unchanged marks in place while assistant tokens stream.
      let rail = "";
      // The model selector is a whole subtree with an open popover in it, and
      // a turn renders ten times a second: send it only when the pick moved.
      let model = "";
      // Same for the dialog and the custom-UI shell: re-sending either would
      // wipe what the reader typed, or take focus out of the panel.
      let dialog = "";
      let custom = "";
      let frame = "";
      const widgetLines = new Map<string, string>();
      // The browser advances Last-Event-ID only through received SSE frames.
      // The page supplies the initial cursor, including for startup retries.
      const lastEventId = c.req.header("Last-Event-ID");
      let cursor = lastEventId?.startsWith("settled=")
        ? decodeURIComponent(lastEventId.slice("settled=".length))
        : (c.req.query("after") ?? "");
      const render = async (kind: "activity" | "turn_done") => {
        if (aborted) return;
        const view = await deps.workspace.viewSession(id, {
          ...warnTokens(c),
          after: cursor,
        });
        if (aborted) return;
        if (!view) return;
        const actions: ItemActions = {
          sessionId: id,
          cwd: view.summary.cwd,
          starred: view.starred,
          ...(turnBusy(view.status) ? { busy: true } : {}),
        };
        const pick = modelPick(view);
        const nextModel = JSON.stringify([
          pick.current,
          pick.level,
          pick.levels,
          pick.models,
        ]);
        const modelChanged = nextModel !== model;
        model = nextModel;
        const nextRail = JSON.stringify([view.rail, view.branched]);
        const railChanged = nextRail !== rail;
        const reconciled = cursor !== view.settledCursor;
        // One snapshot and one frame: never clear a missed answer without its
        // canonical replacement, or clear a newer turn on a delayed turn_done.
        await stream.writeSSE({
          id: `settled=${encodeURIComponent(view.settledCursor)}`,
          data: await html(
            <>
              {view.resetTranscript ? (
                <Partial target=".chat-body" swap="outerHTML">
                  <Transcript view={view} />
                </Partial>
              ) : (
                <>
                  {view.items.length > 0 ? (
                    <Partial target="#messages" swap="beforeend">
                      <Items items={view.items} actions={actions} />
                    </Partial>
                  ) : null}
                  <Partial target="#turn" swap="innerMorph">
                    <TurnFragment
                      items={view.turn}
                      actions={actions}
                      status={view.status}
                    />
                  </Partial>
                </>
              )}
              {railChanged && !view.resetTranscript ? (
                <Rail view={view} oob />
              ) : null}
              <Status view={view} model={modelChanged} oob partial />
            </>,
          ),
        });
        rail = nextRail;
        cursor = view.settledCursor;
        // Native SSE awaits the complete HTML frame before semantic events.
        if (reconciled || kind === "turn_done")
          await stream.writeSSE({ event: "settled", data: id });
        const signature = shelfSignature(view.status);
        if (signature !== shelf) {
          shelf = signature;
          await stream.writeSSE({
            data: await html(
              <Partial target="#shelf" swap="outerHTML">
                <ShelfBody
                  status={view.status}
                  updated={changedWidgets(widgetLines, view.status)}
                />
              </Partial>,
            ),
          });
        }
        const nextDialog = dialogSignature(view.status?.dialog ?? null);
        if (nextDialog !== dialog) {
          dialog = nextDialog;
          await stream.writeSSE({
            data: await html(
              <Partial target="#extension-dialog">
                <ExtensionDialogBody
                  sessionId={id}
                  dialog={view.status?.dialog ?? null}
                />
              </Partial>,
            ),
          });
        }
        const panel = view.status?.custom ?? null;
        if ((panel?.id ?? "") !== custom) {
          custom = panel?.id ?? "";
          frame = "";
          await stream.writeSSE({
            data: await html(
              <Partial target="#custom-ui">
                <CustomPanelBody sessionId={id} frame={panel} />
              </Partial>,
            ),
          });
        }
        const nextFrame = customSignature(panel);
        if (nextFrame !== frame) {
          frame = nextFrame;
          await stream.writeSSE({
            data: await html(
              <Partial target="#custom-frame">
                <CustomFrameBody frame={panel} />
              </Partial>,
            ),
          });
        }
        // Text an extension asked to put in the composer, and a title it set.
        for (const text of view.status?.editorText ?? []) {
          await stream.writeSSE({
            data: await html(
              <Partial target="#editor-insert">
                <span data-insert={text} />
              </Partial>,
            ),
          });
        }
        // Notices are drained by the snapshot: send them once, as toasts.
        const notices = view.status?.notices ?? [];
        if (notices.length > 0) {
          await stream.writeSSE({
            data: await html(
              <Partial target="#toasts" swap="beforeend">
                <Toasts notices={notices} />
              </Partial>,
            ),
          });
        }
      };

      let aborted = false;
      const fail = async (error: unknown) => {
        if (aborted) return;
        aborted = true;
        try {
          await stream.writeSSE({
            data: await html(
              <Partial target="#toasts" swap="beforeend">
                <Toasts
                  notices={[
                    {
                      level: "error",
                      message: `Live updates failed: ${errorText(error)}`,
                    },
                  ]}
                />
              </Partial>,
            ),
          });
        } finally {
          ended.resolve(undefined);
          await stream.close();
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let queue: Promise<void> = Promise.resolve();
      const enqueue = (kind: "activity" | "turn_done") => {
        queue = queue
          .then(async () => {
            await render(kind);
          })
          .catch(fail);
      };
      /**
       * The agent finished a run and went idle. The browser decides what to
       * do with it — a tone, a notification, an unread dot — because only it
       * knows whether anyone is looking.
       */
      const announceDone = () => {
        queue = queue
          .then(async () => {
            if (!aborted) await stream.writeSSE({ event: "done", data: id });
          })
          .catch(fail);
      };
      stream.onAbort(() => {
        aborted = true;
        ended.resolve(undefined);
      });
      const listener = (event: { type: string }) => {
        if (event.type === "activity") {
          // Coalesce bursts of deltas into one re-render per interval.
          timer ??= setTimeout(() => {
            timer = undefined;
            enqueue("activity");
          }, renderIntervalMs);
        } else if (event.type === "turn_done") {
          if (timer) clearTimeout(timer);
          timer = undefined;
          enqueue("turn_done");
        } else if (event.type === "completed") {
          announceDone();
        } else {
          // A stopped runtime can have persisted its final entries just before
          // removal. Reconcile that boundary before allowing reconnection.
          enqueue("turn_done");
          queue = queue.then(async () => {
            await stream.close();
            ended.resolve(undefined);
          });
        }
      };
      // A page for a stored session opens its stream before any runtime
      // exists; reconcile it, then wait for the first prompt to create one.
      let unsubscribe = deps.workspace.subscribe(id, listener);
      if (!unsubscribe) enqueue("activity");
      while (!unsubscribe && !aborted) {
        await sleep(500);
        unsubscribe = deps.workspace.subscribe(id, listener);
      }
      if (!unsubscribe) return;
      // The client may have missed activity between page render and connect.
      enqueue("activity");
      const heartbeat = setInterval(() => {
        queue = queue
          .then(async () => {
            await stream.write(": ping\n\n");
          })
          .catch(fail);
      }, 30_000);
      await ended.promise;
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  });
}
