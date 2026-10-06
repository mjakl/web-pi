import { createExtensionUi } from "@adapters/pi/extension-ui";
import type { FrameComponent } from "@core/extension-ui";
import { describe, expect, it, vi } from "vitest";
import { gate } from "./pi-harness.ts";

function createUi() {
  const sink = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWidget: vi.fn(),
    setTitle: vi.fn(),
    insertEditorText: vi.fn(),
    changed: vi.fn(),
  };
  return { ui: createExtensionUi(sink), sink };
}

describe("extension UI lifetime", () => {
  it("cancels every dialog method and refuses factories after disposal", async () => {
    const { ui, sink } = createUi();
    const pending = ui.context.input("Pending");
    ui.dispose();
    ui.resetForReload();
    const factory = vi.fn();
    expect(await pending).toBeUndefined();
    expect(await ui.context.select("Late", ["one"])).toBeUndefined();
    expect(await ui.context.confirm("Late", "Continue?")).toBe(false);
    expect(await ui.context.input("Late")).toBeUndefined();
    expect(await ui.context.editor("Late", "draft")).toBeUndefined();
    expect(await ui.context.custom(factory)).toBeUndefined();
    ui.context.setWidget("late", factory);
    ui.context.setWidget("late", ["text"]);
    ui.context.setStatus("late", "text");
    ui.context.notify("late");
    ui.context.setEditorText("late");
    ui.context.setTitle("late");
    expect(factory).not.toHaveBeenCalled();
    expect(ui.dialog()).toBeNull();
    expect(ui.frame()).toBeNull();
    expect(sink.setWidget).not.toHaveBeenCalled();
    expect(sink.setStatus).not.toHaveBeenCalled();
    expect(sink.notify).not.toHaveBeenCalled();
    expect(sink.insertEditorText).not.toHaveBeenCalled();
    expect(sink.setTitle).not.toHaveBeenCalled();
  });

  it("settles an admitted custom request before its asynchronous factory returns", async () => {
    const { ui } = createUi();
    const entered = gate();
    const factoryResult = Promise.withResolvers<
      FrameComponent & { invalidate(): void }
    >();
    const disposed = gate();
    const pending = ui.context.custom(() => {
      entered.open();
      return factoryResult.promise;
    });
    await entered.wait;
    ui.dispose();
    expect(await pending).toBeUndefined();
    factoryResult.resolve({
      render: () => ["late"],
      invalidate() {},
      dispose: () => {
        disposed.open();
      },
    });
    await disposed.wait;
    expect(ui.frame()).toBeNull();
  });

  it("does not invoke a scheduled factory if disposed before it starts", async () => {
    const { ui } = createUi();
    const factory = vi.fn(() => ({ render: () => ["late"], invalidate() {} }));
    const pending = ui.context.custom(factory);
    ui.dispose();
    expect(await pending).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not start a replacement widget if disposing the old one closes UI", () => {
    const { ui } = createUi();
    ui.context.setWidget("clock", () => ({
      render: () => ["tick"],
      invalidate() {},
      dispose: () => {
        ui.dispose();
      },
    }));
    const replacement = vi.fn(() => ({
      render: () => ["late"],
      invalidate() {},
    }));
    ui.context.setWidget("clock", replacement);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("disposes visible widget and custom components exactly once", async () => {
    const { ui } = createUi();
    const widgetDisposed = vi.fn();
    const customDisposed = vi.fn();
    ui.context.setWidget("clock", () => ({
      render: () => ["tick"],
      invalidate() {},
      dispose: widgetDisposed,
    }));
    const pending = ui.context.custom(() => ({
      render: () => ["frame"],
      invalidate() {},
      dispose: customDisposed,
    }));
    await vi.waitFor(() => {
      expect(ui.frame()).not.toBeNull();
    });
    ui.dispose();
    ui.dispose();
    expect(await pending).toBeUndefined();
    expect(widgetDisposed).toHaveBeenCalledOnce();
    expect(customDisposed).toHaveBeenCalledOnce();
    expect(ui.frame()).toBeNull();
  });
});
