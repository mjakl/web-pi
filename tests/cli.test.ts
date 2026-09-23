import { parseOptions } from "@/cli";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("web-pi flags", () => {
  it("asks for nothing by default", () => {
    expect(parseOptions([])).toEqual({ help: false, version: false, env: {} });
  });

  it("turns flags into the environment loadConfig already reads", () => {
    expect(
      parseOptions(["--host", "1.2.3.4", "--port", "8080", "--runtime", "fake"])
        .env,
    ).toEqual({
      WEB_PI_HOST: "1.2.3.4",
      WEB_PI_PORT: "8080",
      WEB_PI_RUNTIME: "fake",
    });
  });

  it("binds every interface for --lan, and lets an explicit host win", () => {
    expect(parseOptions(["--lan"]).env).toEqual({ WEB_PI_HOST: "0.0.0.0" });
    expect(parseOptions(["--lan", "--host", "::1"]).env).toEqual({
      WEB_PI_HOST: "::1",
    });
  });

  it.each([
    ["--help", /Usage: web-pi \[options\]/],
    ["--version", /^web-pi \d+\.\d+\.\d+\npi not found on PATH\n$/],
  ])("executes %s without Pi or starting the app", async (flag, expected) => {
    const home = await mkdtemp(join(tmpdir(), "web-pi-cli-"));
    try {
      const cli = pathToFileURL(resolve("src/cli.ts")).href;
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          `import { run } from ${JSON.stringify(cli)}; await run(process.argv.slice(1));`,
          "--",
          flag,
        ],
        {
          timeout: 5000,
          // Startup must not resolve Pi, write state, or validate server flags.
          env: {
            PATH: "",
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, "agent"),
            WEB_PI_PORT: "not-a-port",
          },
        },
      );
      expect(stdout).toMatch(expected);
      expect(stderr).toBe("");
      expect(await readdir(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("points a mistyped flag or a stray argument at --help", () => {
    expect(() => parseOptions(["--prot", "8080"])).toThrow(/web-pi --help/);
    expect(() => parseOptions(["8080"])).toThrow(/web-pi --help/);
  });
});
