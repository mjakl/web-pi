import { createFakeWorld } from "@adapters/fake/index";
import { formatContextUsage } from "@core/context-usage";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { htmxBrowser } from "#/web/htmx4-browser";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness, next, reply } from "./pi-harness.ts";

let h: Harness | undefined;
let browser: Awaited<ReturnType<typeof htmxBrowser>> | undefined;
afterEach(async () => {
  await browser?.close();
  await h?.dispose();
});

it("replaces pre-compaction usage with the rebuilt context estimate, including after reopening", async () => {
  h = await createHarness({
    settings: {
      compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 20 },
    },
  });
  const workspace = createWorkspace({
    ...createFakeWorld(),
    runtime: h.runtime,
    sessions: h.catalog,
  });
  let session = await h.open();
  const currentView = async () => {
    const view = await workspace.viewSession(session.id);
    if (!view) throw new Error("Missing session view");
    return view;
  };
  for (const text of ["one", "two", "three"]) {
    h.script(reply(`${text} answer `.repeat(20), { input: 2500, output: 100 }));
    const done = next(session, "turn_done");
    await session.prompt(text);
    await done;
  }
  expect((await currentView()).usage.tokens).toBe(2600);
  const app = createWebApp({
    workspace,
    defaultCwd: h.cwd,
    staticRoot: "static",
  });
  const page = async () =>
    (await app.request(`/sessions/${session.id}`)).text();
  browser = await htmxBrowser(await page(), (request) =>
    new URL(request.url).pathname === "/events"
      ? new Response("")
      : app.request(request),
  );
  const readout = () =>
    browser?.document.querySelector("#context-readout")?.textContent;
  expect(readout()).toContain("3k / 4k (65%)");
  h.script(reply("Summary of earlier work"));
  await session.compact();
  const view = await currentView();
  const card = [...view.items, ...view.turn].find(
    (item) => item.kind === "compaction",
  );
  if (card?.kind !== "compaction") throw new Error("Missing compaction card");
  expect(card.tokensAfter).toBeGreaterThan(0);
  expect(card.tokensAfter).toBeLessThan(2600);
  expect(view.usage.tokens).toBe(card.tokensAfter);
  expect(view.usage.estimated).toBe(true);
  expect(view.status?.compaction?.tokensAfter).toBe(card.tokensAfter);
  await expect.poll(readout).toContain(formatContextUsage(view.usage));
  expect(await page()).toContain(formatContextUsage(view.usage));

  await session.stop();
  expect((await currentView()).usage.tokens).toBeNull();
  session = await h.open({ sessionId: session.id });
  const reopened = await currentView();
  expect(reopened.usage).toEqual(view.usage);
  expect(reopened.tokens).toEqual(view.tokens);
  expect(reopened.status?.compaction).toBeNull();

  // A response without usage must not resurrect retained assistants' counts.
  h.script(reply("Unmetered answer"));
  const unmetered = next(session, "turn_done");
  await session.prompt("New context ".repeat(40));
  await unmetered;
  const grown = await currentView();
  expect(grown.usage.estimated).toBe(true);
  expect(grown.usage.tokens).toBeGreaterThan(view.usage.tokens ?? 0);
  expect(grown.usage.tokens).toBeLessThan(2600);

  h.script(reply("Next answer", { input: 80, output: 4 }));
  const done = next(session, "turn_done");
  await session.prompt("four");
  await done;
  expect((await currentView()).usage).toMatchObject({
    tokens: 84,
    estimated: false,
  });
});
