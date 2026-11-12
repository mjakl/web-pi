import { ModelSettings } from "@web/views/ModelSettings";
import { expect, it } from "vitest";
import { mount, byId } from "./helpers.ts";

it("filters rendered model rows by name, provider and ID without changing selections", async () => {
  const available = [
    {
      provider: "alpha",
      id: "same",
      name: "First model",
      contextWindow: 1000,
      reasoning: false,
    },
    {
      provider: "beta",
      id: "same",
      name: "Second model",
      contextWindow: 1000,
      reasoning: false,
    },
  ];
  mount(
    ModelSettings({
      cwd: "/repo",
      view: {
        available,
        selected: available.slice(0, 1),
        patterns: ["alpha/same"],
        projectPatterns: null,
        unavailable: [],
        warnings: [],
      },
    }),
  );
  const { setUpShell } = await import("@web/client/shell");
  setUpShell();
  const filter = byId("settings-model-filter") as HTMLInputElement;
  const rows = [
    ...document.querySelectorAll<HTMLElement>("[data-model-search]"),
  ];
  for (const [query, visible] of [
    [" BETA ", [false, true]],
    ["First", [true, false]],
    ["same", [true, true]],
    ["missing", [false, false]],
    ["", [true, true]],
  ] as const) {
    filter.value = query;
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows.map((row) => !row.hidden)).toEqual(visible);
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-model-provider]")]
        .filter((group) => !group.hidden)
        .map((group) => group.querySelector("h3")?.textContent),
    ).toEqual(
      visible.flatMap((shown, index) =>
        shown ? [["alpha", "beta"][index]] : [],
      ),
    );
    expect(
      document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
    ).toBe(!visible.every(Boolean));
    expect(
      document.querySelector<HTMLElement>("[data-model-empty]")?.hidden,
    ).toBe(visible.some(Boolean));
    expect(
      [
        ...document.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        ),
      ].map((input) => input.checked),
    ).toEqual([true, false]);
  }
  const first = document.querySelector<HTMLInputElement>('input[name="model"]');
  if (!first) throw new Error("Missing checkbox");
  first.checked = false;
  first.dispatchEvent(new Event("change", { bubbles: true }));
  expect(first.checked).toBe(true);
  expect(document.querySelector("[data-model-status]")?.textContent).toContain(
    "Keep at least one model selected",
  );

  filter.value = "Second";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  const second = rows[1]?.querySelector("input");
  if (!second) throw new Error("Missing second checkbox");
  second.checked = true;
  second.dispatchEvent(new Event("change", { bubbles: true }));
  expect(visibleGroups()).toEqual([
    { provider: "beta", models: ["Second model"] },
  ]);
  expect(
    document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
  ).toBe(true);

  filter.value = "First";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  first.checked = false;
  first.dispatchEvent(new Event("change", { bubbles: true }));
  expect(visibleGroups()).toEqual([
    { provider: "alpha", models: ["First model"] },
  ]);
  expect(
    document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
  ).toBe(true);
  filter.value = "";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  expect(visibleGroups()).toEqual([
    { provider: "beta", models: ["Second model"] },
    { provider: "alpha", models: ["First model"] },
  ]);
  expect(
    document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
  ).toBe(false);
});

function visibleGroups() {
  return [...document.querySelectorAll<HTMLElement>("[data-model-provider]")]
    .filter((group) => !group.hidden)
    .map((group) => ({
      provider: group.querySelector("h3")?.textContent,
      models: [...group.querySelectorAll<HTMLElement>(".settings-model-row")]
        .filter((row) => !row.hidden)
        .map((row) => row.querySelector("strong")?.textContent),
    }));
}

it("groups selected models first, sorting each section by displayed provider and model names", async () => {
  const available = [
    { provider: "OpenAI", id: "a", name: "Zulu" },
    { provider: "Anthropic", id: "z", name: "Alpha" },
    { provider: "OpenAI", id: "z", name: "Alpha" },
    { provider: "Anthropic", id: "a", name: "Zulu" },
    { provider: "OpenAI", id: "m", name: "Middle" },
    { provider: "Anthropic", id: "m", name: "Middle" },
  ].map((model) => ({ ...model, contextWindow: 1000, reasoning: false }));
  mount(
    ModelSettings({
      cwd: "/repo",
      view: {
        available,
        selected: available.slice(0, 4),
        patterns: ["custom"],
        projectPatterns: null,
        unavailable: [],
        warnings: [],
      },
    }),
  );
  const expected = [
    { provider: "Anthropic", models: ["Alpha", "Zulu"] },
    { provider: "OpenAI", models: ["Alpha", "Zulu"] },
    { provider: "Anthropic", models: ["Middle"] },
    { provider: "OpenAI", models: ["Middle"] },
  ];
  expect(visibleGroups()).toEqual(expected);
  const { setUpShell } = await import("@web/client/shell");
  setUpShell();
  const middle = [
    ...document.querySelectorAll<HTMLInputElement>('input[name="model"]'),
  ].find(
    (input) =>
      input.value === JSON.stringify({ provider: "Anthropic", id: "m" }),
  );
  if (!middle) throw new Error("Missing middle checkbox");
  middle.focus();
  middle.checked = true;
  middle.dispatchEvent(new Event("change", { bubbles: true }));
  expect(visibleGroups()).toEqual([
    { provider: "Anthropic", models: ["Alpha", "Middle", "Zulu"] },
    expected[1],
    expected[3],
  ]);
  expect(document.activeElement).toBe(middle);
  expect(middle.defaultChecked).toBe(false);
  expect(
    document.querySelector<HTMLButtonElement>("[data-model-refresh]")?.disabled,
  ).toBe(true);
  middle.checked = false;
  middle.dispatchEvent(new Event("change", { bubbles: true }));
  expect(visibleGroups()).toEqual(expected);
  expect(
    document.querySelector<HTMLButtonElement>("[data-model-refresh]")?.disabled,
  ).toBe(false);

  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="model"]:not(:checked)',
  )) {
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  expect(visibleGroups()).toEqual([
    { provider: "Anthropic", models: ["Alpha", "Middle", "Zulu"] },
    { provider: "OpenAI", models: ["Alpha", "Middle", "Zulu"] },
  ]);
  expect(
    document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
  ).toBe(true);
});

it.each([true, false])(
  "omits empty sections when all models have selected=%s",
  (selected) => {
    const model = {
      provider: "Only provider",
      id: "only",
      name: "Only model",
      contextWindow: 1000,
      reasoning: false,
    };
    mount(
      ModelSettings({
        cwd: "/repo",
        view: {
          available: [model],
          selected: selected ? [model] : [],
          patterns: ["custom"],
          projectPatterns: null,
          unavailable: [],
          warnings: [],
        },
      }),
    );
    expect(visibleGroups()).toEqual([
      { provider: "Only provider", models: ["Only model"] },
    ]);
    expect(
      [...document.querySelectorAll<HTMLElement>("[data-model-section]")]
        .filter((section) => !section.hidden)
        .map((section) => section.dataset["modelSection"]),
    ).toEqual([String(selected)]);
    expect(
      document.querySelector<HTMLElement>("[data-model-divider]")?.hidden,
    ).toBe(true);
  },
);
