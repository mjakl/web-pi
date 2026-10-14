import {
  assistantEntry,
  createFakeWorld,
  type FakeStoredSession,
  userEntry,
} from "@adapters/fake/index";
import { createWorkspace } from "@core/workspace";
import { createWebApp, type WebDeps } from "@web/app";

/**
 * The session the web tests open, `s1` in /repo/one: a question with markup
 * and an answer with Markdown and a script tag. A test can move or rename it
 * and give it other entries.
 */
export function storedSession(
  summary: Partial<FakeStoredSession["summary"]> = {},
  entries = [
    userEntry("u1", null, "first <b>question</b>"),
    assistantEntry("a1", "u1", "**bold** <script>x</script>", 40_000),
  ],
): FakeStoredSession {
  return {
    summary: {
      id: "s1",
      cwd: "/repo/one",
      name: "Stored one",
      createdAt: "2026-09-01T00:00:00.000Z",
      modifiedAt: "2026-09-02T00:00:00.000Z",
      fileSize: 10,
      ...summary,
    },
    entries,
  };
}

/**
 * The web app over a fake world that stores `storedSession()`. `world`
 * overrides the fake world's options, its sessions included, and `web` the
 * app's.
 */
export function testApp(
  world: Parameters<typeof createFakeWorld>[0] = {},
  web: Partial<Omit<WebDeps, "workspace">> = {},
) {
  const fake = createFakeWorld({
    delayMs: 2,
    sessions: [storedSession()],
    ...world,
  });
  const workspace = createWorkspace(fake);
  const app = createWebApp({
    workspace,
    staticRoot: "/nonexistent",
    defaultCwd: "/repo",
    renderIntervalMs: 1,
    ...web,
  });
  return { app, world: fake, workspace };
}
