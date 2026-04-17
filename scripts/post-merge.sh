#!/bin/bash
# Post-merge setup script
# Build order is critical:
#   1. Install deps
#   2. Regenerate API client types from OpenAPI spec (orval codegen)
#   3. Compile all TypeScript packages via root tsc -b (respects project references,
#      so api-zod and api-client-react are always compiled before the dashboard)
#   4. Push DB schema changes
#   5. Build the dashboard (always runs AFTER types are fully resolved)
set -euo pipefail

step() {
  echo ""
  echo "==> Step $1: $2"
}

fail() {
  echo ""
  echo "✗ FAILED at step $1: $2" >&2
  exit 1
}

step 1 "Installing dependencies"
pnpm install --frozen-lockfile || fail 1 "pnpm install"

step 2 "Regenerating API client types from OpenAPI spec"
pnpm --filter @workspace/api-spec run codegen || fail 2 "orval codegen (api-spec)"

step 3 "Compiling TypeScript packages (api-zod → api-client-react → ...)"
# tsc -b at workspace root follows project references in tsconfig.json,
# guaranteeing api-zod and api-client-react are compiled before anything that
# depends on them.  The dashboard Vite build in step 5 must see up-to-date
# declaration files; this step ensures that invariant holds.
pnpm exec tsc -b || fail 3 "tsc -b (workspace root)"

step 4 "Pushing database schema"
# push-force is required because stdin is closed (/dev/null) during post-merge;
# drizzle-kit push would receive EOF when prompting about destructive changes and
# abort.  --force bypasses interactive confirmation — acceptable here because
# schema migrations are reviewed in code before merging.
pnpm --filter @workspace/db run push-force || fail 4 "db schema push"

step 5 "Building dashboard (requires resolved API types from step 3)"
BASE_PATH=/dtr-dashboard pnpm --filter @workspace/dtr-dashboard build || fail 5 "dtr-dashboard build"

echo ""
echo "==> All steps completed successfully."
