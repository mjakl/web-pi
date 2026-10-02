import type { CoordinatorState as State } from "@core/coordinator-types";
import { CoordinatorPanel, CoordinatorState } from "@web/views/Coordinator";
import { describe, expect, it, vi } from "vitest";
import { query, render } from "#/client/helpers";
import assert from "node:assert/strict";

class Events extends EventTarget {
  static last: Events;
  close = vi.fn();
  constructor() {
    super();
    Events.last = this;
  }
  state(state: State) {
    this.dispatchEvent(
      new MessageEvent("state", { data: render(CoordinatorState({ state })) }),
    );
    return Promise.resolve();
  }
}
const enabled = (): State => ({
  enabled: true,
  busy: false,
  sessions: [],
  target: "",
  context: null,
  question: null,
  conversation: [],
  inputCaption: "",
  outputCaption: "",
  voice: "off",
  voiceGeneration: 0,
  muted: false,
  playback: { sequence: 0, stopped: false },
  pending: null,
  error: "",
});
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const click = (name: string) => {
  query(`[data-coordinator="${name}"]`).click();
};
async function mount() {
  document.body.innerHTML = render(CoordinatorPanel());
  vi.stubGlobal("EventSource", Events);
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(
      Response.json({
        ok: true,
        answer: "answer",
        generation: 1,
        finalized: true,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const { setUpCoordinator } = await import("@web/client/coordinator");
  setUpCoordinator();
  return fetcher;
}
async function enable() {
  click("begin");
  await flush();
  await Events.last.state(enabled());
}

function mediaFixture(started = true) {
  const tracks: { enabled: boolean; stop: ReturnType<typeof vi.fn> }[] = [];
  const peers: Peer[] = [];
  const capture = () => {
    const track = { enabled: true, stop: vi.fn() };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  class Peer extends EventTarget {
    iceGatheringState = "complete";
    connectionState = "new";
    localDescription = { type: "offer", sdp: "v=0\r\n" };
    channel = Object.assign(new EventTarget(), {
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
    });
    close = vi.fn();
    remote = Promise.resolve();
    constructor() {
      super();
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      return this.channel;
    }
    createOffer() {
      return Promise.resolve(this.localDescription);
    }
    setLocalDescription() {
      return Promise.resolve();
    }
    async setRemoteDescription() {
      await this.remote;
      this.connectionState = "connected";
      if (started)
        this.channel.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "session.started" }),
          }),
        );
    }
  }
  const getUserMedia = vi.fn(() => Promise.resolve(capture()));
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser() {
        return {
          fftSize: 256,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
        };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      close() {
        return Promise.resolve();
      }
    },
  );
  return { tracks, peers, capture, getUserMedia };
}

const response = (generation = 1) =>
  Response.json({ ok: true, answer: "answer", generation, finalized: true });

async function startPendingVoice() {
  click("voice");
  await flush();
  await Events.last.state({ ...enabled(), voice: "connecting" });
}

describe("coordinator browser owner", () => {
  it("starts the coordinator and microphone with one Start voice click", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    click("voice");
    await flush();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/coordinator/begin",
      "/coordinator/voice",
    ]);
    expect(media.tracks[0]?.enabled).toBe(true);
    expect(
      query('[data-coordinator="begin"]').closest("details")?.className,
    ).toBe("coordinator-options");
    expect(document.querySelector("#coordinator-mode")).toBeNull();
    expect(query('[data-coordinator="voice"]').hidden).toBe(true);
    expect(query('[data-coordinator="mute"]').hidden).toBe(false);
    click("end");
    await flush();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/coordinator/end");
  });

  it("releases the microphone before full End settles and reports unconfirmed transport shutdown", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    click("voice");
    await flush();
    const ending = Promise.withResolvers<Response>();
    fetcher.mockImplementationOnce(() => ending.promise);
    click("end");
    await flush();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(query(".coordinator-playback").textContent).toContain(
      "Microphone off. Ending",
    );
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    ending.reject(new Error("Server connection failed"));
    await flush();
    expect(query(".coordinator-playback").textContent).toContain(
      "Remote shutdown unconfirmed",
    );
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).toContain("Server connection failed");
  });

  it.each(["permission", "provider"])(
    "ends a newly started coordinator after %s startup failure",
    async (failure) => {
      const fetcher = await mount();
      const media = mediaFixture();
      if (failure === "permission")
        media.getUserMedia.mockRejectedValueOnce(
          new Error("Microphone permission denied"),
        );
      else
        fetcher.mockImplementation((url) =>
          Promise.resolve(
            url === "/coordinator/voice"
              ? Response.json(
                  { error: "Check API quota and billing" },
                  { status: 400 },
                )
              : response(),
          ),
        );
      click("voice");
      await flush();
      await vi.waitFor(() => {
        expect(fetcher.mock.calls.at(-1)?.[0]).toBe("/coordinator/end");
      });
      await flush();
      expect(query(".coordinator-state").dataset["enabled"]).toBe("false");
      expect(
        query(".coordinator-panel > .coordinator-error").textContent,
      ).toContain(
        failure === "permission" ? "permission denied" : "quota and billing",
      );
      expect(
        (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(Events.last.close).toHaveBeenCalled();
    },
  );

  it("leaves Start voice available when the server key is missing, without capturing audio", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    fetcher.mockResolvedValueOnce(
      Response.json(
        { error: "Set OPENAI_API_KEY on the server, then restart" },
        { status: 400 },
      ),
    );
    click("voice");
    await flush();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(query(".coordinator-state").dataset["enabled"]).toBe("false");
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).toContain("OPENAI_API_KEY");
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it.each([false, true])(
    "cleans up a voice readiness timeout without stranding a one-click start (existing text: %s)",
    async (textOnly) => {
      const fetcher = await mount();
      const media = mediaFixture(false);
      vi.useFakeTimers();
      try {
        if (textOnly) await enable();
        click("voice");
        await flush();
        expect(media.peers[0]?.connectionState).toBe("connected");
        expect(media.tracks[0]?.enabled).toBe(false);
        const ending = Promise.withResolvers<Response>();
        fetcher.mockImplementationOnce(() => ending.promise);
        await vi.advanceTimersByTimeAsync(15000);
        await flush();
        expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
          textOnly ? "/coordinator/end-voice" : "/coordinator/end",
        );
        expect(
          (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
        ).toBe(true);
        ending.resolve(response());
        await flush();
        expect(query(".coordinator-state").dataset["enabled"]).toBe(
          String(textOnly),
        );
        expect(
          query(".coordinator-panel > .coordinator-error").textContent,
        ).toContain("did not become ready");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("starts voice without enabling again when text is already active", async () => {
    const fetcher = await mount();
    mediaFixture();
    await enable();
    click("voice");
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/begin"),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/voice"),
    ).toHaveLength(1);
  });

  it("reviews a typed request without a delivery setting and preserves target selection", async () => {
    const fetcher = await mount();
    await enable();
    await Events.last.state({
      ...enabled(),
      sessions: [
        {
          id: "one",
          handle: "S1",
          label: "Release",
          name: "Release",
          task: "Review release changes",
          currentRequest: "Review release changes",
          latestOutcome: "",
          revision: "revision",
          root: true,
          writable: true,
          cwd: "/project",
          project: "/project",
          live: true,
          running: true,
          available: true,
          status: null,
        },
      ],
    });
    const target = query("#coordinator-target") as HTMLSelectElement;
    target.value = "S1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    const selectionBody = fetcher.mock.calls.at(-1)?.[1]?.body;
    assert(typeof selectionBody === "string");
    expect(JSON.parse(selectionBody) as unknown).toEqual({ target: "S1" });
    (query("#coordinator-draft") as HTMLTextAreaElement).value =
      "Ask it to review the changes";
    query(".coordinator-compose").dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    const requestBody = fetcher.mock.calls.at(-1)?.[1]?.body;
    assert(typeof requestBody === "string");
    expect(JSON.parse(requestBody) as unknown).toEqual({
      text: "Ask it to review the changes",
      target: "S1",
    });
    expect(
      fetcher.mock.calls.some(([url]) => url === "/coordinator/confirm"),
    ).toBe(false);
  });
  it.each(["before", "after"])(
    "ignores old voice-off frames but honors current shutdown delivered %s the startup response",
    async (ordering) => {
      const fetcher = await mount();
      const media = mediaFixture();
      await enable();
      click("voice");
      await flush();
      click("end-voice");
      await flush();
      const starting = Promise.withResolvers<Response>();
      fetcher.mockImplementation((url) =>
        url === "/coordinator/voice"
          ? starting.promise
          : Promise.resolve(response()),
      );
      click("voice");
      await flush();
      if (ordering === "before") {
        await Events.last.state({
          ...enabled(),
          voice: "off",
          voiceGeneration: 3,
        });
      }
      starting.resolve(response(3));
      await flush();
      if (ordering === "after") {
        await Events.last.state({
          ...enabled(),
          voice: "off",
          voiceGeneration: 1,
        });
        expect(media.peers[1]?.close).not.toHaveBeenCalled();
        expect(media.tracks[1]?.stop).not.toHaveBeenCalled();
        expect(
          fetcher.mock.calls.filter(
            ([url]) => url === "/coordinator/end-voice",
          ),
        ).toHaveLength(1);
        await Events.last.state({
          ...enabled(),
          voice: "off",
          voiceGeneration: 3,
        });
        await flush();
      }
      expect(media.peers[1]?.close).toHaveBeenCalledOnce();
      expect(media.tracks[1]?.stop).toHaveBeenCalledOnce();
      expect(
        fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
      ).toHaveLength(2);
    },
  );

  it.each([200, 400])(
    "drains a stopped startup (%s) before allowing replacement voice",
    async (status) => {
      const fetcher = await mount();
      const media = mediaFixture();
      await enable();
      const first = Promise.withResolvers<Response>();
      fetcher.mockImplementation((url) =>
        url === "/coordinator/voice"
          ? first.promise
          : Promise.resolve(response()),
      );
      await startPendingVoice();
      click("end-voice");
      await flush();
      expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
      expect(media.peers[0]?.close).toHaveBeenCalledOnce();
      expect(
        (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
      ).toHaveLength(0);
      first.resolve(
        Response.json(
          status === 200 ? { answer: "answer" } : { error: "Startup rejected" },
          { status },
        ),
      );
      await flush();
      expect(
        fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
      ).toHaveLength(1);
      expect(
        (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
      ).toBe(false);
      fetcher.mockImplementation(() => Promise.resolve(response()));
      click("voice");
      await flush();
      expect(media.peers[1]?.close).not.toHaveBeenCalled();
      expect(media.tracks[1]?.stop).not.toHaveBeenCalled();
      expect(media.tracks[1]?.enabled).toBe(true);
      expect(
        query(".coordinator-panel > .coordinator-error").textContent,
      ).not.toContain("Startup rejected");
    },
  );

  it("drains old mute and cleanup before offering a replacement, while stopping locally immediately", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    click("voice");
    await flush();
    const mute = Promise.withResolvers<Response>();
    const stop = Promise.withResolvers<Response>();
    fetcher.mockImplementation((url) =>
      url === "/coordinator/mute"
        ? mute.promise
        : url === "/coordinator/end-voice"
          ? stop.promise
          : Promise.resolve(response()),
    );
    click("mute");
    await flush();
    expect(
      (query('[data-coordinator="mute"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (query('[data-coordinator="end-voice"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    click("end-voice");
    await flush();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
    ).toHaveLength(0);
    mute.resolve(response());
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
    ).toHaveLength(1);
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    stop.resolve(response());
    await flush();
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    click("voice");
    await flush();
    expect(media.tracks[1]?.enabled).toBe(true);
    expect(media.peers[1]?.close).not.toHaveBeenCalled();
  });

  it("ignores an old local startup rejection after its replacement connects", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    const remote = Promise.withResolvers<undefined>();
    fetcher.mockImplementation((url) => {
      if (url === "/coordinator/voice" && media.peers.length === 1) {
        const first = media.peers[0];
        assert(first);
        first.remote = remote.promise;
      }
      return Promise.resolve(response());
    });
    await startPendingVoice();
    click("end-voice");
    await flush();
    click("voice");
    await flush();
    remote.reject(new Error("Old SDP failed"));
    await flush();
    expect(media.peers[1]?.close).not.toHaveBeenCalled();
    expect(media.tracks[1]?.stop).not.toHaveBeenCalled();
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).not.toContain("Old SDP failed");
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
    ).toHaveLength(1);
  });

  it("keeps current-error cleanup pending until confirmed and then permits an explicit retry", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    const startup = Promise.withResolvers<Response>();
    const cleanup = Promise.withResolvers<Response>();
    fetcher.mockImplementation((url) =>
      url === "/coordinator/voice"
        ? startup.promise
        : url === "/coordinator/end-voice"
          ? cleanup.promise
          : Promise.resolve(response()),
    );
    await startPendingVoice();
    startup.resolve(
      Response.json({ error: "Voice startup failed" }, { status: 400 }),
    );
    await flush();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).toContain("Voice startup failed");
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup.resolve(response());
    await flush();
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(false);
    fetcher.mockImplementation(() => Promise.resolve(response()));
    click("voice");
    await flush();
    expect(media.tracks[1]?.enabled).toBe(true);
  });

  it.each(["transport", "finalization"])(
    "does not claim restart readiness after uncertain %s; full End remains available",
    async (failure) => {
      const fetcher = await mount();
      mediaFixture();
      await enable();
      fetcher.mockImplementation((url) => {
        if (failure === "transport" && url === "/coordinator/voice")
          return Promise.reject(new Error("Network failed"));
        if (failure === "finalization" && url === "/coordinator/end-voice")
          return Promise.resolve(Response.json({ ok: true, finalized: false }));
        return Promise.resolve(response());
      });
      click("voice");
      await flush();
      if (failure === "finalization") {
        click("end-voice");
        await flush();
      }
      expect(
        (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        query(".coordinator-panel > .coordinator-error").textContent,
      ).toContain("Use End before starting voice again");
      expect(
        (query('[data-coordinator="end"]') as HTMLButtonElement).disabled,
      ).toBe(false);
      click("end");
      await flush();
      expect(
        fetcher.mock.calls.some(([url]) => url === "/coordinator/end"),
      ).toBe(true);
      await enable();
      expect(
        (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );

  it.each(["grant", "deny"])(
    "disposes pending microphone permission without late %s restarting voice",
    async (outcome) => {
      const fetcher = await mount();
      const media = mediaFixture();
      await enable();
      const permission =
        Promise.withResolvers<ReturnType<typeof media.capture>>();
      media.getUserMedia.mockImplementationOnce(() => permission.promise);
      click("voice");
      await flush();
      query("#coordinator").remove();
      document.dispatchEvent(new Event("htmx:after:settle"));
      await flush();
      if (outcome === "grant") permission.resolve(media.capture());
      else permission.reject(new Error("Old permission denied"));
      await flush();
      if (outcome === "grant")
        expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
      expect(
        fetcher.mock.calls.some(([url]) => url === "/coordinator/voice"),
      ).toBe(false);
      expect(
        fetcher.mock.calls.some(([url]) => url === "/coordinator/end-voice"),
      ).toBe(false);
    },
  );

  it("does not let obsolete permission completion unlock a replacement startup", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    const permission =
      Promise.withResolvers<ReturnType<typeof media.capture>>();
    media.getUserMedia.mockImplementationOnce(() => permission.promise);
    click("voice");
    await flush();
    click("end-voice");
    await flush();
    const replacement = Promise.withResolvers<Response>();
    fetcher.mockImplementation((url) =>
      url === "/coordinator/voice"
        ? replacement.promise
        : Promise.resolve(response()),
    );
    click("voice");
    await flush();
    permission.reject(new Error("Old permission rejected"));
    await flush();
    expect(
      (query('.coordinator-compose [type="submit"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).not.toContain("Old permission rejected");
    replacement.resolve(response());
    await flush();
    expect(media.tracks[0]?.enabled).toBe(true);
    expect(media.peers[0]?.close).not.toHaveBeenCalled();
  });

  it("revokes the conversation on pagehide during voice startup without late cleanup", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    const startup = Promise.withResolvers<Response>();
    fetcher.mockImplementation((url) =>
      url === "/coordinator/voice"
        ? startup.promise
        : Promise.resolve(response()),
    );
    await startPendingVoice();
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url === "/coordinator/end" && init?.keepalive,
      ),
    ).toBe(true);
    startup.resolve(
      Response.json({ error: "Coordinator ended" }, { status: 400 }),
    );
    await flush();
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
    ).toHaveLength(0);
  });

  it("mutes microphone and playback independently without ending the connection", async () => {
    const fetcher = await mount();
    const media = mediaFixture();
    await enable();
    click("voice");
    await flush();
    click("speech");
    await flush();
    expect((query("audio") as HTMLAudioElement).muted).toBe(true);
    expect(media.tracks[0]?.enabled).toBe(true);
    click("mute");
    await flush();
    expect(media.tracks[0]?.enabled).toBe(false);
    click("speech");
    await flush();
    expect((query("audio") as HTMLAudioElement).muted).toBe(false);
    expect(media.tracks[0]?.enabled).toBe(false);
    click("mute");
    await flush();
    expect(media.tracks[0]?.enabled).toBe(true);
    expect(media.peers[0]?.close).not.toHaveBeenCalled();
    expect(
      fetcher.mock.calls.filter(([url]) => url === "/coordinator/end-voice"),
    ).toHaveLength(0);
  });

  it("ignores late playback rejection and leaves replacement voice running", async () => {
    await mount();
    const media = mediaFixture();
    await enable();
    click("voice");
    await flush();
    const playback = Promise.withResolvers<undefined>();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementationOnce(
      () => playback.promise,
    );
    media.peers[0]?.dispatchEvent(
      Object.assign(new Event("track"), { streams: [new MediaStream()] }),
    );
    click("end-voice");
    await flush();
    click("voice");
    await flush();
    playback.reject(new Error("Playback interrupted by stop"));
    await flush();
    expect(media.peers[1]?.close).not.toHaveBeenCalled();
    expect(
      query(".coordinator-panel > .coordinator-error").textContent,
    ).not.toContain("playback was blocked");
  });

  it("does not request microphone, connect, or speak on page load", async () => {
    const fetcher = await mount();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      (query('[data-coordinator="voice"]') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("keeps an edited text draft separate from late captions and stops on stream failure", async () => {
    const fetcher = await mount();
    await enable();
    const draft = query("#coordinator-draft") as HTMLTextAreaElement;
    draft.value = "Review the selected timer session";
    await Events.last.state({
      ...enabled(),
      voice: "connected",
      inputCaption: "No, maybe another session",
    });
    expect(draft.value).toBe("Review the selected timer session");
    Events.last.dispatchEvent(new Event("error"));
    await flush();
    expect(Events.last.close).toHaveBeenCalled();
    expect(fetcher.mock.calls.some(([url]) => url === "/coordinator/end")).toBe(
      true,
    );
    expect(document.querySelector(".coordinator-error")?.textContent).toContain(
      "start again explicitly",
    );
    expect(draft.value).toContain("selected timer");
  });
  it("preserves an exact typed answer across state frames for the same question", async () => {
    const fetcher = await mount();
    await enable();
    const state: State = {
      ...enabled(),
      target: "S1",
      context: {
        id: "one",
        messages: [],
        currentRequest: "",
        latestOutcome: "",
        revision: "question-1",
        running: true,
        writable: true,
        dialog: { id: "d1", method: "input", title: "Which branch?" },
        status: {
          state: "waiting",
          queued: 0,
          tools: [],
          retry: null,
          notices: [],
          error: "",
          blocked: false,
        },
      },
    };
    await Events.last.state(state);
    (query('.coordinator-dialog [name="value"]') as HTMLTextAreaElement).value =
      "release/precise-2";
    await Events.last.state({ ...state, inputCaption: "unrelated speech" });
    const form = query(".coordinator-dialog") as HTMLFormElement;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    const body = fetcher.mock.calls.find(
      ([url]) => url === "/coordinator/answer",
    )?.[1]?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body) as unknown).toEqual({
      revision: "question-1",
      request: "d1",
      value: "release/precise-2",
    });
  });
  it("applies spoken playback controls only to the current generation without muting the microphone", async () => {
    await mount();
    const media = mediaFixture();
    await enable();
    click("voice");
    await flush();
    const state: State = {
      ...enabled(),
      voice: "connected",
      voiceGeneration: 1,
      playback: { sequence: 1, stopped: true },
    };
    await Events.last.state(state);
    expect((query("audio") as HTMLAudioElement).muted).toBe(true);
    expect(media.tracks[0]?.enabled).toBe(true);
    expect(media.peers[0]?.close).not.toHaveBeenCalled();
    await Events.last.state({
      ...state,
      voiceGeneration: 99,
      playback: { sequence: 2, stopped: false },
    });
    expect((query("audio") as HTMLAudioElement).muted).toBe(true);
    await Events.last.state({
      ...state,
      playback: { sequence: 2, stopped: false },
    });
    expect((query("audio") as HTMLAudioElement).muted).toBe(false);
    click("speech");
    await flush();
    await Events.last.state({
      ...state,
      playback: { sequence: 2, stopped: false },
    });
    expect((query("audio") as HTMLAudioElement).muted).toBe(true);
    expect(media.tracks[0]?.enabled).toBe(true);
  });

  it("explains remote HTTP microphone limitations without trying another audio product", async () => {
    const fetcher = await mount();
    await enable();
    vi.stubGlobal("isSecureContext", false);
    click("voice");
    await flush();
    expect(document.querySelector(".coordinator-error")?.textContent).toContain(
      "HTTPS or localhost",
    );
    expect(
      fetcher.mock.calls.some(([url]) => url === "/coordinator/voice"),
    ).toBe(false);
  });
  it.each(["pending response", "before first state"])(
    "ends startup when the owner is removed during %s",
    async (stage) => {
      const fetcher = await mount();
      const response = Promise.withResolvers<Response>();
      fetcher.mockImplementationOnce(() => response.promise);
      const createStream = vi.fn(() => new Events());
      vi.stubGlobal(
        "EventSource",
        class {
          constructor() {
            return createStream();
          }
        },
      );
      click("begin");
      if (stage === "before first state") {
        response.resolve(Response.json({ ok: true }));
        await flush();
        expect(createStream).toHaveBeenCalledOnce();
      }
      query("#coordinator").remove();
      document.dispatchEvent(new Event("htmx:after:settle"));
      response.resolve(Response.json({ ok: true }));
      await flush();
      expect(
        fetcher.mock.calls.some(
          ([url, init]) => url === "/coordinator/end" && init?.keepalive,
        ),
      ).toBe(true);
      if (stage === "pending response")
        expect(createStream).not.toHaveBeenCalled();
      else expect(Events.last.close).toHaveBeenCalled();
    },
  );

  it("ends the app-level conversation when its DOM owner is removed", async () => {
    const fetcher = await mount();
    await enable();
    query("#coordinator").remove();
    document.dispatchEvent(new Event("htmx:after:settle"));
    await flush();
    expect(Events.last.close).toHaveBeenCalled();
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => url === "/coordinator/end" && init?.keepalive,
      ),
    ).toBe(true);
  });
});
