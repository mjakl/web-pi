import { configUseCases } from "./config.ts";
import { createShared, type WorkspaceDeps } from "./deps.ts";
import { fileUseCases } from "./files.ts";
import { liveUseCases } from "./live.ts";
import { sessionUseCases } from "./sessions.ts";

// The application service. Inbound port for every page and partial: the web
// layer renders what this returns and never touches Pi or the file system.
// One flat object, composed from four use-case families over one set of
// shared internals (deps.ts); the families never import each other.

export type {
  FileScope,
  FileView,
  FolderChoice,
  NewSessionView,
  SessionView,
  SidebarView,
  ViewOptions,
} from "./views.ts";
export { ForbiddenPath, InspectionOnlySession } from "./views.ts";

export type Workspace = ReturnType<typeof createWorkspace>;

export function createWorkspace(deps: WorkspaceDeps) {
  const shared = createShared(deps);
  return {
    requireWritableSession: shared.requireWritableSession,
    ...sessionUseCases(shared),
    ...liveUseCases(shared),
    ...fileUseCases(shared),
    ...configUseCases(shared),
  };
}
