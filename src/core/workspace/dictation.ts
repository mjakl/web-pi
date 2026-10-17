import { DictationError, validateRecording } from "@core/dictation";
import type { WorkspaceDeps } from "./deps.ts";

export function dictationUseCases(deps: WorkspaceDeps) {
  return {
    async transcribe(file: File, signal: AbortSignal): Promise<string> {
      if (!deps.transcription) {
        throw new DictationError(
          "Dictation is unavailable. Set OPENAI_API_KEY on the server.",
          503,
        );
      }
      await validateRecording(file);
      return deps.transcription.transcribe(file, signal);
    },
  };
}
