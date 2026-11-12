#!/usr/bin/env node
import {
  lstatSync,
  realpathSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";

// Callers hold .publication.lock across selection/publication, never a runtime.
export function releasePackage(root, target) {
  const directory = realpathSync(target);
  const releases = realpathSync(join(root, "releases"));
  if (!directory.startsWith(releases + sep))
    throw new Error(`Release is outside ${releases}`);
  const pkg = realpathSync(join(directory, "node_modules/web-pi"));
  if (!pkg.startsWith(directory + sep))
    throw new Error("Release dependencies escape their installation");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
  if (manifest.name !== "web-pi") throw new Error("Not a web-pi release");
  lstatSync(join(pkg, "dist/server.js"));
  lstatSync(join(pkg, "dist/server-runtime.js"));
  return pkg;
}
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function point(root, name, target) {
  const temporary = join(root, `.${name}-${randomUUID()}`);
  symlinkSync(target, temporary);
  try {
    renameSync(temporary, join(root, name));
  } finally {
    if (present(temporary)) unlinkSync(temporary);
  }
}
export function publish(root, target) {
  const directory = realpathSync(target);
  releasePackage(root, directory);
  // Neither pointer is changed until the candidate is complete. A failed
  // second rename is reported, not described as an atomic two-pointer commit.
  point(root, "backend-next", directory);
  point(root, "web-current", directory);
}
export function select(root, role) {
  if (role !== "web" && role !== "backend")
    throw new Error("Expected web or backend");
  const next = join(root, "backend-next");
  if (role === "backend" && present(next)) {
    const target = realpathSync(next);
    releasePackage(root, target);
    point(root, "backend-current", target);
    unlinkSync(next);
  }
  return releasePackage(root, join(root, `${role}-current`));
}
if (import.meta.main) {
  try {
    const [action, root, value] = process.argv.slice(2);
    if (!root || !value)
      throw new Error("Expected select ROOT ROLE or publish ROOT RELEASE");
    if (action === "select") console.log(select(root, value));
    else if (action === "publish") publish(root, value);
    else throw new Error("Unknown release operation");
  } catch (error) {
    console.error(`web-pi release: ${error.message}`);
    process.exitCode = 1;
  }
}
