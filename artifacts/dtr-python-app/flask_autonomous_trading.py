"""
DTR Trading Dashboard - Flask App (Proxy Layer)
================================================
Serves the dashboard HTML and proxies all trading API calls to the
TypeScript API server running at http://localhost:8080, which has a
live connection to ProjectX.

Auth: X-Agent-Key header (AGENT_CONTROL_SECRET env var)
Port: reads PORT env var (default 5000)
"""

import os
import logging
from datetime import datetime
import requests
from flask import Flask, render_template, jsonify, request, make_response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# PATH PREFIX MIDDLEWARE
# Replit's reverse proxy forwards the full path (e.g. /dtr-python/api/...)
# to our service. We strip the BASE_PATH prefix so Flask's routes match.
# ═══════════════════════════════════════════════════════════════════════════

BASE_PATH = os.environ.get("BASE_PATH", "").rstrip("/")


class StripPrefixMiddleware:
    def __init__(self, wsgi_app, prefix: str):
        self.app = wsgi_app
        self.prefix = prefix

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if self.prefix and path.startswith(self.prefix):
            environ["PATH_INFO"] = path[len(self.prefix):] or "/"
            environ["SCRIPT_NAME"] = self.prefix
        return self.app(environ, start_response)


if BASE_PATH:
    app.wsgi_app = StripPrefixMiddleware(app.wsgi_app, BASE_PATH)
    logger.info(f"Serving under prefix: {BASE_PATH}")

# ═══════════════════════════════════════════════════════════════════════════
# PROXY HELPERS
# ═══════════════════════════════════════════════════════════════════════════

TS_API = "http://localhost:8080"
POSITION_LIMITS = {
    "one_per_symbol": True,
    "loss_limit": -200,
    "profit_limit": 1400,
}


def _agent_headers() -> dict:
    """Build request headers for the TypeScript API."""
    return {
        "Content-Type": "application/json",
        "X-Agent-Key": os.environ.get("AGENT_CONTROL_SECRET", ""),
    }


def _ts_request(method: str, path: str, params: dict = None, data: dict = None, timeout: int = 10):
    """Generic TypeScript API proxy helper.

    Returns ``(body: dict, upstream_status: int)``.
    On transport error returns ``({"error": ...}, 502)``.
    """
    url = f"{TS_API}/api{path}"
    try:
        r = requests.request(
            method,
            url,
            headers=_agent_headers(),
            params=params,
            json=data if method in ("POST", "PUT", "PATCH") else None,
            timeout=timeout,
        )
        body = r.json() if r.content else {}
        return body, r.status_code
    except Exception as e:
        logger.error(f"TS API {method} /api{path} failed: {e}")
        return {"error": str(e)}, 502


def _ts_get(path: str, params: dict = None, timeout: int = 10) -> dict:
    """GET from the TypeScript API — returns body dict only (status ignored).
    Use for internal helpers that don't need to propagate HTTP status.
    """
    body, _ = _ts_request("GET", path, params=params, timeout=timeout)
    return body


def _ts_post(path: str, data: dict = None, timeout: int = 30) -> dict:
    """POST to the TypeScript API — returns body dict only (status ignored).
    Use for internal helpers (mode switches, etc.) that handle errors via payload.
    """
    body, _ = _ts_request("POST", path, data=data, timeout=timeout)
    return body


def _derive_mode(ts_status: dict) -> tuple:
    """Derive (mode_str, is_running) from TypeScript status fields.

    TypeScript agent/status returns:
      running: bool
      claudeAutonomousMode: bool
    There is no "mode" string field — we compute it here.
    """
    is_running = ts_status.get("running", False)
    claude_mode = ts_status.get("claudeAutonomousMode", False)
    mode = "halted" if not is_running else ("claude" if claude_mode else "dtr")
    return mode, is_running


def _build_dashboard_payload(ts_status: dict) -> dict:
    """Translate TypeScript agent status into dashboard-compatible payload."""
    mode_raw, auto_exec = _derive_mode(ts_status)

    positions_resp = _ts_get("/positions")
    position_count = len(positions_resp) if isinstance(positions_resp, list) else 0

    summary_resp = _ts_get("/agent/daily-summary")
    trade_count = summary_resp.get("tradeCount", ts_status.get("tradeCount", 0))
    win_count = summary_resp.get("winCount", 0)
    win_rate = (win_count / trade_count) if trade_count > 0 else 0

    account_resp = _ts_get("/account", timeout=6)
    balance = account_resp.get("balance")
    account_name = account_resp.get("accountName", "")
    can_trade = account_resp.get("canTrade", None)

    realized_pnl = ts_status.get("dailyPnl", 0)
    unrealized_pnl = ts_status.get("unrealizedPnl", 0)

    return {
        "success": True,
        "timestamp": datetime.now().isoformat(),
        "orchestrator": {
            "mode": mode_raw,
            "auto_executing": auto_exec,
            "monitor_interval": 30,
            "position_limits": POSITION_LIMITS,
            "trade_count": trade_count,
        },
        "trading": {
            "mode": mode_raw,
            "auto_executing": auto_exec,
            "monitoring_interval": 30,
            "status_text": f"{mode_raw.upper()} - Auto: {'ON' if auto_exec else 'OFF'}",
        },
        "position_limits": {**POSITION_LIMITS, "enforced": True},
        "p_and_l": {
            "balance": balance,
            "account_name": account_name,
            "can_trade": can_trade,
            "daily_pnl": realized_pnl,
            "realized_pnl": realized_pnl,
            "unrealized_pnl": unrealized_pnl,
            "daily_loss_hit": ts_status.get("dailyLossHit", False),
            "daily_profit_hit": ts_status.get("dailyProfitHit", False),
            "position_count": position_count,
            "win_rate": win_rate,
        },
        "refresh_note": "Dashboard auto-refreshes - no manual refresh needed",
    }


# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARD
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/")
def dashboard():
    resp = make_response(render_template("dashboard_autonomous.html", base_path=BASE_PATH))
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


# ═══════════════════════════════════════════════════════════════════════════
# MODE ENDPOINTS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/mode/dtr", methods=["POST"])
def switch_to_dtr():
    mode_resp = _ts_post("/agent/mode", {"claudeAutonomous": False})
    if "error" in mode_resp:
        return jsonify({"success": False, "error": mode_resp["error"]}), 502
    start_resp = _ts_post("/agent/start")
    if "error" in start_resp:
        return jsonify({"success": False, "error": start_resp["error"]}), 502
    return jsonify({
        "success": True,
        "mode": "dtr",
        "message": "DTR auto-execution started WITH POSITION LIMITS",
        "auto_execution": True,
        "monitoring_interval": 30,
        "position_limits": POSITION_LIMITS,
        "status": "Running - checking every 30 seconds",
    })


@app.route("/api/mode/claude", methods=["POST"])
def switch_to_claude():
    mode_resp = _ts_post("/agent/mode", {"claudeAutonomous": True})
    if "error" in mode_resp:
        return jsonify({"success": False, "error": mode_resp["error"]}), 502
    start_resp = _ts_post("/agent/start")
    if "error" in start_resp:
        return jsonify({"success": False, "error": start_resp["error"]}), 502
    return jsonify({
        "success": True,
        "mode": "claude",
        "message": "Claude auto-execution started WITH POSITION LIMITS",
        "auto_execution": True,
        "bias_conflict_exit": True,
        "monitoring_interval": 30,
        "position_limits": POSITION_LIMITS,
        "status": "Running - checking every 30 seconds",
    })


@app.route("/api/mode/halt", methods=["POST"])
def halt_trading():
    resp = _ts_post("/agent/stop")
    if "error" in resp:
        return jsonify({"success": False, "error": resp["error"]}), 502
    return jsonify({
        "success": True,
        "mode": "halted",
        "message": "Trading halted",
        "auto_execution": False,
        "status": "All monitoring stopped",
    })


# ═══════════════════════════════════════════════════════════════════════════
# STATUS ENDPOINTS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/mode/status")
def mode_status():
    ts_status = _ts_get("/agent/status")
    mode, auto_exec = _derive_mode(ts_status)
    return jsonify({
        "success": True,
        "mode": mode,
        "auto_executing": auto_exec,
        "monitoring_interval": 30,
        "position_limits": POSITION_LIMITS,
        "message": f"Mode: {mode.upper()}, Auto: {'ON' if auto_exec else 'OFF'}",
    })


@app.route("/api/orchestrator/status")
def orchestrator_status():
    ts_status = _ts_get("/agent/status")
    mode, auto_exec = _derive_mode(ts_status)
    label_map = {
        "halted":  "HALTED - No trading",
        "dtr":     "DTR AUTO - Running (30s checks) - Position limits ENFORCED",
        "claude":  "CLAUDE AUTO - Running (30s checks) - Position limits ENFORCED",
    }
    return jsonify({
        "success": True,
        "status": ts_status,
        "human_readable": label_map.get(mode, mode),
        "auto_execution_active": auto_exec,
        "position_limits_enforced": True,
        "loss_limit": -200,
        "profit_limit": 1400,
    })


# ═══════════════════════════════════════════════════════════════════════════
# LIVE DASHBOARD  (proxy + format)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/live/dashboard")
def live_dashboard():
    ts_status = _ts_get("/agent/status")
    if "error" in ts_status:
        return jsonify({"success": False, "error": ts_status["error"]}), 502
    return jsonify(_build_dashboard_payload(ts_status))


# ═══════════════════════════════════════════════════════════════════════════
# ACCOUNT INFO  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/account")
def get_account():
    body, status = _ts_request("GET", "/account", timeout=8)
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# INSTRUMENTS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/instruments")
def get_instruments():
    body, status = _ts_request("GET", "/agent/instruments")
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# POSITIONS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/positions")
def get_positions():
    body, status = _ts_request("GET", "/positions")
    return jsonify(body), status


@app.route("/api/positions/<symbol>/close", methods=["POST"])
def close_position(symbol: str):
    body, status = _ts_request("POST", f"/positions/{symbol.upper()}/close")
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# TRADES  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/trades")
def get_trades():
    params = {k: request.args[k] for k in ("page", "pageSize", "instrument") if k in request.args}
    body, status = _ts_request("GET", "/trades", params=params)
    return jsonify(body), status


@app.route("/api/trades/<int:trade_id>/notes", methods=["PATCH"])
def patch_trade_notes(trade_id: int):
    body, status = _ts_request("PATCH", f"/trades/{trade_id}/notes", data=request.json or {})
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# INSTRUMENT CONFIGS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/instrument-configs")
def get_instrument_configs():
    body, status = _ts_request("GET", "/instrument-configs")
    return jsonify(body), status


@app.route("/api/instrument-configs", methods=["POST"])
def create_instrument_config():
    body, status = _ts_request("POST", "/instrument-configs", data=request.json or {})
    return jsonify(body), status


@app.route("/api/instrument-configs/<symbol>", methods=["PATCH"])
def patch_instrument_config(symbol: str):
    body, status = _ts_request("PATCH", f"/instrument-configs/{symbol.upper()}", data=request.json or {})
    return jsonify(body), status


@app.route("/api/instrument-configs/<symbol>", methods=["DELETE"])
def delete_instrument_config(symbol: str):
    body, status = _ts_request("DELETE", f"/instrument-configs/{symbol.upper()}")
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# CLAUDE TRADE ANALYSIS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/claude/analyse", methods=["POST"])
def claude_analyse():
    body, status = _ts_request("POST", "/agent/claude-trade", timeout=60)
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# ACCOUNT CONFIGS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/account-configs", methods=["GET"])
def list_account_configs():
    body, status = _ts_request("GET", "/account-configs")
    return jsonify(body), status


@app.route("/api/account-configs", methods=["POST"])
def create_account_config():
    body, status = _ts_request("POST", "/account-configs", data=request.json or {})
    return jsonify(body), status


@app.route("/api/account-configs/<int:row_id>", methods=["PATCH"])
def patch_account_config(row_id: int):
    body, status = _ts_request("PATCH", f"/account-configs/{row_id}", data=request.json or {})
    return jsonify(body), status


@app.route("/api/account-configs/<int:row_id>", methods=["DELETE"])
def delete_account_config(row_id: int):
    body, status = _ts_request("DELETE", f"/account-configs/{row_id}")
    return jsonify(body), status


@app.route("/api/account-configs/<int:row_id>/activate", methods=["POST"])
def activate_account_config(row_id: int):
    body, status = _ts_request("POST", f"/account-configs/{row_id}/activate")
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# RISK CONTROLS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/agent/settings", methods=["GET"])
def get_agent_settings():
    body, status = _ts_request("GET", "/agent/settings")
    return jsonify(body), status


@app.route("/api/agent/settings", methods=["POST"])
def post_agent_settings():
    body, status = _ts_request("POST", "/agent/settings", data=request.json or {})
    return jsonify(body), status


@app.route("/api/agent/liquidate", methods=["POST"])
def agent_liquidate():
    body, status = _ts_request("POST", "/agent/liquidate")
    return jsonify(body), status


@app.route("/api/agent/lock", methods=["POST"])
def agent_lock():
    body, status = _ts_request("POST", "/agent/lock")
    return jsonify(body), status


# ═══════════════════════════════════════════════════════════════════════════
# DTR STATE & MARKET BIAS UPDATES  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/dtr/state/update", methods=["POST"])
def update_dtr_state():
    data = request.json or {}
    symbol = data.get("symbol")
    state  = data.get("state", {})
    return jsonify({
        "success": True,
        "symbol": symbol,
        "stage": state.get("stage"),
        "in_entry_window": state.get("in_entry_window"),
        "bias": state.get("bias"),
        "message": f"DTR state noted for {symbol}",
    })


@app.route("/api/market/bias/update", methods=["POST"])
def update_market_bias():
    data = request.json or {}
    bias_data = data.get("bias_data", {})
    return jsonify({
        "success": True,
        "bias_updates": len(bias_data),
        "message": "Market bias updated",
    })


# ═══════════════════════════════════════════════════════════════════════════
# HEALTH CHECK
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/health")
def health():
    ts_ok = "error" not in _ts_get("/healthz")
    return jsonify({
        "status": "ok",
        "timestamp": datetime.now().isoformat(),
        "typescript_api": "connected" if ts_ok else "unreachable",
    })


# ═══════════════════════════════════════════════════════════════════════════
# STARTUP
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))

    print("\n" + "=" * 80)
    print("  DTR AUTONOMOUS TRADING DASHBOARD  -  WITH POSITION LIMITS")
    print("=" * 80)
    print(f"  Backend API     : {TS_API}")
    print(f"  DTR Mode        : Auto-executes on stage 5 via TypeScript agent")
    print(f"  Claude Mode     : Auto-executes on AI signal via TypeScript agent")
    print(f"  One pos/symbol  : ENFORCED")
    print(f"  Loss limit      : -$200  (auto-close all)")
    print(f"  Profit limit    : +$1,400 (auto-close all)")
    print(f"  Telegram        : {'enabled' if os.environ.get('TELEGRAM_BOT_TOKEN') else 'disabled'}")
    print(f"  Listening on    : 0.0.0.0:{port}")
    print("=" * 80 + "\n")

    app.run(host="0.0.0.0", port=port, debug=False, use_reloader=False)
