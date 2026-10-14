import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs once in Vitest's main process, before any worker starts. Workers
// inherit this environment, and os.homedir() reads the process environment,
// not a worker's process.env, so this is the one place that can keep every
// test, the Pi SDK and the programs tests start out of the developer's home.
// The XDG directories move too: a developer's own would still hand git their
// global ignore file and pnpm their configuration.
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), "web-pi-test-home-"));
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  });
  return () => {
    rmSync(home, { recursive: true, force: true });
  };
}
