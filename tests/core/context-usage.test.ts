import { contextUsage } from "@core/context-usage";
import { describe, expect, it } from "vitest";

describe("contextUsage", () => {
  it("derives percent and level from one formula", () => {
    expect(
      contextUsage({ tokens: 50_000, contextWindow: 100_000 }),
    ).toMatchObject({
      percent: 50,
      level: "ok",
    });
    // pi-web has no yellow percentage: 65 % of the window is still plain
    // while the count sits under the reader's own token threshold.
    expect(contextUsage({ tokens: 65_000, contextWindow: 100_000 }).level).toBe(
      "ok",
    );
    expect(contextUsage({ tokens: 74_000, contextWindow: 100_000 }).level).toBe(
      "ok",
    );
    expect(contextUsage({ tokens: 75_000, contextWindow: 100_000 }).level).toBe(
      "critical",
    );
  });

  it("reports unknown instead of guessing", () => {
    expect(
      contextUsage({ tokens: null, contextWindow: 100_000 }),
    ).toMatchObject({
      percent: null,
      level: "unknown",
    });
    expect(
      contextUsage({ tokens: 10, contextWindow: 0 }).contextWindow,
    ).toBeNull();
  });
});

describe("the reader's own token threshold", () => {
  it("warns once the count passes it, whatever the window says", () => {
    const big = { tokens: 120_000, contextWindow: 1_000_000 };
    // 12 % of a huge window, but past the point where answers get worse.
    expect(contextUsage(big).level).toBe("warn");
    expect(contextUsage({ ...big, warnTokens: 200_000 }).level).toBe("ok");
    // The red percentage still wins where it is stricter.
    expect(
      contextUsage({
        tokens: 80_000,
        contextWindow: 100_000,
        warnTokens: 200_000,
      }).level,
    ).toBe("critical");
  });
});
