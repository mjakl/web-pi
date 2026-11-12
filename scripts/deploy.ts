import { publishRelease, run } from "./release.ts";

async function deploy(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--full"))
    throw new Error("Usage: web-pi-deploy [--full]");
  await publishRelease();
  // Submit both jobs before waiting: restarting backend kills any deploy
  // invoked by one of its tools. Web first also protects older systemctl
  // versions that enqueue one job at a time; systemd orders via After=.
  await run(
    "systemctl",
    [
      "--user",
      "restart",
      "web-pi.service",
      ...(args[0] === "--full" ? ["web-pi-backend.service"] : []),
    ],
    process.cwd(),
  );
}

deploy().catch((error: unknown) => {
  process.stderr.write(
    `web-pi-deploy: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.stderr.write(
    "No automatic rollback. Inspect pointers and the service journal before retrying.\n",
  );
  process.exitCode = 1;
});
