import { createFakeWorld, FAKE_MODEL } from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp } from "@web/app";
import type {
  HTMLButtonElement,
  HTMLInputElement,
  HTMLSelectElement,
} from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmxBrowser } from "#/web/htmx4-browser";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected test value");
  return value;
}

type Browser = Awaited<ReturnType<typeof htmxBrowser>>;
const browsers: Browser[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
  const world = createFakeWorld({
    sessions: [
      {
        summary: {
          id: "s1",
          cwd: "/repo",
          createdAt: "2026-09-01",
          modifiedAt: "2026-09-01",
          fileSize: 0,
        },
        entries: [],
      },
    ],
  });
  world.files.stat = (path) =>
    Promise.resolve(
      path === "/repo"
        ? { size: 0, mtimeMs: 0, isFile: false, isDirectory: true }
        : undefined,
    );
  world.files.realpath = (path) => Promise.resolve(path);
  const prompt = vi.fn().mockResolvedValue(undefined);
  const bash = vi.fn().mockResolvedValue(undefined);
  const open = world.runtime.open.bind(world.runtime);
  const openSpy = vi
    .spyOn(world.runtime, "open")
    .mockImplementation(async (target) => {
      const live = await open(target);
      live.prompt = prompt;
      live.runBash = bash;
      return live;
    });
  const workspace = createWorkspace(world);
  const app = createWebApp({
    workspace,
    defaultCwd: "/repo",
    staticRoot: "static",
  });
  return { app, world, workspace, prompt, bash, openSpy };
}

async function openComposer(
  app: ReturnType<typeof fixture>["app"],
  fresh: boolean,
  loseResponse = false,
) {
  const html = await (
    await app.request(fresh ? "/new" : "/sessions/s1")
  ).text();
  const browser = await htmxBrowser(html, async (request) => {
    const response = await app.request(request);
    if (loseResponse && request.method === "POST")
      throw new Error("Connection lost after dispatch");
    return response;
  });
  browsers.push(browser);
  return browser;
}

const area = (browser: Browser) =>
  required(browser.document.querySelector("textarea"));
const sendButton = (browser: Browser) =>
  required(
    browser.document.querySelector<HTMLButtonElement>(
      ".composer-action-primary",
    ),
  );
const notices = (browser: Browser) =>
  browser.document.querySelector("#toasts")?.textContent;
const posts = (browser: Browser) =>
  browser.requests.filter((request) => request.method === "POST");

async function attach(browser: Browser) {
  const { window, document } = browser;
  const input = required(
    document.querySelector<HTMLInputElement>("#image-input"),
  );
  const files = new window.FileList();
  files.push(
    new window.File([new Uint8Array([0, 128, 255])], "image.png", {
      type: "image/png",
    }),
  );
  input.files = files;
  input.dispatchEvent(new window.Event("change"));
  await expect
    .poll(() => document.querySelectorAll("#image-previews img").length)
    .toBe(1);
  return input;
}

async function expectImage(input: HTMLInputElement) {
  expect(new Uint8Array(await required(input.files[0]).arrayBuffer())).toEqual(
    new Uint8Array([0, 128, 255]),
  );
}

function typeAndSend(browser: Browser, text: string) {
  area(browser).value = text;
  area(browser).dispatchEvent(
    new browser.window.Event("input", { bubbles: true }),
  );
  sendButton(browser).click();
}

async function finished(browser: Browser, send: () => void) {
  const done = new Promise<void>((resolve) => {
    required(browser.document.querySelector("#composer")).addEventListener(
      "htmx:finally:request",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  send();
  await done;
}

describe("composer acceptance through shipped HTMX and real routes", () => {
  it.each(["missing folder", "rejected prompt", "missing name"])(
    "preserves a %s rejection without retrying",
    async (kind) => {
      const { app, world, prompt } = fixture();
      if (kind === "rejected prompt")
        prompt.mockRejectedValue(
          new Error("Prompt rejected: choose an available model."),
        );
      const fresh = kind === "missing folder";
      const browser = await openComposer(app, fresh);
      if (kind === "missing folder")
        world.projects.available = () => Promise.resolve(false);
      const image = kind === "missing name" ? undefined : await attach(browser);
      const text = kind === "missing name" ? "/name" : "keep this request";
      await finished(browser, () => {
        typeAndSend(browser, text);
      });
      expect(area(browser).value).toBe(text);
      expect(notices(browser)).toMatch(/folder|Prompt rejected|Usage/);
      await pause(350);
      expect(
        browser.window.localStorage.getItem(
          `web-pi:draft:${fresh ? "new:/repo" : "s1"}`,
        ),
      ).toBe(text);
      if (image) await expectImage(image);
      expect(posts(browser)).toHaveLength(1);
    },
  );

  it("preserves an ambiguous submission and warns against blindly sending it again", async () => {
    const { app, prompt } = fixture();
    const browser = await openComposer(app, false, true);
    const image = await attach(browser);
    await finished(browser, () => {
      typeAndSend(browser, "possibly accepted");
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(area(browser).value).toBe("possibly accepted");
    await expectImage(image);
    expect(notices(browser)).toContain(
      "Check the conversation before sending again",
    );
    await pause(350);
    expect(posts(browser)).toHaveLength(1);
  });

  it("drops repeat submissions while the first dispatch is pending", async () => {
    const { app, prompt } = fixture();
    const pending = Promise.withResolvers<undefined>();
    prompt.mockImplementation(() => pending.promise);
    const browser = await openComposer(app, false);
    const done = finished(browser, () => {
      typeAndSend(browser, "once");
    });
    await expect.poll(() => prompt.mock.calls.length).toBe(1);
    sendButton(browser).click();
    area(browser).dispatchEvent(
      new browser.window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }),
    );
    pending.resolve(undefined);
    await done;
    await pause(30);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(posts(browser)).toHaveLength(1);
  });

  it.each(["/name title", "/reload"])(
    "accepts %s without prompting and preserves its notice on a new session",
    async (text) => {
      const { app, prompt } = fixture();
      const browser = await openComposer(app, true);
      await finished(browser, () => {
        typeAndSend(browser, text);
      });
      expect(area(browser).value).toBe("");
      expect(notices(browser)).toMatch(/Renamed|reloaded/);
      expect(prompt).not.toHaveBeenCalled();
      await expect
        .poll(() => browser.window.location.pathname)
        .toBe("/sessions/new-1");
      await expect.poll(() => notices(browser)).toMatch(/Renamed|reloaded/);
    },
  );

  it.each(["/session", "/copy"])(
    "keeps unavailable local builtin %s in a new composer",
    async (text) => {
      const { app } = fixture();
      const browser = await openComposer(app, true);
      typeAndSend(browser, text);
      expect(area(browser).value).toBe(text);
      expect(notices(browser)).toMatch(/first|No answer/);
      expect(posts(browser)).toHaveLength(0);
    },
  );

  it.each([false, true])(
    "clears an accepted submission once before promotion (new: %s)",
    async (fresh) => {
      const { app, prompt } = fixture();
      const browser = await openComposer(app, fresh);
      const image = await attach(browser);
      let clears = 0;
      area(browser).addEventListener("input", () => {
        if (area(browser).value === "") clears += 1;
      });
      let promotedDraft: string | null | undefined;
      browser.document.body.addEventListener("web-pi:session-created", () => {
        promotedDraft =
          browser.window.localStorage.getItem("web-pi:draft:new-1");
      });
      await finished(browser, () => {
        typeAndSend(browser, "accepted");
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(area(browser).value).toBe("");
      expect(image.files).toHaveLength(0);
      expect(clears).toBe(1);
      if (fresh) {
        expect(promotedDraft).toBeNull();
        await expect
          .poll(() => browser.window.location.pathname)
          .toBe("/sessions/new-1");
      }
    },
  );
});

describe("explicit startup choices from the rendered form", () => {
  it.each(["untouched", "shown model", "model", "thinking", "both"])(
    "submits only deliberate overrides to the runtime: %s",
    async (choice) => {
      const { app, world, openSpy } = fixture();
      const scoped = {
        ...FAKE_MODEL,
        id: "scoped",
        name: "Scoped model",
        pin: "high" as const,
      };
      const other = {
        ...FAKE_MODEL,
        id: "other",
        name: "Other model",
        pin: "low" as const,
      };
      world.models.list = () =>
        Promise.resolve({ models: [scoped, other], warnings: [] });
      world.models.listAvailable = () => Promise.resolve([scoped, other]);
      // Effective selection and disk writes are exercised through the real
      // adapter in composer-runtime.test.ts, never synthesized by this fake.
      const browser = await openComposer(app, true);
      expect(
        browser.document.querySelector(".composer-model-detail")?.textContent,
      ).toBe("thorough");
      const reasoning = () =>
        required(
          browser.document.querySelector<HTMLSelectElement>(
            ".composer-thinking-field select",
          ),
        );
      expect(reasoning().querySelector('option[value="auto"]')).toBeNull();
      if (choice === "thinking" || choice === "both") {
        reasoning().value = "medium";
        reasoning().dispatchEvent(
          new browser.window.Event("change", { bubbles: true }),
        );
      }
      const otherChosen = choice === "model" || choice === "both";
      const modelChosen = otherChosen || choice === "shown model";
      const thinkingChosen = choice === "thinking" || choice === "both";
      const modelId = otherChosen ? "other" : "scoped";
      if (modelChosen) {
        required(
          browser.document.querySelector<HTMLButtonElement>(
            `[data-model-name="${otherChosen ? "Other" : "Scoped"} model"]`,
          ),
        ).click();
        await expect
          .poll(
            () =>
              browser.document.querySelector<HTMLInputElement>('[name="model"]')
                ?.value,
          )
          .toBe(`fake/${modelId}`);
      }
      await finished(browser, () => {
        typeAndSend(browser, "hello");
      });
      const body = await required(posts(browser)[0]).formData();
      expect(body.get("model")).toBe(modelChosen ? `fake/${modelId}` : "");
      expect(body.get("thinking")).toBe(thinkingChosen ? "medium" : "");
      expect(openSpy).toHaveBeenCalledExactlyOnceWith({
        cwd: "/repo",
        ...(modelChosen ? { model: { provider: "fake", modelId } } : {}),
        ...(thinkingChosen ? { thinkingLevel: "medium" } : {}),
      });
    },
  );
});

describe("new and existing dispatch", () => {
  for (const fresh of [false, true]) {
    it.each([
      ["ordinary text", false, "prompt"],
      ["", true, "prompt"],
      ["!echo safe", false, "bash"],
      ["!!echo private", false, "local bash"],
      ["/name title", false, "name"],
      ["/skill:example", false, "prompt"],
    ] as const)(
      `dispatches %s (new: ${String(fresh)})`,
      async (text, image, kind) => {
        const { app, workspace, prompt, bash, openSpy } = fixture();
        const rename = vi.spyOn(workspace, "rename");
        const body = new FormData();
        body.set("cwd", "/repo");
        body.set("text", text);
        if (image)
          body.append(
            "images[]",
            new Blob(["bytes"], { type: "image/png" }),
            "one.png",
          );
        const response = await app.request(
          fresh ? "/sessions" : "/sessions/s1/prompt",
          { method: "POST", headers: { "HX-Request": "true" }, body },
        );
        expect(openSpy).toHaveBeenCalledTimes(
          kind === "name" && !fresh ? 0 : 1,
        );
        expect(prompt).toHaveBeenCalledTimes(kind === "prompt" ? 1 : 0);
        expect(bash).toHaveBeenCalledTimes(kind.includes("bash") ? 1 : 0);
        if (kind.includes("bash"))
          expect(bash).toHaveBeenCalledWith(
            text.replace(/^!!?/, ""),
            kind === "local bash",
          );
        if (kind === "name")
          expect(rename).toHaveBeenCalledWith(fresh ? "new-1" : "s1", "title");
        if (kind === "prompt")
          expect(prompt).toHaveBeenCalledWith(
            text,
            expect.objectContaining({
              images: image
                ? [{ data: "Ynl0ZXM=", mimeType: "image/png" }]
                : [],
            }),
          );
        expect(response.headers.get("X-Web-Pi-Submission")).toBe("accepted");
      },
    );
  }

  it.each([false, true])(
    "refuses to send local-only text with attachments to a model (new: %s)",
    async (fresh) => {
      const { app, prompt, bash, openSpy } = fixture();
      const body = new FormData();
      body.set("cwd", "/repo");
      body.set("text", "!!echo private");
      body.append(
        "images[]",
        new Blob(["bytes"], { type: "image/png" }),
        "one.png",
      );
      const response = await app.request(
        fresh ? "/sessions" : "/sessions/s1/prompt",
        { method: "POST", body },
      );
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toContain(
        "Remove attachments",
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(bash).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["!", "!!", "/name", "/compact", "/clone", "/copy", "/session"])(
    "rejects unsupported empty-session input %s without creating a session",
    async (text) => {
      const { app, openSpy, prompt } = fixture();
      const response = await app.request("/sessions", {
        method: "POST",
        body: new URLSearchParams({ cwd: "/repo", text }),
      });
      expect(response.headers.get("X-Web-Pi-Submission")).toBeNull();
      expect(response.headers.get("HX-Trigger")).toContain("web-pi:toast");
      expect(openSpy).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
    },
  );
});
