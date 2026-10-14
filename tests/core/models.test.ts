import { initialModel, initialThinking, startupWrites } from "@core/models";
import type { ModelOption } from "@core/ports";
import { describe, expect, it } from "vitest";

const model = (provider: string, id: string, pin?: "high"): ModelOption => ({
  provider,
  id,
  name: id,
  contextWindow: 1000,
  reasoning: true,
  ...(pin === undefined ? {} : { pin }),
});

const scope = [model("anthropic", "sonnet"), model("openai", "gpt", "high")];

describe("the model a new session starts on", () => {
  it("takes the configured default when it is still in scope", () => {
    expect(initialModel(scope, { provider: "openai", id: "gpt" })?.id).toBe(
      "gpt",
    );
  });

  it("falls back to the first scoped model when the default dropped out", () => {
    expect(initialModel(scope, { provider: "gone", id: "x" })?.id).toBe(
      "sonnet",
    );
    expect(initialModel(scope)?.id).toBe("sonnet");
  });

  it("has nothing to offer when the scope is empty", () => {
    expect(initialModel([], { provider: "a", id: "b" })).toBeUndefined();
  });

  it("starts at the level an enabledModels pattern pinned", () => {
    expect(initialThinking(scope[1])).toBe("high");
    expect(initialThinking(scope[0])).toBeUndefined();
    expect(initialThinking(undefined)).toBeUndefined();
  });
});

describe("which startup choices become Pi's defaults", () => {
  const effective = {
    model: { provider: "openai", id: "gpt" },
    thinkingLevel: "high" as const,
    supportsThinking: true,
  };

  it("writes nothing when the reader picked nothing", () => {
    expect(startupWrites({}, effective)).toEqual({});
  });

  it("writes the model only when the session really started on it", () => {
    expect(
      startupWrites({ model: { provider: "openai", id: "gpt" } }, effective),
    ).toEqual({ model: { provider: "openai", id: "gpt" } });
    // A silent fallback must not become the new default.
    expect(
      startupWrites({ model: { provider: "openai", id: "o3" } }, effective),
    ).toEqual({});
  });

  it("writes the level Pi settled on, not the one that was asked for", () => {
    expect(startupWrites({ thinkingLevel: "max" }, effective)).toEqual({
      thinkingLevel: "high",
    });
  });

  it("drops a level clamped to off on a model that cannot reason", () => {
    expect(
      startupWrites(
        { thinkingLevel: "high" },
        { ...effective, thinkingLevel: "off", supportsThinking: false },
      ),
    ).toEqual({});
  });

  it("keeps an explicit off on a model that can reason", () => {
    expect(
      startupWrites(
        { thinkingLevel: "off" },
        { ...effective, thinkingLevel: "off" },
      ),
    ).toEqual({ thinkingLevel: "off" });
  });
});
