#!/bin/bash
# Post-merge setup script
# Build order is critical:
#   1. Install deps
#   2. Regenerate API client types from OpenAPI spec (orval codegen)
#   3. Compile all TypeScript packages via root tsc -b (respects project references,
#      so api-zod and api-client-react are always compiled before the dashboard)
#   4. Push DB schema changes
#   5. Build the dashboard (always runs AFTER types are fully resolved)
#
# Performance: each step stores a checksum of its inputs in .post-merge-hashes.
# If inputs are unchanged from the previous successful run the step is skipped,
# making typical single-file-change merges significantly faster.
set -euo pipefail

HASH_FILE=".post-merge-hashes"

step() {
  echo ""
  echo "==> Step $1: $2"
}

fail() {
  echo ""
  echo "✗ FAILED at step $1: $2" >&2
  exit 1
}

# Compute a stable SHA-256 hash over the content of all regular files found
# under the given paths (files or directories).  Returns the empty string when
# no files are found so callers can tell "nothing to hash" from a real hash.
hash_paths() {
  local files
  # Collect file list first; guard against empty input before piping to sha256sum
  # to avoid platform-dependent behaviour of "xargs sha256sum" with no arguments.
  files=$(find "$@" -type f 2>/dev/null | sort) || true
  if [[ -z "$files" ]]; then
    echo ""
    return
  fi
  echo "$files" | xargs sha256sum | sha256sum | awk '{print $1}'
}

# Read the stored hash for a labelled step from HASH_FILE.
read_hash() {
  local key="$1"
  if [[ -f "$HASH_FILE" ]]; then
    grep "^${key}=" "$HASH_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true
  fi
}

# Persist the hash for a labelled step, replacing any previous value.
write_hash() {
  local key="$1"
  local value="$2"
  local tmp="${HASH_FILE}.tmp"
  if [[ -f "$HASH_FILE" ]]; then
    grep -v "^${key}=" "$HASH_FILE" > "$tmp" 2>/dev/null || true
    mv "$tmp" "$HASH_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$HASH_FILE"
}

# ---------------------------------------------------------------------------
# Step 1 – Install dependencies
# Always run; pnpm install --frozen-lockfile is fast when the lockfile and
# store are warm.  We only skip it when the lockfile hash hasn't changed AND
# node_modules already exists to avoid breaking a fresh clone.
# ---------------------------------------------------------------------------
step 1 "Installing dependencies"
INSTALL_HASH=$(hash_paths pnpm-lock.yaml)
PREV_INSTALL_HASH=$(read_hash "install")
if [[ -n "$INSTALL_HASH" && "$INSTALL_HASH" == "$PREV_INSTALL_HASH" && -d "node_modules" ]]; then
  echo "    ↩ Skipping: pnpm-lock.yaml unchanged and node_modules present"
else
  pnpm install --frozen-lockfile || fail 1 "pnpm install"
  write_hash "install" "$INSTALL_HASH"
fi

# ---------------------------------------------------------------------------
# Step 2 – Regenerate API client types from OpenAPI spec
# ---------------------------------------------------------------------------
step 2 "Regenerating API client types from OpenAPI spec"
CODEGEN_HASH=$(hash_paths lib/api-spec/openapi.yaml lib/api-spec/orval.config.ts)
PREV_CODEGEN_HASH=$(read_hash "codegen")
if [[ -n "$CODEGEN_HASH" && "$CODEGEN_HASH" == "$PREV_CODEGEN_HASH" && -d "lib/api-client-react/src" ]]; then
  echo "    ↩ Skipping: OpenAPI spec and orval config unchanged"
else
  pnpm --filter @workspace/api-spec run codegen || fail 2 "orval codegen (api-spec)"
  write_hash "codegen" "$CODEGEN_HASH"
fi

# ---------------------------------------------------------------------------
# Step 3 – Compile TypeScript packages
# The hash covers all TS sources in every lib package plus the tsconfig files
# that govern compilation.  Generated files written by codegen (step 2) are
# included via lib/api-client-react/src so a spec change correctly invalidates
# this step even when codegen was skipped above on a re-run.
# ---------------------------------------------------------------------------
step 3 "Compiling TypeScript packages (api-zod → api-client-react → ...)"
TSC_HASH=$(hash_paths \
  lib/api-client-react/src \
  lib/api-zod/src \
  lib/db/src \
  lib/api-client-react/tsconfig.json \
  lib/api-zod/tsconfig.json \
  lib/db/tsconfig.json \
  tsconfig.json \
  tsconfig.base.json)
PREV_TSC_HASH=$(read_hash "tsc")
if [[ -n "$TSC_HASH" && "$TSC_HASH" == "$PREV_TSC_HASH" && -d "lib/api-client-react/dist" ]]; then
  echo "    ↩ Skipping: TypeScript sources and tsconfigs unchanged"
else
  # tsc -b respects project references and uses .tsbuildinfo for its own
  # incremental layer; this outer skip avoids even invoking the compiler when
  # we know nothing changed.
  pnpm exec tsc -b || fail 3 "tsc -b (workspace root)"
  write_hash "tsc" "$TSC_HASH"
fi

# ---------------------------------------------------------------------------
# Step 4 – Push database schema
# ---------------------------------------------------------------------------
step 4 "Pushing database schema"
DB_HASH=$(hash_paths lib/db/src lib/db/drizzle.config.ts)
PREV_DB_HASH=$(read_hash "db")
if [[ -n "$DB_HASH" && "$DB_HASH" == "$PREV_DB_HASH" ]]; then
  echo "    ↩ Skipping: DB schema sources unchanged"
else
  # push-force is required because stdin is closed (/dev/null) during
  # post-merge; drizzle-kit push would receive EOF on interactive prompts.
  pnpm --filter @workspace/db run push-force || fail 4 "db schema push"
  write_hash "db" "$DB_HASH"
fi

# ---------------------------------------------------------------------------
# Step 5 – Build the dashboard
# The hash covers the dashboard's own sources AND every lib package's sources
# (because the lib dists, consumed by Vite, are determined by those sources).
# ---------------------------------------------------------------------------
step 5 "Building dashboard (requires resolved API types from step 3)"
DASHBOARD_HASH=$(hash_paths \
  artifacts/dtr-dashboard/src \
  artifacts/dtr-dashboard/vite.config.ts \
  artifacts/dtr-dashboard/index.html \
  artifacts/dtr-dashboard/tsconfig.json \
  lib/api-client-react/src \
  lib/api-zod/src \
  lib/db/src)
PREV_DASHBOARD_HASH=$(read_hash "dashboard")
if [[ -n "$DASHBOARD_HASH" && "$DASHBOARD_HASH" == "$PREV_DASHBOARD_HASH" && -d "artifacts/dtr-dashboard/dist" ]]; then
  echo "    ↩ Skipping: Dashboard and upstream lib sources unchanged"
else
  BASE_PATH=/dtr-dashboard pnpm --filter @workspace/dtr-dashboard build || fail 5 "dtr-dashboard build"
  write_hash "dashboard" "$DASHBOARD_HASH"
fi

echo ""
echo "==> All steps completed successfully."
