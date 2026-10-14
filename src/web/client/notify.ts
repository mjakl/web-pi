// Completion tones follow server events. System notifications belong solely
// to the push subscription, so an unsubscribed browser stays unsubscribed.

import { soundEnabled } from "./preferences.ts";

let audio: AudioContext | undefined;

/**
 * Browsers refuse to start audio before the reader has interacted with the
 * page, and a context created too early is stuck suspended. One is made on the
 * first gesture and reused; `resume` covers a context suspended since.
 */
function unlock(): void {
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
}

/** Two notes, a third apart, short enough not to be in the way. */
export function playDone(): void {
  if (!soundEnabled()) return;
  unlock();
  const context = audio;
  if (!context || context.state !== "running") return;
  for (const [index, frequency] of [523.25, 659.25].entries()) {
    const start = context.currentTime + index * 0.18;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.45);
  }
}

function setUpCompletion(): void {
  document.body.addEventListener("done", (event) => {
    const id = (event as CustomEvent<{ data?: unknown }>).detail?.data;
    if (typeof id !== "string" || !id.trim()) return;
    playDone();
  });
  document.body.addEventListener("htmx:after:settle", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // A dialog an extension just opened is the other thing worth interrupting
    // for: the turn is blocked until someone answers it.
    if (target.id === "extension-dialog" && target.querySelector("dialog")) {
      playDone();
    }
  });
}

/**
 * A run that completed in another session: the tone belongs to it too,
 * because the whole point of leaving a session running is not having to
 * watch it. The sidebar stream reports completions by the same rule as the
 * session stream's `done`, so a shell command, a failed prompt or an abort
 * stays quiet. The one on screen already rang through `done`.
 */
function setUpBackgroundCompletion(): void {
  document.body.addEventListener("completed", (event) => {
    const text = (event as CustomEvent<{ data?: unknown }>).detail?.data;
    if (typeof text !== "string") return;
    let finished: { id?: string } = {};
    try {
      finished = JSON.parse(text) as typeof finished;
    } catch {
      return;
    }
    if (!finished || typeof finished.id !== "string") return;
    const current =
      document.querySelector("main")?.getAttribute("data-session-id") ?? "";
    if (finished.id && finished.id !== current) playDone();
  });
}

export function setUpNotifications(): void {
  for (const event of ["pointerdown", "keydown"] as const) {
    document.addEventListener(event, unlock, { once: true, passive: true });
  }
  setUpCompletion();
  setUpBackgroundCompletion();
}
