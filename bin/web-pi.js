#!/usr/bin/env node
// Nothing here but the entry point: dist/cli.js parses the flags and starts
// dist/server.js with the installed runtime dependencies.
import { run } from "../dist/cli.js";

await run(process.argv.slice(2));
