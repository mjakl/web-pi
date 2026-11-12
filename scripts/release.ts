import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? String(code)})`,
          ),
        );
    });
  });
}

export async function publishRelease(): Promise<void> {
  const source = resolve(import.meta.dirname, "..");
  const targetRoot = resolve(
    process.env["WEB_PI_RELEASE_ROOT"] ??
      join(homedir(), ".local/share/web-pi"),
  );
  await mkdir(targetRoot, { recursive: true });
  const root = await realpath(targetRoot);
  const checkout = await realpath(source);
  if (root === checkout || root.startsWith(`${checkout}/`))
    throw new Error("Release directories must be outside the checkout");
  // Every deployment builds the complete backend too, including a stable-latest Pi refresh.
  await run("just", ["build"], source);
  await mkdir(join(root, "releases"), { recursive: true });
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const stage = join(root, "releases", `.pending-${id}`);
  const release = join(root, "releases", id);
  await mkdir(stage);
  try {
    await run("pnpm", ["pack", "--out", join(stage, "web-pi.tgz")], source);
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    ) as { packageManager: string };
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: manifest.packageManager,
        dependencies: { "web-pi": "file:./web-pi.tgz" },
      }),
    );
    await run(
      "pnpm",
      [
        "install",
        "--prod",
        "--ignore-scripts",
        "--config.node-linker=isolated",
        "--config.enable-global-virtual-store=false",
      ],
      stage,
    );
    const pkg = await realpath(join(stage, "node_modules/web-pi"));
    if (!pkg.startsWith(`${stage}/`))
      throw new Error("Candidate package escapes release");
    // This guard checks exact physical Pi ownership without loading a workspace.
    await run(
      process.execPath,
      [join(pkg, "bin/web-pi.js"), "--version"],
      stage,
    );
    const tarball = await readFile(join(stage, "web-pi.tgz"));
    await writeFile(
      join(stage, "release.json"),
      JSON.stringify(
        {
          id,
          builtAt: new Date().toISOString(),
          sha256: createHash("sha256").update(tarball).digest("hex"),
          node: process.version,
        },
        null,
        2,
      ),
    );
    await rename(stage, release);
    // Publish only a fully installed artifact, under the same lock startup uses.
    await run(
      "flock",
      [
        join(root, ".publication.lock"),
        process.execPath,
        join(source, "bin/web-pi-release.js"),
        "publish",
        root,
        release,
      ],
      source,
    );
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write(
    `Published ${release}; web-current and backend-next selected. Existing releases retained.\n`,
  );
}

if (import.meta.main)
  publishRelease().catch((error: unknown) => {
    process.stderr.write(
      `web-pi-release: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(
      "No automatic rollback. Inspect pointers and the service journal before retrying.\n",
    );
    process.exitCode = 1;
  });
