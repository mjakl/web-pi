import { createWatcher } from "@adapters/fs/watch";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The viewer's live indicator against a real directory. "Nothing else
// arrived" is only asserted once a later change has been seen, so the
// watcher has demonstrably caught up with everything before it.

let dir = "";
let target = "";
let failures = 0;
const stops: (() => void)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "web-pi-watch-"));
  target = join(dir, "target.txt");
  await writeFile(target, "one");
  failures = 0;
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  await rm(dir, { recursive: true, force: true });
  expect(failures).toBe(0);
});

function watch() {
  const changes: { mtime: number; size: number }[] = [];
  const stop = createWatcher().watch(target, {
    change(info) {
      changes.push(info);
    },
    error() {
      failures += 1;
    },
  });
  stops.push(stop);
  return { changes, stop };
}

/** An editor's save: write a sibling, then rename it over the target. */
async function save(content: string): Promise<void> {
  const temporary = join(dir, ".target.txt.tmp");
  await writeFile(temporary, content);
  await rename(temporary, target);
}

async function seen(changes: unknown[], count: number): Promise<void> {
  await expect.poll(() => changes.length, { timeout: 5_000 }).toBe(count);
}

describe("file watcher", () => {
  it("reports a save that renames over the file exactly once", async () => {
    const { changes } = watch();
    await save("two");
    await seen(changes, 1);
    expect(changes[0]?.size).toBe(3);
    await unlink(target);
    await seen(changes, 2);
    expect(changes[1]?.size).toBe(0);
  });

  it("reports a deleted file once", async () => {
    const { changes } = watch();
    await unlink(target);
    await seen(changes, 1);
    expect(changes[0]?.size).toBe(0);
    await save("back");
    await seen(changes, 2);
    expect(changes[1]?.size).toBe(4);
  });

  it("reports nothing for a file written beside it", async () => {
    const { changes } = watch();
    await writeFile(join(dir, "sibling.txt"), "a");
    await writeFile(join(dir, "sibling.txt"), "ab");
    await save("two");
    await seen(changes, 1);
    expect(changes[0]?.size).toBe(3);
  });

  it("reports nothing once disposed", async () => {
    const disposed = watch();
    const witness = watch();
    disposed.stop();
    await save("two");
    await seen(witness.changes, 1);
    expect(disposed.changes).toEqual([]);
  });
});
