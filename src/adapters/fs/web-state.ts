import { syncDirectory, writeFileAtomic } from "@adapters/fs/atomic-write";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export function webStatePath(agentDir: string, file: string): string {
  return join(agentDir, "web-pi", file);
}

/** A failed read is not permission to replace someone's only copy. */
export function readWebState<T>(
  path: string,
  parse: (value: unknown) => T,
): T | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read web state: ${path}`, { cause: error });
  }
  try {
    return parse(JSON.parse(text));
  } catch {
    // Do not include parsed values: push state contains private key material.
    throw new Error(
      `Invalid web state: ${path}. Preserve the file and resolve it before restarting.`,
    );
  }
}

export function writeWebState(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileAtomic(path, JSON.stringify(value), 0o600);
  // The first write may have created the directory itself.
  syncDirectory(dirname(directory));
}

/** One cutover, with old web runtimes stopped. Equal copies resume an interrupted move. */
export function migrateWebState(
  agentDir: string,
  legacy: string,
  file: string,
  parse: (value: unknown) => unknown,
): void {
  const source = join(agentDir, legacy);
  const destination = webStatePath(agentDir, file);
  const old = readWebState(source, parse);
  const current = readWebState(destination, parse);
  if (old === undefined) return;
  if (current !== undefined && !isDeepStrictEqual(old, current)) {
    throw new Error(
      `Conflicting web state: ${source} and ${destination}. Preserve both files and resolve them before restarting.`,
    );
  }
  // Rewrite equal copies too, making the surviving copy private and durable
  // before retiring the source, including after an interrupted rename.
  writeWebState(destination, old);
  unlinkSync(source);
  syncDirectory(agentDir);
}
