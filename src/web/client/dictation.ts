import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_RECORDING_MS,
} from "@core/dictation";
import { setComposerValue } from "./editor.ts";
import { NAVIGATION_INTENT_EVENT, navigationIntent } from "./navigation.ts";

type Operation = {
  area: HTMLTextAreaElement;
  intent: number;
  phase: "permission" | "recording" | "transcribing";
  controller: AbortController;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  chunks: Blob[];
  bytes: number;
};

/** Owns microphone work for this form; cancel before restoring a draft in place. */
export function setUpDictation(
  form: HTMLElement,
  signal: AbortSignal,
): () => void {
  const button = form.querySelector<HTMLButtonElement>("#dictation-button");
  const status = form.querySelector<HTMLElement>("#dictation-status");
  if (!button || !status) return () => {};
  const area = () => form.querySelector<HTMLTextAreaElement>("#composer-text");
  let active: Operation | undefined;

  const display = (message: string, error = false): void => {
    status.textContent = message;
    status.classList.toggle("is-error", error);
    button.disabled = active?.phase === "transcribing";
    const state = active?.phase ?? "idle";
    const label = {
      idle: "Record dictation",
      permission: "Cancel dictation",
      recording: "Stop dictation",
      transcribing: "Transcribing dictation",
    }[state];
    for (const icon of button.querySelectorAll<HTMLElement>(
      "[data-dictation-icon]",
    )) {
      icon.hidden = icon.dataset["dictationIcon"] !== state;
    }
    button.setAttribute("aria-label", label);
    button.title = label;
    button.classList.toggle("is-recording", active?.phase === "recording");
  };

  function stopTracks(operation: Operation): void {
    operation.stream?.getTracks().forEach((track) => {
      track.stop();
    });
    delete operation.stream;
    clearTimeout(operation.timer);
    delete operation.timer;
  }

  function finish(message = "Dictation canceled.", error = false): void {
    const operation = active;
    active = undefined;
    if (operation) {
      operation.controller.abort();
      stopTracks(operation);
      if (operation.recorder?.state !== "inactive") operation.recorder?.stop();
      operation.chunks = [];
    }
    display(message, error);
  }

  const current = (operation: Operation): boolean =>
    active === operation &&
    !signal.aborted &&
    form.isConnected &&
    area() === operation.area &&
    navigationIntent() === operation.intent;

  async function upload(operation: Operation, type: string): Promise<void> {
    if (!current(operation)) return;
    stopTracks(operation);
    if (operation.bytes === 0) {
      finish("The recording is empty. Please try again.", true);
      return;
    }
    const file = new File(
      operation.chunks,
      `dictation.${type === "audio/mp4" ? "mp4" : "webm"}`,
      { type },
    );
    operation.chunks = [];
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch("/dictation/transcribe", {
        method: "POST",
        headers: { "X-Web-Pi-Dictation": "1" },
        body,
        signal: operation.controller.signal,
      });
      const result = (await response.json()) as {
        text?: unknown;
        error?: unknown;
      };
      if (!current(operation)) return;
      if (!response.ok) {
        finish(
          typeof result.error === "string"
            ? result.error
            : "Could not transcribe the recording. Please try again.",
          true,
        );
        return;
      }
      if (typeof result.text !== "string")
        throw new Error("Invalid transcription response");
      const text = result.text.trim();
      if (!text) {
        finish("No speech was found. Please try again.", true);
        return;
      }
      // Read at completion, not at record time: edits made while waiting win.
      const value = operation.area.value;
      setComposerValue(
        operation.area,
        value + (value && !/\s$/.test(value) ? " " : "") + text,
      );
      finish("Dictation added. Review before sending.");
    } catch {
      if (current(operation))
        finish(
          "Could not transcribe the recording. Check your connection and try again.",
          true,
        );
    }
  }

  function stop(operation: Operation, limit = false): void {
    if (!current(operation)) return;
    operation.phase = "transcribing";
    display(limit ? "2 minute limit reached. Transcribing…" : "Transcribing…");
    try {
      operation.recorder?.stop();
      stopTracks(operation);
    } catch {
      finish("Recording failed. Check your microphone and try again.", true);
    }
  }

  async function start(): Promise<void> {
    if (!globalThis.isSecureContext) {
      display(
        "Dictation needs a secure connection (HTTPS or localhost).",
        true,
      );
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      display(
        "This browser does not support microphone recording. Try a current browser.",
        true,
      );
      return;
    }
    const mime = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mime) {
      display(
        "This browser cannot record WebM or MP4 audio for dictation.",
        true,
      );
      return;
    }
    const field = area();
    if (!field) return;
    const operation: Operation = {
      area: field,
      intent: navigationIntent(),
      phase: "permission",
      controller: new AbortController(),
      chunks: [],
      bytes: 0,
    };
    active = operation;
    display("Requesting microphone permission… Click again to cancel.");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (current(operation))
        finish(
          error instanceof Error && error.name === "NotAllowedError"
            ? "Microphone permission denied. Allow microphone access to dictate."
            : "Could not access your microphone. Check it is connected and available.",
          true,
        );
      return;
    }
    if (!current(operation)) {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      return;
    }
    operation.stream = stream;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      operation.recorder = recorder;
      const type = recorder.mimeType.split(";", 1)[0];
      if (type !== "audio/webm" && type !== "audio/mp4")
        throw new Error("Unsupported recording format");
      recorder.addEventListener("dataavailable", (event) => {
        if (!current(operation)) return;
        operation.bytes += event.data.size;
        if (operation.bytes > DICTATION_MAX_BYTES) {
          finish(
            "Recording exceeds the 20 MiB limit. Try a shorter recording.",
            true,
          );
          return;
        }
        operation.chunks.push(event.data);
      });
      recorder.addEventListener("error", () => {
        if (current(operation))
          finish(
            "Recording failed. Check your microphone and try again.",
            true,
          );
      });
      recorder.addEventListener("stop", () => {
        if (!current(operation)) return;
        if (operation.phase !== "transcribing") {
          finish("Recording stopped unexpectedly. Please try again.", true);
          return;
        }
        void upload(operation, type);
      });
      recorder.start(1000);
      operation.phase = "recording";
      display(
        "Recording… Click again to stop and transcribe (2 minute limit).",
      );
      operation.timer = setTimeout(() => {
        stop(operation, true);
      }, DICTATION_MAX_RECORDING_MS);
    } catch {
      finish("Recording failed. Check your microphone and try again.", true);
    }
  }

  button.addEventListener(
    "click",
    () => {
      if (active?.phase === "permission") finish();
      else if (active?.phase === "recording") stop(active);
      else if (!active) void start();
    },
    { signal },
  );
  const cancel = () => {
    if (active) finish();
  };
  form.addEventListener("submit", cancel, { signal, capture: true });
  form.addEventListener(
    "htmx:before:request",
    (event) => {
      if (event.target === form) cancel();
    },
    { signal },
  );
  signal.addEventListener("abort", cancel, { once: true });
  addEventListener("pagehide", cancel, { signal });
  document.addEventListener(NAVIGATION_INTENT_EVENT, cancel, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden && active?.phase !== "transcribing") cancel();
    },
    { signal },
  );
  // Recall/rewind can replace just the textarea without disposing this form.
  const observer = new MutationObserver(() => {
    if (active && (!form.isConnected || area() !== active.area)) cancel();
  });
  observer.observe(form, { childList: true, subtree: true });
  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
  display("");
  return cancel;
}
