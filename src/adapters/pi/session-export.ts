import { resolveBundledPi } from "@/pi-version";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

// Pi's HTML export lives behind the package's export map, so the CLI runs it,
// the same way pi-web does. It is spawned under this process's own Node binary
// (never `pi` from PATH) so the SDK that renders matches the local SDK loaded here.

const run = promisify(execFile);

function cliPath(): string {
  const manifest = resolveBundledPi().codingAgentManifest;
  return join(dirname(manifest), "dist", "bundle", "cli.js");
}

/**
 * The exported page walks the entry tree recursively, which overflows the
 * browser's stack on the long linear sessions this UI is built for. Each
 * rewrite is the same traversal with an explicit stack.
 */
const PATCHES: { name: string; from: string; to: string }[] = [
  {
    name: "sortChildren",
    from: `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    to: `        function sortChildren(root) {
          const pending = [root];
          while (pending.length > 0) {
            const node = pending.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
          }
        }`,
  },
  {
    name: "mapNodes",
    from: `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    to: `          const pending = [...tree].reverse();
          while (pending.length > 0) {
            const node = pending.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
          }`,
  },
  {
    name: "markActive",
    from: `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }
        roots.forEach(markActive);`,
    to: `        const postOrder = [];
        const pendingActive = [...roots];
        while (pendingActive.length > 0) {
          const node = pendingActive.pop();
          postOrder.push(node);
          for (const child of node.children) pendingActive.push(child);
        }
        for (let i = postOrder.length - 1; i >= 0; i--) {
          const node = postOrder[i];
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (containsActive.get(child)) has = true;
          }
          containsActive.set(node, has);
        }`,
  },
];

/** Returns the page and the names of any patch that no longer applied. */
export function patchExportHtml(html: string): {
  html: string;
  missed: string[];
} {
  let patched = html.replaceAll("\r\n", "\n");
  const missed: string[] = [];
  for (const patch of PATCHES) {
    if (patched.includes(patch.from))
      patched = patched.replace(patch.from, patch.to);
    else missed.push(patch.name);
  }
  return { html: patched, missed };
}

export async function exportSessionHtml(
  filePath: string,
): Promise<{ html: string; filename: string }> {
  const directory = join(tmpdir(), "web-pi-export");
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `${randomUUID()}.html`);
  try {
    await run(process.execPath, [cliPath(), "--export", filePath, output], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    });
    const { html, missed } = patchExportHtml(readFileSync(output, "utf8"));
    if (missed.length > 0) {
      // Only very deep sessions notice; serving the page beats failing it.
      process.stderr.write(
        `[web-pi] exported HTML kept recursive ${missed.join(", ")}\n`,
      );
    }
    return {
      html,
      filename: `pi-session-${basename(filePath, ".jsonl")}.html`,
    };
  } finally {
    rmSync(output, { force: true });
  }
}
