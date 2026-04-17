#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-client-react exec tsc -b
pnpm --filter db push
