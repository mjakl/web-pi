# 2. Pi is a package-owned runtime, refreshed at build time

Status: accepted (2026-10-05)

## Context

web-pi runs Pi in-process through its SDK, so the Pi packages it imports decide
how sessions are read, written and run. Until this decision web-pi used the
system Pi: it found `pi` on `PATH`, located the package that owned it, and
symlinked the SDK packages into its own `node_modules` — in a checkout on
install and before every recipe that ran code, in an installed package on every
start. That kept web-pi on the same Pi version as the terminal, but a checkout
could not install its dependencies before Pi was installed, an installed package
needed a writable install directory, and the version web-pi ran was whatever the
system had at the time, not the one it was built and tested against.

## Decision

- The Pi packages web-pi imports, listed in `PI_PACKAGES` in
  `src/pi-version.ts`, are exact `dependencies` in `package.json`. esbuild
  leaves `@earendil-works/*` external, so Pi keeps its own module identity,
  extension loader, workers and assets.
- `just build` starts with `scripts/update-pi.ts`. It asks the registry for Pi's
  stable `latest` tag, even when the lockfile already satisfies the manifest,
  and pins every package in `PI_PACKAGES` to that version in `package.json` and
  `pnpm-lock.yaml`. `scripts/doctor.ts` then checks the installed packages,
  `tsc` typechecks against them, and only then does esbuild write the bundles. A
  registry, install or type error fails the build.
- `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` exempts Pi's runtime
  packages from pnpm's 24-hour release-age delay, so a new stable Pi is usable
  at once. Every other dependency keeps the delay.
- Every start goes through `src/server.ts`, which uses `src/pi-version.ts` to
  check that each Pi package is a direct dependency of this install, physically
  inside it, at exactly the declared version, before it imports the SDK-bearing
  `src/server-runtime.ts`. Startup never updates, relinks or looks for a system
  Pi.

## Consequences

A tarball installs the Pi it was built with and needs no writable package
directory or system Pi. Upgrading the system Pi does not change web-pi;
upgrading web-pi's Pi means a new build and reinstall. Terminal Pi and web-pi
can therefore run different Pi versions against one agent directory; see
[Pi upgrade compatibility](../deployment.md#pi-upgrade-compatibility).

Builds need network access, and each adopts the newest stable Pi, breaking
changes included. A release that breaks the install or the typecheck fails the
build; the build never quietly succeeds on the older SDK. A build that picked up
a newer Pi changes `package.json` and `pnpm-lock.yaml`; contributors commit both
together, and CI warns when its build changed them, because the run then tested
a newer Pi than the commit pins. Tests and `just dev` use the installed
dependencies without refreshing them; `just update-pi` refreshes Pi without
building.

Install layouts that cannot give web-pi its own dependency edges, such as
hoisted local npm installs, pnpm's global virtual store or an SDK found in an
ancestor directory, fail at startup;
[the README](../../README.md#install-and-run) lists the supported ones.
