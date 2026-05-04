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
import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

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

# ─────────────────────────────────────────────────────────────────────────────
# Persisted risk settings (survive process restarts)
# ─────────────────────────────────────────────────────────────────────────────

_RISK_FILE = Path(__file__).parent / "risk_settings.json"

def _load_risk_settings() -> dict:
    """Load persisted risk settings, falling back to env var defaults."""
    defaults = {
        "daily_loss_limit":         float(os.environ.get("DAILY_LOSS_LIMIT", 200)),
        "daily_profit_target":      float(os.environ.get("DAILY_PROFIT_TARGET", 1400)),
        "max_trades_per_day":       int(os.environ.get("MAX_TRADES_PER_DAY", 4)),
        "max_losses_per_direction": int(os.environ.get("MAX_LOSSES_PER_DIRECTION", 2)),
        "trading_locked":           False,
    }
    try:
        if _RISK_FILE.exists():
            saved = json.loads(_RISK_FILE.read_text())
            defaults.update({k: v for k, v in saved.items() if k in defaults})
            logger.info("Loaded persisted risk settings: %s", defaults)
    except Exception as exc:
        logger.warning("Could not load risk_settings.json: %s", exc)
    return defaults

def _save_risk_settings() -> None:
    """Write to local JSON (fast, works during process lifetime)."""
    try:
        _RISK_FILE.write_text(json.dumps(_risk_settings, indent=2))
    except Exception as exc:
        logger.warning("Could not save risk_settings.json: %s", exc)


def _load_risk_settings_supabase() -> Optional[dict]:
    """
    Load risk settings from Supabase platform_settings table.
    Returns the saved dict, or None if unavailable.
    Called after the orchestrator's _supabase client is ready.
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            return None
        sb = create_client(url, key)
        resp = sb.table("platform_settings").select("value").eq("key", "risk_settings").single().execute()
        if resp.data and isinstance(resp.data.get("value"), dict):
            logger.info("✅ Loaded risk settings from Supabase: %s", resp.data["value"])
            return resp.data["value"]
    except Exception as exc:
        logger.warning("Could not load risk settings from Supabase: %s", exc)
    return None


def _save_risk_settings_supabase() -> None:
    """
    Upsert risk settings into Supabase platform_settings.
    Called after every save so settings survive Railway deploys.
    """
    try:
        from supabase import create_client
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not url or not key:
            return
        sb = create_client(url, key)
        sb.table("platform_settings").upsert({
            "key": "risk_settings",
            "value": _risk_settings,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        logger.info("💾 Risk settings saved to Supabase")
    except Exception as exc:
        logger.warning("Could not save risk settings to Supabase: %s", exc)


_risk_settings: dict = _load_risk_settings()

# Try to overlay with Supabase values immediately (they win over JSON + env vars)
_supabase_initial = _load_risk_settings_supabase()
if _supabase_initial:
    _risk_settings.update({k: v for k, v in _supabase_initial.items() if k in _risk_settings})
    logger.info("Risk settings after Supabase overlay: %s", _risk_settings)

CORS(app, origins=[
    os.environ.get("FRONTEND_URL", "http://localhost:5173"),
    "https://*.vercel.app",
    "http://localhost:3000",
])

drawdown_monitor = DrawdownMonitor(
    loss_limit=_risk_settings["daily_loss_limit"],
    profit_target=_risk_settings["daily_profit_target"],
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
# Telegram webhook — inbound bot commands
# ─────────────────────────────────────────────────────────────────────────────

def _tg_send(text: str) -> None:
    """Fire-and-forget message to the configured chat."""
    import urllib.request, json as _json
    token   = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID",   "")
    if not token or not chat_id:
        return
    payload = _json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=5)
    except Exception as exc:
        logger.warning(f"Telegram send failed: {exc}")


@app.route("/api/telegram/webhook", methods=["POST"])
def telegram_webhook():
    """
    Receives all incoming Telegram messages and inline callbacks.
    Handles both /command messages and Hermes approve/reject callbacks.
    """
    data = request.json or {}

    # ── Inline button callback (Hermes approve/reject) ──────────────────────
    callback_query = data.get("callback_query", {})
    if callback_query:
        cb_data = callback_query.get("data", "")
        parts = cb_data.split("_", 3)
        if len(parts) >= 3:
            action, symbol, param = parts[0], parts[1], parts[2]
            if action == "APPROVE" and len(parts) == 4:
                value = float(parts[3])
                strategy = orchestrator.strategies.get(symbol)
                if strategy:
                    strategy.set_params({param: value})
                    logger.info(f"✅ Telegram APPROVED: {symbol} {param} → {value}")
            elif action == "REJECT":
                logger.info(f"❌ Telegram REJECTED: {symbol} {param}")
        return jsonify({"ok": True})

    # ── Text commands ────────────────────────────────────────────────────────
    message  = data.get("message", {})
    chat_id  = str(message.get("chat", {}).get("id", ""))
    text     = (message.get("text") or "").strip().lower().split()[0] if message.get("text") else ""

    # Security: only respond to the configured chat
    allowed_chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if chat_id != allowed_chat:
        return jsonify({"ok": True})

    if text in ("/start", "/help"):
        reply = (
            "🤖 <b>DTR Trading Bot</b>\n\n"
            "/status   — System status &amp; mode\n"
            "/pnl      — Today's P&amp;L\n"
            "/positions — Open positions\n"
            "/halt     — Emergency halt\n"
            "/resume   — Resume trading"
        )

    elif text == "/status":
        state   = orchestrator.get_dashboard_state()
        dm      = drawdown_monitor.status()
        mode    = orchestrator.mode or "UNKNOWN"
        running = "🟢 Running" if orchestrator.running and not orchestrator.halted else "🔴 Halted"
        pnl     = state.get("daily_pnl", 0)
        trades  = state.get("trade_count", 0)
        phase   = state.get("session_phase", "—")
        reply = (
            f"<b>DTR Status</b>\n"
            f"State: {running}\n"
            f"Mode: {mode}\n"
            f"Session: {phase}\n"
            f"Daily P&amp;L: ${pnl:+.2f}\n"
            f"Trades today: {trades}"
        )

    elif text == "/pnl":
        state      = orchestrator.get_dashboard_state()
        realized   = state.get("daily_pnl", 0)
        unrealized = sum((p.get("live_pnl") or 0) for p in state.get("open_positions", []))
        loss_limit = float(os.environ.get("DAILY_LOSS_LIMIT", 200))
        target     = float(os.environ.get("DAILY_PROFIT_TARGET", 1400))
        reply = (
            f"<b>Today's P&amp;L</b>\n"
            f"Realized:   ${realized:+.2f}\n"
            f"Unrealized: ${unrealized:+.2f}\n"
            f"─────────────\n"
            f"Target: ${target:.0f}  |  Limit: -${loss_limit:.0f}"
        )

    elif text == "/positions":
        positions = state = orchestrator.get_dashboard_state().get("open_positions", [])
        if not positions:
            reply = "📭 No open positions"
        else:
            lines = ["<b>Open Positions</b>"]
            for p in positions:
                sym  = p.get("symbol", "?")
                dire = (p.get("direction") or "?").upper()
                qty  = p.get("qty_remaining", 1)
                entry = p.get("entry_price", 0)
                pnl  = p.get("live_pnl") or 0
                arrow = "🟢" if pnl >= 0 else "🔴"
                lines.append(f"{arrow} {sym} {dire} x{qty}  entry {entry:.2f}  P&amp;L ${pnl:+.2f}")
            reply = "\n".join(lines)

    elif text == "/halt":
        orchestrator.set_mode("HALT")
        logger.info("🛑 Trading HALTED via Telegram command")
        reply = "🛑 <b>Trading halted.</b> Send /resume to restart."

    elif text == "/resume":
        orchestrator.resume_from_halt()
        reply = f"✅ <b>Trading resumed.</b> Mode: {orchestrator.mode}"

    else:
        reply = "Unknown command. Send /help for a list of commands."

    _tg_send(reply)
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


@app.route("/api/debug/auth", methods=["GET"])
def debug_auth():
    """Check authentication state of the running orchestrator."""
    api = orchestrator.api
    return jsonify({
        "has_token": bool(api.access_token) if api else False,
        "token_expires": api.token_expires_at.isoformat() if (api and api.token_expires_at) else None,
        "account_id": api.account_id if api else None,
        "halted": orchestrator.halted,
        "halt_reason": orchestrator.halt_reason,
        "mode": orchestrator.mode,
    })


@app.route("/api/debug/account", methods=["GET"])
def debug_account():
    """
    Raw ProjectX account response for diagnosing balance issues.
    Calls the API directly and returns the unmodified response body.
    """
    import asyncio as _asyncio
    import aiohttp as _aiohttp

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"error": "Orchestrator loop not ready"}), 503

    async def _fetch():
        api = orchestrator.api
        if not api:
            return {"error": "API not initialised"}
        await api.refresh_token_if_needed()
        try:
            # POST — same as get_accounts() fix
            async with api.session.post(
                f"{api.base_url}/api/Account/search",
                json={"onlyActive": True},
                headers=api._get_headers(),
                timeout=_aiohttp.ClientTimeout(total=15),
            ) as resp:
                content_type = resp.headers.get("Content-Type", "")
                try:
                    body = await resp.json(content_type=None)
                except Exception:
                    body = await resp.text()
                return {"status": resp.status, "content_type": content_type, "body": body}
        except Exception as exc:
            return {"error": str(exc)}

    future = _asyncio.run_coroutine_threadsafe(_fetch(), loop)
    try:
        result = future.result(timeout=15)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    # Also show what the orchestrator currently has cached
    result["cached_available_accounts"] = orchestrator.available_accounts
    result["cached_active_account_id"]  = orchestrator.active_account_id
    result["dashboard_account"]         = orchestrator.get_dashboard_state().get("account", {})
    result["contract_ids"]              = orchestrator.contract_ids
    return jsonify(result)


@app.route("/api/debug/contracts", methods=["GET"])
def debug_contracts():
    """Show resolved contract IDs + probe bar fetch with different unit values."""
    import asyncio as _asyncio
    from datetime import datetime, timedelta, timezone

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"error": "Orchestrator loop not ready", "contract_ids": orchestrator.contract_ids}), 503

    async def _test_bars():
        # Re-search contracts (live=False to resolve IDs)
        search_results = {}
        for symbol in list(orchestrator.contract_ids.keys()):
            try:
                contracts = await orchestrator.api.search_contracts(symbol)
                search_results[symbol] = [
                    {"id": c.get("id"), "name": c.get("name"), "contractId": c.get("contractId")}
                    for c in (contracts or [])[:3]
                ]
            except Exception as exc:
                search_results[symbol] = {"error": str(exc)}

        # Test bars on first RESOLVED contract only (save API calls)
        bar_probe = {}
        first_resolved = next(
            ((sym, cid) for sym, cid in orchestrator.contract_ids.items()
             if cid != sym and cid.startswith("CON.")),
            None
        )
        if first_resolved:
            sym, cid = first_resolved
            now_utc = datetime.now(timezone.utc)
            end_utc   = now_utc.strftime("%Y-%m-%dT%H:%M:%SZ")
            start_utc = (now_utc - timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
            # Test both live=True and live=False to find which works for Combine accounts
            for unit_val in [2]:
                try:
                    await orchestrator.api.refresh_token_if_needed()
                    import aiohttp as _aiohttp
                    for live_flag in [True, False]:
                        try:
                            await orchestrator.api.refresh_token_if_needed()
                            body = {
                                "contractId": cid,
                                "live": live_flag,
                                "unit": unit_val,
                                "unitNumber": 1,
                                "limit": 10,
                                "startTime": start_utc,
                                "endTime": end_utc,
                                "includePartialBar": False,
                            }
                            async with orchestrator.api.session.post(
                                f"{orchestrator.api.base_url}/api/History/retrieveBars",
                                json=body,
                                headers=orchestrator.api._get_headers(),
                                timeout=_aiohttp.ClientTimeout(total=15)
                            ) as resp:
                                raw = await resp.json()
                                bars = raw.get("bars") or []
                                key = f"unit_{unit_val}_live_{live_flag}"
                                bar_probe[key] = {
                                    "contract": cid,
                                    "http_status": resp.status,
                                    "bars_returned": len(bars),
                                    "latest_close": bars[-1].get("c") if bars else None,
                                    "full_response": raw,
                                }
                        except Exception as exc:
                            bar_probe[f"unit_{unit_val}_live_{live_flag}"] = {"error": str(exc)}
                except Exception as exc:
                    bar_probe[f"unit_{unit_val}_outer"] = {"error": str(exc)}
        else:
            bar_probe["note"] = "No resolved contracts to test (all IDs still unresolved)"

        return search_results, bar_probe

    future = _asyncio.run_coroutine_threadsafe(_test_bars(), loop)
    try:
        search_results, bar_probe = future.result(timeout=60)
    except Exception as exc:
        return jsonify({"error": str(exc), "contract_ids": orchestrator.contract_ids}), 500

    return jsonify({
        "contract_ids": orchestrator.contract_ids,
        "search_results": search_results,
        "bar_unit_probe": bar_probe,
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

    async def _switch_and_fetch(aid: str):
        switched = await orchestrator.set_active_account(aid)
        if not switched:
            return None
        # Immediately fetch the new account's balance so frontend doesn't wait 60s
        summary = await orchestrator.api.get_account_summary()
        return summary

    future = asyncio.run_coroutine_threadsafe(
        _switch_and_fetch(account_id),
        loop,
    )
    try:
        summary = future.result(timeout=10)
    except Exception as exc:
        logger.error(f"❌ select_account error: {exc}", exc_info=True)
        return jsonify({"success": False, "error": str(exc)}), 500

    if summary is not None:
        return jsonify({
            "success":           True,
            "active_account_id": account_id,
            "balance":           summary.get("balance"),
            "equity":            summary.get("equity"),
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

@app.errorhandler(Exception)
def handle_exception(exc):
    """Return JSON for all unhandled exceptions — never return HTML to the React frontend."""
    logger.error(f"❌ Unhandled exception: {exc}", exc_info=True)
    return jsonify({"success": False, "error": str(exc)}), 500


@app.errorhandler(404)
def handle_404(exc):
    return jsonify({"success": False, "error": "Endpoint not found"}), 404


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
# Session management (HttpOnly cookie auth for React dashboard)
# AGENT_CONTROL_SECRET env var — set once in Railway, enter in dashboard UI
# ─────────────────────────────────────────────────────────────────────────────

import secrets as _secrets
from functools import wraps
from flask import session as _flask_session

app.secret_key = os.environ.get("FLASK_SECRET_KEY", _secrets.token_hex(24))
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"] = True

_AGENT_SECRET = os.environ.get("AGENT_CONTROL_SECRET", "")


@app.route("/api/agent/session", methods=["GET"])
def get_agent_session():
    if _flask_session.get("authenticated"):
        return jsonify({"authenticated": True})
    return jsonify({"authenticated": False}), 401


@app.route("/api/agent/session", methods=["POST"])
def create_agent_session():
    key = request.headers.get("x-agent-key", "")
    if not _AGENT_SECRET:
        return jsonify({"error": "AGENT_CONTROL_SECRET not configured on server"}), 503
    if not key or key != _AGENT_SECRET:
        return jsonify({"error": "Invalid agent key"}), 401
    _flask_session["authenticated"] = True
    return jsonify({"authenticated": True})


@app.route("/api/agent/session", methods=["DELETE"])
def delete_agent_session():
    _flask_session.clear()
    return jsonify({"authenticated": False})


# ─────────────────────────────────────────────────────────────────────────────
# Health (openapi compat — /api/healthz)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/healthz")
def healthz():
    return jsonify({"status": "ok"})


# ─────────────────────────────────────────────────────────────────────────────
# Agent status (openapi: GET /api/agent/status)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/status")
def agent_status():
    from zoneinfo import ZoneInfo
    state = orchestrator.get_dashboard_state()
    dm = drawdown_monitor.status()

    now_ny = datetime.now(ZoneInfo("America/New_York"))
    hm = now_ny.hour * 60 + now_ny.minute

    if not orchestrator.running or orchestrator.halted or orchestrator.mode == "HALT":
        phase = "daily_limit_hit" if dm.get("daily_loss_hit") else "idle"
    elif 72 <= hm < 75:
        phase = "london_range"
    elif 75 <= hm < 150:
        phase = "london_entry"
    elif 540 <= hm < 555:
        phase = "ny_range"
    elif 555 <= hm < 630:
        phase = "ny_entry"
    else:
        phase = "eod_flat"

    unrealized = sum((p.get("live_pnl") or 0) for p in state.get("open_positions", []))

    # Pull account balance from last dashboard snapshot (updated every tick)
    account = state.get("account") or {}
    available_accounts = orchestrator.available_accounts or []

    return jsonify({
        "running":                   orchestrator.running,
        "mode":                      orchestrator.mode,
        "activeStrategy":            orchestrator.active_strategy_name,
        "sessionPhase":              phase,
        "dailyPnl":                  state.get("daily_pnl", 0),
        "unrealizedPnl":             round(unrealized, 2),
        "dailyLossLimit":            _risk_settings["daily_loss_limit"],
        "dailyProfitTarget":         _risk_settings["daily_profit_target"],
        "tradeCount":                state.get("trade_count", 0),
        "lastUpdated":               state.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "authenticatedWithProjectX": (orchestrator.api is not None and not orchestrator.halted),
        "errorMessage":              orchestrator.halt_reason if orchestrator.halted else None,
        "claudeAutonomousMode":      orchestrator.mode == "CLAUDE+HERMES",
        "lastClaudeAutonomousTick":  None,
        # Account data for balance display
        "accountBalance":            account.get("balance"),
        "activeAccountId":           orchestrator.active_account_id,
        "availableAccounts":         available_accounts,
    })


# ─────────────────────────────────────────────────────────────────────────────
# Instruments (openapi: GET /api/agent/instruments)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/instruments")
def agent_instruments():
    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg
    state = orchestrator.get_dashboard_state()
    instruments_raw = state.get("instruments", {})

    result = []
    for symbol, snap in instruments_raw.items():
        trade = snap.get("trade")
        in_trade = snap.get("in_trade", False)

        sym_trades = [t for t in orchestrator.daily_trades if t.get("symbol") == symbol]
        today_pnl = sum((t.get("pnl") or 0) for t in sym_trades)
        long_losses  = sum(1 for t in sym_trades if (t.get("outcome","")).startswith("LOSS") and (t.get("direction","")).upper() == "LONG")
        short_losses = sum(1 for t in sym_trades if (t.get("outcome","")).startswith("LOSS") and (t.get("direction","")).upper() == "SHORT")

        stage = snap.get("stage", 0)
        direction = (snap.get("direction") or "").upper()
        rbs = {
            "shortStage":      stage if direction == "SHORT" else 0,
            "longStage":       stage if direction == "LONG"  else 0,
            "shortPending":    bool(snap.get("bos_confirmed") and direction == "SHORT"),
            "longPending":     bool(snap.get("bos_confirmed") and direction == "LONG"),
            "shortSignalFired": False,
            "longSignalFired":  False,
        }

        d = (trade or {}).get("direction", "")
        result.append({
            "symbol":        symbol,
            "name":          snap.get("name", symbol),
            "enabled":       _cfg.get(symbol, {}).get("enabled", True),
            "position":      ("long" if d.upper() == "LONG" else "short") if in_trade else None,
            "positionSize":  (trade or {}).get("qty_remaining", (trade or {}).get("qty", 0)) if in_trade else 0,
            "entryPrice":    (trade or {}).get("entry_price") if in_trade else None,
            "unrealizedPnl": (trade or {}).get("live_pnl") if in_trade else None,
            "todayPnl":      round(today_pnl, 2),
            "todayTrades":   len(sym_trades),
            "longLosses":    long_losses,
            "shortLosses":   short_losses,
            "rangeHigh":     snap.get("range_high"),
            "rangeLow":      snap.get("range_low"),
            "lastPrice":     snap.get("last_price"),
            "rbsLondon":     rbs,
            "rbsNy":         None,
        })

    return jsonify(result)


# ─────────────────────────────────────────────────────────────────────────────
# Agent start / stop (openapi)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/start", methods=["POST"])
def agent_start():
    orchestrator.set_mode("DTR")
    return jsonify({"success": True, "message": "Trading agent started (DTR mode)"})


@app.route("/api/agent/stop", methods=["POST"])
def agent_stop():
    orchestrator.set_mode("HALT")
    return jsonify({"success": True, "message": "Trading agent halted"})


# ─────────────────────────────────────────────────────────────────────────────
# Trades (openapi: GET /api/trades + PATCH /api/trades/<id>/notes)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/trades")
def get_trades():
    page        = int(request.args.get("page", 1))
    page_size   = min(int(request.args.get("pageSize", 20)), 100)
    instrument  = request.args.get("instrument")
    date_filter = request.args.get("date")
    offset      = (page - 1) * page_size

    supabase = orchestrator._supabase
    if not supabase:
        empty_stats = {"totalClosed": 0, "winCount": 0, "lossCount": 0, "totalWinPnl": 0.0, "totalLossPnl": 0.0}
        return jsonify({"trades": [], "total": 0, "page": page, "pageSize": page_size, "stats": empty_stats})

    try:
        q = supabase.table("trades").select("*", count="exact").order("opened_at", desc=True)
        if instrument:
            q = q.eq("symbol", instrument)
        if date_filter:
            q = q.gte("opened_at", f"{date_filter}T00:00:00").lte("opened_at", f"{date_filter}T23:59:59")
        count_resp = q.execute()
        total = count_resp.count or len(count_resp.data or [])

        q2 = supabase.table("trades").select("*").order("opened_at", desc=True).range(offset, offset + page_size - 1)
        if instrument:
            q2 = q2.eq("symbol", instrument)
        if date_filter:
            q2 = q2.gte("opened_at", f"{date_filter}T00:00:00").lte("opened_at", f"{date_filter}T23:59:59")
        trades_raw = q2.execute().data or []

        def _map_trade(t):
            d = (t.get("direction") or "").upper()
            session = (t.get("session") or "london").lower()
            return {
                "id":         t.get("id") or 0,
                "instrument": t.get("symbol", ""),
                "direction":  "long" if d == "LONG" else "short",
                "entryPrice": t.get("entry_price", 0),
                "exitPrice":  t.get("exit_price"),
                "qty":        t.get("qty", 1),
                "pnl":        t.get("pnl"),
                "session":    session if session in ("london", "ny") else "london",
                "status":     "closed" if t.get("exit_price") is not None else "open",
                "entryTime":  t.get("opened_at", ""),
                "exitTime":   t.get("closed_at"),
                "stopPrice":  t.get("sl_level"),
                "tp1Price":   t.get("tp1_level"),
                "tp2Price":   t.get("tp2_level"),
                "notes":      t.get("notes"),
            }

        trades = [_map_trade(t) for t in trades_raw]
        closed = [t for t in trades if t["status"] == "closed"]
        wins   = [t for t in closed if (t.get("pnl") or 0) > 0]
        losses = [t for t in closed if (t.get("pnl") or 0) < 0]

        return jsonify({
            "trades":   trades,
            "total":    total,
            "page":     page,
            "pageSize": page_size,
            "stats": {
                "totalClosed": len(closed),
                "winCount":    len(wins),
                "lossCount":   len(losses),
                "totalWinPnl":  round(sum((t.get("pnl") or 0) for t in wins), 2),
                "totalLossPnl": round(sum((t.get("pnl") or 0) for t in losses), 2),
            },
        })
    except Exception as exc:
        logger.error(f"❌ get_trades error: {exc}")
        empty_stats = {"totalClosed": 0, "winCount": 0, "lossCount": 0, "totalWinPnl": 0.0, "totalLossPnl": 0.0}
        return jsonify({"trades": [], "total": 0, "page": page, "pageSize": page_size, "stats": empty_stats})


@app.route("/api/trades/<int:trade_id>/notes", methods=["PATCH"])
def update_trade_notes(trade_id: int):
    data = request.get_json() or {}
    supabase = orchestrator._supabase
    if not supabase:
        return jsonify({"success": False, "message": "Supabase not connected"})
    try:
        supabase.table("trades").update({"notes": data.get("notes")}).eq("id", trade_id).execute()
        return jsonify({"success": True, "message": "Notes updated"})
    except Exception as exc:
        logger.error(f"❌ update_trade_notes error: {exc}")
        return jsonify({"success": False, "message": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# Positions (openapi: GET /api/positions + POST /api/positions/<symbol>/close)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/positions")
def get_positions():
    state = orchestrator.get_dashboard_state()
    instruments_raw = state.get("instruments", {})

    positions = []
    for p in state.get("open_positions", []):
        sym = p.get("symbol", "")
        inst = instruments_raw.get(sym, {})
        d = (p.get("direction") or "").upper()
        positions.append({
            "instrument":    sym,
            "direction":     "long" if d == "LONG" else "short",
            "size":          p.get("qty_remaining", 1),
            "entryPrice":    p.get("entry_price", 0),
            "currentPrice":  inst.get("last_price") or p.get("entry_price", 0),
            "unrealizedPnl": p.get("live_pnl") or 0,
            "openedAt":      p.get("entry_time", datetime.now(timezone.utc).isoformat()),
            "stopPrice":     p.get("sl_level"),
            "tp1Price":      p.get("tp1_level"),
            "tp2Price":      p.get("tp2_level"),
        })

    return jsonify(positions)


@app.route("/api/positions/<symbol>/close", methods=["POST"])
def close_position(symbol: str):
    import asyncio as _asyncio

    if symbol not in orchestrator.open_trades:
        return jsonify({"success": False, "message": f"No open position for {symbol}"}), 404

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"success": False, "message": "Orchestrator not ready"}), 503

    trade = orchestrator.open_trades.get(symbol, {})
    future = _asyncio.run_coroutine_threadsafe(
        orchestrator._early_close_trade(symbol, trade, "manual_close"),
        loop,
    )
    try:
        future.result(timeout=10)
        return jsonify({"success": True, "message": f"Position {symbol} closed"})
    except Exception as exc:
        logger.error(f"❌ close_position error: {exc}")
        return jsonify({"success": False, "message": str(exc)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Daily summary (openapi: GET /api/agent/daily-summary)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/daily-summary")
def agent_daily_summary():
    state = orchestrator.get_dashboard_state()
    dm = drawdown_monitor.status()
    trades = orchestrator.daily_trades

    wins   = [t for t in trades if (t.get("outcome") or "").startswith("WIN")]
    losses = [t for t in trades if (t.get("outcome") or "").startswith("LOSS")]
    london_pnl = sum((t.get("pnl") or 0) for t in trades if (t.get("session") or "").upper() == "LONDON")
    ny_pnl     = sum((t.get("pnl") or 0) for t in trades if (t.get("session") or "").upper() == "NY")

    if dm.get("daily_loss_hit"):
        status = "loss_limit_hit"
    elif dm.get("daily_profit_hit"):
        status = "profit_target_hit"
    elif not orchestrator.running or orchestrator.halted:
        status = "ended"
    else:
        status = "active"

    return jsonify({
        "date":       datetime.now(timezone.utc).date().isoformat(),
        "totalPnl":   state.get("daily_pnl", 0),
        "tradeCount": state.get("trade_count", 0),
        "winCount":   len(wins),
        "lossCount":  len(losses),
        "status":     status,
        "londonPnl":  round(london_pnl, 2),
        "nyPnl":      round(ny_pnl, 2),
    })


# ─────────────────────────────────────────────────────────────────────────────
# Settings (GET + POST /api/agent/settings)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/settings", methods=["GET"])
def get_agent_settings():
    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg
    instruments_cfg = {}
    for sym, strategy in orchestrator.strategies.items():
        instruments_cfg[sym] = {
            "enabled": _cfg.get(sym, {}).get("enabled", True),
            "qty":     _cfg.get(sym, {}).get("qty", 1),
            "params":  strategy.get_params() if hasattr(strategy, "get_params") else {},
        }
    # Return camelCase keys to match the React RiskSettings interface
    return jsonify({
        "mode":                  orchestrator.mode,
        "activeStrategy":        orchestrator.active_strategy_name,
        "dailyLossLimit":        _risk_settings["daily_loss_limit"],
        "dailyProfitTarget":     _risk_settings["daily_profit_target"],
        "maxTradesPerDay":       _risk_settings.get("max_trades_per_day", 4),
        "maxLossesPerDirection": _risk_settings.get("max_losses_per_direction", 2),
        "tradingLocked":         _risk_settings.get("trading_locked", False),
        "instruments":           instruments_cfg,
        "strategy_timeframes":   orchestrator.strategy_timeframes,
    })


@app.route("/api/agent/settings", methods=["POST"])
def update_agent_settings():
    data = request.get_json() or {}
    changed = False

    # Mode / strategy switches
    if "mode" in data and data["mode"] in ("DTR", "CLAUDE+HERMES", "HALT"):
        orchestrator.set_mode(data["mode"])
    if "active_strategy" in data:
        orchestrator.set_active_strategy(data["active_strategy"])

    # Per-instrument quantity
    if "instrument_qty" in data:
        from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg
        for sym, qty in data["instrument_qty"].items():
            if sym in _cfg and isinstance(qty, (int, float)) and 1 <= int(qty) <= 50:
                _cfg[sym]["qty"] = int(qty)

    # Daily loss limit — accept both camelCase (frontend) and snake_case (legacy)
    loss_val = data.get("dailyLossLimit") or data.get("daily_loss_limit")
    if loss_val is not None:
        val = float(loss_val)
        if val > 0:
            _risk_settings["daily_loss_limit"] = val
            drawdown_monitor.loss_limit = val
            changed = True

    # Daily profit target — accept both camelCase and snake_case
    profit_val = data.get("dailyProfitTarget") or data.get("daily_profit_target")
    if profit_val is not None:
        val = float(profit_val)
        if val > 0:
            _risk_settings["daily_profit_target"] = val
            drawdown_monitor.profit_target = val
            changed = True

    # Max trades / losses per direction
    if data.get("maxTradesPerDay") is not None:
        val = int(data["maxTradesPerDay"])
        if 1 <= val <= 20:
            _risk_settings["max_trades_per_day"] = val
            changed = True

    if data.get("maxLossesPerDirection") is not None:
        val = int(data["maxLossesPerDirection"])
        if 1 <= val <= 10:
            _risk_settings["max_losses_per_direction"] = val
            changed = True

    if changed:
        _save_risk_settings()
        # Also push to Supabase for deploy-safe persistence
        _save_risk_settings_supabase()

    return jsonify({"success": True, "message": "Settings updated"})


# ─────────────────────────────────────────────────────────────────────────────
# Liquidate all / Lock / Trigger Claude trade
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/liquidate", methods=["POST"])
def liquidate_all():
    import asyncio as _asyncio

    symbols = list(orchestrator.open_trades.keys())
    if not symbols:
        return jsonify({"success": True, "message": "No open positions"})

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running():
        return jsonify({"success": False, "message": "Orchestrator not ready"}), 503

    errors = []
    for sym in symbols:
        trade = orchestrator.open_trades.get(sym)
        if trade:
            future = _asyncio.run_coroutine_threadsafe(
                orchestrator._early_close_trade(sym, trade, "liquidate_all"),
                loop,
            )
            try:
                future.result(timeout=10)
            except Exception as exc:
                errors.append(f"{sym}: {exc}")

    if errors:
        return jsonify({"success": False, "message": "; ".join(errors)})
    return jsonify({"success": True, "message": f"Liquidated {len(symbols)} position(s)"})


@app.route("/api/agent/lock", methods=["POST"])
def lock_trading():
    orchestrator.set_mode("HALT")
    return jsonify({"success": True, "message": "Trading locked"})


@app.route("/api/agent/claude-trade", methods=["POST"])
def trigger_claude_trade():
    orchestrator.set_mode("CLAUDE+HERMES")
    return jsonify({"success": True, "message": "Claude+Hermes autonomous mode activated"})


# ─────────────────────────────────────────────────────────────────────────────
# Broker orders (GET /api/agent/orders)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/orders")
def get_orders():
    import asyncio as _asyncio

    loop = getattr(orchestrator, "_loop", None)
    if loop is None or not loop.is_running() or orchestrator.api is None:
        return jsonify({})

    try:
        future = _asyncio.run_coroutine_threadsafe(
            orchestrator.api.get_open_orders(),
            loop,
        )
        orders = future.result(timeout=5) or []
        by_symbol: dict = {}
        for o in orders:
            sym = o.get("symbol", o.get("contractId", "unknown"))
            by_symbol.setdefault(sym, []).append(o)
        return jsonify(by_symbol)
    except Exception as exc:
        logger.error(f"❌ get_orders error: {exc}")
        return jsonify({})


# ─────────────────────────────────────────────────────────────────────────────
# Manual order placement (POST /api/agent/manual-order)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/manual-order", methods=["POST"])
def manual_order():
    import asyncio as _asyncio

    data = request.get_json() or {}
    symbol   = data.get("symbol")
    side     = data.get("side", "").upper()
    try:
        quantity = int(data.get("quantity", 1))
    except (ValueError, TypeError):
        quantity = 1

    if not symbol or side not in ("BUY", "SELL"):
        return jsonify({"success": False, "error": "symbol and side (BUY|SELL) required"}), 400
    if quantity < 1 or quantity > 50:
        return jsonify({"success": False, "error": "quantity must be 1–50"}), 400

    if orchestrator.api is None:
        return jsonify({"success": False, "error": "Not connected to broker"}), 503

    # Validate symbol is a known instrument
    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg
    if symbol not in _cfg and symbol not in orchestrator.contract_ids:
        return jsonify({"success": False, "error": f"Unknown instrument: {symbol}"}), 404

    # Get numeric contract ID resolved at boot (falls back to symbol if not yet resolved)
    contract_id = orchestrator.contract_ids.get(symbol)
    if not contract_id:
        return jsonify({
            "success": False,
            "error": f"Contract ID for {symbol} not yet resolved — wait 60s for orchestrator to boot",
        }), 503

    loop = getattr(orchestrator, "_loop", None)
    try:
        if loop and loop.is_running():
            future = _asyncio.run_coroutine_threadsafe(
                orchestrator.api.place_order(contract_id, side, quantity, "MARKET", comment="manual"),
                loop,
            )
            result = future.result(timeout=10)
        else:
            new_loop = _asyncio.new_event_loop()
            result = new_loop.run_until_complete(
                orchestrator.api.place_order(contract_id, side, quantity, "MARKET", comment="manual")
            )
            new_loop.close()
    except Exception as exc:
        logger.error(f"❌ manual_order error: {exc}")
        return jsonify({"success": False, "error": str(exc)}), 500

    if result and result.get("success", True):
        logger.info(f"✅ manual_order: {side} {quantity} {symbol} → orderId={result.get('orderId')}")
        return jsonify({"success": True, "message": f"{side} {quantity} {symbol} placed", "orderId": result.get("orderId")})
    broker_error = (result or {}).get("errorMessage") or (result or {}).get("message") or "Order rejected by broker"
    logger.error(f"❌ manual_order: broker rejected {side} {quantity} {symbol}: {broker_error}")
    return jsonify({"success": False, "error": broker_error}), 400


# ─────────────────────────────────────────────────────────────────────────────
# Toggle instrument enabled/disabled (POST /api/agent/instruments/<symbol>/toggle)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/agent/instruments/<symbol>/toggle", methods=["POST"])
def toggle_instrument(symbol: str):
    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg

    if symbol not in _cfg:
        return jsonify({"success": False, "message": f"Unknown instrument: {symbol}"}), 404

    current = _cfg[symbol].get("enabled", True)
    _cfg[symbol]["enabled"] = not current
    return jsonify({
        "success": True,
        "symbol":  symbol,
        "enabled": _cfg[symbol]["enabled"],
        "message": f"{symbol} {'enabled' if _cfg[symbol]['enabled'] else 'disabled'}",
    })


# ─────────────────────────────────────────────────────────────────────────────
# TradingView Webhook  (POST /api/webhook/tradingview)
# ─────────────────────────────────────────────────────────────────────────────
#
# Set WEBHOOK_SECRET in Railway env vars.  Use the same value in the TradingView
# alert message body (JSON).
#
# TradingView alert message format (JSON body):
#   {
#     "secret":   "{{your_secret}}",
#     "symbol":   "NAS100",          ← or TV alias: MNQ1!, US30, XAUUSD, etc.
#     "side":     "BUY",             ← BUY or SELL  (hardcode — don't use {{strategy.order.action}})
#     "quantity": 1,                 ← optional, defaults to instrument qty
#     "sl":       19200.0,           ← optional stop-loss price
#     "tp1":      19350.0,           ← optional take-profit 1 price
#     "tp2":      19500.0,           ← optional take-profit 2 price (splits qty evenly with tp1)
#     "comment":  "Long NAS100"      ← optional label
#   }
#
# Bracket order behaviour:
#   • Entry always fires as MARKET.
#   • If "sl" is set → STOP order placed on opposite side at that price.
#   • If "tp1" is set (no tp2) → one LIMIT order for full quantity.
#   • If both "tp1" and "tp2" set → two LIMIT orders, quantity split in half.
#   • SL/TP orders are placed after a successful entry (orderId returned).
#   • If a bracket order fails the entry is NOT reversed — check logs.
#
# Webhook URL to paste in TradingView:
#   https://dtr-range-finder-production.up.railway.app/api/webhook/tradingview
# ─────────────────────────────────────────────────────────────────────────────

# TradingView ticker → TopstepX contract symbol
# Covers: futures codes, CFD names (Pepperstone/OANDA/etc), TV continuous contracts
_TV_SYMBOL_MAP = {
    # ── Micro NQ / NAS100 ──────────────────────────────────────────────────
    "MNQM26":   "MNQM26",
    "MNQ1!":    "MNQM26",
    "NAS100":   "MNQM26",
    "NAS100USD":"MNQM26",
    "USTEC":    "MNQM26",
    "NDX":      "MNQM26",
    "US100":    "MNQM26",

    # ── Micro YM / US30 / Dow ──────────────────────────────────────────────
    "MYMM26":   "MYMM26",
    "MYM1!":    "MYMM26",
    "US30":     "MYMM26",
    "US30USD":  "MYMM26",
    "WS30":     "MYMM26",
    "DJI":      "MYMM26",
    "DJ30":     "MYMM26",

    # ── Micro Gold / XAUUSD ────────────────────────────────────────────────
    "MGCM26":   "MGCM26",
    "MGC1!":    "MGCM26",
    "XAUUSD":   "MGCM26",
    "GOLD":     "MGCM26",
    "GC1!":     "MGCM26",
    "XAUUSDT":  "MGCM26",

    # ── Micro Crude Oil / WTI ──────────────────────────────────────────────
    "MCLN26":   "MCLN26",
    "MCLK26":   "MCLN26",
    "MCL1!":    "MCLN26",
    "WTI":      "MCLN26",
    "USOIL":    "MCLN26",
    "CL1!":     "MCLN26",
    "WTICOUSD": "MCLN26",
    "OIL":      "MCLN26",

    # ── Micro S&P 500 / US500 ─────────────────────────────────────────────
    # Add MESM26 to Railway INSTRUMENTS dict if you want to trade this
    "MESM26":   "MESM26",
    "MES1!":    "MESM26",
    "US500":    "MESM26",
    "SPX500":   "MESM26",
    "SP500":    "MESM26",
    "SPX":      "MESM26",
    "ES1!":     "MESM26",
}


@app.route("/api/webhook/tradingview", methods=["POST"])
def tradingview_webhook():
    import asyncio as _asyncio

    # ── Parse body ────────────────────────────────────────────────────────────
    data = request.get_json(silent=True) or {}
    if not data:
        # TradingView sometimes sends plain text — try to parse it
        try:
            import json as _json
            data = _json.loads(request.data.decode())
        except Exception:
            return jsonify({"success": False, "error": "Invalid JSON body"}), 400

    # ── Secret check ──────────────────────────────────────────────────────────
    expected_secret = os.environ.get("WEBHOOK_SECRET", "")
    if expected_secret:
        provided = data.get("secret") or request.headers.get("X-Webhook-Secret", "")
        if provided != expected_secret:
            logger.warning("⚠️  TradingView webhook: bad secret from %s", request.remote_addr)
            return jsonify({"success": False, "error": "Unauthorized"}), 401

    # ── Field extraction ──────────────────────────────────────────────────────
    tv_symbol = str(data.get("symbol", "")).upper().strip()
    side      = str(data.get("side", "")).upper().strip()
    comment   = str(data.get("comment", "tv-alert"))

    # Optional SL / TP prices (None = not set)
    def _float_or_none(v):
        try:
            return float(v) if v not in (None, "", "null") else None
        except (TypeError, ValueError):
            return None

    sl_price  = _float_or_none(data.get("sl"))
    tp1_price = _float_or_none(data.get("tp1"))
    tp2_price = _float_or_none(data.get("tp2"))

    symbol = _TV_SYMBOL_MAP.get(tv_symbol)
    if not symbol:
        return jsonify({"success": False, "error": f"Unknown symbol: {tv_symbol}. "
                        f"Use one of: {list(_TV_SYMBOL_MAP.keys())}"}), 400

    if side not in ("BUY", "SELL"):
        return jsonify({"success": False, "error": "side must be BUY or SELL"}), 400

    # Quantity: use payload value, else fall back to per-instrument config
    from multi_instrument_config import MULTI_INSTRUMENT_CONFIG as _cfg
    default_qty = _cfg.get(symbol, {}).get("qty", 1)
    try:
        quantity = int(data.get("quantity", default_qty))
    except (ValueError, TypeError):
        quantity = default_qty
    quantity = max(1, min(quantity, 50))

    # ── Broker connection check ───────────────────────────────────────────────
    if orchestrator.api is None:
        logger.error("❌ TradingView webhook: broker not connected")
        return jsonify({"success": False, "error": "Not connected to broker"}), 503

    contract_id = orchestrator.contract_ids.get(symbol)
    if not contract_id:
        logger.error("❌ TradingView webhook: contract ID not resolved for %s", symbol)
        return jsonify({
            "success": False,
            "error": f"Contract ID for {symbol} not yet resolved — wait 60s after boot",
        }), 503

    # ── Helper: run coroutine thread-safely ───────────────────────────────────
    def _run(coro):
        loop = getattr(orchestrator, "_loop", None)
        if loop and loop.is_running():
            return _asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=10)
        new_loop = _asyncio.new_event_loop()
        try:
            return new_loop.run_until_complete(coro)
        finally:
            new_loop.close()

    # ── Place MARKET entry order ───────────────────────────────────────────────
    logger.info("📡 TradingView webhook: %s %s × %d", side, symbol, quantity)
    try:
        result = _run(
            orchestrator.api.place_order(contract_id, side, quantity, "MARKET", comment=comment)
        )
    except Exception as exc:
        logger.error("❌ TradingView webhook order error: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500

    if not result or not result.get("success", True):
        broker_error = (result or {}).get("errorMessage") or (result or {}).get("message") or "Order rejected"
        logger.error("❌ TradingView webhook: broker rejected %s %s: %s", side, symbol, broker_error)
        return jsonify({"success": False, "error": broker_error}), 400

    entry_order_id = result.get("orderId")
    logger.info("✅ TradingView webhook: %s %s × %d → orderId=%s", side, symbol, quantity, entry_order_id)

    # ── Bracket orders (SL / TP) ──────────────────────────────────────────────
    bracket_side = "SELL" if side == "BUY" else "BUY"
    bracket_results = []

    if sl_price is not None:
        try:
            sl_result = _run(
                orchestrator.api.place_order(
                    contract_id, bracket_side, quantity, "STOP",
                    stop_price=sl_price, comment=f"SL-{comment}"
                )
            )
            if sl_result and sl_result.get("success", True):
                logger.info("✅ SL order placed @ %s → orderId=%s", sl_price, sl_result.get("orderId"))
                bracket_results.append({"type": "sl", "price": sl_price, "orderId": sl_result.get("orderId")})
            else:
                err = (sl_result or {}).get("errorMessage", "unknown")
                logger.error("❌ SL order failed: %s", err)
                bracket_results.append({"type": "sl", "price": sl_price, "error": err})
        except Exception as exc:
            logger.error("❌ SL order exception: %s", exc)
            bracket_results.append({"type": "sl", "price": sl_price, "error": str(exc)})

    if tp1_price is not None:
        # If both tp1 and tp2, split quantity in half (each gets floor(qty/2), tp1 gets remainder)
        if tp2_price is not None:
            tp1_qty = (quantity + 1) // 2  # ceiling half
            tp2_qty = quantity // 2        # floor half
        else:
            tp1_qty = quantity
            tp2_qty = 0

        try:
            tp1_result = _run(
                orchestrator.api.place_order(
                    contract_id, bracket_side, tp1_qty, "LIMIT",
                    limit_price=tp1_price, comment=f"TP1-{comment}"
                )
            )
            if tp1_result and tp1_result.get("success", True):
                logger.info("✅ TP1 order placed @ %s → orderId=%s", tp1_price, tp1_result.get("orderId"))
                bracket_results.append({"type": "tp1", "price": tp1_price, "orderId": tp1_result.get("orderId")})
            else:
                err = (tp1_result or {}).get("errorMessage", "unknown")
                logger.error("❌ TP1 order failed: %s", err)
                bracket_results.append({"type": "tp1", "price": tp1_price, "error": err})
        except Exception as exc:
            logger.error("❌ TP1 order exception: %s", exc)
            bracket_results.append({"type": "tp1", "price": tp1_price, "error": str(exc)})

        if tp2_price is not None and tp2_qty > 0:
            try:
                tp2_result = _run(
                    orchestrator.api.place_order(
                        contract_id, bracket_side, tp2_qty, "LIMIT",
                        limit_price=tp2_price, comment=f"TP2-{comment}"
                    )
                )
                if tp2_result and tp2_result.get("success", True):
                    logger.info("✅ TP2 order placed @ %s → orderId=%s", tp2_price, tp2_result.get("orderId"))
                    bracket_results.append({"type": "tp2", "price": tp2_price, "orderId": tp2_result.get("orderId")})
                else:
                    err = (tp2_result or {}).get("errorMessage", "unknown")
                    logger.error("❌ TP2 order failed: %s", err)
                    bracket_results.append({"type": "tp2", "price": tp2_price, "error": err})
            except Exception as exc:
                logger.error("❌ TP2 order exception: %s", exc)
                bracket_results.append({"type": "tp2", "price": tp2_price, "error": str(exc)})

    response = {
        "success": True,
        "message": f"{side} {quantity} {symbol} placed",
        "orderId": entry_order_id,
    }
    if bracket_results:
        response["bracket"] = bracket_results

    return jsonify(response)


# ─────────────────────────────────────────────────────────────────────────────
# Dev server
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logger.info(f"🌐 Flask dev server on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
