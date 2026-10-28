import { createOpenAITranscriber } from "@adapters/openai/transcription";
import { afterEach, describe, expect, it, vi } from "vitest";

const recording = () =>
  new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], "recording.webm", {
    type: "audio/webm;codecs=opus",
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI recorded transcription", () => {
  it("sends the original recording as multipart with fixed model and JSON response format", async () => {
    let sent: Request | undefined;
    const fetch = vi
      .fn()
      .mockImplementation((url: string, init: RequestInit) => {
        sent = new Request(url, init);
        return Promise.resolve(
          Response.json({ text: "  Příliš žluťoučký kůň.\n" }),
        );
      });
    vi.stubGlobal("fetch", fetch);
    const file = recording();
    const text = await createOpenAITranscriber("server-only-secret").transcribe(
      file,
      new AbortController().signal,
    );

    expect(text).toBe("  Příliš žluťoučký kůň.\n");
    expect(fetch).toHaveBeenCalledOnce();
    expect(sent?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(sent?.method).toBe("POST");
    expect(sent?.redirect).toBe("error");
    expect(sent?.headers.get("Authorization")).toBe(
      "Bearer server-only-secret",
    );
    expect(sent?.headers.get("Content-Type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
    if (!sent) throw new Error("No request was sent");
    const form = await sent.formData();
    expect([...form.keys()].sort()).toEqual([
      "file",
      "model",
      "response_format",
    ]);
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("response_format")).toBe("json");
    const audio = form.get("file") as File;
    expect(audio.name).toBe("recording.webm");
    expect(audio.type).toBe("audio/webm;codecs=opus");
    expect(await audio.arrayBuffer()).toEqual(await file.arrayBuffer());
  });

  it.each([401, 403, 413, 429, 500])(
    "maps provider %s to a safe error without reading its body",
    async (status) => {
      const response = new Response(
        "private transcript and server-only-secret",
        { status },
      );
      const json = vi.spyOn(response, "json");
      const text = vi.spyOn(response, "text");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const result = createOpenAITranscriber("server-only-secret").transcribe(
        recording(),
        new AbortController().signal,
      );

      await expect(result).rejects.toMatchObject({
        status: status === 429 ? 503 : 502,
        message:
          status === 429
            ? "Dictation provider is busy. Try again later."
            : "Dictation provider could not transcribe this recording.",
      });
      expect(json).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { text: 12 }, null, { transcript: "private text" }])(
    "rejects a response without JSON text",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
      await expect(
        createOpenAITranscriber("key").transcribe(
          recording(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        status: 502,
        message: "Dictation provider returned an invalid response.",
      });
    },
  );

  it("does not expose network errors or invalid JSON", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("server-only-secret"))
      .mockResolvedValueOnce(new Response("private text, not JSON"));
    vi.stubGlobal("fetch", fetch);
    const transcriber = createOpenAITranscriber("key");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        transcriber.transcribe(recording(), new AbortController().signal),
      ).rejects.toMatchObject({
        status: 502,
        message: "Cannot reach the dictation provider. Try again later.",
      });
    }
  });

  it.each(["cancel", "timeout"])(
    "aborts an active upstream request on %s",
    async (reason) => {
      vi.useFakeTimers();
      let upstreamSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((_url, init: RequestInit) => {
          const signal = init.signal;
          if (!signal) throw new Error("No upstream abort signal");
          upstreamSignal = signal;
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        }),
      );
      const controller = new AbortController();
      const pending = createOpenAITranscriber("key").transcribe(
        recording(),
        controller.signal,
      );
      const result = expect(pending).rejects.toMatchObject({
        status: reason === "cancel" ? 400 : 504,
        message:
          reason === "cancel"
            ? "Dictation was cancelled."
            : "Dictation timed out. Try a shorter recording.",
      });
      if (reason === "cancel") controller.abort();
      else {
        await vi.advanceTimersByTimeAsync(180_000 - 1);
        expect(upstreamSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      await result;
      expect(upstreamSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not send audio when the caller already aborted", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createOpenAITranscriber("key").transcribe(recording(), controller.signal),
    ).rejects.toMatchObject({
      status: 400,
      message: "Dictation was cancelled.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
