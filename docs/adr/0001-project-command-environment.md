# 1. Project commands run in the project's environment, not the server's

Status: accepted (2026-09-10)

## Context

web-pi is a Node server. Its own process environment carries `PORT`, `NODE_ENV`,
and the `WEB_PI_*` settings. Every shell command a session runs — `!cmd` from
the composer and the agent's own `bash` tool — inherits that environment by
default.

Those variables mean something else inside a project. `PORT` reroutes a dev
server the agent starts, `NODE_ENV=production` makes `npm ci` skip
devDependencies, and `WEB_PI_*` leaks our configuration into build scripts. The
commands look right and behave differently than they would in a terminal.

## Decision

`src/adapters/pi/bash-env.ts` sanitises the environment for both paths:

- `PORT`, `NODE_ENV`, and every `WEB_PI_*` variable are removed (compared
  case-insensitively on Windows, where variable names are). That helper behavior
  does not imply Windows support; web-pi currently targets POSIX systems.
- `<agentDir>/bin` is prepended to `PATH` when it is not already there, so tools
  an extension installed are found, as they are in Pi's terminal.
- Everything else — `PATH`, Pi's own `PI_*` session metadata, per-command
  variables — is passed through untouched.

`createProjectBashOperations` applies this to `AgentSession.executeBash`.
`createProjectBashExtension` registers a hidden inline extension that replaces
the agent's `bash` tool with one built on the same operations.

If a user extension registers its own `bash` tool, `preferUserBashExtension`
drops ours and the tool-name conflict the loader raised for it. A third-party
shell override wins outright and keeps its own environment.

## Consequences

Built-in shell execution no longer inherits these server-specific overrides. It
still inherits the rest of the server environment; this is not a sandbox or a
guarantee that every variable matches an interactive terminal. The cost is one
inline extension and a wrapper around Pi's local shell backend; the alternative
— documenting that `PORT` is taken — puts the surprise on the reader instead.

This is web-pi's version of pi-web's ADR-0001. The rule is the same; the
variables differ because there is no Next.js here.
