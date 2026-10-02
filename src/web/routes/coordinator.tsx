import { COORDINATOR_WINDOW_MS } from "@core/coordinator";
import type { DialogAnswer } from "@core/extension-ui";
import type { CoordinatorMode } from "@core/workspace/coordinator";
import { CoordinatorState } from "@web/views/Coordinator";
import { html, type RouteContext, type WebApp } from "@web/routes/shared";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";

const COOKIE = "web-pi-coordinator";
export function coordinatorRoutes(app: WebApp, { deps }: RouteContext) {
  const coordinator = deps.coordinator;
  app.use("/coordinator/*", bodyLimit({ maxSize: 65536 }));
  app.post("/coordinator/:action", async (c) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("Origin");
    let sameHost = true;
    try {
      sameHost = !origin || new URL(origin).host === new URL(c.req.url).host;
    } catch {
      sameHost = false;
    }
    if (
      !sameHost ||
      !c.req.header("Content-Type")?.startsWith("application/json")
    )
      return c.json({ error: "Same-host JSON requests are required." }, 403);
    if (!coordinator)
      return c.json(
        { error: "The OpenAI coordinator is unavailable in this server." },
        503,
      );
    try {
      const body: unknown = await c.req.json();
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Invalid coordinator request.");
      const data = body as Record<string, unknown>;
      const text = (name: string) => {
        const value = data[name];
        if (typeof value !== "string") throw new Error(`Missing ${name}.`);
        return value;
      };
      const action = c.req.param("action");
      if (action === "begin") {
        const key = await coordinator.begin();
        setCookie(c, COOKIE, key, {
          path: "/coordinator",
          httpOnly: true,
          sameSite: "Strict",
          secure:
            origin?.startsWith("https:") === true ||
            new URL(c.req.url).protocol === "https:",
          // Begin is the sole cookie writer. Cover both the text-only window
          // and a first voice connection just before that window expires.
          maxAge: (2 * COORDINATOR_WINDOW_MS) / 1000,
        });
        return c.json({ ok: true });
      }
      const key = getCookie(c, COOKIE) ?? "";
      if (action === "end") {
        const finalized = await coordinator.end(key);
        // end() revokes the token. Late cookie deletion could erase a newer Begin.
        return c.json({ ok: true, finalized });
      }
      if (action === "voice") {
        const offer = text("offer");
        if (!offer.startsWith("v=0") || offer.length > 60000)
          throw new Error("Invalid WebRTC offer.");
        return c.json(await coordinator.connect(key, offer));
      }
      if (action === "end-voice")
        return c.json({ ok: true, finalized: await coordinator.endVoice(key) });
      if (action === "mute") {
        if (typeof data["muted"] !== "boolean")
          throw new Error("Invalid microphone state.");
        coordinator.mute(key, data["muted"]);
      } else if (action === "select")
        await coordinator.select(key, text("target"));
      else if (action === "request") {
        const mode = data["mode"];
        if (
          mode !== undefined &&
          (typeof mode !== "string" ||
            !["prompt", "steer", "followUp"].includes(mode))
        )
          throw new Error("Choose a delivery mode.");
        await coordinator.request(
          key,
          text("text"),
          text("target"),
          mode as CoordinatorMode | undefined,
        );
      } else if (action === "answer") {
        let answer: DialogAnswer;
        if (typeof data["confirmed"] === "boolean")
          answer = { confirmed: data["confirmed"] };
        else {
          const value = text("value");
          if (value.length > 6000) throw new Error("Answer is too long.");
          answer = { value };
        }
        await coordinator.answer(
          key,
          text("revision"),
          text("request"),
          answer,
        );
      } else throw new Error("Unknown coordinator action.");
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Coordinator request failed.",
        },
        400,
      );
    }
  });
  app.get("/coordinator/events", (c) => {
    c.header("Cache-Control", "no-store");
    if (!coordinator) return c.notFound();
    const key = getCookie(c, COOKIE) ?? "";
    try {
      coordinator.state(key);
    } catch {
      return c.json(
        { error: "Coordinator ended. Enable it again explicitly." },
        410,
      );
    }
    return streamSSE(c, async (stream) => {
      let resolve!: () => void;
      const done = new Promise<void>((end) => {
        resolve = end;
      });
      // A state frame replaces the entire coordinator-owned view; captions are
      // presentation, not a browser-owned transcript or a command stream.
      let delivery = Promise.resolve();
      const off = coordinator.subscribe(key, (state) => {
        delivery = delivery
          .then(async () => {
            await stream.writeSSE({
              event: "state",
              data: await html(<CoordinatorState state={state} />),
            });
            if (!state.enabled) resolve();
          })
          .catch(resolve);
      });
      stream.onAbort(resolve);
      await done;
      off();
      try {
        await coordinator.end(key);
      } catch {
        /* Already ended explicitly. */
      }
    });
  });
}
