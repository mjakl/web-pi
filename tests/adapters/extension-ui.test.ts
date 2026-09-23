import type { LiveSession } from "@core/ports";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHarness,
  type Harness,
  next,
  reply,
  until,
} from "./pi-harness.ts";

// Extension UI without a terminal, driven from real extensions: an inline
// extension registers commands that call ctx.ui.*, the page answers through
// the LiveSession, and the closures record what the extension got back.

let h: Harness;

afterEach(async () => {
  await h.dispose();
});

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** A harness whose one extension registers the given slash commands. */
async function withCommands(
  commands: Record<string, Handler>,
): Promise<{ session: LiveSession }> {
  h = await createHarness({
    extensions: [
      (pi: ExtensionAPI) => {
        for (const [name, handler] of Object.entries(commands)) {
          pi.registerCommand(name, { description: name, handler });
        }
      },
    ],
  });
  return { session: await h.open() };
}

/** The dialog on screen, once there is one. */
async function dialog(session: LiveSession) {
  const snapshot = await until(session, (s) => s.status.dialog !== null);
  const request = snapshot.status.dialog;
  if (!request) throw new Error("unreachable");
  return request;
}

describe("dialogs", () => {
  it("shows a select and hands the chosen option to the extension", async () => {
    let received: string | undefined = "unset";
    const { session } = await withCommands({
      ask: async (_args, ctx) => {
        received = await ctx.ui.select("Pick a branch", ["main", "next"]);
      },
    });
    const asked = session.prompt("/ask");
    const request = await dialog(session);
    expect(request).toMatchObject({
      method: "select",
      title: "Pick a branch",
      options: ["main", "next"],
    });
    expect(request.expiresAt).toBeUndefined();
    expect(session.answerDialog(request.id, { value: "next" })).toBe(true);
    await asked;
    expect(received).toBe("next");
    expect(session.snapshot().status.dialog).toBeNull();
    // A stale tab answering again changes nothing.
    expect(session.answerDialog(request.id, { value: "main" })).toBe(false);
  });

  it("resolves confirm, input, and editor with their own answer shapes", async () => {
    const got: unknown[] = [];
    const { session } = await withCommands({
      confirm: async (_args, ctx) => {
        got.push(await ctx.ui.confirm("Push?", "Rewrites the remote"));
      },
      input: async (_args, ctx) => {
        got.push(await ctx.ui.input("Name", "feature/…"));
      },
      editor: async (_args, ctx) => {
        got.push(await ctx.ui.editor("Message", "Fix\n"));
      },
    });
    const confirming = session.prompt("/confirm");
    const confirm = await dialog(session);
    expect(confirm).toMatchObject({
      method: "confirm",
      title: "Push?",
      message: "Rewrites the remote",
    });
    session.answerDialog(confirm.id, { confirmed: true });
    await confirming;

    const inputting = session.prompt("/input");
    const input = await dialog(session);
    expect(input).toMatchObject({ method: "input", placeholder: "feature/…" });
    session.answerDialog(input.id, { value: "feature/x" });
    await inputting;

    const editing = session.prompt("/editor");
    const editor = await dialog(session);
    expect(editor).toMatchObject({ method: "editor", prefill: "Fix\n" });
    session.answerDialog(editor.id, { cancelled: true });
    await editing;
    expect(got).toEqual([true, "feature/x", undefined]);
  });

  it("gives up on a dialog when the extension's own timeout passes", async () => {
    let received: string | undefined = "unset";
    const { session } = await withCommands({
      ask: async (_args, ctx) => {
        received = await ctx.ui.input("Quick", undefined, { timeout: 40 });
      },
    });
    const asked = session.prompt("/ask");
    const request = await dialog(session);
    expect(request.expiresAt).toBeGreaterThan(Date.now());
    await asked;
    expect(received).toBeUndefined();
    expect(session.snapshot().status.dialog).toBeNull();
  });

  it("cancels a waiting dialog when the extension's signal aborts", async () => {
    let received: boolean | undefined;
    const controller = new AbortController();
    const { session } = await withCommands({
      ask: async (_args, ctx) => {
        received = await ctx.ui.confirm("Sure?", "…", {
          signal: controller.signal,
        });
      },
    });
    const asked = session.prompt("/ask");
    await dialog(session);
    controller.abort();
    await asked;
    expect(received).toBe(false);
    expect(session.snapshot().status.dialog).toBeNull();
  });

  it("shows only the newest of two dialogs and settles the rest on stop", async () => {
    const answers: (string | undefined)[] = [];
    const { session } = await withCommands({
      ask: async (args, ctx) => {
        answers.push(await ctx.ui.input(`Ask ${args}`));
      },
    });
    const first = session.prompt("/ask one");
    await dialog(session);
    const second = session.prompt("/ask two");
    const newest = await until(
      session,
      (s) => s.status.dialog?.title === "Ask two",
    );
    session.answerDialog(newest.status.dialog?.id ?? "", { value: "2" });
    await second;
    expect(answers).toEqual(["2"]);
    // The older one is back on screen, still waiting.
    expect(session.snapshot().status.dialog?.title).toBe("Ask one");
    await session.stop();
    await first;
    expect(answers).toEqual(["2", undefined]);
  });

  it("keeps a pending dialog across a reload but drops statuses and widgets", async () => {
    let received: string | undefined = "unset";
    let disposed = 0;
    const { session } = await withCommands({
      ask: async (_args, ctx) => {
        ctx.ui.setStatus("git", "main");
        ctx.ui.setWidget("todo", ["one", "two"]);
        ctx.ui.setWidget("clock", () => ({
          render: () => ["tick"],
          invalidate() {},
          dispose() {
            disposed += 1;
          },
        }));
        received = await ctx.ui.input("Still here?");
      },
    });
    const asked = session.prompt("/ask");
    const request = await dialog(session);
    expect(session.snapshot().status.statuses).toEqual({ git: "main" });
    expect(session.snapshot().status.widgets.map((w) => w.key)).toEqual([
      "todo",
      "clock",
    ]);
    await session.reload();
    const after = session.snapshot().status;
    expect(after.statuses).toEqual({});
    expect(after.widgets).toEqual([]);
    expect(disposed).toBe(1);
    expect(after.dialog?.id).toBe(request.id);
    session.answerDialog(request.id, { value: "yes" });
    await asked;
    expect(received).toBe("yes");
  });
});

describe("shelf, notices, and composer", () => {
  it("mirrors statuses, widgets, title, notices, and editor text", async () => {
    const { session } = await withCommands({
      show: (_args, ctx) => {
        ctx.ui.setStatus("git", "\u001b[32mmain\u001b[0m");
        ctx.ui.setWidget("todo", ["- [ ] a"], { placement: "belowEditor" });
        ctx.ui.setTitle("Counting");
        ctx.ui.notify("heads up", "warning");
        ctx.ui.notify("plain");
        ctx.ui.setEditorText("draft text");
        ctx.ui.pasteToEditor("pasted");
        return Promise.resolve();
      },
      clear: (_args, ctx) => {
        ctx.ui.setStatus("git", undefined);
        ctx.ui.setWidget("todo", undefined);
        return Promise.resolve();
      },
    });
    await session.prompt("/show");
    const status = session.snapshot().status;
    expect(status.statuses).toEqual({ git: "\u001b[32mmain\u001b[0m" });
    expect(status.widgets).toEqual([
      { key: "todo", lines: ["- [ ] a"], placement: "belowEditor" },
    ]);
    expect(status.title).toBe("Counting");
    expect(status.notices).toEqual([
      { level: "warning", message: "heads up" },
      { level: "info", message: "plain" },
    ]);
    expect(status.editorText).toEqual(["draft text", "pasted"]);
    session.takePending();
    expect(session.snapshot().status.notices).toEqual([]);
    expect(session.snapshot().status.editorText).toEqual([]);

    await session.prompt("/clear");
    expect(session.snapshot().status.statuses).toEqual({});
    expect(session.snapshot().status.widgets).toEqual([]);
  });

  it("renders a component widget headlessly and redraws on request", async () => {
    let redraw = () => {};
    let count = 0;
    const { session } = await withCommands({
      widget: (_args, ctx) => {
        ctx.ui.setWidget("counter", (tui) => {
          redraw = () => {
            count += 1;
            tui.requestRender();
          };
          return {
            render: () => [`count ${String(count)}`],
            invalidate() {},
          };
        });
        return Promise.resolve();
      },
      replace: (_args, ctx) => {
        ctx.ui.setWidget("counter", ["plain lines"]);
        ctx.ui.setWidget("ignored", 42 as never);
        return Promise.resolve();
      },
      broken: (_args, ctx) => {
        ctx.ui.setWidget("bad", () => ({
          render: () => {
            throw new Error("cannot draw");
          },
          invalidate() {},
        }));
        ctx.ui.setWidget("text", () => ({
          render: () => "not lines" as never,
          invalidate() {},
        }));
        return Promise.resolve();
      },
    });
    await session.prompt("/widget");
    expect(session.snapshot().status.widgets[0]?.lines).toEqual(["count 0"]);
    redraw();
    expect(session.snapshot().status.widgets[0]?.lines).toEqual(["count 1"]);

    // Replaced by plain lines: a late redraw from the old component is ignored.
    await session.prompt("/replace");
    redraw();
    expect(session.snapshot().status.widgets).toEqual([
      { key: "counter", lines: ["plain lines"], placement: "aboveEditor" },
    ]);

    await session.prompt("/broken");
    expect(session.snapshot().status.widgets.map((w) => w.key)).toEqual([
      "counter",
    ]);
    expect(session.snapshot().status.notices).toEqual([
      { level: "error", message: 'Extension widget "bad": cannot draw' },
      {
        level: "error",
        message: 'Extension widget "text": render must return lines',
      },
    ]);
  });

  it("stubs what only a terminal could do", async () => {
    const seen: unknown[] = [];
    const { session } = await withCommands({
      probe: (_args, ctx) => {
        seen.push(
          ctx.ui.getEditorText(),
          ctx.ui.getAllThemes(),
          ctx.ui.getTheme("dark"),
          ctx.ui.setTheme("dark"),
          ctx.ui.getToolsExpanded(),
          typeof ctx.ui.onTerminalInput(() => undefined),
        );
        ctx.ui.setWorkingMessage("x");
        ctx.ui.setWorkingVisible(false);
        ctx.ui.setWorkingIndicator();
        ctx.ui.setHiddenThinkingLabel("hidden");
        ctx.ui.setFooter(undefined);
        ctx.ui.setHeader(undefined);
        ctx.ui.setToolsExpanded(true);
        ctx.ui.addAutocompleteProvider((current) => current);
        ctx.ui.setEditorComponent(undefined);
        seen.push(ctx.ui.getEditorComponent());
        ctx.ui.setTitle("");
        ctx.ui.setEditorText("");
        return Promise.resolve();
      },
    });
    await session.prompt("/probe");
    expect(seen).toEqual([
      "",
      [],
      undefined,
      { success: false, error: "Themes are not supported here" },
      false,
      "function",
      undefined,
    ]);
    expect(session.snapshot().status.title).toBeNull();
    expect(session.snapshot().status.editorText).toEqual([]);
  });
});

describe("custom terminal UI", () => {
  /** A counter the arrow keys change and Enter finishes. */
  function counter(done: (value: number) => void) {
    let count = 0;
    return {
      render: (width: number) => [`Count ${String(count)} @${String(width)}`],
      handleInput(data: string) {
        if (data === "\u001b[A") count += 1;
        if (data === "\r") done(count);
        if (data === "x") throw new Error("bad key");
      },
      invalidate() {},
    };
  }

  it("draws frames, forwards keys, and closes when the component is done", async () => {
    let result: unknown = "unset";
    let painted: string[] = [];
    let redraw = () => {};
    const { session } = await withCommands({
      count: async (_args, ctx) => {
        result = await ctx.ui.custom(
          (tui, theme, _keys, done: (value: number) => void) => {
            // The theme applies no colour, so a component draws plain text.
            painted = [
              theme.fg("accent", "fg"),
              theme.bg("selectedBg", "bg"),
              theme.bold("b"),
              theme.italic("i"),
              theme.underline("u"),
              theme.inverse("v"),
              theme.strikethrough("s"),
              theme.getFgAnsi("accent"),
              theme.getBgAnsi("selectedBg"),
              theme.getThinkingBorderColor("high")("t"),
              theme.getBashModeBorderColor()("h"),
            ];
            const component = counter(done);
            redraw = () => {
              component.handleInput("\u001b[A");
              tui.requestRender();
            };
            return component;
          },
          { overlayOptions: () => ({ width: 60 }) },
        );
      },
    });
    const counting = session.prompt("/count");
    const opened = await until(session, (s) => s.status.custom !== null);
    const id = opened.status.custom?.id ?? "";
    expect(opened.status.custom?.lines).toEqual(["Count 0 @60"]);
    expect(painted).toEqual([
      "fg",
      "bg",
      "b",
      "i",
      "u",
      "v",
      "s",
      "",
      "",
      "t",
      "h",
    ]);
    session.customInput(id, "\u001b[A");
    session.customInput(id, "\u001b[A");
    expect(session.snapshot().status.custom?.lines).toEqual(["Count 2 @60"]);
    redraw();
    expect(session.snapshot().status.custom?.lines).toEqual(["Count 3 @60"]);
    session.customInput(id, "\r");
    await counting;
    expect(result).toBe(3);
    expect(session.snapshot().status.custom).toBeNull();
  });

  it("disposes a component whose factory finished before returning it", async () => {
    let result: unknown = "unset";
    let disposed = 0;
    const { session } = await withCommands({
      early: async (_args, ctx) => {
        result = await ctx.ui.custom((_tui, _theme, _keys, done) => {
          done("early");
          return {
            render: () => ["never shown"],
            invalidate() {},
            dispose() {
              disposed += 1;
            },
          };
        });
      },
    });
    await session.prompt("/early");
    expect(result).toBe("early");
    expect(disposed).toBe(1);
    expect(session.snapshot().status.custom).toBeNull();
  });

  it("settles a component that throws on input without stopping the session", async () => {
    let result: unknown = "unset";
    const { session } = await withCommands({
      count: async (_args, ctx) => {
        result = await ctx.ui.custom((_tui, _theme, _keys, done) =>
          counter(done),
        );
      },
    });
    const counting = session.prompt("/count");
    const opened = await until(session, (s) => s.status.custom !== null);
    expect(opened.status.custom?.lines).toEqual(["Count 0 @92"]);
    session.customInput(opened.status.custom?.id ?? "", "x");
    expect(session.snapshot().status.custom).toBeNull();
    expect(session.snapshot().status.notices).toEqual([
      { level: "error", message: "Extension UI: bad key" },
    ]);
    await counting;
    expect(result).toBeUndefined();
    expect(h.runtime.get(session.id)).toBeDefined();
  });

  it("resolves with nothing when the factory fails or returns no component", async () => {
    const results: unknown[] = [];
    const { session } = await withCommands({
      broken: async (_args, ctx) => {
        results.push(
          await ctx.ui.custom(() => {
            throw new Error("no component");
          }),
        );
      },
      empty: async (_args, ctx) => {
        results.push(await ctx.ui.custom(() => ({}) as never));
      },
    });
    await session.prompt("/broken");
    await session.prompt("/empty");
    expect(results).toEqual([undefined, undefined]);
    expect(session.snapshot().status.notices).toEqual([
      { level: "error", message: "Extension UI: no component" },
    ]);
    expect(session.snapshot().status.custom).toBeNull();
  });
});

describe("session control from an extension", () => {
  it("refuses to replace the session, but navigates, reloads, and shuts down", async () => {
    const seen: unknown[] = [];
    const { session } = await withCommands({
      control: async (_args, ctx) => {
        await ctx.waitForIdle();
        seen.push(await ctx.newSession());
        seen.push(await ctx.fork("x"));
        seen.push(await ctx.switchSession("/nowhere"));
        const question = ctx.sessionManager
          .getBranch()
          .find(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          );
        seen.push(await ctx.navigateTree(question?.id ?? ""));
        // Last: the SDK forbids using this context after a reload.
        await ctx.reload();
      },
      bye: (_args, ctx) => {
        ctx.shutdown();
        return Promise.resolve();
      },
    });
    h.script(reply("answer"));
    const done = next(session, "turn_done");
    await session.prompt("question");
    await done;
    await session.prompt("/control");
    expect(seen).toEqual([
      { cancelled: true },
      { cancelled: true },
      { cancelled: true },
      { cancelled: false, editorText: "question" },
    ]);
    // The leaf moved before the answer, so the turn boundary moved with it.
    expect(session.snapshot().turnStart).toBe(session.snapshot().branch.length);
    const stopped = next(session, "stopped");
    await session.prompt("/bye");
    expect(session.snapshot().status.notices).toEqual([
      {
        level: "warning",
        message: "An extension asked to shut this session down.",
      },
    ]);
    await stopped;
    expect(h.runtime.get(session.id)).toBeUndefined();
  });
});
