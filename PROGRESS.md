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

## Pending
[ ] Upgrade Supabase to Pro plan — https://supabase.com/dashboard/org/hauptcc-6068/billing
[ ] Create Supabase project "dtr-trading" — after Pro upgrade
[ ] Run 3 SQL migrations in new project SQL editor
[ ] Deploy Flask backend to Railway
[ ] Deploy React frontend to Vercel
[ ] Set all env vars on Railway + Vercel
[ ] 2-week forward test: net positive P&L
