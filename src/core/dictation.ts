export const DICTATION_MAX_BYTES = 20 * 1024 * 1024;
export const DICTATION_MAX_RECORDING_MS = 10 * 60_000;
export const DICTATION_MAX_REQUEST_BYTES = DICTATION_MAX_BYTES + 64 * 1024;

const RECORDING_FORMATS = [
  {
    mime: "audio/webm",
    extension: ".webm",
    signature: [0x1a, 0x45, 0xdf, 0xa3],
    offset: 0,
  },
  {
    mime: "audio/mp4",
    extension: ".mp4",
    signature: [102, 116, 121, 112],
    offset: 4,
  },
  {
    mime: "audio/wav",
    extension: ".wav",
    signature: [82, 73, 70, 70],
    offset: 0,
  },
  {
    mime: "audio/x-wav",
    extension: ".wav",
    signature: [82, 73, 70, 70],
    offset: 0,
  },
];

export async function validateRecording(file: File): Promise<void> {
  if (file.size === 0) throw new DictationError("The recording is empty.", 400);
  if (file.size > DICTATION_MAX_BYTES) {
    throw new DictationError("The recording exceeds the 20 MiB limit.", 413);
  }
  const mime = file.type.split(";", 1)[0]?.trim().toLowerCase();
  const format = RECORDING_FORMATS.find((entry) => entry.mime === mime);
  const unsupported = () =>
    new DictationError("Use a WebM, MP4, or WAV audio recording.", 415);
  if (!format || !file.name.toLowerCase().endsWith(format.extension))
    throw unsupported();
  // Check the container signature, not just the caller's MIME and filename.
  // This does not decode audio or enforce the browser's duration cap.
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (
    !format.signature.every(
      (value, index) => bytes[format.offset + index] === value,
    )
  ) {
    throw unsupported();
  }
  if (
    format.extension === ".wav" &&
    ![87, 65, 86, 69].every((value, index) => bytes[8 + index] === value)
  ) {
    throw unsupported();
  }
}

export class DictationError extends Error {
  readonly status: 400 | 413 | 415 | 502 | 503 | 504;

  constructor(message: string, status: DictationError["status"]) {
    super(message);
    this.status = status;
    this.name = "DictationError";
  }
}
