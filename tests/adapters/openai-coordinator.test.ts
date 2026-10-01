import { createOpenAiCoordinatorProvider } from "@adapters/openai/coordinator";
import type { CoordinatorInput, VoiceEvent } from "@core/coordinator-types";
import type { WebSocket } from "undici";
import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";

const input: CoordinatorInput = {
  purpose: "request",
  text: "List active sessions",
  sessions: [],
  target: null,
  context: null,
  conversation: [],
};
const reply = {
  kind: "reply",
  text: "No active sessions.",
  speech: "No active sessions.",
  instruction: "",
};
class Socket extends EventTarget {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(text: string) {
    const data = JSON.parse(text) as Record<string, unknown>;
    this.sent.push(data);
    if (data["type"] === "session.close")
      queueMicrotask(() => {
        this.message({ type: "session.closed" });
      });
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  message(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(data) }),
    );
  }
}

describe("OpenAI coordinator transport", () => {
  it("fails explicitly when unconfigured and never substitutes another provider", () => {
    expect(createOpenAiCoordinatorProvider().ready()).toBe(false);
  });
  it("uses stateless Responses with bounded context and no executable tools", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: JSON.stringify(reply) }],
          },
        ],
      }),
    );
    const provider = createOpenAiCoordinatorProvider({
      apiKey: "test-secret",
      fetch: fetcher,
    });
    expect(await provider.respond(input, new AbortController().signal)).toEqual(
      reply,
    );
    const call = fetcher.mock.calls[0];
    assert(call && typeof call[1]?.body === "string");
    expect(call[0]).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(call[1].body) as Record<string, unknown>;
    expect(body).toMatchObject({
      store: false,
      model: "gpt-4.1-mini-2025-04-14",
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(body["tools"]).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-secret");
  });
  it("rejects oversized requests before contacting OpenAI", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = createOpenAiCoordinatorProvider({
      apiKey: "test-secret",
      fetch: fetcher,
    });
    await expect(
      provider.connect(
        "x".repeat(80001),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("exceeds this trial's size limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects incomplete replies and hides provider errors that could echo credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "incomplete", output: [] }),
      )
      .mockResolvedValueOnce(
        new Response("test-secret details", { status: 401 }),
      );
    const provider = createOpenAiCoordinatorProvider({
      apiKey: "test-secret",
      fetch: fetcher,
    });
    await expect(
      provider.respond(input, new AbortController().signal),
    ).rejects.toThrow(/did not complete/);
    await expect(
      provider.respond(input, new AbortController().signal),
    ).rejects.toThrow(
      "OpenAI request failed (HTTP 401). Check the server API key and model access.",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("restricts the browser, forwards transcripts without inventing turns, and closes Live independently", async () => {
    const ws = new Socket();
    const socket = vi.fn<
      (url: string, options: { headers: Record<string, string> }) => WebSocket
    >(() => {
      queueMicrotask(() => ws.dispatchEvent(new Event("open")));
      return ws as unknown as WebSocket;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { session: { id: "live_test" }, transport: { sdp: "answer" } },
          { status: 201 },
        ),
      );
    const events: VoiceEvent[] = [];
    const provider = createOpenAiCoordinatorProvider({
      apiKey: "test-secret",
      fetch: fetcher,
      socket,
    });
    const voice = await provider.connect(
      "offer",
      (event) => events.push(event),
      new AbortController().signal,
    );
    const bodyText = fetcher.mock.calls[0]?.[1]?.body;
    assert(typeof bodyText === "string");
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body["session"]).toMatchObject({
      model: "gpt-live-1",
      store: false,
      delegation: { type: "client" },
      client: { data_channel: { allowed_client_events: ["session.close"] } },
    });
    expect(socket.mock.calls[0]).toMatchObject([
      "wss://api.openai.com/v1/live/sessions/live_test/attach",
      { headers: { Authorization: "Bearer test-secret" } },
    ]);
    ws.message({
      type: "session.input_transcript.delta",
      event_id: "i1",
      delta: " ask it",
    });
    ws.message({
      type: "session.delegation.created",
      delegation: { id: "d1", target: "client" },
    });
    expect(events).toEqual([
      { type: "input", id: "i1", text: " ask it" },
      { type: "delegate", id: "d1" },
    ]);
    voice.context("🙂".repeat(500), true, "d1");
    voice.mute(true);
    expect(
      new TextEncoder().encode(String(ws.sent[0]?.["content"])).length,
    ).toBeLessThanOrEqual(480);
    expect(ws.sent[0]).toMatchObject({
      type: "session.commentary.append",
      delegation_id: "d1",
    });
    expect(ws.sent[1]).toMatchObject({ type: "session.input_audio.mute" });
    expect(await voice.close()).toBe(true);
    expect(voice.answer).toBe("answer");
    expect(ws.readyState).toBe(3);
  });
});
