import { resolveBundledPi } from "@/pi-version";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const packages = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(
  (name) => `@earendil-works/${name}`,
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "web-pi-owned-"));
  roots.push(root);
  return root;
}
function app(root: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "web-pi",
      version: "0.1.0",
      dependencies: Object.fromEntries(packages.map((name) => [name, "1.2.3"])),
    }),
  );
}
function sdk(modules: string, version = "1.2.3") {
  for (const name of packages) {
    const root = join(modules, name);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name, version, main: "index.js" }),
    );
    writeFileSync(join(root, "index.js"), "");
  }
}

it("accepts a checkout or npm shallow install and checks all exact pins", () => {
  const root = join(temporary(), "web-pi");
  app(root);
  sdk(join(root, "node_modules"));
  expect(resolveBundledPi(root).version).toBe("1.2.3");
  writeFileSync(
    join(root, "node_modules", packages[1] ?? "", "package.json"),
    JSON.stringify({ name: packages[1], version: "1.2.2" }),
  );
  expect(() => resolveBundledPi(root)).toThrow(/exact bundled Pi version/);
});

it("accepts pnpm's isolated dependency links but not its hidden hoist fallback", () => {
  const store = join(temporary(), "node_modules", ".pnpm");
  const modules = join(store, "web-pi@0.1.0", "node_modules");
  const root = join(modules, "web-pi");
  app(root);
  for (const name of packages) {
    const target = join(
      store,
      `${name.replace("/", "+")}@1.2.3`,
      "node_modules",
    );
    sdk(target);
    mkdirSync(dirname(join(modules, name)), { recursive: true });
    symlinkSync(join(target, name), join(modules, name));
  }
  expect(resolveBundledPi(root).version).toBe("1.2.3");
  sdk(join(store, "node_modules"));
  rmSync(join(modules, packages[0] ?? ""));
  expect(() => resolveBundledPi(root)).toThrow(/not owned by web-pi/);
});

it("rejects an ancestor SDK even at the exact declared version", () => {
  const modules = join(temporary(), "lib", "node_modules");
  const root = join(modules, "web-pi");
  app(root);
  sdk(modules);
  expect(() => resolveBundledPi(root)).toThrow(/not owned by web-pi/);
});

it("rejects legacy system-Pi links left in a checkout", () => {
  const root = join(temporary(), "web-pi");
  const globalModules = join(temporary(), "lib", "node_modules");
  app(root);
  sdk(globalModules);
  for (const name of packages) {
    const link = join(root, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(globalModules, name), link);
  }
  expect(() => resolveBundledPi(root)).toThrow(/not owned by web-pi/);
});
