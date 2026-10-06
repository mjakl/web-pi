// What an extension asks the reader for, and what is on screen while it waits.
// Both hosts are pure state machines: the Pi adapter feeds them SDK calls and
// pi-tui components, the fake world feeds them scripted ones, and the views
// render whatever `pending()` and `frame()` return.

export type DialogMethod = "select" | "confirm" | "input" | "editor";

/** One unanswered question, as the browser has to render it. */
export type DialogRequest = {
  id: string;
  method: DialogMethod;
  title: string;
  /** `confirm` only. */
  message?: string;
  /** `select` only. */
  options?: string[];
  /** `input` only. */
  placeholder?: string;
  /** `editor` only. */
  prefill?: string;
  /** Epoch milliseconds the extension's own timeout expires at. */
  expiresAt?: number;
};

/**
 * The three shapes an answer takes. A cancelled dialog carries neither a
 * value nor a confirmation, which is exactly how the SDK's default (undefined,
 * or false for `confirm`) is spelled — an extension cannot tell a cancel from
 * an empty answer, as in pi-web.
 */
export type DialogAnswer =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

export const CANCELLED: DialogAnswer = { cancelled: true };

/** The text a `select`/`input`/`editor` call resolves with. */
export function answerText(answer: DialogAnswer): string | undefined {
  return "value" in answer ? answer.value : undefined;
}

/** Whether a `confirm` call resolves true. */
export function answerConfirmed(answer: DialogAnswer): boolean {
  return "confirmed" in answer ? answer.confirmed : false;
}

export type DialogSpec = Omit<DialogRequest, "id" | "expiresAt">;

export type DialogOptions = { timeout?: number; signal?: AbortSignal };

export type DialogHost = ReturnType<typeof createDialogHost>;

/**
 * Pending extension dialogs. Several may wait at once — the SDK keys them by
 * id and an extension may ask twice — but only the newest is shown, so an
 * older one is left to its timeout, its abort signal, or session stop. That is
 * pi-web's behaviour, kept because answering an invisible dialog is worse.
 */
export function createDialogHost(onChange: () => void = () => {}) {
  const pending = new Map<
    string,
    { request: DialogRequest; settle: (answer: DialogAnswer) => void }
  >();
  let counter = 0;
  let disposed = false;

  function resolve(id: string, answer: DialogAnswer): boolean {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.settle(answer);
    onChange();
    return true;
  }

  return {
    /** The dialog on screen: the most recent one still waiting. */
    pending(): DialogRequest | null {
      return [...pending.values()].at(-1)?.request ?? null;
    },
    ask(spec: DialogSpec, options: DialogOptions = {}): Promise<DialogAnswer> {
      if (disposed || options.signal?.aborted)
        return Promise.resolve(CANCELLED);
      counter += 1;
      const id = `d${String(counter)}`;
      const request: DialogRequest = {
        ...spec,
        id,
        ...(options.timeout === undefined
          ? {}
          : { expiresAt: Date.now() + options.timeout }),
      };
      return new Promise<DialogAnswer>((settle) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (answer: DialogAnswer) => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          settle(answer);
        };
        function abort(): void {
          resolve(id, CANCELLED);
        }
        pending.set(id, { request, settle: finish });
        if (options.timeout !== undefined) {
          timer = setTimeout(() => {
            resolve(id, CANCELLED);
          }, options.timeout);
          timer.unref?.();
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        onChange();
      });
    },
    /** False when the id is unknown: a stale tab answering a closed dialog. */
    answer(id: string, answer: DialogAnswer): boolean {
      return resolve(id, answer);
    },
    cancelAll(): void {
      for (const id of [...pending.keys()]) resolve(id, CANCELLED);
    },
    /** Session stop also cancels all future requests. */
    dispose(): void {
      disposed = true;
      for (const id of [...pending.keys()]) resolve(id, CANCELLED);
    },
  };
}

/** What a terminal component gives this process: full frames, not diffs. */
export type FrameComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
};

/** The frame of the custom UI that is on screen, if any. */
export type CustomFrame = { id: string; lines: string[] };

export type CustomUiHost = ReturnType<typeof createCustomUiHost>;

/** A frame that failed to render still says so rather than killing the turn. */
function renderFrame(component: FrameComponent, width: number): string[] {
  try {
    const lines = component.render(width);
    return Array.isArray(lines) ? lines : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`Extension custom UI render failed: ${message}`];
  }
}

/**
 * Custom extension UI: a terminal component rendered to text frames. As with
 * dialogs, several may be active and only the newest is shown.
 */
export function createCustomUiHost(onChange: () => void = () => {}) {
  const active = new Map<
    string,
    {
      component: FrameComponent;
      width: number;
      lines: string[];
      onClose: (() => void) | undefined;
    }
  >();
  let counter = 0;
  let disposed = false;

  function draw(id: string): void {
    const entry = active.get(id);
    if (!entry) return;
    entry.lines = renderFrame(entry.component, entry.width);
    onChange();
  }

  function close(id: string): void {
    const entry = active.get(id);
    if (!entry) return;
    active.delete(id);
    try {
      entry.component.dispose?.();
    } catch {
      // A component that throws on dispose is still gone.
    }
    entry.onClose?.();
    onChange();
  }

  return {
    frame(): CustomFrame | null {
      const id = [...active.keys()].at(-1);
      const entry = id === undefined ? undefined : active.get(id);
      return id === undefined || !entry ? null : { id, lines: entry.lines };
    },
    /**
     * Registers a component and draws its first frame. Returns its id.
     * `onClose` runs whenever the UI goes away, including a close the host
     * decides on (a failing keystroke, session stop), so the extension
     * waiting on it can be answered instead of left hanging.
     */
    open(
      component: FrameComponent,
      width: number,
      onClose?: () => void,
    ): string {
      counter += 1;
      const id = `c${String(counter)}`;
      if (disposed) {
        try {
          component.dispose?.();
        } catch {
          // Disposal failure must not leave the caller waiting.
        }
        onClose?.();
        return id;
      }
      active.set(id, { component, width, lines: [], onClose });
      draw(id);
      return id;
    },
    has(id: string): boolean {
      return active.has(id);
    },
    /** The component asked to be redrawn (`tui.requestRender()`). */
    redraw(id: string): void {
      draw(id);
    },
    /**
     * One keystroke or paste. Throws are the component's own failure: the UI
     * is closed rather than left in a state nobody can see.
     */
    input(id: string, data: string): { failed?: string } {
      const entry = active.get(id);
      if (!entry) return {};
      try {
        entry.component.handleInput?.(data);
      } catch (error) {
        close(id);
        return {
          failed: error instanceof Error ? error.message : String(error),
        };
      }
      draw(id);
      return {};
    },
    close,
    closeAll(): string[] {
      const ids = [...active.keys()];
      for (const id of ids) close(id);
      return ids;
    },
    /** Disposal is terminal, including opens attempted by a close callback. */
    dispose(): void {
      disposed = true;
      for (const id of [...active.keys()]) close(id);
    },
  };
}
