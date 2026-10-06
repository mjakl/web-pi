import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A throwaway agent directory and project folder for one test. The root is
// also HOME and PI_CODING_AGENT_DIR while it lives: MCP uses the process-wide
// agent directory, and skill discovery uses HOME independently of agentDir.
// Launch threaded test runs with an isolated HOME too: Node's os.homedir()
// reads the worker's inherited environment, not its process.env changes.

export type TempAgent = Awaited<ReturnType<typeof createTempAgent>>;

export async function createTempAgent(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(agentDir);
  await mkdir(project);
  const home = process.env["HOME"];
  const processAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["HOME"] = root;
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  return {
    root,
    agentDir,
    project,
    async dispose(): Promise<void> {
      if (home === undefined) delete process.env["HOME"];
      else process.env["HOME"] = home;
      if (processAgentDir === undefined)
        delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = processAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}
