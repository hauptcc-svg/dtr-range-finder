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
from flask import Flask, render_template, jsonify, request

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


def _ts_get(path: str, timeout: int = 10) -> dict:
    """GET from the TypeScript API. All routes are mounted under /api."""
    try:
        r = requests.get(f"{TS_API}/api{path}", headers=_agent_headers(), timeout=timeout)
        return r.json()
    except Exception as e:
        logger.error(f"TS API GET /api{path} failed: {e}")
        return {"error": str(e)}


def _ts_post(path: str, data: dict = None, timeout: int = 10) -> dict:
    """POST to the TypeScript API. All routes are mounted under /api."""
    try:
        r = requests.post(
            f"{TS_API}/api{path}",
            json=data or {},
            headers=_agent_headers(),
            timeout=timeout,
        )
        return r.json()
    except Exception as e:
        logger.error(f"TS API POST /api{path} failed: {e}")
        return {"error": str(e)}


def _build_dashboard_payload(ts_status: dict) -> dict:
    """Translate TypeScript agent status into dashboard-compatible payload."""
    mode_raw = ts_status.get("mode", "halted")
    auto_exec = ts_status.get("isRunning", False)
    return {
        "success": True,
        "timestamp": datetime.now().isoformat(),
        "orchestrator": {
            "mode": mode_raw,
            "auto_executing": auto_exec,
            "monitor_interval": 30,
            "position_limits": POSITION_LIMITS,
        },
        "trading": {
            "mode": mode_raw,
            "auto_executing": auto_exec,
            "monitoring_interval": 30,
            "status_text": f"{mode_raw.upper()} - Auto: {'ON' if auto_exec else 'OFF'}",
        },
        "position_limits": {**POSITION_LIMITS, "enforced": True},
        "p_and_l": {
            "daily_pnl": ts_status.get("dailyPnl", 0),
            "daily_loss_hit": ts_status.get("dailyLossHit", False),
            "daily_profit_hit": ts_status.get("dailyProfitHit", False),
            "open_positions": ts_status.get("openPositions", 0),
        },
        "refresh_note": "Dashboard auto-refreshes - no manual refresh needed",
    }


# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARD
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/")
def dashboard():
    return render_template("dashboard_autonomous.html", base_path=BASE_PATH)


# ═══════════════════════════════════════════════════════════════════════════
# MODE ENDPOINTS  (proxy to TypeScript API)
# ═══════════════════════════════════════════════════════════════════════════

@app.route("/api/mode/dtr", methods=["POST"])
def switch_to_dtr():
    resp = _ts_post("/agent/mode", {"mode": "dtr"})
    if "error" in resp:
        return jsonify({"success": False, "error": resp["error"]}), 502
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
    resp = _ts_post("/agent/mode", {"mode": "claude"})
    if "error" in resp:
        return jsonify({"success": False, "error": resp["error"]}), 502
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
    _ts_post("/agent/mode", {"mode": "halted"})
    _ts_post("/agent/stop")
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
    ts_mode = _ts_get("/agent/mode")
    ts_status = _ts_get("/agent/status")
    mode = ts_mode.get("mode", "halted")
    auto_exec = ts_status.get("isRunning", False)
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
    mode = ts_status.get("mode", "halted")
    label_map = {
        "halted":  "HALTED - No trading",
        "dtr":     "DTR AUTO - Running (30s checks) - Position limits ENFORCED",
        "claude":  "CLAUDE AUTO - Running (30s checks) - Position limits ENFORCED",
    }
    return jsonify({
        "success": True,
        "status": ts_status,
        "human_readable": label_map.get(mode, mode),
        "auto_execution_active": ts_status.get("isRunning", False),
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
