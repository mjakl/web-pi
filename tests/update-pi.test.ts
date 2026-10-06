import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const piPackages = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(
  (name) => `@earendil-works/${name}`,
);

it("normal builds refresh a locked Pi, freeze the version, and fail before compiling on update errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-pi-update-"));
  const tarballs = new Map<string, Buffer>();
  const manifests = new Map<string, Record<string, unknown>>();
  let latest = "1.0.0";
  let failure = "";
  let metadataRequests = 0;
  const registry = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "").slice(1));
    if (path === piPackages[0]) metadataRequests++;
    if (
      failure === "metadata" ||
      (failure === "install" && path.endsWith(".tgz"))
    ) {
      response
        .writeHead(failure === "metadata" ? 401 : 403)
        .end("required update failed");
      return;
    }
    const tarball = tarballs.get(path);
    if (tarball) {
      response.end(tarball);
      return;
    }
    const versions = manifests.get(path);
    if (!versions) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        name: path,
        "dist-tags": {
          latest:
            path === "build-tools" || path === "too-young" ? "1.0.0" : latest,
        },
        time: Object.fromEntries(
          Object.keys(versions).map((version) => [
            version,
            path === "build-tools"
              ? "2020-01-01T00:00:00Z"
              : new Date().toISOString(),
          ]),
        ),
        versions,
      }),
    );
  });
  try {
    await new Promise<void>((done) => {
      registry.listen(0, "127.0.0.1", done);
    });
    const address = registry.address();
    if (address === null || typeof address === "string")
      throw new Error("missing registry port");
    const url = `http://127.0.0.1:${String(address.port)}`;
    function publish(
      name: string,
      version: string,
      bin?: Record<string, string>,
      dependencies?: Record<string, string>,
    ) {
      const source = join(root, "tar-source");
      const pkg = join(source, "package");
      rmSync(source, { recursive: true, force: true });
      mkdirSync(pkg, { recursive: true });
      const manifest = {
        name,
        version,
        ...(bin ? { bin } : {}),
        ...(dependencies ? { dependencies } : {}),
      };
      writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));
      if (bin) {
        // Compile tools are stand-ins; this test covers the real recipe and
        // package-manager refresh. The installed-tarball smoke covers the SDK.
        writeFileSync(
          join(pkg, "tool.js"),
          '#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("dist", {recursive:true}); writeFileSync("dist/compiled", "compiled");\n',
          { mode: 0o755 },
        );
      }
      const key = `${name}-${version}.tgz`;
      const file = join(root, "package.tgz");
      execFileSync("tar", ["-czf", file, "-C", source, "package"]);
      const bytes = readFileSync(file);
      tarballs.set(key, bytes);
      const versions = manifests.get(name) ?? {};
      versions[version] = {
        ...manifest,
        dist: {
          tarball: `${url}/${key}`,
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        },
      };
      manifests.set(name, versions);
    }
    for (const name of piPackages)
      for (const version of ["1.0.0", "1.0.1", "1.0.2"]) publish(name, version);
    publish("build-tools", "1.0.0", {
      esbuild: "tool.js",
      tsc: "tool.js",
      tsx: "tool.js",
    });
    publish("too-young", "1.0.0");
    for (const name of piPackages)
      publish(name, "1.0.3", undefined, { "too-young": "1.0.0" });
    const checkout = join(root, "checkout");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    copyFileSync(resolve("justfile"), join(checkout, "justfile"));
    // This Pi-only fixture does not install the patched browser dependencies.
    writeFileSync(
      join(checkout, "pnpm-workspace.yaml"),
      `${readFileSync(resolve("pnpm-workspace.yaml"), "utf8")}\nallowUnusedPatches: true\n`,
    );
    cpSync(resolve("patches"), join(checkout, "patches"), { recursive: true });
    copyFileSync(
      resolve("scripts/update-pi.ts"),
      join(checkout, "scripts", "update-pi.ts"),
    );
    writeFileSync(
      join(checkout, "package.json"),
      JSON.stringify({
        name: "refresh-fixture",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          piPackages.map((name) => [name, "1.0.0"]),
        ),
        devDependencies: { "build-tools": "1.0.0" },
        packageManager: "pnpm@12.3.4",
      }),
    );
    writeFileSync(
      join(checkout, ".npmrc"),
      `registry=${url}\nstore-dir=${join(root, "store")}\ncache-dir=${join(root, "cache")}\n`,
    );
    const exec = promisify(execFile);
    const options = {
      cwd: checkout,
      timeout: 30_000,
      env: {
        ...process.env,
        CI: "true",
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
      },
    };
    await exec("pnpm", ["install", "--ignore-scripts"], options);
    const manifestVersions = () =>
      (
        JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")) as {
          dependencies: Record<string, string>;
        }
      ).dependencies;
    const installedVersions = () =>
      piPackages.map(
        (name) =>
          (
            JSON.parse(
              readFileSync(
                join(checkout, "node_modules", name, "package.json"),
                "utf8",
              ),
            ) as { version: string }
          ).version,
      );
    await exec("just", ["build"], options);
    expect(installedVersions()).toEqual(piPackages.map(() => "1.0.0"));
    latest = "1.0.1";
    const before = metadataRequests;
    await exec("just", ["build"], options);
    expect(metadataRequests).toBeGreaterThan(before);
    expect(manifestVersions()).toEqual(
      Object.fromEntries(piPackages.map((name) => [name, "1.0.1"])),
    );
    expect(installedVersions()).toEqual(piPackages.map(() => "1.0.1"));
    expect(readFileSync(join(checkout, "pnpm-lock.yaml"), "utf8")).toContain(
      "specifier: 1.0.1",
    );
    await exec(
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts"],
      options,
    );

    const locked = readFileSync(join(checkout, "pnpm-lock.yaml"), "utf8");
    const pinned = manifestVersions();
    for (const scenario of ["metadata", "install", "prerelease", "policy"]) {
      failure = scenario;
      latest =
        scenario === "prerelease"
          ? "2.0.0-beta.1"
          : scenario === "policy"
            ? "1.0.3"
            : "1.0.2";
      rmSync(join(checkout, "dist"), { recursive: true, force: true });
      await expect(exec("just", ["build"], options)).rejects.toThrow(
        scenario === "policy"
          ? /minimumReleaseAge/
          : /Cannot update bundled Pi/,
      );
      expect(() => readFileSync(join(checkout, "dist", "compiled"))).toThrow();
      expect(installedVersions()).toEqual(piPackages.map(() => "1.0.1"));
      expect(manifestVersions()).toEqual(pinned);
      expect(readFileSync(join(checkout, "pnpm-lock.yaml"), "utf8")).toBe(
        locked,
      );
    }
  } finally {
    await new Promise<void>((done, reject) =>
      registry.close((error) => {
        if (error) reject(error);
        else done();
      }),
    );
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
