import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadStore } from "@adapters/fs/uploads";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_REQUEST_BYTES,
} from "@core/composer";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testApp } from "#/web/fixtures/test-app";
import { required } from "#/web/helpers";

function upload(name = "notes.txt", content = "private file contents") {
  return new File([content], name, { type: "text/plain" });
}

function form(files: File[], text = "") {
  const body = new FormData();
  body.set("text", text);
  for (const file of files) body.append("attachments[]", file);
  return body;
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "web-pi-attachment-route-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const result = testApp();
  result.world.uploads = createUploadStore(root);
  return result;
}
const pathFrom = (text: string) =>
  required(text.split("\n").at(-1)).replace(/^`+|`+$/g, "");

describe("composer file uploads", () => {
  it("sends file-only messages as server paths, never inline file contents", async () => {
    const { app, world } = fixture();
    const live = await world.runtime.open({ sessionId: "s1" });
    const prompt = vi.spyOn(live, "prompt").mockResolvedValue(undefined);
    const response = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form([upload()]),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
    expect(prompt).toHaveBeenCalledOnce();
    const [text, input] = required(prompt.mock.calls[0]);
    expect(text).toContain("/1-notes.txt");
    expect(text).not.toContain("private file contents");
    expect(input?.images).toEqual([]);
    expect(input).not.toHaveProperty("files");
    expect(await readFile(pathFrom(text), "utf8")).toBe(
      "private file contents",
    );
  });

  it("keeps native images alongside opaque files and typed text", async () => {
    const { app, world } = fixture();
    const live = await world.runtime.open({ sessionId: "s1" });
    const prompt = vi.spyOn(live, "prompt").mockResolvedValue(undefined);
    const response = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form(
        [
          new File([new Uint8Array([0, 128, 255])], "shot.png", {
            type: "image/png",
          }),
          upload("archive.zip"),
        ],
        "Investigate these",
      ),
    });
    expect(response.status).toBe(204);
    const [text, input] = required(prompt.mock.calls[0]);
    expect(text).toMatch(/^Investigate these\n\nAttached files/);
    expect(input?.images).toEqual([{ data: "AID/", mimeType: "image/png" }]);
    expect(await readFile(pathFrom(text), "utf8")).toBe(
      "private file contents",
    );
  });

  it("keeps paths usable after stopping, reopening, and cloning a saved session", async () => {
    const { app, world, workspace } = fixture();
    const response = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form([upload()]),
    });
    expect(response.status).toBe(204);
    await expect
      .poll(() => world.runtime.get("s1")?.snapshot().status.running)
      .toBe(false);
    await required(world.runtime.get("s1")).stop();
    const reopened = await world.runtime.open({ sessionId: "s1" });
    const message = reopened
      .snapshot()
      .entries.findLast(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    if (message?.type !== "message" || message.message.role !== "user")
      throw new Error("Missing saved user message");
    const text = message.message.content;
    if (typeof text !== "string")
      throw new Error("Expected a path-only text message");
    const path = pathFrom(text);
    expect(await readFile(path, "utf8")).toBe("private file contents");
    const accessible = await workspace.fileBytes("s1", path);
    expect(await new Response(accessible.open()).text()).toBe(
      "private file contents",
    );
    await expect(
      workspace.fileTree({ sessionId: "s1" }, { path: dirname(path) }),
    ).rejects.toThrow("Access denied");
    const unreferenced = required(
      (
        await world.uploads.save([
          { name: "private.txt", data: new Uint8Array([1]) },
        ])
      )[0],
    );
    await expect(workspace.fileBytes("s1", unreferenced)).rejects.toThrow(
      "Access denied",
    );
    const cloneId = await workspace.clone("s1");
    expect(JSON.stringify(world.store.get(cloneId)?.entries)).toContain(path);
    expect(await readFile(path, "utf8")).toBe("private file contents");
  });

  it("accepts an empty file and a file at the byte limit on a new session", async () => {
    const { app, world } = fixture();
    const body = form([
      upload("empty.txt", ""),
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "full.bin"),
    ]);
    body.set("cwd", "/repo");
    const response = await app.request("/sessions", { method: "POST", body });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sessions/new-1");
    expect(JSON.stringify(world.store.get("new-1")?.entries)).toContain(
      "2-full.bin",
    );
  });

  it.each(["count", "size", "field"])(
    "rejects invalid %s without writing files or prompting",
    async (kind) => {
      const { app, world } = fixture();
      const save = vi.spyOn(world.uploads, "save");
      const open = vi.spyOn(world.runtime, "open");
      const body =
        kind === "count"
          ? form(Array.from({ length: 10 }, () => upload()))
          : kind === "size"
            ? form([
                new File(
                  [new Uint8Array(MAX_ATTACHMENT_BYTES + 1)],
                  "large.bin",
                ),
              ])
            : form([]);
      if (kind === "count")
        body.append(
          "images[]",
          new File(["x"], "shot.png", { type: "image/png" }),
        );
      if (kind === "field") body.set("attachments[]", "/etc/passwd");
      const response = await app.request("/sessions/s1/prompt", {
        method: "POST",
        body,
      });
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toMatch(
        /10 attachments|10 MiB|Invalid attachment/,
      );
      expect(save).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    },
  );

  it.each([undefined, "1", "invalid"])(
    "bounds streamed bytes even with Content-Length=%s",
    async (length) => {
      const { app, world } = fixture();
      const save = vi.spyOn(world.uploads, "save");
      const headers = new Headers({
        "Content-Type": "multipart/form-data; boundary=test",
      });
      if (length !== undefined) headers.set("Content-Length", length);
      let sent = 0;
      const chunk = new Uint8Array(1024 * 1024);
      const body = new ReadableStream({
        pull(controller) {
          sent += chunk.length;
          controller.enqueue(chunk);
          if (sent > MAX_ATTACHMENT_REQUEST_BYTES + chunk.length)
            controller.close();
        },
      });
      const response = await app.request(
        new Request("http://localhost/sessions/s1/prompt", {
          method: "POST",
          headers,
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.headers.get("HX-Trigger")).toContain("101 MiB");
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed multipart and local-only commands with attachments", async () => {
    const { app, world } = fixture();
    const save = vi.spyOn(world.uploads, "save");
    for (const request of [
      {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=broken" },
        body: "broken",
      },
      { method: "POST", body: form([upload()], "!!do-not-run") },
    ]) {
      const response = await app.request("/sessions/s1/prompt", request);
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toMatch(
        /Cannot read|local-only/,
      );
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("does not prompt after a storage failure, but retains files after ambiguous dispatch failure", async () => {
    const { app, world } = fixture();
    const live = await world.runtime.open({ sessionId: "s1" });
    const prompt = vi
      .spyOn(live, "prompt")
      .mockRejectedValue(new Error("Prompt failed"));
    const save = vi
      .spyOn(world.uploads, "save")
      .mockRejectedValueOnce(new Error("Disk full"));
    const failedSave = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form([upload()]),
    });
    expect(failedSave.headers.get("X-Web-Pi-Submission")).toBeNull();
    expect(failedSave.headers.get("HX-Trigger")).toContain("Disk full");
    expect(prompt).not.toHaveBeenCalled();
    const failedPrompt = await app.request("/sessions/s1/prompt", {
      method: "POST",
      body: form([upload()]),
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(failedPrompt.headers.get("X-Web-Pi-Submission")).toBeNull();
    expect(failedPrompt.headers.get("HX-Trigger")).toContain("Prompt failed");
    expect(
      await readFile(pathFrom(required(prompt.mock.calls[0])[0]), "utf8"),
    ).toBe("private file contents");
  });
});
