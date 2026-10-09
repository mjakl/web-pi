import {
  createPushSuppression,
  PUSH_PRESENCE_LEASE_MS,
} from "@core/push-suppression";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

describe("push suppression", () => {
  it("checks availability without claiming and rechecks foreground when claiming", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const suppression = createPushSuppression({ consumed: false, persist });
    expect(suppression.available()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    suppression.report({ clientId: "page", sequence: 1, foreground: true });
    expect(suppression.claim()).toBe(false);
    vi.advanceTimersByTime(PUSH_PRESENCE_LEASE_MS - 1);
    expect(suppression.available()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(suppression.claim()).toBe(true);
    expect(persist).toHaveBeenCalledExactlyOnceWith(true);
    expect(suppression.available()).toBe(false);
    expect(suppression.claim()).toBe(false);
  });

  it("cancels on accepted foreground before failed durable rearming, but not stale reports", () => {
    const onForeground = vi.fn();
    const persist = vi.fn().mockImplementation(() => {
      throw new Error("storage failed");
    });
    const suppression = createPushSuppression({
      consumed: true,
      persist,
      onForeground,
    });
    suppression.report({ clientId: "page", sequence: 2, foreground: false });
    suppression.report({ clientId: "page", sequence: 1, foreground: true });
    suppression.report({ clientId: "page", sequence: 2, foreground: true });
    expect(onForeground).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(() => {
      suppression.report({ clientId: "page", sequence: 3, foreground: true });
    }).toThrow("storage failed");
    expect(onForeground).toHaveBeenCalledOnce();
    expect(suppression.available()).toBe(false);
    suppression.report({ clientId: "page", sequence: 4, foreground: false });
    expect(suppression.claim()).toBe(false);
    persist.mockImplementation(() => {});
    suppression.report({ clientId: "page", sequence: 5, foreground: true });
    suppression.report({ clientId: "page", sequence: 6, foreground: false });
    expect(suppression.claim()).toBe(true);
  });
});
