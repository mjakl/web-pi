import type { HTMLButtonElement } from "happy-dom";
import { expect, it, vi } from "vitest";
import { required } from "#/web/helpers";
import { open, streamingFixture } from "#/web/fixtures/streaming";

it("updates history actions on existing and paginated messages as the session becomes idle and busy", async () => {
  const f = await streamingFixture();
  for (let turn = 1; turn <= 40; turn += 1)
    f.finish(`Answer ${String(turn)}`, false);
  f.agentRun([]);
  const { document, window, requests, firstFrame } = await open(f);
  await firstFrame;
  const log = required(document.querySelector("#log"));
  const recent = required(document.querySelector("#entry-u40"));
  expect(document.querySelector("#entry-u1")).toBeNull();
  const earlier = required(
    document.querySelector(".load-earlier")?.getAttribute("hx-get"),
  );
  await window.eval(
    `htmx.ajax('GET', ${JSON.stringify(earlier)}, {target:'.load-earlier', swap:'outerHTML'})`,
  );
  const oldest = required(document.querySelector("#entry-u1"));
  const rewind = (id: string) =>
    document.querySelector<HTMLButtonElement>(`#entry-${id} .message-rewind`);
  const branches = () => [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[aria-label="New branch"]',
    ),
  ];
  const expectBusy = () => {
    for (const id of ["u1", "u40"]) {
      expect(rewind(id) === null || rewind(id)?.hidden).toBe(true);
    }
    expect(branches().every((button) => button.disabled)).toBe(true);
    expect(
      branches().every((button) => button.title.includes("Wait for")),
    ).toBe(true);
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>('[hx-post$="/fork"]'),
      ].every((button) => !button.disabled),
    ).toBe(true);
  };
  expectBusy();

  const branch = f.snapshot.branch;
  f.update(
    {
      turnStart: branch.length,
      partial: undefined,
      status: { ...f.snapshot.status, running: false },
    },
    "turn_done",
  );
  await expect.poll(() => rewind("u1")?.hidden).toBe(false);
  for (const id of ["u1", "u40", "run-user"]) {
    const button = required(rewind(id));
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("hx-confirm")).toBe(
      "Remove this message and all later history?",
    );
    expect(JSON.parse(required(button.getAttribute("hx-vals")))).toEqual({
      entryId: id,
    });
  }
  expect(branches().every((button) => !button.disabled)).toBe(true);
  expect(
    branches().every((button) => button.title.startsWith("New branch")),
  ).toBe(true);
  expect(document.querySelector("#entry-u1")).toBe(oldest);
  expect(document.querySelector("#entry-u40")).toBe(recent);
  expect(document.querySelector("#log")).toBe(log);

  const confirm = vi.fn(() => false);
  Object.assign(window, { confirm });
  required(rewind("u1")).click();
  await expect.poll(() => confirm.mock.calls.length).toBe(1);
  expect(confirm).toHaveBeenCalledWith(
    "Remove this message and all later history?",
  );
  expect(
    requests.some((request) =>
      new URL(request.url).pathname.endsWith("/rewind"),
    ),
  ).toBe(false);

  for (const flag of ["running", "bashRunning", "compacting"] as const) {
    f.update({ status: { ...f.snapshot.status, [flag]: true } }, "activity");
    await expect.poll(() => rewind("u1")?.hidden).toBe(true);
    expectBusy();
    expect(rewind("u1")?.disabled).toBe(true);
    f.update({ status: { ...f.snapshot.status, [flag]: false } }, "activity");
    await expect.poll(() => rewind("u1")?.hidden).toBe(false);
    expect(rewind("u1")?.disabled).toBe(false);
  }
});
