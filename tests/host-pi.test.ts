import {
  findCodingAgentRoot,
  findPiExecutable,
  linkHostPi,
  resolveHostPi,
  staleLinks,
} from "@/host-pi";
import {
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "web-pi-host-")));
  temporary.push(dir);
  return dir;
}

function writeExecutable(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
}

/** A Pi install shaped like a plain `npm install -g`. */
function fakeInstall(versions: Record<string, string> = {}): string {
  const root = temporaryDir();
  const modules = join(root, "node_modules", "@earendil-works");
  for (const name of ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"]) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(
      join(modules, name, "package.json"),
      JSON.stringify({
        name: `@earendil-works/${name}`,
        version: versions[name] ?? "1.2.3",
      }),
    );
  }
  writeExecutable(join(root, "node_modules", ".bin", "pi"));
  return root;
}

describe("finding the pi executable", () => {
  it("takes the first pi on PATH and ignores directories without one", () => {
    const empty = temporaryDir();
    const install = fakeInstall();
    const binDir = join(install, "node_modules", ".bin");
    expect(
      findPiExecutable({ PATH: [empty, binDir].join(":") }, temporaryDir()),
    ).toBe(join(binDir, "pi"));
  });

  it("ignores this checkout's own node_modules/.bin", () => {
    const checkout = temporaryDir();
    writeExecutable(join(checkout, "node_modules", ".bin", "pi"));
    expect(() =>
      findPiExecutable(
        { PATH: join(checkout, "node_modules", ".bin") },
        checkout,
      ),
    ).toThrow(/no `pi` executable on PATH/);
  });

  it("reports a PATH without pi", () => {
    expect(() =>
      findPiExecutable({ PATH: temporaryDir() }, temporaryDir()),
    ).toThrow(/no `pi` executable on PATH/);
  });
});

describe("locating the SDK behind the executable", () => {
  it("rejects a version-manager shim that is not inside a Pi package", () => {
    const shims = temporaryDir();
    writeExecutable(join(shims, "pi"));
    expect(() => findCodingAgentRoot(join(shims, "pi"))).toThrow(
      /not inside a @earendil-works\/pi-coding-agent install/,
    );
  });

  it("finds the package that owns the executable", () => {
    const install = fakeInstall();
    expect(
      findCodingAgentRoot(join(install, "node_modules", ".bin", "pi")),
    ).toBe(join(install, "node_modules", "@earendil-works", "pi-coding-agent"));
  });

  it("resolves every SDK package at the coding agent's version", () => {
    const install = fakeInstall();
    const host = resolveHostPi(
      { PATH: join(install, "node_modules", ".bin") },
      temporaryDir(),
    );
    expect(host.version).toBe("1.2.3");
    expect(Object.keys(host.packages)).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-tui",
    ]);
    expect(host.packages["@earendil-works/pi-ai"]).toBe(
      join(install, "node_modules", "@earendil-works", "pi-ai"),
    );
  });

  it("refuses an install whose packages disagree on the version", () => {
    const install = fakeInstall({ "pi-ai": "1.0.0" });
    expect(() =>
      resolveHostPi(
        { PATH: join(install, "node_modules", ".bin") },
        temporaryDir(),
      ),
    ).toThrow(
      /pi-ai is 1\.0\.0 but @earendil-works\/pi-coding-agent is 1\.2\.3/,
    );
  });
});

describe("linking", () => {
  it("replaces a stale directory and reports links that are missing", () => {
    const install = fakeInstall();
    const checkout = temporaryDir();
    const host = resolveHostPi(
      { PATH: join(install, "node_modules", ".bin") },
      checkout,
    );
    expect(staleLinks(checkout, host)).toHaveLength(4);

    // A package manager may have left a real directory in the way.
    const stale = join(checkout, "node_modules", "@earendil-works", "pi-ai");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "package.json"), "{}");

    linkHostPi(checkout, host);
    expect(staleLinks(checkout, host)).toEqual([]);
    expect(readlinkSync(stale)).toBe(host.packages["@earendil-works/pi-ai"]);
    linkHostPi(checkout, host);
    expect(staleLinks(checkout, host)).toEqual([]);
  });
});
