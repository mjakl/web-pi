import { createFakeWorld } from "@adapters/fake/index";
import { createCoordinator } from "@core/coordinator";
import type { CoordinatorProvider } from "@core/coordinator-types";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import { describe, expect, it, vi } from "vitest";

function fixture(ready = true) {
  const workspace = createWorkspace(createFakeWorld());
  const provider: CoordinatorProvider = {
    ready: () => ready,
    respond: vi.fn(() =>
      Promise.resolve({
        kind: "reply" as const,
        text: "No sessions.",
        speech: "No sessions.",
        instruction: "",
        targetId: null,
        question: null,
      }),
    ),
    connect: vi.fn(),
  };
  let nextId = 0;
  const coordinator = createCoordinator(
    workspace,
    provider,
    () => `private-coordinator-token-${String(++nextId)}`,
  );
  const app = createWebApp({
    workspace,
    coordinator,
    staticRoot: "/nonexistent",
    defaultCwd: "/tmp/trial",
  });
  const post = (
    action: string,
    data = {},
    cookie = "",
    origin = "http://localhost",
  ) =>
    app.request(`/coordinator/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookie,
      },
      body: JSON.stringify(data),
    });
  return { app, coordinator, provider, post };
}

describe("coordinator HTTP boundary", () => {
  it("requires explicit enable, same-host JSON and a private conversation cookie", async () => {
    const { post, provider } = fixture();
    expect(
      (await post("begin", {}, "", "https://untrusted.example")).status,
    ).toBe(403);
    expect(
      (await post("request", { text: "list", target: "", mode: "prompt" }))
        .status,
    ).toBe(400);
    const begin = await post("begin");
    expect(begin.status).toBe(200);
    const cookie = begin.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=10800");
    const response = await post(
      "request",
      { text: "List active sessions", target: "", mode: "prompt" },
      cookie,
    );
    expect(response.status).toBe(200);
    expect(provider.respond).toHaveBeenCalledOnce();
    expect(
      (await post("confirm", { proposal: "invented" }, cookie)).status,
    ).toBe(400);
    await post("end", {}, cookie);
  });
  it("accepts omitted delivery and explicit modes, but rejects invalid supplied modes", async () => {
    const { post, provider, coordinator } = fixture();
    const begin = await post("begin");
    const cookie = begin.headers.get("Set-Cookie") ?? "";
    try {
      const request = { text: "List active sessions", target: "" };
      expect((await post("request", request, cookie)).status).toBe(200);
      expect(provider.respond).toHaveBeenCalledOnce();
      expect(
        coordinator.state("private-coordinator-token-1").proposal,
      ).toBeNull();
      for (const mode of ["prompt", "followUp", "steer"]) {
        expect(
          (await post("request", { ...request, mode }, cookie)).status,
        ).toBe(200);
      }
      expect(provider.respond).toHaveBeenCalledTimes(4);
      for (const mode of ["", "interrupt", null, 1]) {
        expect(
          (await post("request", { ...request, mode }, cookie)).status,
        ).toBe(400);
      }
      expect(provider.respond).toHaveBeenCalledTimes(4);
      expect(provider.connect).not.toHaveBeenCalled();
    } finally {
      await coordinator.shutdown();
    }
  });

  it("returns the core voice generation in startup JSON", async () => {
    const { post, provider, coordinator } = fixture();
    vi.mocked(provider.connect).mockResolvedValue({
      answer: "answer",
      context: vi.fn(),
      mute: vi.fn(),
      close: () => Promise.resolve(true),
    });
    const begin = await post("begin");
    const cookie = begin.headers.get("Set-Cookie") ?? "";
    try {
      const connected = await post("voice", { offer: "v=0\r\n" }, cookie);
      expect(await connected.json()).toEqual({
        answer: "answer",
        generation: 1,
      });
      expect(
        coordinator.state("private-coordinator-token-1").voiceGeneration,
      ).toBe(1);
    } finally {
      await coordinator.shutdown();
    }
  });

  it.each([true, false])(
    "keeps a replacement usable when old End responses arrive last (finalized: %s)",
    async (finalized) => {
      const { post, provider, app, coordinator } = fixture();
      const closing = Promise.withResolvers<boolean>();
      const close = vi.fn(() => closing.promise);
      vi.mocked(provider.connect).mockResolvedValue({
        answer: "answer",
        context: vi.fn(),
        mute: vi.fn(),
        close,
      });
      let browserCookie = "";
      const receive = (response: Response) => {
        const cookie = response.headers.get("Set-Cookie")?.split(";")[0];
        if (cookie !== undefined) browserCookie = cookie;
      };
      const select = (cookie: string) => post("select", { target: "" }, cookie);
      try {
        receive(await post("begin"));
        const oldCookie = browserCookie;
        expect(
          (await post("voice", { offer: "v=0\r\n" }, browserCookie)).status,
        ).toBe(200);
        const pending = [
          post("end", {}, oldCookie),
          post("end", {}, oldCookie),
        ];
        await vi.waitFor(() => {
          expect(close).toHaveBeenCalledOnce();
        });
        expect((await select(oldCookie)).status).toBe(400);
        const replacement = await post("begin", {}, browserCookie);
        expect(replacement.status).toBe(200);
        receive(replacement);
        expect(browserCookie).not.toBe(oldCookie);
        closing.resolve(finalized);
        for (const pendingResponse of pending) {
          const response = await pendingResponse;
          expect(await response.json()).toEqual({ ok: true, finalized });
          receive(response);
        }
        expect((await select(browserCookie)).status).toBe(200);
        expect((await post("end", {}, oldCookie)).status).toBe(400);
        expect(
          (
            await app.request("/coordinator/events", {
              headers: { Cookie: oldCookie },
            })
          ).status,
        ).toBe(410);
        expect((await select(browserCookie)).status).toBe(200);
      } finally {
        closing.resolve(finalized);
        await coordinator.shutdown();
      }
    },
  );

  it("gives a server configuration error without any fallback or microphone call", async () => {
    const { post, provider } = fixture(false);
    const response = await post("begin");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("OPENAI_API_KEY");
    expect(provider.connect).not.toHaveBeenCalled();
    expect(provider.respond).not.toHaveBeenCalled();
  });
  it("supports private HTTPS termination without allowing another host", async () => {
    const { post } = fixture();
    const response = await post("begin", {}, "", "https://localhost");
    expect(response.status).toBe(200);
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("Secure");
    await post("end", {}, cookie);
  });
  it("renders an app-level, opt-in shell rather than tying voice to a session fragment", async () => {
    const { app } = fixture();
    const full = await (await app.request("/new")).text();
    expect(full).toContain('id="coordinator"');
    expect(full).toContain("Start voice");
    expect(full).not.toContain("Enable text coordinator");
    expect(full).not.toContain('id="coordinator-mode"');
    expect(full).toContain(
      "Instructions and approval answers always need visible confirmation",
    );
    expect(full).toContain("90-minute window");
    expect(full).toContain("There is no automatic reconnect");
    const fragment = await (
      await app.request("/new", { headers: { "HX-Request": "true" } })
    ).text();
    expect(fragment).not.toContain('id="coordinator"');
  });
});
