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
  src/pages/dashboard.tsx   — main dashboard (account stats, open trades, risk controls)
  src/pages/analytics.tsx   — Daily Target Progress + Hermes Report (NEW)
  src/pages/positions.tsx
  src/pages/trades.tsx
  src/components/equity-curve.tsx
  src/components/hermes-report-modal.tsx
  src/components/instrument-card.tsx  — includes ManualTradeWidget
  src/components/layout.tsx           — sidebar + mobile bottom nav
  src/index.css                       — Inter font, stat-pill, section-header utilities
supabase/migrations/        — SQL migrations (run in order)
```

## Supabase Migrations (run in order)
1. `supabase/migrations/001_trading_schema.sql` — core tables
2. `supabase/migrations/002_multi_tp_schema.sql` — multi-TP bracket
3. `supabase/migrations/003_equity_snapshots.sql` — equity curve + account_id

## Environment Variables Required
```
PROJECTX_USERNAME=          # TopstepX login email
PROJECTX_API_KEY=           # TopstepX API key from topstepx.com/settings?tab=api (NOT password)
PROJECTX_ACCOUNT_ID=        # Numeric account ID from TopstepX
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
FRONTEND_URL=https://project-wonf5.vercel.app
PORT=5000
```

> **Note:** `PROJECTX_PASSWORD` is NOT used. The auth endpoint is `POST /api/Auth/loginKey`
> with body `{ userName, apiKey }`. No appId, cid, or deviceId needed.

## Architecture Decisions
- **Hermes JSON output** uses snake_case: `win_rate_by_setup`, `best_instruments`, `worst_instruments`, `param_recommendations`, `early_close_analysis`, `news_correlation`, `overall_summary`
- **HermesReport TypeScript interface** must match the above snake_case fields exactly
- **pnpm workspace** — Windows native binaries required: `@rollup/rollup-win32-x64-msvc`, `@esbuild/win32-x64@0.27.3`, `lightningcss-win32-x64-msvc@1.31.1`
- **Build for Vercel**: use `BASE_PATH=/dtr-dashboard` in Vite config for production deploy
- **Build for local preview**: use `BASE_PATH=/` to avoid blank page
- **Font system**: Inter is the primary font (both `--app-font-sans` and `--app-font-mono` map to Inter). JetBrains Mono available as `--app-font-data` for numeric displays only. All 277 `font-mono` class usages render Inter — do NOT change `--app-font-mono` back to a monospace font.
- **ProjectX auth**: endpoint is `POST /api/Auth/loginKey` with `{ userName, apiKey }` — NOT `/api/Auth/signIn` with password+appId fields. Only PROJECTX_USERNAME + PROJECTX_API_KEY + PROJECTX_ACCOUNT_ID needed.
- **Dashboard mode control**: DTR / XXX / AI MODE / HALT buttons are on the dashboard UI — no manual API calls needed to switch strategy
- **Telegram bot**: token `8396207281:AAEa...` (in `.env`). Webhook registered at `https://dtr-range-finder-production.up.railway.app/api/telegram/webhook`. Old `.replit` token is expired — do not use. Chat ID `332762243` = Craig's personal Telegram user ID (@cchaos21). Bot commands: /status /pnl /positions /halt /resume.
- **Manual order endpoint**: `POST /api/agent/manual-order` — body `{ symbol, side: "BUY"|"SELL", quantity }`. Looks up `contract_id` from `orchestrator.instruments`. Requires auth cookie.
- **Per-instrument qty**: stored in `MULTI_INSTRUMENT_CONFIG[sym]["qty"]`. Updated via `POST /api/agent/settings` with `{ instrument_qty: { MNQM26: 2, ... } }`. Values clamped 1–50.
- **Analytics page**: `/analytics` route — Daily Target Progress + Hermes Report generator (inline, not modal). Period selector 7D/30D/ALL.
- **Open Trades inline**: `OpenTradesInline` component on dashboard, polls `useGetPositions` every 3s. CLOSE button calls `useClosePosition`. Table hides SIZE/ENTRY/CURRENT on mobile (`hidden sm:table-cell`).
- **Mobile nav**: Fixed bottom nav bar on mobile (`md:hidden`), 64px tall. Sidebar hidden on mobile. Content area uses `pb-20` to avoid overlap.

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
| POST | /api/agent/manual-order | Place manual order `{ symbol, side, quantity }` |
| POST | /api/agent/settings | Update settings incl. `instrument_qty` per symbol |
| POST | /api/telegram/webhook | Telegram inbound commands + Hermes callbacks |

## Deployment
- **Backend (Railway):** `Procfile` → `web: gunicorn -w 2 -b 0.0.0.0:$PORT "dtr-complete-final.flask_autonomous_trading:app"`
- **Frontend (Vercel):** root = `artifacts/dtr-dashboard`, build command = `pnpm build`, output = `dist/public`

## Rules
- Never commit `.env`
- Always backfill new DB columns + run SELECT COUNT(*) to confirm
- Git: commit only when Craig says "ship it" or "commit it" — EXCEPTION: Craig has enabled auto-commit for this project
- Mobile first: 375px, 52px tap targets
