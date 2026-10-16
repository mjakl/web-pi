import { DICTATION_MAX_REQUEST_BYTES, DictationError } from "@core/dictation";
import type { RouteContext, WebApp } from "@web/routes/shared";
import { bodyLimit } from "hono/body-limit";

export function dictationRoutes(app: WebApp, { deps }: RouteContext): void {
  // Admission covers upload buffering too, not just the paid upstream request.
  let active = false;
  const limit = bodyLimit({
    maxSize: DICTATION_MAX_REQUEST_BYTES,
    onError: (c) =>
      c.json({ error: "The recording upload is too large." }, 413),
  });

  app.post(
    "/dictation/transcribe",
    async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (
        c.req.header("X-Web-Pi-Dictation") !== "1" ||
        c.req.header("Sec-Fetch-Site") === "cross-site"
      ) {
        return c.json(
          { error: "Dictation requires a same-origin recording request." },
          403,
        );
      }
      if (active) {
        return c.json(
          {
            error: "Another recording is being transcribed. Try again shortly.",
          },
          429,
        );
      }
      if (
        !/^multipart\/form-data(?:;|$)/i.test(
          c.req.header("Content-Type") ?? "",
        )
      ) {
        return c.json(
          { error: "Send the recording as multipart form data." },
          415,
        );
      }
      active = true;
      try {
        // Hono otherwise trusts Content-Length and skips the streamed-byte check.
        const headers = new Headers(c.req.raw.headers);
        headers.delete("Content-Length");
        c.req.raw = new Request(c.req.raw, { headers });
        return await limit(c, next);
      } catch {
        return c.json({ error: "Cannot read the recording upload." }, 400);
      } finally {
        active = false;
      }
    },
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.raw.formData();
      } catch {
        return c.json({ error: "Cannot read the recording upload." }, 400);
      }
      const file = form.get("file");
      if (!(file instanceof File) || [...form.keys()].length !== 1) {
        return c.json(
          { error: "Include one audio recording in the file field." },
          400,
        );
      }
      try {
        const text = await deps.workspace.transcribe(file, c.req.raw.signal);
        return c.json({ text });
      } catch (error) {
        if (error instanceof DictationError) {
          return c.json({ error: error.message }, error.status);
        }
        return c.json({ error: "Cannot transcribe this recording." }, 502);
      }
    },
  );
}
