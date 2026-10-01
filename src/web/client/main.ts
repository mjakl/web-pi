// The only script the browser runs besides htmx, bundled to static/client.js.
// One import per area, and nothing else: each area owns its own module and the
// helpers it pulls in, so five of them can be worked on at once.

import { setUpShell } from "./shell.ts";
import { setUpSidebar } from "./sidebar.ts";
import { setUpTranscript } from "./transcript.ts";
import { setUpComposer } from "./composer.ts";
import { setUpFiles } from "./files.ts";
import { setUpRequestFields } from "./htmx.ts";
import { setUpSseStartup } from "./sse.ts";
import { setUpNavigation } from "./navigation.ts";
import { setUpCoordinator } from "./coordinator.ts";

setUpRequestFields();
setUpSseStartup();
setUpShell();
setUpSidebar();
setUpTranscript();
setUpComposer();
setUpFiles();
setUpNavigation();
setUpCoordinator();
