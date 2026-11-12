import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { connect } from "node:net";
import type { Server } from "node:http";

/** Refuse shared directories and live owners; remove only our stale socket. */
export async function listenBackend(
  server: Server,
  path: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      `Backend socket directory must be owned by this user and private (0700): ${directory}`,
    );
  const existing = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== process.getuid?.())
      throw new Error(`Refusing to replace ${path}`);
    const active = await new Promise<boolean>((resolve, reject) => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
          resolve(false);
        else reject(error);
      });
    });
    if (active) throw new Error(`Backend is already listening on ${path}`);
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(path, 0o600);
}
