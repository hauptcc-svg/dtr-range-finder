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

## 2026-05-03

[x] Fixed ProjectX auth: wrong endpoint (/api/Auth/signIn → /api/Auth/loginKey) + wrong field (password → apiKey)
[x] Updated PROJECTX_API_KEY in Railway with correct TopstepX API key from topstepx.com/settings?tab=api
[x] Railway backend fully live: https://dtr-range-finder-production.up.railway.app
    - Auth ✅ | Supabase ✅ | Claude brain ✅ | Hermes brain ✅ | DTRv3 x4 instruments ✅
[x] GET /health → {"status":"ok","running":true,"halted":false,"mode":"HALT"}
[x] Deployed React frontend to Vercel: https://project-wonf5.vercel.app
    - Root: artifacts/dtr-dashboard | Build: pnpm build | Output: dist/public
    - VITE_API_URL = https://dtr-range-finder-production.up.railway.app

## 2026-05-03 (session 2)

[x] Full UI overhaul — account stats bar (Balance, Drawdown, RP&L, UP&L)
[x] Open Trades inline on dashboard with CLOSE buttons, live 3s polling
[x] Analytics page (/analytics) — Daily Target Progress + Hermes Report generator
[x] ManualTradeWidget on each instrument card (qty ±1–10, BUY/SELL buttons)
[x] Contracts-per-instrument section in Risk Controls (saved to MULTI_INSTRUMENT_CONFIG)
[x] POST /api/agent/manual-order endpoint for manual market orders
[x] Dashboard restructure: AccountStatsBar → (SystemStatus + OpenTrades) → RiskControls → Instruments → EquityCurve
[x] Analytics route wired (/analytics), Positions removed from primary nav
[x] Inter font system — replaced Space Mono across all 277 usages, --app-font-data keeps JetBrains Mono for numeric displays
[x] Mobile responsive: overflow-x-hidden, tables hide non-essential columns on mobile
[x] Mobile bottom navigation bar (Dashboard / Analytics / Trade History)
[x] Telegram bot commands: /status /pnl /positions /halt /resume
[x] Registered Telegram webhook at https://dtr-range-finder-production.up.railway.app/api/telegram/webhook
[x] Confirmed Telegram connectivity (test message delivered to @cchaos21)

## 2026-05-04

[x] Fixed mode buttons (DTR/XXX/AI MODE/HALT) — were unclickable/invisible in dark mode
    - Added `pendingMode` optimistic state for instant visual feedback on click
    - Fixed activeMode default from "DTR" → "" (no button pre-selected until backend confirms)
    - Added hover:border/text styles to authenticated inactive buttons
    - Added amber hint text "← Select a mode, then click START" when no mode selected
    - Buttons disabled while pendingMode != null (prevents double-click)
[x] Added `mode` + `activeStrategy` fields to GET /api/agent/status response
[x] Fixed Risk Controls fields showing empty — GET /api/agent/settings now returns camelCase
    keys (dailyLossLimit, dailyProfitTarget, maxTradesPerDay, maxLossesPerDirection)
    matching the React RiskSettings interface (was snake_case, causing undefined in all inputs)
[x] Fixed Risk Controls save having no effect — POST /api/agent/settings now reads camelCase
    keys (dailyLossLimit, dailyProfitTarget) sent by the frontend (was looking for snake_case)
[x] Risk settings now persist across Railway deploys via Supabase platform_settings table
    - Upserted on every save; loaded on boot (Supabase overlay wins over JSON + env vars)
    - platform_settings table created in Supabase with seed row { daily_loss_limit: 200, ... }
    - Railway filesystem wipe on deploy no longer resets risk controls
[x] Fixed zero market data — orchestrator now resolves ticker → numeric contract IDs on boot
    - TopstepX API requires numeric IDs, not symbols like "MNQM26"
    - search_contracts(symbol) called for all 4 instruments in start(); IDs stored in self.contract_ids
    - Added _cid(symbol) helper; all API calls use self._cid(symbol) instead of bare symbol
[x] Fixed account balance showing "---" — get_accounts() was using GET, TopstepX requires POST
    - Every TopstepX search endpoint uses POST; GET returns HTML (wrong MIME type)
    - Changed to POST /api/Account/search with json={"onlyActive": True}
    - Added multi-key fallback: tries "accounts" → "data" → "result" → direct list
[x] Added GET /api/debug/account endpoint — returns raw TopstepX response for balance diagnosis
[x] Added periodic account refresh every 5 ticks (~5 min) in orchestrator _tick()
[x] Added accountBalance, activeAccountId, availableAccounts to /api/agent/status response
