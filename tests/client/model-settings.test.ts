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
});
