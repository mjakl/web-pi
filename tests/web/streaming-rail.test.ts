import { assistantEntry, userEntry } from "@adapters/fake/index";
import { expect, it } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";
import { streamingFixture } from "#/web/fixtures/streaming";

async function open(f: Awaited<ReturnType<typeof streamingFixture>>) {
  const subscribers = f.subscribers;
  const browser = await htmxBrowser(
    await (await f.app.request(`/sessions/${f.id}`)).text(),
    (request) =>
      new URL(request.url).pathname === "/events"
        ? new Response("")
        : f.app.request(request),
  );
  await expect.poll(() => f.subscribers).toBe(subscribers + 1);
  return browser;
}

function startPrompt(
  f: Awaited<ReturnType<typeof streamingFixture>>,
  id: string,
) {
  const snapshot = f.snapshot;
  const user = userEntry(id, snapshot.branch.at(-1)?.id ?? null, id);
  f.update(
    {
      branch: [...snapshot.branch, user],
      entries: [...snapshot.entries, user],
      turnStart: snapshot.branch.length,
      status: { ...snapshot.status, running: true },
    },
    "activity",
  );
}

it("shows the initial and next prompt before settlement, without replacing an unchanged rail", async () => {
  const f = await streamingFixture();
  const { document } = await open(f);
  expect(document.querySelectorAll(".minimap-row")).toHaveLength(0);
  startPrompt(f, "first-prompt");
  await expect
    .poll(() => document.querySelectorAll(".minimap-row").length)
    .toBe(1);
  expect(
    document.querySelector('[data-minimap-entry-id="first-prompt"]'),
  ).not.toBeNull();
  expect(document.querySelector("#messages")?.textContent).toBe("");
  expect(document.querySelector("#turn")?.textContent).toContain(
    "first-prompt",
  );
  // A direct load also renders a usable single mark.
  const fresh = await open(f);
  expect(fresh.document.querySelectorAll(".minimap-row")).toHaveLength(1);

  const rail = document.querySelector("#rail");
  const answer = assistantEntry(
    "first-answer",
    "first-prompt",
    "still streaming",
    100,
  );
  if (answer.type !== "message" || answer.message.role !== "assistant")
    throw new Error("Invalid assistant fixture");
  f.update({ partial: answer.message }, "activity");
  await expect
    .poll(() => document.querySelector("#turn")?.textContent)
    .toContain("still streaming");
  expect(document.querySelector("#rail")).toBe(rail);
  const branch = [...f.snapshot.branch, answer];
  f.update(
    {
      branch,
      entries: branch,
      partial: undefined,
      turnStart: branch.length,
      status: { ...f.snapshot.status, running: false },
    },
    "turn_done",
  );
  await expect
    .poll(() => document.querySelector("#messages")?.textContent)
    .toContain("still streaming");
  expect(document.querySelector("#rail")).toBe(rail);

  startPrompt(f, "next-prompt");
  await expect
    .poll(() => document.querySelectorAll(".minimap-row").length)
    .toBe(2);
  expect(
    document.querySelector('[data-minimap-entry-id="next-prompt"]'),
  ).not.toBeNull();
  expect(document.querySelector("#turn")?.textContent).toContain("next-prompt");
  expect(document.querySelector("#messages")?.textContent).not.toContain(
    "next-prompt",
  );
});

it("activates a new branch and enables hover expansion while its response is still running", async () => {
  const f = await streamingFixture();
  f.finish("shared answer", false);
  const shared = f.snapshot.branch;
  f.finish("old branch answer", false);
  // Navigation to the shared ancestor precedes submitting the forked prompt.
  f.update({ branch: shared, turnStart: shared.length });
  const { document, window } = await open(f);
  await expect
    .poll(() => document.querySelector("#rail")?.getAttribute("data-branched"))
    .toBe("false");
  const column = document.querySelector("#rail-column");
  if (!column) throw new Error("Missing rail column");
  startPrompt(f, "fork-prompt");
  await expect
    .poll(() => document.querySelector("#rail")?.getAttribute("data-branched"))
    .toBe("true");
  expect(document.querySelector("#rail-column")).toBe(column);
  expect(
    document.querySelector('[data-minimap-entry-id="fork-prompt"]'),
  ).not.toBeNull();
  expect(
    document
      .querySelector('[data-minimap-entry-id="u2"]')
      ?.getAttribute("data-branch"),
  ).toBe("true");
  expect(
    document.querySelector("#rail")?.getAttribute("data-graph-width"),
  ).toBe("72");
  expect(
    document.querySelector("#rail")?.getAttribute("data-strip-width"),
  ).toBe("36");
  column.dispatchEvent(new window.PointerEvent("pointerenter"));
  await expect.poll(() => column.classList.contains("is-expanded")).toBe(true);
  column.dispatchEvent(new window.PointerEvent("pointerleave"));
  expect(column.classList.contains("is-expanded")).toBe(false);
  expect(document.querySelector("#turn")?.textContent).toContain("fork-prompt");
  expect(document.querySelector("#messages")?.textContent).not.toContain(
    "fork-prompt",
  );
  expect(f.snapshot.status.running).toBe(true);
});
