// The only script the browser runs besides htmx, bundled to static/client.js.
// Each area owns its own module and the helpers it pulls in, so five of them
// can be worked on at once; this file only calls their setups and those of
// the page-wide modules. The cached offline page has no htmx and runs push
// presence alone, so it can reconfirm presence when the connection returns.

import { setUpShell } from "./shell.ts";
import { setUpSidebar } from "./sidebar.ts";
import { setUpTranscript } from "./transcript.ts";
import { setUpComposer } from "./composer.ts";
import { setUpFiles } from "./files.ts";
import { setUpRequestFields } from "./htmx.ts";
import { setUpSseStartup } from "./sse.ts";
import { setUpNavigation } from "./navigation.ts";
import { setUpPushPresence } from "./push-presence.ts";

setUpPushPresence();
if (!document.body.hasAttribute("data-offline-page")) {
  setUpRequestFields();
  setUpSseStartup();
  setUpShell();
  setUpSidebar();
  setUpTranscript();
  setUpComposer();
  setUpFiles();
  setUpNavigation();
}
