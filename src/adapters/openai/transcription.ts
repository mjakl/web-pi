import { DictationError } from "@core/dictation";
import type { AudioTranscriber } from "@core/ports";

const TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT_MS = 180_000;

export function createOpenAITranscriber(apiKey: string): AudioTranscriber {
  return {
    async transcribe(file, signal) {
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort();
      }, TRANSCRIPTION_TIMEOUT_MS);
      timer.unref();
      try {
        signal.throwIfAborted();
        const body = new FormData();
        body.set("file", file);
        body.set("model", "gpt-transcribe");
        body.set("response_format", "json");
        const response = await fetch(TRANSCRIPTION_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.any([signal, timeout.signal]),
          redirect: "error",
        });
        if (!response.ok) {
          // Provider errors may contain private inputs. Never read or forward them.
          await response.body?.cancel();
          if (response.status === 429) {
            throw new DictationError(
              "Dictation provider is busy. Try again later.",
              503,
            );
          }
          throw new DictationError(
            "Dictation provider could not transcribe this recording.",
            502,
          );
        }
        const result: unknown = await response.json();
        if (
          typeof result !== "object" ||
          result === null ||
          !("text" in result) ||
          typeof result.text !== "string"
        ) {
          throw new DictationError(
            "Dictation provider returned an invalid response.",
            502,
          );
        }
        return result.text;
      } catch (error) {
        if (signal.aborted)
          throw new DictationError("Dictation was cancelled.", 400);
        if (timeout.signal.aborted)
          throw new DictationError(
            "Dictation timed out. Try a shorter recording.",
            504,
          );
        if (error instanceof DictationError) throw error;
        throw new DictationError(
          "Cannot reach the dictation provider. Try again later.",
          502,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
