import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_RECORDING_MS,
} from "@core/dictation";
import { Composer, ComposerText } from "@web/views/Composer";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  area,
  byId,
  click,
  flush,
  htmxEvent,
  json,
  keydown,
  mount,
  query,
  render,
  type,
} from "./helpers.ts";

class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static isTypeSupported = vi.fn(
    (mime: string) => mime === "audio/webm;codecs=opus",
  );
  state = "inactive";
  mimeType: string;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    // MediaRecorder delivers its final chunk and stop event asynchronously.
    void Promise.resolve().then(() => {
      this.data(new Blob(["recorded audio"]));
      this.dispatchEvent(new Event("stop"));
    });
  });
  constructor(_stream: MediaStream, options: MediaRecorderOptions) {
    super();
    this.mimeType = options.mimeType ?? "";
    Recorder.instances.push(this);
  }
  data(data: Blob): void {
    this.dispatchEvent(Object.assign(new Event("dataavailable"), { data }));
  }
}

const trackStop = vi.fn();
const stream = {
  getTracks: () => [{ stop: trackStop }],
} as unknown as MediaStream;
let permission: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  Recorder.instances = [];
  Recorder.isTypeSupported
    .mockReset()
    .mockImplementation((mime) => mime === "audio/webm;codecs=opus");
  trackStop.mockReset();
  permission = vi.fn(() => Promise.resolve(stream));
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: permission },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });
  fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(json({ text: "dictated words" })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

function button(): HTMLButtonElement {
  return byId("dictation-button") as HTMLButtonElement;
}
function status(): string {
  return byId("dictation-status").textContent ?? "";
}
function errorStatus(): string {
  expect(byId("dictation-status").classList.contains("sr-only")).toBe(false);
  expect(byId("dictation-status").classList.contains("is-error")).toBe(true);
  expect(byId("dictation-status").getAttribute("role")).toBe("status");
  return status();
}
function expectButtonState(state: string, label: string): void {
  expect(byId("dictation-status").classList.contains("sr-only")).toBe(true);
  expect(byId("dictation-status").classList.contains("is-error")).toBe(false);
  expect(button().textContent?.trim()).toBe("");
  expect(button().getAttribute("aria-label")).toBe(label);
  expect(button().title).toBe(label);
  const visibleIcons = [
    ...button().querySelectorAll<HTMLElement>("[data-dictation-icon]"),
  ].filter((icon) => !icon.hidden);
  expect(visibleIcons).toHaveLength(1);
  expect(visibleIcons[0]?.dataset["dictationIcon"]).toBe(state);
  expect(
    visibleIcons[0]?.querySelector("svg")?.getAttribute("aria-hidden"),
  ).toBe("true");
}
function recorder(): Recorder {
  const value = Recorder.instances.at(-1);
  if (!value) throw new Error("No recorder started");
  return value;
}
async function page(sessionId?: string): Promise<ReturnType<typeof vi.fn>> {
  mount(
    `<div id="session-region"><main data-cwd="/repo">${render(Composer({ ...(sessionId ? { sessionId } : { cwd: "/repo" }) }))}</main></div>`,
  );
  const submits = vi.fn((event: Event) => {
    event.preventDefault();
  });
  byId("composer").addEventListener("submit", submits);
  const { setUpComposer } = await import("@web/client/composer");
  setUpComposer();
  return submits;
}
async function record(): Promise<void> {
  click(button());
  await flush();
}
async function transcribe(): Promise<void> {
  click(button());
  await flush();
}

describe("composer dictation", () => {
  it("only records on demand, appends repeated recordings to current edits, and never submits", async () => {
    const submits = await page("s1");
    expect(permission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().type).toBe("button");
    expectButtonState("idle", "Record dictation");
    expect(button().nextElementSibling).toBe(query(".composer-action-primary"));
    expect(byId("dictation-status").getAttribute("role")).toBe("status");
    type(area(), "Keep this.");
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    click(button());
    expect(status()).toMatch(/permission/i);
    expectButtonState("permission", "Cancel dictation");
    await flush();
    expect(status()).toMatch(/recording/i);
    expectButtonState("recording", "Stop dictation");
    await transcribe();
    expect(status()).toMatch(/transcribing/i);
    expectButtonState("transcribing", "Transcribing dictation");
    expect(button().disabled).toBe(true);
    click(button());
    expect(permission).toHaveBeenCalledOnce();
    type(area(), "Edited while waiting.");
    pending.resolve(json({ text: "First dictation." }));
    await flush();
    expect(area().value).toBe("Edited while waiting. First dictation.");
    expectButtonState("idle", "Record dictation");
    await record();
    await transcribe();
    expect(area().value).toBe(
      "Edited while waiting. First dictation. dictated words",
    );
    expect(submits).not.toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalledTimes(2);
    expect(
      (query(".composer-action-primary") as HTMLButtonElement).disabled,
    ).toBe(false);
    vi.advanceTimersByTime(300);
    expect(localStorage.getItem("web-pi:draft:s1")).toBe(area().value);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/dictation/transcribe");
    expect(options?.method).toBe("POST");
    expect(options?.headers).toEqual({ "X-Web-Pi-Dictation": "1" });
    const body = options?.body as FormData;
    expect([...body.keys()]).toEqual(["file"]);
    const file = body.get("file") as File;
    expect(file.name).toBe("dictation.webm");
    expect(file.type).toBe("audio/webm");
  });

  it("cancels pending permission, closes a late stream, and permits a fresh attempt", async () => {
    const pending = Promise.withResolvers<MediaStream>();
    permission.mockReturnValueOnce(pending.promise);
    await page();
    click(button());
    click(button());
    expect(status()).toMatch(/canceled/i);
    expectButtonState("idle", "Record dictation");
    pending.resolve(stream);
    await flush();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await record();
    await transcribe();
    expect(area().value).toBe("dictated words");
  });

  const cancellations = [
    "submit",
    "request",
    "pagehide",
    "hidden",
    "owner cleanup",
    "textarea replacement",
    "navigation link",
    "navigation request",
  ] as const;
  async function cancel(reason: (typeof cancellations)[number]): Promise<void> {
    switch (reason) {
      case "submit":
        (byId("composer") as HTMLFormElement).requestSubmit();
        break;
      case "request":
        htmxEvent(byId("composer"), "htmx:before:request", { ctx: {} });
        break;
      case "pagehide":
        dispatchEvent(new Event("pagehide"));
        break;
      case "hidden":
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
        break;
      case "owner cleanup":
        htmxEvent(byId("composer"), "htmx:before:cleanup");
        byId("composer").outerHTML = render(Composer({ cwd: "/other" }));
        htmxEvent(byId("composer"), "htmx:after:process");
        break;
      case "textarea replacement":
        area().outerHTML = render(ComposerText({ draft: "Recalled draft" }));
        break;
      case "navigation link": {
        const { setUpNavigation } = await import("@web/client/navigation");
        setUpNavigation();
        document.body.insertAdjacentHTML(
          "beforeend",
          '<a data-session-link href="/sessions/other">Other</a>',
        );
        click(query("[data-session-link]"));
        break;
      }
      case "navigation request": {
        const { setUpNavigation } = await import("@web/client/navigation");
        setUpNavigation();
        htmxEvent(document.body, "htmx:before:request", {
          ctx: {
            target: byId("session-region"),
            request: {
              action: "/new?cwd=/other",
              signal: new AbortController().signal,
              headers: {},
            },
          },
        });
      }
    }
    await flush();
  }

  it.each(cancellations)(
    "discards recording and releases microphone on %s",
    async (reason) => {
      await page();
      type(area(), "Original draft");
      await record();
      const old = recorder();
      await cancel(reason);
      expect(trackStop).toHaveBeenCalledOnce();
      expect(old.state).toBe("inactive");
      vi.advanceTimersByTime(DICTATION_MAX_RECORDING_MS);
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(area().value).not.toContain("dictated words");
    },
  );

  it.each(cancellations.filter((reason) => reason !== "hidden"))(
    "ignores a late transcription after %s even when fetch ignores abort",
    async (reason) => {
      const pending = Promise.withResolvers<Response>();
      fetchMock.mockReturnValueOnce(pending.promise);
      await page();
      await record();
      await transcribe();
      const abort = fetchMock.mock.calls[0]?.[1]?.signal;
      await cancel(reason);
      expect(abort?.aborted).toBe(true);
      type(area(), "Current draft");
      pending.resolve(json({ text: "Obsolete dictation" }));
      await flush();
      expect(area().value).toBe("Current draft");
      vi.advanceTimersByTime(300);
      expect(
        localStorage.getItem(
          reason === "owner cleanup"
            ? "web-pi:draft:new:/other"
            : "web-pi:draft:new:/repo",
        ),
      ).toBe("Current draft");
    },
  );

  it.each([
    ["ArrowUp", "permission"],
    ["ArrowUp", "recording"],
    ["ArrowUp", "transcribing"],
    ["ArrowDown", "permission"],
    ["ArrowDown", "recording"],
    ["ArrowDown", "transcribing"],
  ] as const)(
    "cancels %s history restoration during %s on the same textarea",
    async (key, phase) => {
      const pendingPermission = Promise.withResolvers<MediaStream>();
      const pendingResponse = Promise.withResolvers<Response>();
      if (phase === "permission")
        permission.mockReturnValueOnce(pendingPermission.promise);
      if (phase === "transcribing")
        fetchMock.mockReturnValueOnce(pendingResponse.promise);
      await page("s1");
      query("main").insertAdjacentHTML(
        "afterbegin",
        "<div data-user-text>Earlier prompt</div>",
      );
      const field = area();
      if (key === "ArrowDown") keydown(field, "ArrowUp");
      if (phase === "permission") click(button());
      else {
        await record();
        if (phase === "transcribing") await transcribe();
      }
      const abort = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(keydown(field, key).defaultPrevented).toBe(true);
      expect(area()).toBe(field);
      const restored = key === "ArrowUp" ? "Earlier prompt" : "";
      expect(field.value).toBe(restored);
      if (phase === "permission") {
        pendingPermission.resolve(stream);
        await flush();
        expect(trackStop).toHaveBeenCalledOnce();
        expect(Recorder.instances).toHaveLength(0);
      } else if (phase === "recording") {
        expect(trackStop).toHaveBeenCalledOnce();
        expect(recorder().state).toBe("inactive");
      } else {
        pendingResponse.resolve(json({ text: "Obsolete speech" }));
        await flush();
        expect(field.value).toBe(restored);
        expect(abort?.aborted).toBe(true);
      }
      vi.advanceTimersByTime(DICTATION_MAX_RECORDING_MS);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(phase === "transcribing" ? 1 : 0);
      expect(field.value).toBe(restored);
      expect(localStorage.getItem("web-pi:draft:s1")).toBe(restored || null);
      expect(button().disabled).toBe(false);
    },
  );

  it("keeps pending dictation through typing and arrow keys that do not restore history", async () => {
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await page("s1");
    query("main").insertAdjacentHTML(
      "afterbegin",
      "<div data-user-text>Earlier prompt</div>",
    );
    await record();
    await transcribe();
    type(area(), "Ordinary edit");
    expect(keydown(area(), "ArrowUp").defaultPrevented).toBe(false);
    expect(keydown(area(), "ArrowDown").defaultPrevented).toBe(false);
    pending.resolve(json({ text: "New speech" }));
    await flush();
    expect(area().value).toBe("Ordinary edit New speech");
  });

  it("closes a canceled permission stream without disturbing a newer recording", async () => {
    const pending = Promise.withResolvers<MediaStream>();
    const oldTrackStop = vi.fn();
    permission.mockReturnValueOnce(pending.promise);
    await page();
    click(button());
    click(button());
    await record();
    pending.resolve({
      getTracks: () => [{ stop: oldTrackStop }],
    } as unknown as MediaStream);
    await flush();
    expect(oldTrackStop).toHaveBeenCalledOnce();
    expect(trackStop).not.toHaveBeenCalled();
    expect(Recorder.instances).toHaveLength(1);
    expect(status()).toMatch(/recording/i);
    expect(fetchMock).not.toHaveBeenCalled();
    await transcribe();
    expect(area().value).toBe("dictated words");
  });

  it("does not upload when submission happens before the recorder's final chunk", async () => {
    await page();
    await record();
    click(button());
    (byId("composer") as HTMLFormElement).requestSubmit();
    await flush();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(area().value).toBe("");
  });

  it("rejects empty audio before contacting the transcription service", async () => {
    await page();
    await record();
    recorder().stop.mockImplementationOnce(() => {
      recorder().state = "inactive";
      recorder().dispatchEvent(new Event("stop"));
    });
    await transcribe();
    expect(errorStatus()).toMatch(/recording is empty/i);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });

  it("keeps a late permission result out of a new textarea", async () => {
    const pending = Promise.withResolvers<MediaStream>();
    permission.mockReturnValueOnce(pending.promise);
    await page();
    click(button());
    area().outerHTML = render(ComposerText({ draft: "Rewound" }));
    pending.resolve(stream);
    await flush();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
    expect(area().value).toBe("Rewound");
  });

  it("stops and transcribes at the duration limit without submitting", async () => {
    const submits = await page();
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await record();
    vi.advanceTimersByTime(DICTATION_MAX_RECORDING_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(status()).toMatch(/limit reached.*transcribing/i);
    expect(trackStop).toHaveBeenCalledOnce();
    await flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    pending.resolve(json({ text: "At the limit" }));
    await flush();
    expect(area().value).toBe("At the limit");
    expect(submits).not.toHaveBeenCalled();
  });

  it("discards accumulated audio over the byte cap and allows retry", async () => {
    await page();
    await record();
    recorder().data(new Blob([new Uint8Array(DICTATION_MAX_BYTES)]));
    expect(trackStop).not.toHaveBeenCalled();
    recorder().data(new Blob(["x"]));
    await flush();
    expect(errorStatus()).toMatch(/20 MiB limit/i);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
    await record();
    await transcribe();
    expect(area().value).toBe("dictated words");
  });

  it("discards a final chunk that takes the recording over the byte cap", async () => {
    await page();
    await record();
    recorder().data(new Blob([new Uint8Array(DICTATION_MAX_BYTES)]));
    await transcribe();
    expect(errorStatus()).toMatch(/20 MiB limit/i);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses MP4 when WebM is unavailable, with a matching file type and extension", async () => {
    Recorder.isTypeSupported.mockImplementation(
      (mime) => mime === "audio/mp4;codecs=mp4a.40.2",
    );
    await page();
    await record();
    expect(recorder().mimeType).toBe("audio/mp4;codecs=mp4a.40.2");
    await transcribe();
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    const file = body.get("file") as File;
    expect(file.type).toBe("audio/mp4");
    expect(file.name).toBe("dictation.mp4");
  });

  it.each(["insecure", "missing API", "unsupported container"])(
    "explains %s without requesting permission",
    async (reason) => {
      if (reason === "insecure") vi.stubGlobal("isSecureContext", false);
      if (reason === "missing API") vi.stubGlobal("MediaRecorder", undefined);
      if (reason === "unsupported container")
        Recorder.isTypeSupported.mockReturnValue(false);
      await page();
      await record();
      expect(errorStatus()).toMatch(
        reason === "insecure"
          ? /secure connection/i
          : reason === "missing API"
            ? /not support/i
            : /WebM or MP4/i,
      );
      expect(permission).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reports denied permission and allows retry", async () => {
    permission.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    await page();
    await record();
    expect(errorStatus()).toMatch(/permission denied/i);
    expect(button().disabled).toBe(false);
    await record();
    await transcribe();
    expect(area().value).toBe("dictated words");
  });

  it("distinguishes recording errors from transcription failure and stops the microphone", async () => {
    await page();
    await record();
    recorder().dispatchEvent(new Event("error"));
    expect(errorStatus()).toMatch(/recording failed/i);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    await record();
    await transcribe();
    expect(area().value).toBe("dictated words");
  });

  it.each(["API", "network", "invalid response", "empty speech"])(
    "reports %s failure without changing the draft and allows retry",
    async (reason) => {
      if (reason === "API")
        fetchMock.mockResolvedValueOnce(
          json({ error: "Dictation needs OPENAI_API_KEY." }, 503),
        );
      if (reason === "network")
        fetchMock.mockRejectedValueOnce(new TypeError("offline"));
      if (reason === "invalid response")
        fetchMock.mockResolvedValueOnce(json({ text: 4 }));
      if (reason === "empty speech")
        fetchMock.mockResolvedValueOnce(json({ text: "  " }));
      await page();
      type(area(), "Keep my draft");
      await record();
      await transcribe();
      expect(errorStatus()).toMatch(
        reason === "API"
          ? /OPENAI_API_KEY/
          : reason === "empty speech"
            ? /No speech/i
            : /Could not transcribe/i,
      );
      expect(area().value).toBe("Keep my draft");
      expect(button().disabled).toBe(false);
      await record();
      expectButtonState("recording", "Stop dictation");
      await transcribe();
      expect(area().value).toBe("Keep my draft dictated words");
      expectButtonState("idle", "Record dictation");
    },
  );
});
