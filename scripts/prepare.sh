#!/usr/bin/env sh
# pnpm runs `prepare` for a checkout and for a git dependency alike. Only a
# checkout has husky, so anywhere else this does nothing.
[ -d .git ] || exit 0

exec husky
