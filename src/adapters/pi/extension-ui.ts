import {
  answerConfirmed,
  answerText,
  createCustomUiHost,
  createDialogHost,
  type DialogAnswer,
  type FrameComponent,
} from "@core/extension-ui";
import type { ExtensionWidget } from "@core/ports";
import {
  type ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  type OverlayOptions,
  TUI_KEYBINDINGS,
  type TUI,
} from "@earendil-works/pi-tui";

/** A theme that applies no colours: extensions may read it, nothing draws it. */
class PlainTextTheme extends Theme {
  constructor() {
    super(
      {
        text: "",
        muted: "",
        thinkingXhigh: "",
        searchMatchText: "",
      } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string {
    return text;
  }
  override bg(...[, text]: Parameters<Theme["bg"]>): string {
    return text;
  }
  override bold(text: string): string {
    return text;
  }
  override italic(text: string): string {
    return text;
  }
  override underline(text: string): string {
    return text;
  }
  override inverse(text: string): string {
    return text;
  }
  override strikethrough(text: string): string {
    return text;
  }
  override getFgAnsi(): string {
    return "";
  }
  override getBgAnsi(): string {
    return "";
  }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string {
    return (text) => text;
  }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();

/** Pi's own key chords, so a component behaves as it would in the terminal. */
const KEYBINDINGS = new KeybindingsManager(TUI_KEYBINDINGS);

/** The terminal a component is told it is drawing into. */
const COLUMNS = 92;
const ROWS = 40;
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 140;

/**
 * A pi-tui `TUI` with no terminal behind it: a component only needs the size
 * it may draw into and a way to say it wants redrawing. Everything else on the
 * interface belongs to a real screen, and a component that reaches for it gets
 * a TypeError it would also get from a headless terminal.
 */
function headlessTui(columns: number, requestRender: () => void): TUI {
  return {
    terminal: { columns, rows: ROWS, kittyProtocolActive: false },
    requestRender,
  } as unknown as TUI;
}

function widthFrom(options: unknown): number {
  const overlay: unknown =
    typeof options === "object" &&
    options !== null &&
    "overlayOptions" in options
      ? (options as { overlayOptions?: unknown }).overlayOptions
      : undefined;
  const resolved: unknown =
    typeof overlay === "function"
      ? (overlay as () => OverlayOptions)()
      : overlay;
  const width =
    typeof resolved === "object" && resolved !== null && "width" in resolved
      ? (resolved as { width?: unknown }).width
      : undefined;
  if (typeof width !== "number" || !Number.isFinite(width)) return COLUMNS;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.round(width)));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type ExtensionUiSink = {
  notify(level: "info" | "warning" | "error", message: string): void;
  setStatus(key: string, text: string | undefined): void;
  /** `undefined` removes the widget. */
  setWidget(
    key: string,
    lines: string[] | undefined,
    placement: ExtensionWidget["placement"],
  ): void;
  setTitle(title: string): void;
  /** Text to insert at the composer's cursor. */
  insertEditorText(text: string): void;
  /** Something changed that the session's renderers have to see. */
  changed(): void;
};

export type ExtensionUi = ReturnType<typeof createExtensionUi>;

/**
 * Extension UI without a terminal. Dialogs become pending requests the browser
 * answers; a custom UI is a pi-tui component rendered to text frames and fed
 * keystrokes from the page; statuses and widgets go to the shelf. What a
 * terminal alone could do — themes, the footer, the working indicator — stays
 * stubbed, as it is in pi-web.
 */
export function createExtensionUi(sink: ExtensionUiSink) {
  const changed = () => {
    sink.changed();
  };
  const dialogs = createDialogHost(changed);
  const custom = createCustomUiHost(changed);
  /** Factory widgets, so a reload can dispose the components they own. */
  const widgetComponents = new Map<string, FrameComponent>();
  const pendingCustom = new Set<() => void>();
  let disposed = false;

  function disposeWidget(key: string): void {
    const component = widgetComponents.get(key);
    if (!component) return;
    widgetComponents.delete(key);
    try {
      component.dispose?.();
    } catch {
      // A widget that throws on dispose is still gone.
    }
  }

  /** A widget whose content is a component: rendered like a custom UI frame. */
  function drawWidget(
    key: string,
    component: FrameComponent,
    placement: ExtensionWidget["placement"],
  ): void {
    if (disposed || widgetComponents.get(key) !== component) return;
    try {
      const lines = component.render(COLUMNS);
      if (!Array.isArray(lines))
        throw new TypeError("render must return lines");
      if (!disposed) sink.setWidget(key, lines, placement);
    } catch (error) {
      disposeWidget(key);
      if (!disposed) {
        sink.setWidget(key, undefined, placement);
        sink.notify("error", `Extension widget "${key}": ${message(error)}`);
      }
    }
  }

  const context: ExtensionUIContext = {
    async select(title, options, opts) {
      return answerText(
        await dialogs.ask({ method: "select", title, options }, opts),
      );
    },
    async confirm(title, messageText, opts) {
      return answerConfirmed(
        await dialogs.ask(
          { method: "confirm", title, message: messageText },
          opts,
        ),
      );
    },
    async input(title, placeholder, opts) {
      return answerText(
        await dialogs.ask(
          {
            method: "input",
            title,
            ...(placeholder === undefined ? {} : { placeholder }),
          },
          opts,
        ),
      );
    },
    async editor(title, prefill) {
      return answerText(
        await dialogs.ask({
          method: "editor",
          title,
          ...(prefill === undefined ? {} : { prefill }),
        }),
      );
    },
    custom<T>(factory: unknown, options?: unknown): Promise<T> {
      if (disposed || typeof factory !== "function")
        return Promise.resolve(undefined as T);
      const width = widthFrom(options);
      return new Promise<T>((resolve) => {
        let id: string | undefined;
        let settled = false;
        const finish = (value: T) => {
          if (settled) return;
          settled = true;
          pendingCustom.delete(cancel);
          if (id !== undefined) custom.close(id);
          resolve(value);
        };
        const cancel = () => {
          finish(undefined as T);
        };
        pendingCustom.add(cancel);
        const tui = headlessTui(width, () => {
          if (id !== undefined) custom.redraw(id);
        });
        Promise.resolve()
          .then(() => {
            if (disposed || settled) return undefined;
            return (
              factory as (
                tui: TUI,
                theme: Theme,
                keybindings: KeybindingsManager,
                done: (value: T) => void,
              ) => FrameComponent | Promise<FrameComponent>
            )(tui, PLAIN_TEXT_THEME, KEYBINDINGS, finish);
          })
          .then((component) => {
            if (!component) {
              cancel();
              return;
            }
            if (disposed || settled) {
              component.dispose?.();
              return;
            }
            if (typeof component.render !== "function") {
              finish(undefined as T);
              return;
            }
            // Closed by the host — a failing keystroke, session stop — the
            // extension gets nothing back, as in pi-web, rather than waiting.
            id = custom.open(component, width, () => {
              finish(undefined as T);
            });
          })
          .catch((error: unknown) => {
            if (!disposed)
              sink.notify("error", `Extension UI: ${message(error)}`);
            finish(undefined as T);
          });
      });
    },
    notify(text, type) {
      if (!disposed) sink.notify(type ?? "info", text);
    },
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      if (!disposed) sink.setStatus(key, text);
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(
      key: string,
      content: unknown,
      options?: { placement?: ExtensionWidget["placement"] },
    ) {
      if (disposed) return;
      const placement = options?.placement ?? "aboveEditor";
      disposeWidget(key);
      if (disposed) return;
      if (content === undefined) {
        sink.setWidget(key, undefined, placement);
        return;
      }
      if (Array.isArray(content)) {
        sink.setWidget(key, content as string[], placement);
        return;
      }
      if (typeof content !== "function") return;
      try {
        const component = (
          content as (tui: TUI, theme: Theme) => FrameComponent
        )(
          headlessTui(COLUMNS, () => {
            drawWidget(key, component, placement);
          }),
          PLAIN_TEXT_THEME,
        );
        if (disposed) {
          component.dispose?.();
          return;
        }
        widgetComponents.set(key, component);
        drawWidget(key, component, placement);
      } catch (error) {
        if (!disposed)
          sink.notify("error", `Extension widget "${key}": ${message(error)}`);
      }
    },
    setFooter() {},
    setHeader() {},
    setTitle(title) {
      if (!disposed && title) sink.setTitle(title);
    },
    // `setEditorText` and `pasteToEditor` are one insertion at the cursor, as
    // in pi-web: the composer belongs to the reader, not to the extension.
    pasteToEditor(text) {
      if (!disposed && text) sink.insertEditorText(text);
    },
    setEditorText(text) {
      if (!disposed && text) sink.insertEditorText(text);
    },
    getEditorText() {
      return "";
    },
    // No autocomplete provider is ever registered: the `@` and `/` menus are
    // the server's, and an extension cannot reach into them.
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    theme: PLAIN_TEXT_THEME,
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "Themes are not supported here" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };

  return {
    context,
    dialog: () => dialogs.pending(),
    frame: () => custom.frame(),
    answerDialog: (id: string, answer: DialogAnswer) =>
      dialogs.answer(id, answer),
    customInput(id: string, data: string): void {
      const { failed } = custom.input(id, data);
      if (failed !== undefined) {
        sink.notify("error", `Extension UI: ${failed}`);
      }
    },
    /**
     * `/reload` rebuilds the extensions, so their statuses and widgets are
     * stale; a dialog or a custom UI already waiting is not, and survives.
     */
    resetForReload(): void {
      for (const key of [...widgetComponents.keys()]) {
        disposeWidget(key);
        sink.setWidget(key, undefined, "aboveEditor");
      }
    },
    /** Terminal closure: even a later lifecycle hook cannot reopen UI. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dialogs.dispose();
      for (const cancel of [...pendingCustom]) cancel();
      custom.dispose();
      for (const key of [...widgetComponents.keys()]) {
        disposeWidget(key);
        sink.setWidget(key, undefined, "aboveEditor");
      }
    },
  };
}
