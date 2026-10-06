set quiet := true

# pi-web's stylesheets are the pixel spec (src/web/styles); esbuild only
# inlines the @imports. Absolute /static/... urls are the browser's, not
# esbuild's, so they stay external. Target = the browserslist floor.
esbuild-css := "./node_modules/.bin/esbuild src/web/styles/index.css --bundle --target=chrome125,edge125,firefox147,safari26 '--external:/static/*' --outfile=static/app.css"
esbuild := "./node_modules/.bin/esbuild src/web/client/main.ts --bundle --format=esm --target=es2022 --alias:@core=./src/core --outfile=static/client.js"
# The published server: everything bundled except the locally installed Pi SDK
# and the runtime packages listed in AGENTS.md. Not
# minified, so a stack trace from an install still names real functions.
esbuild-server := "./node_modules/.bin/esbuild src/server.ts src/server-runtime.ts src/cli.ts --bundle --platform=node --format=esm --target=node24 --jsx=automatic --jsx-import-source=hono/jsx --alias:@=./src --alias:@core=./src/core --alias:@adapters=./src/adapters --alias:@web=./src/web '--external:@earendil-works/*' --external:web-push --external:undici --outdir=dist"
smoke := "WEB_PI_SMOKE=1 pnpm exec vitest run tests/smoke"

# INFO: List all available commands
default:
    @just --list

# BUILD: Resolve stable latest Pi and freeze it in the manifest and lockfile
update-pi:
    node scripts/update-pi.ts

# DEV: Report the Pi installed in this checkout
doctor:
    pnpm exec tsx scripts/doctor.ts

# DEV: Start the server with reload plus the CSS and client-script watchers
dev:
    {{ esbuild-css }}
    {{ esbuild }} --sourcemap
    node --watch --import tsx src/dev.ts & \
    {{ esbuild }} --sourcemap --watch & \
    {{ esbuild-css }} --watch; \
    kill %1 %2

# DEV: Build the stylesheet once
build-css:
    {{ esbuild-css }} --minify

# DEV: Build the client script once
build-js:
    # Packing includes static/ bundles left by older checkouts.
    rm -f static/mermaid.js
    {{ esbuild }} --minify

# DEV: Build everything the package ships: assets and dist/
build: update-pi doctor typecheck build-css build-js
    {{ esbuild-server }}

# DEV: Start the built server, as the published bin does
start: build
    node bin/web-pi.js

# DOCS: Serve fictional screenshot sessions on an ephemeral loopback port
screenshots: build
    node --import tsx scripts/screenshot-fixture.ts

# TEST: Real-browser settings layout against the isolated screenshot fixture
settings-scroll url:
    node --import tsx scripts/check-settings-scroll.ts '{{url}}'

# TEST: Real-browser style scale checks and captures against the isolated fixture
style-scale url output="dist/style-scale":
    node --import tsx scripts/check-style-scale.ts '{{url}}' '{{output}}'

# LINT: Formatting, lint, and types
lint: typecheck
    pnpm exec oxfmt --check .
    pnpm exec oxlint .
    pnpm exec stylelint "src/web/styles/**/*.css"
    node --import tsx scripts/check-doc-path-references.ts

# LINT: Apply lint and format fixes
fix:
    pnpm exec oxlint --fix .
    pnpm exec stylelint --fix "src/web/styles/**/*.css"
    pnpm exec oxfmt --write .

# LINT: TypeScript only
typecheck:
    pnpm exec tsc --noEmit

# TEST: Whole suite
test:
    pnpm exec vitest run

# TEST: Whole suite with line coverage; `--project client` narrows to the bundle
coverage:
    pnpm exec vitest run --coverage

# TEST: Selected tests, e.g. `just test-one tests/core`
[positional-arguments]
test-one *args:
    pnpm exec vitest run "$@"

# TEST: Pack the package, install it, and serve a fixture session from it
smoke: build
    {{ smoke }}

# QA: The handoff gate: fix, lint, test
qa:
    just fix
    just lint
    just test

# CI: Refresh Pi, then run non-fixing validation
ci: build
    just lint
    just test
    {{ smoke }}
