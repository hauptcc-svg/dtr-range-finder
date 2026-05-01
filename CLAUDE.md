# CLAUDE.md — DTR Range Finder / AI Trading Platform

## Project Overview
Autonomous AI trading platform. Two AI brains collaborate:
- **Hermes 3** (`nousresearch/hermes-3-llama-3.1-70b` via OpenRouter) — strategic brain, runs after each trade/session, writes patterns to `trading_context` in Supabase
- **Claude haiku-4-5** (Anthropic SDK) — tactical brain, validates entries every 60s in real-time

## Stack
- **Backend:** Python (Flask) → Railway
- **Frontend:** React + Vite + TypeScript + Tailwind + shadcn/ui → Vercel
- **DB:** Supabase (PostgreSQL)
- **Instruments:** MNQM26 (MNQ), MYMM26 (MYM), MGCM26 (MGC), MCLK26 (MCL)
- **Trading API:** ProjectX

## Key Directories
```
dtr-complete-final/         — Python backend
  strategies/               — BaseStrategy, DTRv3, XXXv1
  flask_autonomous_trading.py
  market_data_orchestrator.py
  claude_brain.py
  hermes_brain.py
  drawdown_monitor.py
artifacts/dtr-dashboard/    — React frontend
  src/pages/dashboard.tsx
  src/pages/positions.tsx
  src/components/equity-curve.tsx
  src/components/hermes-report-modal.tsx
  src/components/instrument-card.tsx
  src/components/layout.tsx
supabase/migrations/        — SQL migrations (run in order)
```

## Supabase Migrations (run in order)
1. `supabase/migrations/001_trading_schema.sql` — core tables
2. `supabase/migrations/002_multi_tp_schema.sql` — multi-TP bracket
3. `supabase/migrations/003_equity_snapshots.sql` — equity curve + account_id

## Environment Variables Required
```
PROJECTX_USERNAME=
PROJECTX_PASSWORD=
PROJECTX_BASE_URL=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FRONTEND_URL=https://your-app.vercel.app
PORT=5000
```

## Architecture Decisions
- **Hermes JSON output** uses snake_case: `win_rate_by_setup`, `best_instruments`, `worst_instruments`, `param_recommendations`, `early_close_analysis`, `news_correlation`, `overall_summary`
- **HermesReport TypeScript interface** must match the above snake_case fields exactly
- **pnpm workspace** — Windows native binaries required: `@rollup/rollup-win32-x64-msvc`, `@esbuild/win32-x64@0.27.3`, `lightningcss-win32-x64-msvc@1.31.1`
- **Build for Vercel**: use `BASE_PATH=/dtr-dashboard` in Vite config for production deploy
- **Build for local preview**: use `BASE_PATH=/` to avoid blank page
- **Terminal UI design system**: JetBrains Mono font, `.terminal-card` CSS class (backdrop-blur, rgba dark bg), neon green BOS glow (`bos-active` animation)

## API Endpoints (Flask)
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/live/dashboard | Full dashboard state (polls every 3s) |
| POST | /api/hermes/report | Generate Hermes feedback report |
| GET | /api/performance/equity | Equity curve data (?range=7d\|30d\|all) |
| POST | /api/strategy/<name>/timeframe | Switch timeframe (409 if open trades) |
| GET | /api/trades/history | Trade history |
| GET | /api/hermes/insights | Trading context for all symbols |
| POST | /api/mode/dtr | Activate DTR strategy |
| POST | /api/mode/xxx | Activate XXX strategy |
| POST | /api/mode/halt | Halt trading |

## Deployment
- **Backend (Railway):** `Procfile` → `web: gunicorn -w 2 -b 0.0.0.0:$PORT "dtr-complete-final.flask_autonomous_trading:app"`
- **Frontend (Vercel):** root = `artifacts/dtr-dashboard`, build command = `pnpm build`, output = `dist/public`

## Rules
- Never commit `.env`
- Always backfill new DB columns + run SELECT COUNT(*) to confirm
- Git: commit only when Craig says "ship it" or "commit it" — EXCEPTION: Craig has enabled auto-commit for this project
- Mobile first: 375px, 52px tap targets
