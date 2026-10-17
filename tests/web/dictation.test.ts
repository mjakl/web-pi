import { createFakeWorld } from "@adapters/fake/index";
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_REQUEST_BYTES,
  DictationError,
} from "@core/dictation";
import type { AudioTranscriber } from "@core/ports";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

function recording() {
  return new File(
    [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])],
    "recording.webm",
    {
      type: "audio/webm;codecs=opus",
    },
  );
}

function fixture(transcription?: AudioTranscriber) {
  const world = createFakeWorld();
  const open = vi.spyOn(world.runtime, "open");
  const app = createWebApp({
    workspace: createWorkspace({
      ...world,
      ...(transcription ? { transcription } : {}),
    }),
    defaultCwd: "/repo",
    staticRoot: "/nonexistent",
  });
  return { app, open };
}

function upload(file = recording()) {
  const body = new FormData();
  body.set("file", file);
  return {
    method: "POST",
    headers: { "X-Web-Pi-Dictation": "1" },
    body,
  };
}

describe("recorded dictation", () => {
  it("reports missing server credentials without opening an agent", async () => {
    const { app, open } = fixture();
    const response = await app.request("/dictation/transcribe", upload());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Dictation is unavailable. Set OPENAI_API_KEY on the server.",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(open).not.toHaveBeenCalled();
  });

  // Fixtures: ffmpeg 9.0.2, lavfi sine=frequency=440:sample_rate=48000:duration=0.2,
  // -map_metadata -1 -ac 1; libopus -b:a 24k (WebM), aac -b:a 32k (MP4),
  // pcm_s16le -ar 16000 (WAV). Synthetic tone only; no speech or private audio.
  it.each([
    ["webm", "audio/webm;codecs=opus"],
    ["mp4", "audio/mp4;codecs=mp4a.40.2"],
    ["wav", "audio/wav"],
  ])(
    "forwards intact %s audio and returns text without opening an agent",
    async (extension, type) => {
      const name = `recording.${extension}`;
      const bytes = new Uint8Array(
        await readFile(
          new URL(`./fixtures/dictation/tone.${extension}`, import.meta.url),
        ),
      );
      const transcribe = vi
        .fn<AudioTranscriber["transcribe"]>()
        .mockResolvedValue("Příliš žluťoučký kůň.");
      const { app, open } = fixture({ transcribe });
      const response = await app.request(
        "/dictation/transcribe",
        upload(new File([bytes], name, { type })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ text: "Příliš žluťoučký kůň." });
      expect(transcribe).toHaveBeenCalledOnce();
      const forwarded = transcribe.mock.calls[0]?.[0];
      if (!forwarded) throw new Error("No recording was forwarded");
      expect(forwarded.name).toBe(name);
      expect(forwarded.type).toBe(type);
      expect(new Uint8Array(await forwarded.arrayBuffer())).toEqual(bytes);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{}, 403],
    [{ "X-Web-Pi-Dictation": "0" }, 403],
    [{ "X-Web-Pi-Dictation": "1", "Sec-Fetch-Site": "cross-site" }, 403],
  ])(
    "rejects unsafe browser requests before sending audio: %j",
    async (headers, status) => {
      const transcribe = vi.fn();
      const { app } = fixture({ transcribe });
      const response = await app.request("/dictation/transcribe", {
        ...upload(),
        headers,
      });
      expect(response.status).toBe(status);
      expect(transcribe).not.toHaveBeenCalled();
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    },
  );

  it.each([
    [new File([], "recording.webm", { type: "audio/webm" }), 400],
    [new File(["text"], "recording.txt", { type: "text/plain" }), 415],
    [new File(["not audio"], "recording.webm", { type: "audio/webm" }), 415],
    [
      new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "recording.wav", {
        type: "audio/webm",
      }),
      415,
    ],
    [
      new File([new Uint8Array(DICTATION_MAX_BYTES + 1)], "recording.wav", {
        type: "audio/wav",
      }),
      413,
    ],
  ])(
    "rejects invalid files before sending audio (%s)",
    async (file, status) => {
      const transcribe = vi.fn();
      const { app } = fixture({ transcribe });
      const response = await app.request("/dictation/transcribe", upload(file));
      expect(response.status).toBe(status);
      expect(transcribe).not.toHaveBeenCalled();
    },
  );

  it("accepts a recording at the byte limit", async () => {
    const transcribe = vi.fn().mockResolvedValue("Within the limit.");
    const { app } = fixture({ transcribe });
    const bytes = new Uint8Array(DICTATION_MAX_BYTES);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    const response = await app.request(
      "/dictation/transcribe",
      upload(new File([bytes], "recording.webm", { type: "audio/webm" })),
    );
    expect(response.status).toBe(200);
  });

  it.each(["missing", "duplicate", "extra", "text"])(
    "rejects a %s file field",
    async (kind) => {
      const transcribe = vi.fn();
      const { app } = fixture({ transcribe });
      const request = upload();
      if (kind === "missing") request.body.delete("file");
      if (kind === "duplicate") request.body.append("file", recording());
      if (kind === "extra") request.body.set("other", "not expected");
      if (kind === "text") request.body.set("file", "not a file");
      expect((await app.request("/dictation/transcribe", request)).status).toBe(
        400,
      );
      expect(transcribe).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["text/plain", "not multipart", 415],
    ["multipart/form-data; boundary=broken", "not multipart", 400],
  ])(
    "safely rejects malformed request bodies",
    async (contentType, body, status) => {
      const transcribe = vi.fn();
      const { app } = fixture({ transcribe });
      const response = await app.request("/dictation/transcribe", {
        method: "POST",
        headers: { "X-Web-Pi-Dictation": "1", "Content-Type": contentType },
        body,
      });
      expect(response.status).toBe(status);
      expect(transcribe).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "1"])(
    "bounds streamed bytes even with content-length %s",
    async (contentLength) => {
      const transcribe = vi.fn();
      const { app } = fixture({ transcribe });
      const headers = new Headers({
        "X-Web-Pi-Dictation": "1",
        "Content-Type": "multipart/form-data; boundary=recording",
      });
      if (contentLength !== undefined)
        headers.set("Content-Length", contentLength);
      let sent = 0;
      const chunk = new Uint8Array(64 * 1024);
      const body = new ReadableStream({
        pull(controller) {
          sent += chunk.length;
          controller.enqueue(chunk);
          if (sent > DICTATION_MAX_REQUEST_BYTES + chunk.length)
            controller.close();
        },
      });
      const response = await app.request(
        new Request("http://localhost/dictation/transcribe", {
          method: "POST",
          headers,
          body,
          duplex: "half",
        } as RequestInit),
      );
      expect(response.status).toBe(413);
      expect(transcribe).not.toHaveBeenCalled();
    },
  );

  it("rejects overlapping uploads and releases admission after completion", async () => {
    let finish!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transcribe = vi.fn().mockImplementation(() => {
      entered();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const { app } = fixture({ transcribe });
    const first = app.request("/dictation/transcribe", upload());
    await started;
    expect((await app.request("/dictation/transcribe", upload())).status).toBe(
      429,
    );
    expect(transcribe).toHaveBeenCalledOnce();
    finish("done");
    expect((await first).status).toBe(200);
    transcribe.mockResolvedValue("next");
    expect((await app.request("/dictation/transcribe", upload())).status).toBe(
      200,
    );
  });

  it("admits only one upload before multipart buffering completes", async () => {
    const transcribe = vi.fn().mockResolvedValue("done");
    const { app } = fixture({ transcribe });
    const request = new Request(
      "http://localhost/dictation/transcribe",
      upload(),
    );
    const bytes = new Uint8Array(await request.arrayBuffer());
    let finishUpload!: () => void;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        finishUpload = () => {
          controller.enqueue(bytes.slice(1));
          controller.close();
        };
      },
    });
    const first = app.request(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body,
        duplex: "half",
      } as RequestInit),
    );
    try {
      expect(
        (await app.request("/dictation/transcribe", upload())).status,
      ).toBe(429);
      expect(transcribe).not.toHaveBeenCalled();
    } finally {
      finishUpload();
      expect((await first).status).toBe(200);
    }
  });

  it("forwards request cancellation to transcription", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transcribe = vi
      .fn()
      .mockImplementation((_file: File, signal: AbortSignal) => {
        entered();
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new DictationError("Dictation was cancelled.", 400));
            },
            { once: true },
          );
        });
      });
    const { app } = fixture({ transcribe });
    const controller = new AbortController();
    const pending = app.request("/dictation/transcribe", {
      ...upload(),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Dictation was cancelled.",
    });
    transcribe.mockResolvedValue("next");
    expect((await app.request("/dictation/transcribe", upload())).status).toBe(
      200,
    );
  });

  it("does not expose unexpected provider errors", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValue(new Error("secret-key and private transcript"));
    const { app } = fixture({ transcribe });
    const response = await app.request("/dictation/transcribe", upload());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "Cannot transcribe this recording.",
    });
    transcribe.mockResolvedValue("next");
    expect((await app.request("/dictation/transcribe", upload())).status).toBe(
      200,
    );
  });
});
