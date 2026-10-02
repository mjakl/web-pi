import { setUpRegion } from "./lifecycle.ts";

type Result = {
  error?: string;
  answer?: string;
  generation?: number;
  finalized?: boolean;
};
type VoiceAttempt = {
  epoch: number;
  requests: Set<Promise<Result>>;
  stopping?: Promise<void>;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  microphone?: MediaStream;
  audio?: HTMLAudioElement;
  meter?: AudioContext;
  animation: number;
  timer?: ReturnType<typeof setTimeout>;
  generation?: number;
  muted: boolean;
  speechStopped: boolean;
  playbackSequence: number;
};

export function setUpCoordinator(): void {
  setUpRegion("#coordinator", (owner, signal) => {
    function query(selector: string, root: ParentNode = owner): HTMLElement {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing coordinator element: ${selector}`);
      return element;
    }
    const error = query(".coordinator-panel > .coordinator-error");
    const playback = query(".coordinator-playback");
    const draft = query("#coordinator-draft") as HTMLTextAreaElement;
    const form = query(".coordinator-compose") as HTMLFormElement;
    let stream: EventSource | undefined;
    let voice: VoiceAttempt | undefined;
    let mediaEpoch = 0;
    let pending: Promise<unknown> | undefined;
    let disposed = false;
    let ownsConversation = false;
    let active = false;
    const button = (name: string) =>
      query(`[data-coordinator="${name}"]`) as HTMLButtonElement;
    const showError = (reason: unknown) => {
      error.textContent =
        reason instanceof Error
          ? reason.message
          : "Coordinator request failed.";
    };
    function current(attempt: VoiceAttempt): boolean {
      return (
        voice === attempt &&
        attempt.epoch === mediaEpoch &&
        !disposed &&
        !signal.aborted
      );
    }
    function run(operation: () => Promise<unknown>) {
      const task = Promise.resolve().then(operation);
      pending = task;
      controls();
      void task
        .catch((reason: unknown) => {
          if (pending === task) showError(reason);
        })
        .finally(() => {
          if (pending !== task) return;
          pending = undefined;
          controls();
        });
    }
    function controls() {
      const state = query(".coordinator-state");
      active = state.dataset["enabled"] === "true";
      const busy = !!pending || state.dataset["busy"] === "true";
      const capturing = voice && current(voice);
      button("begin").disabled = active || !!pending;
      button("voice").disabled = !!pending || !!voice;
      button("voice").hidden = !!capturing;
      button("mute").hidden = !capturing;
      button("end").disabled = !active;
      button("end").hidden = !active;
      button("begin").hidden = active;
      button("mute").disabled =
        !capturing || !voice?.microphone || !!voice.requests.size;
      button("speech").disabled = !capturing || !voice?.peer;
      button("end-voice").disabled = !capturing;
      button("captions").disabled = !active;
      (query('[type="submit"]', form) as HTMLButtonElement).disabled =
        !active || busy;
      query(".coordinator-indicator").textContent = capturing
        ? voice?.muted
          ? "muted"
          : "voice on"
        : voice
          ? "ending"
          : active
            ? "text on"
            : "off";
    }
    async function request(
      action: string,
      data: object = {},
      keepalive = false,
    ): Promise<Result> {
      const response = await fetch(`/coordinator/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive,
      });
      const result = (await response.json()) as Result;
      if (!response.ok) result.error ??= "Coordinator request failed.";
      return result;
    }
    async function post(
      action: string,
      data: object = {},
      keepalive = false,
    ): Promise<Result> {
      const result = await request(action, data, keepalive);
      if (result.error) throw new Error(result.error);
      return result;
    }
    async function voicePost(
      attempt: VoiceAttempt,
      action: string,
      data: object = {},
    ) {
      const response = request(action, data);
      attempt.requests.add(response);
      controls();
      const result = await response;
      // A received application rejection has settled. A transport failure has
      // an unknown remote outcome and stays in the drain set until teardown.
      attempt.requests.delete(response);
      if (result.error) throw new Error(result.error);
      return result;
    }
    function releaseMedia(attempt: VoiceAttempt) {
      if (voice === attempt) mediaEpoch++;
      clearTimeout(attempt.timer);
      cancelAnimationFrame(attempt.animation);
      try {
        if (attempt.channel?.readyState === "open")
          attempt.channel.send(JSON.stringify({ type: "session.close" }));
      } catch {
        /* Remote failure must not prevent local microphone release. */
      }
      attempt.channel?.close();
      attempt.channel = undefined;
      attempt.peer?.close();
      attempt.peer = undefined;
      attempt.microphone?.getTracks().forEach((track) => {
        track.stop();
      });
      attempt.microphone = undefined;
      attempt.audio?.pause();
      attempt.audio?.remove();
      attempt.audio = undefined;
      void attempt.meter?.close();
      attempt.meter = undefined;
      if (voice !== attempt) return;
      playback.textContent = "Microphone off. Speech off.";
      button("mute").textContent = "Mute microphone";
      button("speech").textContent = "Stop speaking";
      controls();
    }
    function closeMedia() {
      if (voice) releaseMedia(voice);
      voice = undefined;
      controls();
    }
    function endVoice(attempt = voice): Promise<void> {
      if (!attempt) return Promise.resolve();
      if (attempt.stopping) return attempt.stopping;
      releaseMedia(attempt);
      playback.textContent = "Microphone off. Finishing voice…";
      attempt.stopping = (async () => {
        const outcomes = await Promise.allSettled([...attempt.requests]);
        if (voice !== attempt || disposed || signal.aborted) return;
        const result = await post("end-voice");
        if (voice !== attempt) return;
        if (
          result.finalized !== true ||
          outcomes.some((outcome) => outcome.status === "rejected")
        )
          throw new Error(
            "Voice stopped locally; remote shutdown is unconfirmed. Use End before starting voice again.",
          );
        voice = undefined;
        playback.textContent = "Microphone off. Speech off.";
        controls();
      })().catch(() => {
        if (voice !== attempt) return;
        playback.textContent = "Microphone off. Remote shutdown unconfirmed.";
        showError(
          new Error(
            "Voice stopped locally; remote shutdown is unconfirmed. Use End before starting voice again.",
          ),
        );
        controls();
      });
      return attempt.stopping;
    }
    function frame(html: string) {
      const previous = query(".coordinator-state");
      const opened = new Map(
        [...previous.querySelectorAll("details")].map((details) => [
          details.className,
          details.open,
        ]),
      );
      const dialog = previous.querySelector<HTMLFormElement>(
        ".coordinator-dialog",
      );
      const value = dialog?.querySelector<
        HTMLTextAreaElement | HTMLSelectElement
      >('[name="value"]')?.value;
      const template = document.createElement("template");
      template.innerHTML = html;
      const next = template.content.firstElementChild as HTMLElement | null;
      if (!next?.matches(".coordinator-state")) return;
      for (const details of next.querySelectorAll("details"))
        if (opened.has(details.className))
          details.open = opened.get(details.className) === true;
      const nextDialog = next.querySelector<HTMLFormElement>(
        ".coordinator-dialog",
      );
      if (
        value !== undefined &&
        dialog?.dataset["revision"] === nextDialog?.dataset["revision"]
      ) {
        const input = nextDialog?.querySelector<
          HTMLTextAreaElement | HTMLSelectElement
        >('[name="value"]');
        if (input) input.value = value;
      }
      const focus = previous.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)
        : null;
      const fieldName = focus?.getAttribute("name");
      const focusedId = focus?.id;
      const selection =
        focus instanceof HTMLTextAreaElement
          ? [focus.selectionStart, focus.selectionEnd]
          : null;
      const log = previous.querySelector(".coordinator-log");
      const atTail =
        !log || log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      previous.replaceWith(next);
      const restored = focusedId
        ? next.querySelector<HTMLElement>(`#${focusedId}`)
        : fieldName === "value"
          ? nextDialog?.querySelector<HTMLElement>('[name="value"]')
          : null;
      restored?.focus({ preventScroll: true });
      if (selection && restored instanceof HTMLTextAreaElement)
        restored.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
      const nextLog = next.querySelector(".coordinator-log");
      if (nextLog)
        nextLog.scrollTop = atTail
          ? nextLog.scrollHeight
          : (log?.scrollTop ?? 0);
      controls();
      if (!active) {
        ownsConversation = false;
        stream?.close();
        stream = undefined;
        closeMedia();
      } else syncVoiceState();
    }
    function syncVoiceState() {
      const state = query(".coordinator-state");
      if (
        !voice ||
        !current(voice) ||
        voice.generation === undefined ||
        Number(state.dataset["voiceGeneration"]) !== voice.generation
      )
        return;
      if (state.dataset["voice"] === "off") void endVoice(voice);
      else {
        const sequence = Number(state.dataset["playbackSequence"]);
        if (sequence > voice.playbackSequence) {
          voice.playbackSequence = sequence;
          setPlayback(voice, state.dataset["playbackStopped"] === "true");
        }
      }
    }
    function listen() {
      stream?.close();
      const connection = new EventSource("/coordinator/events");
      stream = connection;
      connection.addEventListener("state", (event) => {
        if (stream === connection && !signal.aborted)
          frame((event as MessageEvent<string>).data);
      });
      connection.addEventListener("error", () => {
        if (stream !== connection) return;
        ownsConversation = false;
        connection.close();
        stream = undefined;
        closeMedia();
        query(".coordinator-state").dataset["enabled"] = "false";
        controls();
        showError(
          new Error(
            "Coordinator disconnected. Voice stopped; start again explicitly. No instructions were retried.",
          ),
        );
        void post("end").catch(() => {});
      });
    }
    function requireMicrophoneSupport() {
      if (
        !window.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === "undefined"
      )
        throw new Error(
          "Microphone capture requires HTTPS or localhost and browser WebRTC support. Plain remote HTTP is text-only.",
        );
    }
    async function startVoice(startedCoordinator: boolean) {
      requireMicrophoneSupport();
      if (voice) return;
      const attempt: VoiceAttempt = {
        epoch: ++mediaEpoch,
        requests: new Set(),
        animation: 0,
        muted: false,
        speechStopped: false,
        playbackSequence: 0,
      };
      voice = attempt;
      playback.textContent =
        "Connecting voice… Allow microphone access when asked.";
      controls();
      // SDP setup is not readiness: the provider must also start the session.
      async function failedStart(reason: unknown) {
        if (!current(attempt)) return;
        showError(reason);
        if (startedCoordinator) await endCoordinator();
        else await endVoice(attempt);
      }
      try {
        const capture = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        if (!current(attempt)) {
          capture.getTracks().forEach((track) => {
            track.stop();
          });
          return;
        }
        attempt.microphone = capture;
        capture.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        const connection = new RTCPeerConnection();
        attempt.peer = connection;
        const output = document.createElement("audio");
        attempt.audio = output;
        output.autoplay = true;
        output.hidden = true;
        owner.append(output);
        connection.addEventListener("track", (event) => {
          if (!current(attempt)) return;
          const remote = event.streams[0] ?? new MediaStream([event.track]);
          output.srcObject = remote;
          void output.play().catch(() => {
            if (!current(attempt)) return;
            showError(
              new Error(
                "Audio playback was blocked. Use End, then Start voice again.",
              ),
            );
          });
          // Show speaking from received audio energy, not transcript arrival or
          // a provider append acknowledgment (neither proves playback).
          try {
            const meter = new AudioContext();
            attempt.meter = meter;
            const analyser = meter.createAnalyser();
            analyser.fftSize = 256;
            meter.createMediaStreamSource(remote).connect(analyser);
            const samples = new Float32Array(analyser.fftSize);
            const measure = () => {
              if (!current(attempt)) return;
              analyser.getFloatTimeDomainData(samples);
              const audible =
                !output.muted &&
                !output.paused &&
                samples.some((sample) => Math.abs(sample) > 0.015);
              playback.textContent = `${attempt.muted ? "Microphone muted" : "Listening"}. ${attempt.speechStopped ? "Speech stopped" : audible ? "Speaking" : "Voice ready"}.`;
              attempt.animation = requestAnimationFrame(measure);
            };
            attempt.animation = requestAnimationFrame(measure);
          } catch {
            playback.textContent =
              "Voice connected. Captions do not confirm playback.";
          }
        });
        capture
          .getTracks()
          .forEach((track) => connection.addTrack(track, capture));
        const channel = connection.createDataChannel("oai-events");
        attempt.channel = channel;
        channel.addEventListener("message", (event) => {
          if (!current(attempt)) return;
          let data: { type?: string };
          try {
            data = JSON.parse(String(event.data)) as { type?: string };
          } catch {
            return;
          }
          if (data.type === "session.started") {
            clearTimeout(attempt.timer);
            capture.getAudioTracks().forEach((track) => {
              track.enabled = !attempt.muted;
            });
            playback.textContent = "Listening. Voice ready.";
          } else if (data.type === "session.closed") void endVoice(attempt);
          else if (data.type === "error")
            showError(
              new Error(
                "OpenAI voice reported an error. Use End before trying again.",
              ),
            );
        });
        connection.addEventListener("connectionstatechange", () => {
          if (
            current(attempt) &&
            (connection.connectionState === "failed" ||
              connection.connectionState === "disconnected")
          ) {
            void endVoice(attempt);
            showError(
              new Error(
                "Voice connection lost. Start it again explicitly after shutdown; no work was retried.",
              ),
            );
          }
        });
        await connection.setLocalDescription(await connection.createOffer());
        if (connection.iceGatheringState !== "complete")
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("WebRTC setup timed out."));
            }, 8000);
            connection.addEventListener("icegatheringstatechange", () => {
              if (connection.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        if (!current(attempt)) return;
        const result = await voicePost(attempt, "voice", {
          offer: connection.localDescription?.sdp,
        });
        if (!current(attempt)) return;
        if (
          !result.answer ||
          !Number.isSafeInteger(result.generation) ||
          (result.generation ?? 0) < 1
        )
          throw new Error("OpenAI returned no valid voice connection.");
        attempt.generation = result.generation;
        // SSE and startup HTTP can arrive in either order. Only a state for
        // this server generation may close this attempt.
        syncVoiceState();
        if (!current(attempt)) return;
        attempt.timer = setTimeout(() => {
          if (!current(attempt)) return;
          run(() =>
            failedStart(
              new Error(
                "OpenAI voice did not become ready. No connection was retried.",
              ),
            ),
          );
        }, 15000);
        await connection.setRemoteDescription({
          type: "answer",
          sdp: result.answer,
        });
      } catch (reason) {
        await failedStart(reason);
      }
      if (voice === attempt) controls();
    }
    async function begin() {
      disposed = false;
      await post("begin");
      ownsConversation = true;
      if (disposed || signal.aborted) {
        dispose();
        return false;
      }
      query(".coordinator-state").dataset["enabled"] = "true";
      controls();
      listen();
      return true;
    }
    async function endCoordinator() {
      ownsConversation = false;
      closeMedia();
      stream?.close();
      stream = undefined;
      query(".coordinator-state").dataset["enabled"] = "false";
      playback.textContent = "Microphone off. Ending…";
      controls();
      try {
        const result = await post("end");
        playback.textContent = "Microphone off. Speech off.";
        if (result.finalized === false)
          showError(
            new Error(
              "Coordinator ended locally; provider finalization is unconfirmed.",
            ),
          );
      } catch (reason) {
        playback.textContent = "Microphone off. Remote shutdown unconfirmed.";
        throw reason;
      }
    }
    function setPlayback(attempt: VoiceAttempt, stopped: boolean) {
      attempt.speechStopped = stopped;
      if (attempt.audio) attempt.audio.muted = stopped;
      button("speech").textContent = stopped
        ? "Resume speech"
        : "Stop speaking";
    }
    async function action(name: string) {
      error.textContent = "";
      if (name === "end") await endCoordinator();
      else if (name === "end-voice") await endVoice();
      else if (name === "speech") {
        const attempt = voice;
        if (!attempt || !current(attempt)) return;
        setPlayback(attempt, !attempt.speechStopped);
      } else if (name === "mute") {
        const attempt = voice;
        if (!attempt || !current(attempt) || attempt.requests.size) return;
        attempt.muted = !attempt.muted;
        attempt.microphone?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        try {
          await voicePost(attempt, "mute", { muted: attempt.muted });
          if (!current(attempt)) return;
          attempt.microphone?.getAudioTracks().forEach((track) => {
            track.enabled = !attempt.muted;
          });
          button("mute").textContent = attempt.muted
            ? "Unmute microphone"
            : "Mute microphone";
          playback.textContent = attempt.muted
            ? "Microphone muted."
            : "Listening. Voice ready.";
        } catch (reason) {
          if (!current(attempt)) return;
          showError(reason);
          await endVoice(attempt);
        }
      } else if (name === "captions") {
        const text =
          owner.querySelector("[data-coordinator-input]")?.textContent ?? "";
        draft.value = text === "Waiting for speech…" ? "" : text;
        draft.focus();
      } else if (name === "voice") {
        requireMicrophoneSupport();
        const startedCoordinator = !active;
        if (startedCoordinator && !(await begin())) return;
        await startVoice(startedCoordinator);
      } else if (name === "begin") {
        if (await begin()) playback.textContent = "Text ready. Microphone off.";
      }
      controls();
    }
    owner.addEventListener(
      "click",
      (event) => {
        const source = (event.target as Element).closest<HTMLElement>(
          "[data-coordinator]",
        );
        const name = source?.dataset["coordinator"];
        if (!source || !name) return;
        // End and playback controls remain independent of a slow provider request.
        if (pending && !["end", "end-voice", "speech", "mute"].includes(name))
          return;
        run(() => action(name));
      },
      { signal },
    );
    owner.addEventListener(
      "change",
      (event) => {
        if (
          !(event.target instanceof HTMLSelectElement) ||
          event.target.id !== "coordinator-target"
        )
          return;
        const target = event.target.value;
        run(() => post("select", { target }));
      },
      { signal },
    );
    owner.addEventListener(
      "submit",
      (event) => {
        const submitted = event.target;
        if (!(submitted instanceof HTMLFormElement)) return;
        event.preventDefault();
        if (pending) return;
        const data = new FormData(submitted);
        let operation: Promise<Result>;
        if (submitted === form) {
          operation = post("request", {
            text: draft.value,
            target:
              owner.querySelector<HTMLSelectElement>("#coordinator-target")
                ?.value ?? "",
          });
        } else if (submitted.matches(".coordinator-dialog")) {
          const submitter = event.submitter as HTMLButtonElement | null;
          operation = post("answer", {
            revision: submitted.dataset["revision"],
            request: submitted.dataset["request"],
            ...(submitter?.name === "confirmed"
              ? { confirmed: submitter.value === "true" }
              : { value: data.get("value") }),
          });
        } else return;
        run(() => operation);
      },
      { signal },
    );
    function dispose() {
      disposed = true;
      query(".coordinator-state").dataset["enabled"] = "false";
      closeMedia();
      stream?.close();
      stream = undefined;
      if (ownsConversation) {
        ownsConversation = false;
        void post("end", {}, true).catch(() => {});
      }
    }
    signal.addEventListener("abort", dispose, { once: true });
    window.addEventListener("pagehide", dispose, { signal });
    controls();
  });
}
