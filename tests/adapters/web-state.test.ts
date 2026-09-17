import { createWebSettingsStore } from "@adapters/fs/web-settings";
import { createPiProjectResolver } from "@adapters/pi/projects";
import { createWebPushNotifier } from "@adapters/pi/web-push";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
function fixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "web-pi-state-"));
  directories.push(agentDir);
  const notifier = createWebPushNotifier({ agentDir });
  const subscription = {
    endpoint: "https://push.example/one",
    keys: { p256dh: "p", auth: "a" },
  };
  notifier.subscribe(subscription);
  const key = notifier.publicKey();
  const oldPush = join(agentDir, "web-push.json");
  const push = join(agentDir, "web-pi", "push.json");
  renameSync(push, oldPush);
  const oldProjects = join(agentDir, "web-worktree-projects.json");
  const projects = join(agentDir, "web-pi", "worktree-projects.json");
  writeFileSync(oldProjects, JSON.stringify({ "/missing/worktree": "/repo" }));
  return { agentDir, key, subscription, oldPush, push, oldProjects, projects };
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("web state cutover", () => {
  it("preserves VAPID identity, every subscription and removed worktree mapping, then retires originals", async () => {
    const f = fixture();
    const before = readFileSync(f.oldPush, "utf8");
    const notifier = createWebPushNotifier({ agentDir: f.agentDir });
    const projects = createPiProjectResolver({ agentDir: f.agentDir });
    expect(notifier.publicKey()).toBe(f.key);
    expect(notifier.has(f.subscription)).toBe(true);
    expect(readFileSync(f.push, "utf8")).toBe(before);
    expect((await projects.resolve("/missing/worktree")).root).toBe("/repo");
    expect(existsSync(f.oldPush)).toBe(false);
    expect(existsSync(f.oldProjects)).toBe(false);
    expect(statSync(f.push).mode & 0o777).toBe(0o600);
    expect(statSync(f.projects).mode & 0o777).toBe(0o600);
  });

  it("resumes after destination preservation but before source retirement", () => {
    const f = fixture();
    writeFileSync(f.push, readFileSync(f.oldPush));
    writeFileSync(f.projects, readFileSync(f.oldProjects));
    expect(createWebPushNotifier({ agentDir: f.agentDir }).publicKey()).toBe(
      f.key,
    );
    createPiProjectResolver({ agentDir: f.agentDir });
    expect(existsSync(f.oldPush)).toBe(false);
    expect(existsSync(f.oldProjects)).toBe(false);
    expect(statSync(f.push).mode & 0o777).toBe(0o600);
  });

  it("does not retire the only valid source when destination preservation fails", () => {
    const f = fixture();
    mkdirSync(f.push);
    expect(() => createWebPushNotifier({ agentDir: f.agentDir })).toThrow();
    expect(existsSync(f.oldPush)).toBe(true);
    rmSync(f.push, { recursive: true });
    expect(createWebPushNotifier({ agentDir: f.agentDir }).publicKey()).toBe(
      f.key,
    );
  });

  it.each(["source", "destination"])(
    "refuses malformed %s without overwriting either copy",
    (side) => {
      const f = fixture();
      writeFileSync(f.push, readFileSync(f.oldPush));
      const broken = side === "source" ? f.oldPush : f.push;
      writeFileSync(broken, "not json");
      const source = readFileSync(f.oldPush, "utf8");
      const destination = readFileSync(f.push, "utf8");
      expect(() => createWebPushNotifier({ agentDir: f.agentDir })).toThrow(
        "Invalid web state",
      );
      expect(readFileSync(f.oldPush, "utf8")).toBe(source);
      expect(readFileSync(f.push, "utf8")).toBe(destination);
    },
  );

  it("refuses conflicting valid copies, including differing subscriptions under the same keys", () => {
    const f = fixture();
    const different = JSON.parse(readFileSync(f.oldPush, "utf8")) as {
      subscriptions: unknown[];
    };
    different.subscriptions = [];
    writeFileSync(f.push, JSON.stringify(different));
    expect(() => createWebPushNotifier({ agentDir: f.agentDir })).toThrow(
      "Conflicting web state",
    );
    expect(existsSync(f.oldPush)).toBe(true);
    writeFileSync(
      f.projects,
      JSON.stringify({ "/missing/worktree": "/other" }),
    );
    expect(() => createPiProjectResolver({ agentDir: f.agentDir })).toThrow(
      "Conflicting web state",
    );
    expect(existsSync(f.oldProjects)).toBe(true);
  });

  it("refuses a malformed mapping rather than silently discarding entries", () => {
    const f = fixture();
    writeFileSync(
      f.oldProjects,
      JSON.stringify({ "/valid": "/repo", "/invalid": 42 }),
    );
    expect(() => createPiProjectResolver({ agentDir: f.agentDir })).toThrow(
      "Invalid web state",
    );
    expect(existsSync(f.oldProjects)).toBe(true);
  });

  it("resets only web state after completed cutover, without resurrecting legacy files", () => {
    const f = fixture();
    const shared = ["settings.json", "auth.json", "models.json", "trust.json"];
    for (const file of shared)
      writeFileSync(join(f.agentDir, file), "untouched");
    createWebPushNotifier({ agentDir: f.agentDir });
    createPiProjectResolver({ agentDir: f.agentDir });
    createWebSettingsStore(f.agentDir).update({
      sound: false,
      theme: "dark",
      warnTokens: 1,
    });
    rmSync(join(f.agentDir, "web-pi"), { recursive: true });
    expect(createWebSettingsStore(f.agentDir).get()).toEqual({
      visibleModels: null,
      systemPromptAddition: null,
      warnTokens: 100000,
      theme: "auto",
      sound: true,
    });
    const next = createWebPushNotifier({ agentDir: f.agentDir });
    expect(next.publicKey()).not.toBe(f.key);
    expect(next.has(f.subscription)).toBe(false);
    for (const file of shared)
      expect(readFileSync(join(f.agentDir, file), "utf8")).toBe("untouched");
  });
});

describe("shared settings storage", () => {
  it("reads pre-customization files and preserves exact prompt text, empty and reset across restarts", () => {
    const { agentDir } = fixture();
    writeFileSync(
      join(agentDir, "web-pi", "settings.json"),
      JSON.stringify({ theme: "light", sound: false, warnTokens: 42 }),
    );
    expect(
      createWebSettingsStore(agentDir).get().systemPromptAddition,
    ).toBeNull();
    for (const value of ["  Keep this.\n\nAnd this.  ", "", null]) {
      createWebSettingsStore(agentDir).update({ systemPromptAddition: value });
      expect(createWebSettingsStore(agentDir).get()).toEqual({
        theme: "light",
        sound: false,
        warnTokens: 42,
        systemPromptAddition: value,
        visibleModels: null,
      });
    }
  });

  it("persists across adapters, merges independent edits, and writes privately", () => {
    const { agentDir } = fixture();
    const one = createWebSettingsStore(agentDir);
    const two = createWebSettingsStore(agentDir);
    expect(one.get()).toEqual({
      visibleModels: null,
      systemPromptAddition: null,
      warnTokens: 100000,
      theme: "auto",
      sound: true,
    });
    one.update({ theme: "dark" });
    two.update({ sound: false });
    expect(one.get()).toEqual({
      visibleModels: null,
      systemPromptAddition: null,
      warnTokens: 100000,
      theme: "dark",
      sound: false,
    });
    expect(
      statSync(join(agentDir, "web-pi", "settings.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it.each([
    { warnTokens: 0 },
    { warnTokens: 1.5 },
    { warnTokens: Number.MAX_SAFE_INTEGER + 1 },
    { theme: "sepia" },
    { sound: "false" },
  ])(
    "rejects invalid settings without replacing valid values: %j",
    (invalid) => {
      const { agentDir } = fixture();
      const store = createWebSettingsStore(agentDir);
      store.update({ theme: "light" });
      expect(() =>
        store.update(invalid as Parameters<typeof store.update>[0]),
      ).toThrow();
      expect(store.get().theme).toBe("light");
    },
  );
});
