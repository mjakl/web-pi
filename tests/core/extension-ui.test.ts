import {
  answerConfirmed,
  answerText,
  createCustomUiHost,
  createDialogHost,
  type FrameComponent,
} from "@core/extension-ui";
import { describe, expect, it, vi } from "vitest";

describe("dialog host", () => {
  it("shows the newest request and resolves the one that is answered", async () => {
    const host = createDialogHost();
    const first = host.ask({ method: "input", title: "First" });
    const second = host.ask({ method: "input", title: "Second" });
    const showing = host.pending();
    expect(showing?.title).toBe("Second");

    expect(host.answer(showing?.id ?? "", { value: "hi" })).toBe(true);
    expect(answerText(await second)).toBe("hi");
    // The first is still waiting, exactly as in pi-web.
    expect(host.pending()?.title).toBe("First");
    host.cancelAll();
    expect(answerText(await first)).toBeUndefined();
  });

  it("answers an unknown id with false and changes nothing", () => {
    const host = createDialogHost();
    void host.ask({ method: "confirm", title: "Sure?", message: "…" });
    expect(host.answer("nope", { confirmed: true })).toBe(false);
    expect(host.pending()?.title).toBe("Sure?");
  });

  it("resolves confirm as false when cancelled and select as undefined", async () => {
    const host = createDialogHost();
    const confirm = host.ask({ method: "confirm", title: "Push?" });
    host.answer(host.pending()?.id ?? "", { cancelled: true });
    expect(answerConfirmed(await confirm)).toBe(false);

    const select = host.ask({
      method: "select",
      title: "Pick",
      options: ["a"],
    });
    host.answer(host.pending()?.id ?? "", { cancelled: true });
    expect(answerText(await select)).toBeUndefined();
  });

  it("expires a request with a timeout and reports when it will", async () => {
    vi.useFakeTimers();
    try {
      const host = createDialogHost();
      const asked = host.ask(
        { method: "input", title: "Slow" },
        { timeout: 50 },
      );
      expect(host.pending()?.expiresAt).toBeGreaterThan(Date.now());
      vi.advanceTimersByTime(60);
      expect(answerText(await asked)).toBeUndefined();
      expect(host.pending()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles at once for a signal that already aborted", async () => {
    const host = createDialogHost();
    const controller = new AbortController();
    controller.abort();
    const answer = await host.ask(
      { method: "input", title: "Gone" },
      { signal: controller.signal },
    );
    expect(answerText(answer)).toBeUndefined();
    expect(host.pending()).toBeNull();
  });

  it("cancels a waiting request when its signal fires", async () => {
    const host = createDialogHost();
    const controller = new AbortController();
    const asked = host.ask(
      { method: "input", title: "Later" },
      { signal: controller.signal },
    );
    controller.abort();
    expect(answerText(await asked)).toBeUndefined();
    expect(host.pending()).toBeNull();
  });

  it("permanently cancels pending and future requests on disposal", async () => {
    const host = createDialogHost();
    const pending = host.ask({ method: "input", title: "Pending" });
    host.dispose();
    host.dispose();
    expect(answerText(await pending)).toBeUndefined();
    expect(
      answerConfirmed(await host.ask({ method: "confirm", title: "Late" })),
    ).toBe(false);
    expect(host.pending()).toBeNull();
  });

  it("reports every change so the session can re-render", () => {
    const changed = vi.fn();
    const host = createDialogHost(changed);
    void host.ask({ method: "input", title: "One" });
    expect(changed).toHaveBeenCalledTimes(1);
    host.answer(host.pending()?.id ?? "", { value: "" });
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

function counter(): FrameComponent & { count: number } {
  return {
    count: 0,
    render() {
      return [`count ${String(this.count)}`];
    },
    handleInput(data: string) {
      if (data === "+") this.count += 1;
    },
  };
}

describe("custom UI host", () => {
  it("draws a frame on open and again after input", () => {
    const host = createCustomUiHost();
    const id = host.open(counter(), 40);
    expect(host.frame()).toEqual({ id, lines: ["count 0"] });
    host.input(id, "+");
    expect(host.frame()?.lines).toEqual(["count 1"]);
  });

  it("ignores input for a closed UI and disposes on close", () => {
    const disposed = vi.fn();
    const host = createCustomUiHost();
    const id = host.open({ render: () => ["x"], dispose: disposed }, 40);
    host.close(id);
    expect(disposed).toHaveBeenCalledOnce();
    expect(host.frame()).toBeNull();
    expect(host.input(id, "+")).toEqual({});
  });

  it("closes a component whose input handler throws, and says why", () => {
    const host = createCustomUiHost();
    const closed = vi.fn();
    const id = host.open(
      {
        render: () => ["x"],
        handleInput() {
          throw new Error("boom");
        },
      },
      40,
      closed,
    );
    expect(host.input(id, "+")).toEqual({ failed: "boom" });
    expect(host.has(id)).toBe(false);
    // Whoever waits on the UI hears that the host closed it.
    expect(closed).toHaveBeenCalledOnce();
  });

  it("tells every open UI it was closed when all are closed at once", () => {
    const host = createCustomUiHost();
    const closed = vi.fn();
    host.open({ render: () => ["a"] }, 40, closed);
    host.open({ render: () => ["b"] }, 40, closed);
    expect(host.closeAll()).toHaveLength(2);
    expect(closed).toHaveBeenCalledTimes(2);
    expect(host.frame()).toBeNull();
  });

  it("disposes existing and late components without reopening", () => {
    const host = createCustomUiHost();
    const disposed = vi.fn();
    const closed = vi.fn();
    host.open({ render: () => ["pending"], dispose: disposed }, 40, closed);
    host.dispose();
    host.dispose();
    const id = host.open(
      { render: () => ["late"], dispose: disposed },
      40,
      closed,
    );
    expect(host.has(id)).toBe(false);
    expect(host.frame()).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("shows a failed render instead of losing the panel", () => {
    const host = createCustomUiHost();
    host.open(
      {
        render() {
          throw new Error("nope");
        },
      },
      40,
    );
    expect(host.frame()?.lines).toEqual([
      "Extension custom UI render failed: nope",
    ]);
  });

  it("shows the newest of several and closes them all at once", () => {
    const host = createCustomUiHost();
    host.open({ render: () => ["first"] }, 40);
    host.open({ render: () => ["second"] }, 40);
    expect(host.frame()?.lines).toEqual(["second"]);
    expect(host.closeAll()).toHaveLength(2);
    expect(host.frame()).toBeNull();
  });

  it("redraws when the component asks for it", () => {
    const host = createCustomUiHost();
    let value = 1;
    const id = host.open({ render: () => [String(value)] }, 40);
    value = 2;
    expect(host.frame()?.lines).toEqual(["1"]);
    host.redraw(id);
    expect(host.frame()?.lines).toEqual(["2"]);
  });
});
