import { type FileEntry, type FileSearch, fileSearch } from "@core/composer";
import { FileAccessError } from "@core/path-access";
import type { DirEntry, Files, FileStat } from "@core/ports";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { constants, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const run = promisify(execFile);

// The browser filters the first MAX_FILES paths on its own and asks the
// server about the rest, which searches the whole listing up to the hard
// caps. Git is asked once per folder, and the answer and its prepared search
// are reused for ten seconds.
const MAX_FILES = 5000;
const GIT_HARD_CAP = 200_000;
const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const MAX_CHILDREN = 20;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** A NUL byte this close to the start marks a binary file, as for Git. */
const BINARY_SNIFF_BYTES = 8192;

/** Names the explorer never lists, whatever `.gitignore` says. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
]);

function toPosix(path: string): string {
  return sep === "/" ? path : path.replaceAll(sep, "/");
}

async function gitFiles(cwd: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        cwd,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        timeout: 10_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
        encoding: "utf8",
      },
    );
    const files = stdout.split("\0").filter((line) => line !== "");
    return files.slice(0, GIT_HARD_CAP);
  } catch {
    return undefined;
  }
}

/** Breadth-first, so a shallow file is never lost to a deep subtree. */
async function walkFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  let level = [""];
  for (let depth = 0; depth <= MAX_WALK_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const relative of level) {
      if (files.length >= WALK_HARD_CAP) return files;
      let entries;
      try {
        entries = await readdir(join(cwd, relative), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) next.push(path);
        } else if (entry.isFile() && !entry.name.endsWith(".pyc")) {
          files.push(path);
          if (files.length >= WALK_HARD_CAP) return files;
        }
      }
    }
    level = next;
  }
  return files;
}

function expand(query: string, cwd: string): string {
  const path = query.replaceAll("\\", "/");
  if (path === "~" || path.startsWith("~/")) {
    return join(homedir(), path.slice(1));
  }
  return isAbsolute(path) ? path : resolve(cwd, path);
}

type Listing = {
  index: { files: string[]; truncated: boolean };
  search: FileSearch;
};

export function createFileTree(): Files {
  const cache = new Map<
    string,
    { expiresAt: number; listing: Promise<Listing> }
  >();

  async function load(cwd: string): Promise<Listing> {
    const listed = (await gitFiles(cwd)) ?? (await walkFiles(cwd));
    const search = fileSearch(listed.map(toPosix));
    return {
      index: {
        files: search("", MAX_FILES, "files").map((entry) => entry.path),
        truncated: listed.length > MAX_FILES,
      },
      search,
    };
  }

  function listing(cwd: string): Promise<Listing> {
    const hit = cache.get(cwd);
    if (hit && hit.expiresAt > Date.now()) return hit.listing;
    const loaded = load(cwd);
    cache.set(cwd, { expiresAt: Date.now() + CACHE_TTL_MS, listing: loaded });
    loaded.catch(() => cache.delete(cwd));
    while (cache.size > CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return loaded;
  }

  return {
    async index(cwd) {
      return (await listing(cwd)).index;
    },

    async search(cwd, query, limit, only) {
      return (await listing(cwd)).search(query, limit, only);
    },

    async children(query, cwd) {
      const expanded = expand(query, cwd);
      // A query that ends in a separator names the directory itself.
      const trailing = /[\\/]$/.test(query) || query === "" || query === "~";
      const directory = trailing ? expanded : join(expanded, "..");
      const prefix = (
        trailing ? "" : expanded.slice(directory.length + 1)
      ).toLowerCase();
      const entries = await readdir(directory, { withFileTypes: true });
      const matched: FileEntry[] = [];
      for (const entry of entries) {
        if (!entry.name.toLowerCase().startsWith(prefix)) continue;
        const path = join(directory, entry.name);
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          isDir = await stat(path).then(
            (info) => info.isDirectory(),
            () => false,
          );
        }
        matched.push({ path, isDir });
      }
      return matched
        .sort(
          (a, b) =>
            Number(b.isDir) - Number(a.isDir) ||
            a.path.localeCompare(b.path, "en"),
        )
        .slice(0, MAX_CHILDREN);
    },

    async readOutput(path) {
      // O_NOFOLLOW: the name was validated, a symlink at that name was not.
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Not a regular file");
        if (info.size > MAX_OUTPUT_BYTES) {
          throw new FileAccessError(
            `Output file is ${String(info.size)} bytes, above the 5 MiB this route serves. Download it instead.`,
            413,
          );
        }
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },

    async list(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      const listed: DirEntry[] = [];
      for (const entry of entries) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name === ".DS_Store" || entry.name.endsWith(".pyc")) continue;
        let isDir = entry.isDirectory();
        if (!isDir && !entry.isFile()) {
          // A symlink or a socket: ask the target what it is, and drop the
          // entry when the answer is an error (a dangling link).
          const info = await stat(join(directory, entry.name)).catch(
            () => undefined,
          );
          if (!info) continue;
          isDir = info.isDirectory();
        }
        listed.push({ name: entry.name, isDir });
      }
      return listed.sort(
        (a, b) =>
          Number(b.isDir) - Number(a.isDir) ||
          a.name.localeCompare(b.name, "en"),
      );
    },

    stat(path) {
      return stat(path).then(
        (info): FileStat => ({
          size: info.size,
          mtimeMs: info.mtimeMs,
          isFile: info.isFile(),
          isDirectory: info.isDirectory(),
        }),
        () => undefined,
      );
    },

    realpath(path) {
      return realpath(path).then(
        (resolved) => resolved,
        () => undefined,
      );
    },

    async readText(path) {
      const handle = await open(path, constants.O_RDONLY);
      try {
        // A positional read leaves the file position at 0 for readFile.
        const head = Buffer.alloc(BINARY_SNIFF_BYTES);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        if (head.subarray(0, bytesRead).includes(0)) return undefined;
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },

    stream(path, range) {
      const node = createReadStream(
        path,
        range === undefined ? {} : { start: range.start, end: range.end },
      );
      return Readable.toWeb(node) as ReadableStream<Uint8Array>;
    },
  };
}
