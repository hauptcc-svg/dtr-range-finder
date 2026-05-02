# PROGRESS.md — DTR Range Finder / AI Trading Platform

## 2026-05-01

[x] Implemented Phase 1 backend: strategies/base.py, dtr_v3.py, xxx_v1.py
[x] Implemented market_data_orchestrator.py with async loop, 4 instruments
[x] Implemented claude_brain.py — haiku-4-5 tactical validation with prompt caching
[x] Implemented hermes_brain.py — Hermes 3 strategic brain via OpenRouter
[x] Implemented drawdown_monitor.py — auto-halt on drawdown thresholds
[x] Added Flask endpoints: /api/hermes/report, /api/performance/equity, /api/strategy/<name>/timeframe
[x] Created Supabase migrations: 001_trading_schema.sql, 002_multi_tp_schema.sql, 003_equity_snapshots.sql
[x] Built React frontend: dashboard, positions page, instrument cards, mode control
[x] Created equity-curve.tsx — Recharts ComposedChart with 7D/30D/ALL range selector
[x] Created hermes-report-modal.tsx — 6-section collapsible report with APPROVE/REJECT buttons
[x] Fixed HermesReport interface to match actual Hermes JSON output (snake_case fields)
[x] Fixed ([Math.abs(report.avgLoss)]).toFixed(2) array bug → Math.abs(report.avgLoss).toFixed(2)
[x] Applied Terminal/Pro Trading UI: JetBrains Mono, .terminal-card CSS, BOS neon glow
[x] Fixed Windows build: added @rollup/rollup-win32-x64-msvc, @esbuild/win32-x64@0.27.3, lightningcss-win32-x64-msvc@1.31.1
[x] Built dashboard locally — confirmed no TypeScript errors
[x] Added _snapshot_equity(), set_strategy_timeframe(), _calc_live_pnl() to orchestrator
[x] Created .env.example, Procfile, runtime.txt for Railway deployment
[x] Committed all Phase 1 + UI enhancements to git

## 2026-05-02

[x] Upgraded Supabase to Pro plan
[x] Created Supabase project "dtr-trading" (URL: https://gphoaubbvimcetlehvmk.supabase.co)
[x] Ran all 3 SQL migrations in Supabase SQL editor (001, 002, 003)
[x] Collected all credentials: ProjectX, Anthropic, OpenRouter, Telegram, Supabase
[x] Wrote .env file with all 11 env vars
[x] Confirmed PROJECTX_BASE_URL is hardcoded in projectx_api.py — not needed in .env
[x] Created Railway project "awake-respect" — connected dtr-range-finder GitHub repo
[x] Set root directory to dtr-complete-final on Railway
[x] Fixed Railway build failure: added custom start command (gunicorn -w 2 -b 0.0.0.0:$PORT flask_autonomous_trading:app)
[x] Added all env vars to Railway Variables tab (pending FRONTEND_URL)

## Pending
[ ] Confirm Railway Flask backend is live (redeploy in progress)
[ ] Get Railway public URL once deploy succeeds
[ ] Deploy React frontend to Vercel (root: artifacts/dtr-dashboard)
[ ] Add VITE_API_URL=<railway-url> to Vercel env vars
[ ] Add FRONTEND_URL=<vercel-url> back to Railway
[ ] End-to-end smoke test: GET /health → GET /api/live/dashboard
[ ] 2-week forward test: net positive P&L
