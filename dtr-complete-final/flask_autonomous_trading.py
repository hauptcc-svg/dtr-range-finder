"""
Flask Autonomous Trading App
=============================
Production entrypoint for the DTR AI Trading Platform.

Boot sequence:
  1. Flask starts (Gunicorn)
  2. MarketDataOrchestrator.start() runs in a background asyncio task
  3. Orchestrator fetches bars every 60s, runs DTR state machines
  4. React frontend polls /api/live/dashboard every 3s

Endpoints:
  POST /api/mode/dtr              — Rule-based DTR only (BOS signal entries)
  POST /api/mode/xxx              — XXX strategy (ALMA crossover, London+NY session)
  POST /api/mode/claude           — Full AI: Claude + Hermes
  POST /api/mode/halt             — Stop all trading
  POST /api/mode/resume           — Resume from drawdown halt
  GET  /api/mode/status           — Current mode + health
  GET  /api/live/dashboard        — Real-time state (polled every 3s)
  GET  /api/trades/history        — Last N trades from Supabase
  GET  /api/performance/metrics   — Win rate, P&L, streaks
  GET  /api/hermes/insights       — trading_context for all symbols
  GET  /api/ai/log                — Claude + Hermes decision log
  GET  /api/drawdown/status       — Drawdown monitor state
  POST /api/telegram/callback     — Hermes approve/reject param change
  GET  /api/accounts              — List all ProjectX accounts
  POST /api/accounts/select       — Switch active trading account

Deploy: gunicorn -w 2 -b 0.0.0.0:$PORT "dtr-complete-final.flask_autonomous_trading:app"
"""

import asyncio
import logging
import os
import threading
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS

from market_data_orchestrator import orchestrator
from drawdown_monitor import DrawdownMonitor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# App init
# ─────────────────────────────────────────────────────────────────────────────

app = Flask(__name__)

CORS(app, origins=[
    os.environ.get("FRONTEND_URL", "http://localhost:5173"),
    "https://*.vercel.app",
    "http://localhost:3000",
])

drawdown_monitor = DrawdownMonitor(
    loss_limit=float(os.environ.get("DAILY_LOSS_LIMIT",   200)),
    profit_target=float(os.environ.get("DAILY_PROFIT_TARGET", 1400)),
)

# Wire drawdown monitor → orchestrator (injected after both are created)
orchestrator._drawdown_monitor = drawdown_monitor


# ─────────────────────────────────────────────────────────────────────────────
# Background orchestrator thread
# ─────────────────────────────────────────────────────────────────────────────

def _run_orchestrator_loop() -> None:
    """Run the async orchestrator in its own event loop (separate thread)."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    orchestrator._loop = loop  # store ref for sync→async bridging (account switching)
    try:
        loop.run_until_complete(orchestrator.start())
    except Exception as exc:
        logger.error(f"❌ Orchestrator loop crashed: {exc}", exc_info=True)
    finally:
        loop.close()


def _boot_orchestrator() -> None:
    t = threading.Thread(target=_run_orchestrator_loop, daemon=True, name="orchestrator")
    t.start()
    logger.info("🚀 Orchestrator background thread started")


# Boot when Gunicorn (or __main__) starts
_boot_orchestrator()


# ─────────────────────────────────────────────────────────────────────────────
# Mode control endpoints
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/mode/dtr", methods=["POST"])
def switch_to_dtr():
    orchestrator.set_active_strategy("DTR")
    orchestrator.set_mode("DTR")
    return jsonify({
        "success": True,
        "mode": "DTR",
        "active_strategy": "DTR",
        "message": "DTR rule-based trading active. BOS signal entries.",
        "ai_validation": False,
    })


@app.route("/api/mode/xxx", methods=["POST"])
def switch_to_xxx():
    orchestrator.set_active_strategy("XXX")
    orchestrator.set_mode("DTR")  # DTR mode = rule-based, just different strategy
    return jsonify({
        "success": True,
        "mode": "DTR",
        "active_strategy": "XXX",
        "message": "XXX strategy active. ALMA crossover signals, London+NY session.",
    })


@app.route("/api/mode/claude", methods=["POST"])
def switch_to_claude():
    orchestrator.set_mode("CLAUDE+HERMES")
    return jsonify({
        "success": True,
        "mode": "CLAUDE+HERMES",
        "message": "Full AI mode: Claude validates entries, Hermes learns after each trade.",
        "ai_validation": True,
    })


@app.route("/api/mode/halt", methods=["POST"])
def halt_trading():
    orchestrator.set_mode("HALT")
    return jsonify({
        "success": True,
        "mode": "HALT",
        "message": "Trading halted. Dashboard still updates.",
    })


@app.route("/api/mode/resume", methods=["POST"])
def resume_trading():
    """Resume from drawdown auto-halt. Does not change mode."""
    orchestrator.resume_from_halt()
    return jsonify({
        "success": True,
        "message": "Trading resumed from halt.",
        "mode": orchestrator.mode,
    })


@app.route("/api/mode/status")
def mode_status():
    state = orchestrator.get_dashboard_state()
    return jsonify({
        "success":           True,
        "mode":              orchestrator.mode,
        "active_strategy":   orchestrator.active_strategy_name,
        "active_account_id": orchestrator.active_account_id,
        "halted":            orchestrator.halted,
        "halt_reason":       orchestrator.halt_reason,
        "running":           orchestrator.running,
        "daily_pnl":         state.get("daily_pnl", 0),
        "trade_count":       state.get("trade_count", 0),
        "timestamp":         datetime.now(timezone.utc).isoformat(),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Dashboard (polled every 3s by React frontend)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/live/dashboard")
def live_dashboard():
    try:
        state = orchestrator.get_dashboard_state()
        state["drawdown"] = drawdown_monitor.status()
        return jsonify({"success": True, **state})
    except Exception as exc:
        logger.error(f"❌ Dashboard error: {exc}")
        return jsonify({"success": False, "error": "Dashboard unavailable"}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Trade history
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/trades/history")
def trade_history():
    limit = min(int(request.args.get("limit", 50)), 200)
    symbol = request.args.get("symbol")

    supabase = orchestrator._supabase
    if not supabase:
        # Fall back to in-memory trades
        trades = orchestrator.daily_trades[-limit:]
        if symbol:
            trades = [t for t in trades if t.get("symbol") == symbol]
        return jsonify({"success": True, "trades": trades, "source": "memory"})

    try:
        q = supabase.table("trades").select("*").order("opened_at", desc=True).limit(limit)
        if symbol:
            q = q.eq("symbol", symbol)
        resp = q.execute()
        return jsonify({"success": True, "trades": resp.data or [], "source": "supabase"})
    except Exception as exc:
        logger.error(f"❌ Trade history error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Performance metrics
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/performance/metrics")
def performance_metrics():
    trades = orchestrator.daily_trades
    total  = len(trades)
    wins   = sum(1 for t in trades if t.get("outcome") == "WIN")
    losses = sum(1 for t in trades if t.get("outcome") == "LOSS")
    daily_pnl = orchestrator.daily_pnl
    win_rate  = (wins / total) if total else 0.0

    # Per-symbol breakdown
    symbols: dict = {}
    for t in trades:
        sym = t.get("symbol", "?")
        if sym not in symbols:
            symbols[sym] = {"wins": 0, "losses": 0, "pnl": 0.0}
        if t.get("outcome") == "WIN":
            symbols[sym]["wins"] += 1
        elif t.get("outcome") == "LOSS":
            symbols[sym]["losses"] += 1
        symbols[sym]["pnl"] += t.get("pnl", 0)

    return jsonify({
        "success":   True,
        "today": {
            "trades":    total,
            "wins":      wins,
            "losses":    losses,
            "win_rate":  round(win_rate, 4),
            "daily_pnl": round(daily_pnl, 2),
        },
        "by_symbol":      symbols,
        "drawdown":       drawdown_monitor.status(),
        "open_positions": len(orchestrator.open_trades),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Hermes insights
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/hermes/insights")
def hermes_insights():
    """Return trading_context for all symbols (Hermes long-term memory)."""
    symbol = request.args.get("symbol")
    supabase = orchestrator._supabase

    if not supabase:
        return jsonify({"success": True, "insights": {}, "source": "none"})

    try:
        q = supabase.table("trading_context").select("symbol, context, updated_at")
        if symbol:
            q = q.eq("symbol", symbol)
        resp = q.execute()
        insights = {row["symbol"]: row for row in (resp.data or [])}
        return jsonify({"success": True, "insights": insights, "source": "supabase"})
    except Exception as exc:
        logger.error(f"❌ Hermes insights error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# AI decision log
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/ai/log")
def ai_log():
    limit = min(int(request.args.get("limit", 50)), 200)
    supabase = orchestrator._supabase

    if not supabase:
        return jsonify({"success": True, "log": [], "source": "none"})

    try:
        resp = (
            supabase.table("agent_audit_log")
            .select("*")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return jsonify({"success": True, "log": resp.data or [], "source": "supabase"})
    except Exception as exc:
        logger.error(f"❌ AI log error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Drawdown status
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/drawdown/status")
def drawdown_status():
    return jsonify({"success": True, **drawdown_monitor.status()})


# ─────────────────────────────────────────────────────────────────────────────
# Telegram callback (approve/reject Hermes param proposals)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/telegram/callback", methods=["POST"])
def telegram_callback():
    """
    Receives Telegram inline button callbacks for Hermes parameter approvals.
    Callback data format: APPROVE_{symbol}_{param}_{value} or REJECT_{symbol}_{param}
    """
    data = request.json or {}
    callback_query = data.get("callback_query", {})
    cb_data = callback_query.get("data", "")

    parts = cb_data.split("_", 3)
    if len(parts) < 3:
        return jsonify({"ok": True})

    action = parts[0]  # APPROVE | REJECT
    symbol = parts[1]
    param  = parts[2]

    if action == "APPROVE" and len(parts) == 4:
        value = float(parts[3])
        strategy = orchestrator.strategies.get(symbol)
        if strategy:
            strategy.set_params({param: value})
            logger.info(f"✅ Telegram APPROVED: {symbol} {param} → {value}")

    elif action == "REJECT":
        logger.info(f"❌ Telegram REJECTED: {symbol} {param}")

    return jsonify({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Account management
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/accounts", methods=["GET"])
def list_accounts():
    """Return all ProjectX accounts available under current login."""
    return jsonify({
        "success":           True,
        "accounts":          orchestrator.available_accounts,
        "active_account_id": orchestrator.active_account_id,
    })


@app.route("/api/accounts/select", methods=["POST"])
def select_account():
    """Switch active trading account."""
    import concurrent.futures

    data = request.get_json() or {}
    account_id = data.get("account_id")
    if not account_id:
        return jsonify({"success": False, "error": "account_id required"}), 400

    # Check if account exists in the known list (skip check when list is still empty)
    known_ids = [a.get("id") for a in orchestrator.available_accounts]
    if known_ids and account_id not in known_ids:
        return jsonify({"success": False, "error": "Account not found"}), 404

    # Bridge sync Flask route → async orchestrator method via stored event loop
    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"success": False, "error": "Orchestrator event loop not ready"}), 503

    future = asyncio.run_coroutine_threadsafe(
        orchestrator.set_active_account(account_id),
        loop,
    )
    try:
        result = future.result(timeout=10)
    except Exception as exc:
        logger.error(f"❌ select_account error: {exc}", exc_info=True)
        return jsonify({"success": False, "error": str(exc)}), 500

    if result:
        return jsonify({
            "success":           True,
            "active_account_id": account_id,
            "message":           f"Active account switched to {account_id}",
        })
    return jsonify({"success": False, "error": "Failed to switch account"}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Hermes on-demand feedback report
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/hermes/report", methods=["POST"])
def hermes_report():
    """Generate on-demand Hermes feedback report. Fetches trades from Supabase, calls Hermes."""
    import asyncio as _asyncio

    data = request.get_json() or {}
    period = data.get("period", "7d")   # "7d" | "30d" | "all"

    supabase = orchestrator._supabase
    if not supabase:
        return jsonify({"success": False, "error": "Supabase not connected"}), 503

    # Fetch trades for the period
    try:
        from datetime import timedelta
        cutoff = None
        if period == "7d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        elif period == "30d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

        q = supabase.table("trades").select("*").order("opened_at", desc=True).limit(200)
        if cutoff:
            q = q.gte("opened_at", cutoff)
        trades_resp = q.execute()
        trades = trades_resp.data or []

        ctx_resp = supabase.table("trading_context").select("symbol, context").execute()
        contexts = {row["symbol"]: row["context"] for row in (ctx_resp.data or [])}
    except Exception as exc:
        logger.error(f"❌ hermes_report fetch error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500

    # Call Hermes generate_feedback_report via asyncio bridge
    hermes_brain = orchestrator._hermes_brain
    if not hermes_brain:
        return jsonify({"success": False, "error": "Hermes brain not loaded"}), 503

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"success": False, "error": "Orchestrator event loop not ready"}), 503

    future = _asyncio.run_coroutine_threadsafe(
        hermes_brain.generate_feedback_report(trades, contexts, period),
        loop,
    )
    try:
        report = future.result(timeout=60)   # Hermes can take up to 30s
    except Exception as exc:
        logger.error(f"❌ hermes_report generation error: {exc}", exc_info=True)
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify({"success": True, "report": report, "period": period})


# ─────────────────────────────────────────────────────────────────────────────
# Equity curve data
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/performance/equity")
def performance_equity():
    """Return daily equity snapshots for the equity curve chart."""
    from datetime import timedelta
    range_param = request.args.get("range", "7d")
    account_id  = request.args.get("account_id", orchestrator.active_account_id)

    supabase = orchestrator._supabase
    if not supabase:
        return jsonify({"success": True, "equity": [], "source": "none"})

    try:
        cutoff = None
        if range_param == "7d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).date().isoformat()
        elif range_param == "30d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).date().isoformat()

        q = (supabase.table("performance_snapshots")
             .select("date,balance,daily_pnl,trade_count,win_rate")
             .order("date", desc=False))
        if account_id:
            q = q.eq("account_id", account_id)
        if cutoff:
            q = q.gte("date", cutoff)
        resp = q.execute()
        rows = resp.data or []

        # Calculate drawdown from peak balance
        if rows:
            peak = max((r["balance"] for r in rows if r.get("balance") is not None), default=1) or 1
            for row in rows:
                bal = row.get("balance") or 0
                row["drawdown_pct"] = round((peak - bal) / peak * 100, 2) if peak else 0

        return jsonify({"success": True, "equity": rows, "range": range_param})
    except Exception as exc:
        logger.error(f"❌ performance_equity error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Strategy timeframe switching
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/strategy/<name>/timeframe", methods=["POST"])
def set_strategy_timeframe(name: str):
    """Switch bar resolution for a strategy. Blocked if open trades exist."""
    import asyncio as _asyncio

    data = request.get_json() or {}
    timeframe = data.get("timeframe")
    if not timeframe:
        return jsonify({"success": False, "error": "timeframe required"}), 400

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"success": False, "error": "Orchestrator event loop not ready"}), 503

    future = _asyncio.run_coroutine_threadsafe(
        orchestrator.set_strategy_timeframe(name.upper(), timeframe),
        loop,
    )
    try:
        result = future.result(timeout=5)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500

    return jsonify(result), 200 if result["success"] else 409


# ─────────────────────────────────────────────────────────────────────────────
# Health check
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({
        "status":    "ok",
        "mode":      orchestrator.mode,
        "running":   orchestrator.running,
        "halted":    orchestrator.halted,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Dev server
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logger.info(f"🌐 Flask dev server on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
