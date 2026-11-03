import { createUploadStore } from "@adapters/fs/uploads";
import { required } from "#/web/helpers";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "web-pi-uploads-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const data = new Uint8Array([0, 255, 13, 10, 128]);

describe("persistent upload store", () => {
  it("stores exact private bytes at safe unique paths, also across store recreation", async () => {
    const files = [
      { name: "../../escape.pdf", data },
      { name: "C:\\folder\\escape.pdf", data },
      { name: "escape.pdf", data },
      { name: 'bad\n"$(touch owned).zip', data },
      { name: ".".repeat(300), data: new Uint8Array() },
    ];
    const first = await createUploadStore(root).save(files);
    const second = await createUploadStore(root).save(files);
    expect(new Set([...first, ...second]).size).toBe(10);
    for (const [index, path] of first.entries()) {
      expect(relative(join(root, "web-pi/uploads"), path)).not.toMatch(/^\.\./);
      expect(basename(path)).toMatch(/^\d+-[a-zA-Z0-9._-]+$/);
      expect(basename(path).length).toBeLessThan(190);
      expect(await fs.readFile(path)).toEqual(
        Buffer.from(required(files[index]).data),
      );
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    expect((await fs.stat(join(root, "web-pi"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(root, "web-pi/uploads"))).mode & 0o777).toBe(
      0o700,
    );
    expect(await fs.readFile(required(first[0]))).toEqual(Buffer.from(data));
  });

  it("removes an unpublished partial batch when a later write fails", async () => {
    const { writeFile } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.writeFile)
      .mockImplementationOnce(writeFile)
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(
      createUploadStore(root).save([
        { name: "first.txt", data },
        { name: "second.txt", data },
      ]),
    ).rejects.toThrow("Cannot save attachments");
    expect(await fs.readdir(join(root, "web-pi/uploads"))).toEqual([]);
  });

  it("refuses out-of-budget batches before creating storage", async () => {
    const store = createUploadStore(root);
    await expect(
      store.save(Array.from({ length: 11 }, () => ({ name: "x", data }))),
    ).rejects.toThrow("10 attachments");
    await expect(
      store.save([{ name: "x", data: new Uint8Array(10 * 1024 * 1024 + 1) }]),
    ).rejects.toThrow("10 MiB");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports storage errors rather than pretending files were attached", async () => {
    await fs.writeFile(join(root, "web-pi"), "not a directory");
    await expect(
      createUploadStore(root).save([{ name: "x", data }]),
    ).rejects.toThrow("Cannot save attachments");
    expect(await fs.readFile(join(root, "web-pi"), "utf8")).toBe(
      "not a directory",
    );
  });
});
