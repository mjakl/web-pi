// Notices and editor text an extension leaves pending reach the page once,
// in the next live view, whatever other requests render meanwhile.

import type { HTMLDetailsElement, HTMLTextAreaElement } from "happy-dom";
import { expect, it } from "vitest";
import { required } from "#/web/helpers";
import { open, openDetails, streamingFixture } from "#/web/fixtures/streaming";

it.each(["decoration", "models"] as const)(
  "captures pending events before awaited %s and delivers later events in the next live view",
  async (phase) => {
    const f = await streamingFixture();
    const { document, firstFrame } = await open(f);
    await expect.poll(() => f.subscribers).toBe(1);
    // Only the next render may meet the blocked step, not the initial one.
    await firstFrame;

    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let block = true;
    const pause = async () => {
      if (block) {
        block = false;
        entered.resolve(undefined);
        await release.promise;
      }
    };
    if (phase === "decoration") {
      const resolve = f.world.projects.resolve.bind(f.world.projects);
      f.world.projects.resolve = async (cwd) => {
        await pause();
        return resolve(cwd);
      };
    } else {
      const list = f.world.models.list.bind(f.world.models);
      f.world.models.list = async (cwd) => {
        await pause();
        return list(cwd);
      };
    }

    f.resetSnapshotReads();
    f.injectPending("first pending notice", "first pending text");
    f.emit("activity");
    await entered.promise;
    f.injectPending("second pending notice", "second pending text");
    release.resolve(undefined);

    await expect
      .poll(() => document.body.textContent)
      .toContain("first pending notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("first pending text");
    expect(document.body.textContent).not.toContain("second pending notice");
    expect(
      document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
    ).not.toContain("second pending text");
    expect(f.snapshotReads).toBe(1);

    f.resetSnapshotReads();
    f.emit("activity");
    await expect
      .poll(() => document.body.textContent)
      .toContain("second pending notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("second pending text");
    expect(
      document.body.textContent?.match(/first pending notice/g),
    ).toHaveLength(1);
    expect(f.snapshotReads).toBe(1);
  },
);

it("does not consume pending events while rendering an alternate live branch", async () => {
  const f = await streamingFixture();
  const alternate = f.alternateCompletedTools();
  f.injectPending("pending branch notice", "pending branch text");

  const response = await f.app.request(
    `/sessions/${f.id}?leaf=${alternate.leaf}`,
  );
  expect(response.status).toBe(200);
  expect(f.snapshot.status.notices).toContainEqual({
    level: "info",
    message: "pending branch notice",
  });
  expect(f.snapshot.status.editorText).toEqual(["pending branch text"]);
});

it.each(["refresh", "switch", "page"])(
  "preserves pending output through a %s request until the next SSE delivery",
  async (action) => {
    const f = await streamingFixture();
    const { document } = await open(f);
    await expect.poll(() => f.subscribers).toBe(1);
    f.injectPending("selector-safe notice", "selector-safe text");

    const model = required(f.snapshot.status.model);
    const response =
      action === "page"
        ? await f.app.request(`/sessions/${f.id}`)
        : action === "refresh"
          ? await f.app.request(`/sessions/${f.id}/model-selector`)
          : await f.app.request(
              `/sessions/${f.id}/model?model=${encodeURIComponent(`${model.provider}/${model.id}`)}`,
              { method: "POST" },
            );
    expect(response.status).toBe(200);
    const selector = await response.text();
    expect(selector).toContain('id="model-selector"');
    expect(selector).not.toContain("selector-safe notice");
    expect(selector).not.toContain("selector-safe text");
    expect(f.snapshot.status.notices).toContainEqual({
      level: "info",
      message: "selector-safe notice",
    });
    expect(f.snapshot.status.editorText).toEqual(["selector-safe text"]);

    f.emit("activity");
    await expect
      .poll(() => document.body.textContent)
      .toContain("selector-safe notice");
    await expect
      .poll(
        () =>
          document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
      )
      .toContain("selector-safe text");
    expect(f.snapshot.status.notices).toEqual([]);
    expect(f.snapshot.status.editorText).toEqual([]);
  },
);

it("leaves pending events for the live view after a deferred body request", async () => {
  const f = await streamingFixture();
  f.richRunningTools();
  const { document } = await open(f);
  await expect.poll(() => f.subscribers).toBe(1);
  f.injectPending("body-safe notice", "body-safe text");

  openDetails(
    required(
      document.querySelector<HTMLDetailsElement>("#tool-call-rich-ordinary"),
    ),
  );
  await expect
    .poll(() => document.body.textContent)
    .toContain("ordinary-output-body:");
  expect(f.snapshot.status.notices).toContainEqual({
    level: "info",
    message: "body-safe notice",
  });
  expect(f.snapshot.status.editorText).toEqual(["body-safe text"]);

  f.emit("activity");
  await expect
    .poll(() => document.body.textContent)
    .toContain("body-safe notice");
  await expect
    .poll(
      () =>
        document.querySelector<HTMLTextAreaElement>("#composer-text")?.value,
    )
    .toContain("body-safe text");
});
