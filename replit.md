# Workspace

## Overview

DTR (Draw The Range) Multi-Instrument Trading Agent + Dashboard. A full-stack autonomous futures trading system that trades MYMM26, MCLK26, MGCM26, MNQM26 via the ProjectX API, with a React web dashboard for monitoring.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind CSS v4 + shadcn/ui

## Artifacts

- **`artifacts/api-server`** — Express API server (port 8080, path `/api`)
- **`artifacts/dtr-dashboard`** — React/Vite monitoring dashboard (path `/`)
- **`artifacts/dtr-python-app`** — Python/Flask autonomous trading UI (port 5000, path `/dtr-python`)
  - Proxies all ProjectX API calls through the TypeScript API server (Python DNS can't resolve gateway.projectx.com in dev)
  - `StripPrefixMiddleware` handles `/dtr-python` → `/` path stripping
  - `BASE_PATH` env var controls the URL prefix; HTML template injects it via `window.DTR_BASE`
  - Registered as the `python` service under the `dtr-dashboard` artifact to enable path-based routing

## Trading System

### Strategy: DTR (Draw The Range)
- Collect 1-min bars during range window to find daily high/low
- Detect bias candle (close vs midpoint → bullish/bearish)
- On breakout of range in entry window: place bracket order (SL + TP1 + TP2)
- Shared daily limits: stop at -$200 loss or +$1,400 profit

### Sessions (all times America/New_York)
- **London**: Range 1:12–2:13 AM, Entries 3:13–7:00 AM
- **NY**: Range 8:12–9:13 AM, Entries 9:13–2:00 PM

### Instruments
| Symbol | Name | Qty | Point Value |
|--------|------|-----|-------------|
| MYMM26 | Mini Yen | 2 | $12.50 |
| MCLK26 | Micro Crude Oil | 2 | $10.00 |
| MGCM26 | Micro Gold | 2 | $10.00 |
| MNQM26 | Micro NQ (Nasdaq 100) | 3 | $20.00 |

## Required Secrets
- `PROJECTX_API_KEY` — ProjectX API key
- `PROJECTX_USERNAME` — ProjectX username/email
- `PROJECTX_ACCOUNT_ID` — ProjectX account number

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Key Files

- `artifacts/api-server/src/lib/projectx-client.ts` — ProjectX REST API client
- `artifacts/api-server/src/lib/trading-config.ts` — Instrument configs, session times, helpers
- `artifacts/api-server/src/lib/dtr-strategy.ts` — Range computation, entry signal logic
- `artifacts/api-server/src/lib/agent-controller.ts` — Singleton agent with tick loop & risk management
- `artifacts/api-server/src/routes/agent.ts` — Agent status, start/stop, instruments, daily summary
- `artifacts/api-server/src/routes/trades.ts` — Trade history with pagination/filters
- `artifacts/api-server/src/routes/positions.ts` — Open positions
- `lib/db/src/schema/trades.ts` — trades + daily_summary tables
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth)
- `artifacts/dtr-dashboard/src/pages/dashboard.tsx` — Main dashboard page
- `artifacts/dtr-dashboard/src/pages/trades.tsx` — Trade history page
- `artifacts/dtr-dashboard/src/pages/positions.tsx` — Positions page

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
