"""
Market Data Orchestrator
========================
Async 60-second loop. Fetches 1-min OHLC bars from ProjectX, runs the active
strategy state machines for all four instruments, and fires entries when BOS
is confirmed.

Claude brain validates every entry signal. Hermes brain runs after each trade
closes. Supabase stores all trades and state for the React dashboard.

Mode states:
  DTR            — Run DTR signals, skip Claude validation (rule-based only)
  CLAUDE+HERMES  — Full AI: Claude validates entry, Hermes learns after each trade
  HALT           — No trading. Dashboard still updates.

Strategy switching:
  Use set_active_strategy("DTR") or set_active_strategy("XXX") to switch the
  strategy engine live. All 4 instruments are re-instantiated immediately.

Bracket execution (3-TP):
  Every entry places a MARKET order for full qty, then three LIMIT take-profit
  orders (TP1/TP2/TP3) and one STOP loss order. As each TP fills the SL steps
  forward to protect capital: TP1 hit → SL to break even, TP2 hit → SL to TP1.
"""

import asyncio
import logging
import os
from datetime import datetime, date, timezone
from typing import Dict, List, Optional, Any
from zoneinfo import ZoneInfo

from projectx_api import ProjectXAPI
from strategies import DTRv3Strategy, StrategyState
from multi_instrument_config import MULTI_INSTRUMENT_CONFIG
from drawdown_monitor import DrawdownMonitor

logger = logging.getLogger(__name__)

NY_TZ = ZoneInfo("America/New_York")

# ─────────────────────────────────────────────────────────────────────────────
# Instrument metadata (augments multi_instrument_config.py)
# ─────────────────────────────────────────────────────────────────────────────

INSTRUMENTS = {
    "MYMM26": {"name": "Mini YM",        "point_value": 12.50},
    "MCLN26": {"name": "Micro Crude Oil", "point_value": 10.00},
    "MGCM26": {"name": "Micro Gold",      "point_value": 10.00},
    "MNQM26": {"name": "Micro NQ",        "point_value": 20.00},
}

TICK_INTERVAL = 60   # seconds between data fetches
BAR_HISTORY   = 250  # bars to fetch per tick (enough for ATR(14) + context)


def _calc_tp_qtys(qty: int, pct1: float, pct2: float) -> tuple:
    """Split qty into tp1/tp2/tp3 portions.

    Args:
        qty:  Total position size in contracts.
        pct1: Fraction for TP1 (e.g. 0.33).
        pct2: Fraction for TP2 (e.g. 0.33).

    Returns:
        (tp1_qty, tp2_qty, tp3_qty) — always sum to qty.
    """
    if qty <= 0:
        return 0, 0, 0
    if qty == 1:
        return qty, 0, 0
    if qty == 2:
        return 1, 1, 0
    if qty == 3:
        return 2, 1, 0
    tp1_qty = max(1, round(qty * pct1))
    tp2_qty = max(1, round(qty * pct2))
    tp3_qty = max(0, qty - tp1_qty - tp2_qty)
    if tp3_qty == 0:
        tp2_qty = qty - tp1_qty
    return tp1_qty, tp2_qty, tp3_qty


def _calc_live_pnl(trade: dict, current_price: Optional[float]) -> Optional[float]:
    """Calculate unrealized P&L for an open trade at current_price."""
    if current_price is None:
        return None
    point_value = INSTRUMENTS.get(trade.get("symbol", ""), {}).get("point_value", 10.0)
    qty = trade.get("qty_remaining", trade.get("qty", 1))
    if trade.get("direction") == "LONG":
        points = current_price - trade["entry_price"]
    else:
        points = trade["entry_price"] - current_price
    return round(points * point_value * qty, 2)


def strategy_params_for(symbol: str, strategies: dict) -> dict:
    """Return params dict for the strategy on the given symbol."""
    s = strategies.get(symbol)
    return s.get_params() if s else {}


class MarketDataOrchestrator:
    """
    Central coordinator for the DTR autonomous trading platform.

    Instantiated once at Flask startup. Flask endpoints call set_mode(),
    set_active_strategy(), and get_dashboard_state(). The async run loop
    (start()) runs in a background task.
    """

    def __init__(self) -> None:
        # ── API clients (lazy-initialised in start()) ──────────────────────
        self.api: Optional[ProjectXAPI] = None
        self._supabase = None        # supabase.Client or None
        self._claude_brain = None    # imported lazily
        self._hermes_brain = None    # imported lazily

        # ── Strategy engines — one per instrument ─────────────────────────
        self.strategies: Dict[str, Any] = {}
        self.states:     Dict[str, Optional[StrategyState]] = {s: None for s in INSTRUMENTS}

        # ── Active strategy ───────────────────────────────────────────────
        self.active_strategy_name: str = "DTR"
        self.strategy_timeframes: Dict[str, str] = {"DTR": "1m", "XXX": "1m"}

        # ── Account management ────────────────────────────────────────────
        self.available_accounts: List[dict] = []   # [{id, name, balance}]
        self.active_account_id:  str = os.environ.get("PROJECTX_ACCOUNT_ID", "")

        # ── Trade tracking ────────────────────────────────────────────────
        self.open_trades:  Dict[str, dict] = {}   # symbol → trade record
        self.daily_trades: List[dict] = []
        self.daily_pnl:    float = 0.0
        self._trade_date:  Optional[date] = None   # reset counters on date change

        # ── Control state ─────────────────────────────────────────────────
        self.mode:    str  = "HALT"
        self.running: bool = False
        self.halted:  bool = False   # drawdown auto-pause
        self.halt_reason: str = ""

        # ── Contract ID mapping (symbol → numeric ID from ProjectX) ──────────
        # Populated in start() via search_contracts(). All API calls use these.
        self.contract_ids: Dict[str, str] = {}

        # ── Tick counter (used to schedule periodic account refresh) ─────────
        self._tick_count: int = 0

        # ── Injected by Flask after construction ──────────────────────────
        self._drawdown_monitor: DrawdownMonitor = None

        # ── Last dashboard snapshot (written every tick) ──────────────────
        self._dashboard: dict = {"status": "BOOT", "instruments": {}}

    # ═════════════════════════════════════════════════════════════════════════
    # PUBLIC INTERFACE
    # ═════════════════════════════════════════════════════════════════════════

    def set_mode(self, mode: str) -> None:
        """Switch operating mode. Called by Flask endpoints."""
        assert mode in ("DTR", "CLAUDE+HERMES", "HALT")
        self.mode = mode
        if mode == "HALT":
            self.halted = False
            self.halt_reason = ""
        logger.info(f"🔄 Mode → {mode}")

    def set_active_strategy(self, name: str) -> None:
        """Switch strategy engine for all instruments. Re-instantiates all 4 objects."""
        assert name in ("DTR", "XXX"), f"Unknown strategy: {name}"
        self.active_strategy_name = name
        for symbol in INSTRUMENTS:
            if name == "DTR":
                from strategies import DTRv3Strategy
                s = DTRv3Strategy()
            else:
                # XXXv1Strategy is the placeholder for the second strategy.
                # Import lazily so the orchestrator boots even if XXX isn't yet written.
                from strategies import XXXv1Strategy  # type: ignore[attr-defined]
                s = XXXv1Strategy()
            s.init(symbol, {})
            self.strategies[symbol] = s
        logger.info(f"🔄 Active strategy → {name}")

    async def set_strategy_timeframe(self, strategy: str, timeframe: str) -> dict:
        """Switch bar timeframe for a strategy. Blocked if open trades exist for that strategy."""
        valid = {"1m", "5m", "15m"}
        if timeframe not in valid:
            return {"success": False, "error": f"Invalid timeframe. Choose from: {valid}"}
        open_for_strategy = [
            sym for sym, t in self.open_trades.items()
            if t.get("strategy", "DTR") == strategy
        ]
        if open_for_strategy:
            return {
                "success": False,
                "error": f"Cannot switch timeframe: {len(open_for_strategy)} open trade(s) for {strategy}",
            }
        self.strategy_timeframes[strategy] = timeframe
        logger.info(f"⏱️  {strategy} timeframe → {timeframe}")
        return {"success": True, "strategy": strategy, "timeframe": timeframe}

    def emergency_halt(self, reason: str) -> None:
        """Called by drawdown_monitor when limits are breached."""
        self.halted = True
        self.halt_reason = reason
        logger.warning(f"🚨 EMERGENCY HALT: {reason}")

    def resume_from_halt(self) -> None:
        """Called via dashboard / Telegram when Craig resumes."""
        self.halted = False
        self.halt_reason = ""
        logger.info("✅ Trading resumed from halt")

    def get_dashboard_state(self) -> dict:
        """Thread-safe snapshot for /api/live/dashboard."""
        return dict(self._dashboard)

    def get_strategy_state(self, symbol: str) -> Optional[StrategyState]:
        return self.states.get(symbol)

    def _cid(self, symbol: str) -> str:
        """Return the numeric contract ID for a symbol (resolved on boot)."""
        return self.contract_ids.get(symbol, symbol)

    async def set_active_account(self, account_id: str) -> bool:
        """Switch the active account on ProjectX and locally."""
        result = await self.api.set_active_account(account_id)
        if result:
            self.active_account_id = account_id
            logger.info(f"🏦 Active account → {account_id}")
        return bool(result)

    # ═════════════════════════════════════════════════════════════════════════
    # LIFECYCLE
    # ═════════════════════════════════════════════════════════════════════════

    async def start(self) -> None:
        """Boot the orchestrator. Called once from Flask startup."""
        logger.info("🚀 Market Data Orchestrator starting…")

        # ── ProjectX API ───────────────────────────────────────────────────
        self.api = ProjectXAPI(
            username=os.environ["PROJECTX_USERNAME"],
            api_key=os.environ["PROJECTX_API_KEY"],
            account_id=os.environ.get("PROJECTX_ACCOUNT_ID", ""),
        )
        connected = await self.api.connect()
        if not connected:
            logger.error("❌ ProjectX auth failed — orchestrator halted")
            self.halted = True
            self.halt_reason = "ProjectX authentication failed"
            return

        # ── Account management ─────────────────────────────────────────────
        try:
            accounts = await self.api.get_accounts()
            if accounts:
                self.available_accounts = accounts
                needle = str(self.active_account_id)

                # Try to find the configured account by exact API id
                matched = next((a for a in accounts if str(a.get("id")) == needle), None)

                # Fallback: match by name containing the configured number
                if not matched and needle:
                    matched = next((a for a in accounts if needle in str(a.get("name", ""))), None)
                    if matched:
                        logger.info(
                            f"🏦 PROJECTX_ACCOUNT_ID '{needle}' matched by name "
                            f"'{matched.get('name')}' → using api_id={matched.get('id')}"
                        )

                # Fallback: auto-select the only tradeable account
                if not matched:
                    tradeable = [a for a in accounts if a.get("canTrade")]
                    matched = tradeable[0] if tradeable else accounts[0]
                    logger.warning(
                        f"⚠️  PROJECTX_ACCOUNT_ID '{needle}' not found — "
                        f"auto-selecting canTrade account: {matched.get('name')} (id={matched.get('id')})"
                    )

                self.active_account_id = str(matched.get("id", ""))
                self.api.account_id    = self.active_account_id
                logger.info(f"🏦 Active account: {matched.get('name')} (id={self.active_account_id}, canTrade={matched.get('canTrade')})")
        except Exception as exc:
            logger.warning(f"⚠️  Could not fetch accounts: {exc}")

        # ── Resolve symbol → contract ID ───────────────────────────────────
        # TopstepX API requires numeric contract IDs, not ticker symbols.
        for symbol in INSTRUMENTS:
            try:
                contracts = await self.api.search_contracts(symbol)
                if not contracts:
                    # Exact symbol not listed yet (e.g. MCLN26 before July rolls on).
                    # Retry with the 3-char root to find the current front-month.
                    root = symbol[:3]
                    logger.warning(f"⚠️  No contract for {symbol}, retrying with root '{root}'")
                    contracts = await self.api.search_contracts(root)
                if contracts:
                    # Pick first exact or closest match
                    cid = str(contracts[0].get("id", contracts[0].get("contractId", symbol)))
                    name = contracts[0].get("name", contracts[0].get("description", cid))
                    self.contract_ids[symbol] = cid
                    logger.info(f"🔗 {symbol} → contract_id={cid} ({name})")
                else:
                    self.contract_ids[symbol] = symbol  # fallback (will likely fail)
                    logger.warning(f"⚠️  No contract found for {symbol} or root, using symbol as ID")
            except Exception as exc:
                self.contract_ids[symbol] = symbol
                logger.warning(f"⚠️  Contract lookup failed for {symbol}: {exc}")

        # ── Supabase ───────────────────────────────────────────────────────
        self._init_supabase()

        # ── AI brains (optional — won't crash if packages missing) ────────
        self._load_ai_brains()

        # ── Strategy instances ─────────────────────────────────────────────
        for symbol in INSTRUMENTS:
            strategy = DTRv3Strategy()
            strategy.init(symbol, {})
            self.strategies[symbol] = strategy

        self.running = True
        logger.info("✅ Orchestrator ready")

        # ── Main loop ──────────────────────────────────────────────────────
        await self._run_loop()

    async def stop(self) -> None:
        """Graceful shutdown."""
        self.running = False
        if self.api:
            await self.api.close()
        logger.info("🛑 Orchestrator stopped")

    # ═════════════════════════════════════════════════════════════════════════
    # MAIN LOOP
    # ═════════════════════════════════════════════════════════════════════════

    async def _run_loop(self) -> None:
        while self.running:
            try:
                self._check_date_rollover()
                await self._tick()
            except Exception as exc:
                logger.error(f"❌ Tick error: {exc}", exc_info=True)
            await asyncio.sleep(TICK_INTERVAL)

    async def _tick(self) -> None:
        """One 60-second cycle: fetch bars → run strategy → fire signals → update dashboard."""
        self._tick_count += 1
        now_ny = datetime.now(NY_TZ)

        # Daily equity snapshot at noon NY (fires once per minute window)
        if now_ny.hour == 12 and now_ny.minute == 0:
            asyncio.create_task(self._snapshot_equity())

        # ── Refresh account list every 5 ticks (~5 min) ───────────────────
        if self._tick_count % 5 == 1:  # also fires on first tick
            try:
                accounts = await self.api.get_accounts()
                if accounts:
                    self.available_accounts = accounts
                    logger.info(f"🏦 Accounts refreshed: {[a.get('id') for a in accounts]}")
                else:
                    logger.warning("⚠️  Account refresh returned empty list")
            except Exception as exc:
                logger.warning(f"⚠️  Account refresh failed: {exc}")

        # ── Monitor open trades first (detect TP fills and closes) ─────────
        await self._monitor_open_trades()

        # ── Process each instrument ────────────────────────────────────────
        instrument_states = {}
        enabled_symbols = [
            sym for sym in INSTRUMENTS
            if MULTI_INSTRUMENT_CONFIG.get(sym, {}).get("enabled", True)
        ]
        tasks = [self._process_instrument(sym) for sym in enabled_symbols]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for sym, result in zip(enabled_symbols, results):
            if isinstance(result, Exception):
                logger.error(f"❌ {sym} tick failed: {result}")
                instrument_states[sym] = self._build_instrument_snapshot(sym, None)
            else:
                instrument_states[sym] = result

        # Fill in any disabled instruments
        for sym in INSTRUMENTS:
            if sym not in instrument_states:
                instrument_states[sym] = self._build_instrument_snapshot(sym, self.states.get(sym))

        # ── Account snapshot ───────────────────────────────────────────────
        account = await self._safe_get_account()

        # Build open positions with live P&L
        latest_prices = {
            sym: snap.get("last_price")
            for sym, snap in instrument_states.items()
        }
        open_positions_list = [
            {
                "symbol":        sym,
                "direction":     t["direction"],
                "strategy":      t.get("strategy", "DTR"),
                "entry_price":   t["entry_price"],
                "entry_time":    t.get("opened_at"),
                "sl_level":      t.get("current_sl_level", t["sl_level"]),
                "tp1_level":     t.get("tp1_level", 0.0),
                "tp2_level":     t.get("tp2_level", 0.0),
                "tp3_level":     t.get("tp3_level", 0.0),
                "tp1_filled":    t.get("tp1_filled", False),
                "tp2_filled":    t.get("tp2_filled", False),
                "tp3_filled":    t.get("tp3_filled", False),
                "qty_remaining": t.get("qty_remaining", t.get("qty", 1)),
                "live_pnl":      _calc_live_pnl(t, latest_prices.get(sym)),
            }
            for sym, t in self.open_trades.items()
        ]

        self._dashboard = {
            "status":             "HALTED" if (self.halted or self.mode == "HALT") else "ACTIVE",
            "mode":               self.mode,
            "halt_reason":        self.halt_reason,
            "timestamp":          now_ny.isoformat(),
            "instruments":        instrument_states,
            "daily_pnl":          round(self.daily_pnl, 2),
            "trade_count":        len(self.daily_trades),
            "open_trades":        len(self.open_trades),
            "open_positions":     open_positions_list,
            "account":            account,
            "active_strategy":    self.active_strategy_name,
            "active_account_id":  self.active_account_id,
            "available_accounts": self.available_accounts,
            "strategy_timeframes": self.strategy_timeframes,
        }

    async def _process_instrument(self, symbol: str) -> dict:
        """Fetch bars, run strategy state machine, fire entry if BOS confirmed."""
        cfg         = MULTI_INSTRUMENT_CONFIG.get(symbol, {})
        tf          = self.strategy_timeframes.get(self.active_strategy_name, "1m")
        contract_id = self.contract_ids.get(symbol, symbol)
        bars        = await self.api.get_bars(contract_id, time_frame=tf, limit=BAR_HISTORY)

        if not bars or len(bars) < 20:
            logger.debug(f"⚠️  {symbol}: insufficient bars ({len(bars) if bars else 0})")
            return self._build_instrument_snapshot(symbol, None)

        # ── Run state machine ──────────────────────────────────────────────
        strategy = self.strategies[symbol]
        strategy.update(bars)
        state = strategy.get_state()
        self.states[symbol] = state

        # ── Check for entry signal ─────────────────────────────────────────
        if state.bos_confirmed and not self.halted and self.mode != "HALT":
            await self._handle_signal(symbol, state, cfg)

        return self._build_instrument_snapshot(symbol, state)

    # ═════════════════════════════════════════════════════════════════════════
    # SIGNAL HANDLING & EXECUTION
    # ═════════════════════════════════════════════════════════════════════════

    async def _handle_signal(self, symbol: str, state: StrategyState, cfg: dict) -> None:
        """Validate signal via Claude (if enabled) then execute."""

        # ── Guard: already in a trade for this symbol ─────────────────────
        if symbol in self.open_trades:
            logger.info(f"⏭️  {symbol}: signal skipped — already in trade")
            return

        # ── Guard: daily trade limit ───────────────────────────────────────
        symbol_trades_today = sum(1 for t in self.daily_trades if t["symbol"] == symbol)
        max_trades = strategy_params_for(symbol, self.strategies).get("maxTrades", 4)
        if symbol_trades_today >= max_trades:
            logger.info(f"⏭️  {symbol}: daily trade limit reached ({symbol_trades_today})")
            return

        # ── Claude validation ──────────────────────────────────────────────
        approved          = True
        reasoning         = "Rule-based signal — no AI validation"
        hermes_confidence = 0.0

        if self.mode == "CLAUDE+HERMES" and self._claude_brain:
            trading_context = await self._load_trading_context(symbol)
            try:
                result = await self._claude_brain.validate_entry(state, trading_context)
                approved          = result.get("decision") == "ENTER"
                reasoning         = result.get("reasoning", "")
                hermes_confidence = result.get("confidence", 0.0)

                # Apply param adjustments within safe bounds
                if result.get("param_adjustments"):
                    self.strategies[symbol].set_params(result["param_adjustments"])

                logger.info(
                    f"🧠 Claude {'ENTER' if approved else 'SKIP'} {symbol} "
                    f"({state.direction}) conf={hermes_confidence:.2f}"
                )
            except Exception as exc:
                logger.error(f"❌ Claude brain error: {exc}")
                # Fall back to rule-based entry rather than blocking
                approved  = True
                reasoning = f"Claude error fallback: {exc}"

        if not approved:
            await self._log_agent_action("claude", "SKIP", symbol, {
                "direction": state.direction,
                "session":   state.session,
                "reasoning": reasoning,
            })
            return

        # ── Hermes early-close signal check ───────────────────────────────
        if self.mode == "CLAUDE+HERMES" and self._hermes_brain:
            trading_context = await self._load_trading_context(symbol)
            if trading_context.get("early_close_signal"):
                ec = trading_context["early_close_signal"]
                sym_to_close = ec.get("symbol")
                close_reason = ec.get("reason", "hermes_early_close")
                if sym_to_close and sym_to_close in self.open_trades:
                    logger.info(
                        f"🧠 Hermes early-close signal: {sym_to_close} ({close_reason})"
                    )
                    await self._early_close_trade(
                        sym_to_close, self.open_trades[sym_to_close], close_reason
                    )
                # Clear signal from context
                trading_context.pop("early_close_signal", None)
                await self._save_trading_context(symbol, trading_context)

        await self._execute_entry(symbol, state, cfg, reasoning, hermes_confidence)

    async def _execute_entry(
        self,
        symbol:            str,
        state:             StrategyState,
        cfg:               dict,
        claude_reasoning:  str,
        hermes_confidence: float,
    ) -> None:
        """Place market entry + 3-TP LIMIT orders + 1 STOP loss bracket."""
        direction  = state.direction          # "LONG" | "SHORT"
        qty        = cfg.get("qty", 1)
        sl_level   = state.sl_level

        entry_side = "BUY"  if direction == "LONG"  else "SELL"
        close_side = "SELL" if direction == "LONG"  else "BUY"

        logger.info(
            f"📈 ENTERING {direction} {symbol}  "
            f"qty={qty}  SL={sl_level:.4f}  "
            f"session={state.session}  strategy={self.active_strategy_name}"
        )

        # ── Step A: Market entry for full qty ──────────────────────────────
        entry_order = await self.api.place_order(
            contract_id=self._cid(symbol),
            side=entry_side,
            quantity=qty,
            order_type="MARKET",
            comment=f"{self.active_strategy_name} {direction} {state.session}",
        )
        if not entry_order:
            logger.error(f"❌ {symbol}: entry order failed")
            return

        entry_price = entry_order.get("fill_price") or entry_order.get("price", 0.0)

        # ── Step B: Compute actual TP levels from fill price ───────────────
        is_dtr = self.active_strategy_name == "DTR"

        if is_dtr:
            # DTR: TP3 = range extreme, TP1 and TP2 are evenly spaced thirds
            tp3 = state.tp3_level   # range_high (LONG) or range_low (SHORT)
            if direction == "LONG":
                tp1 = entry_price + (tp3 - entry_price) / 3
                tp2 = entry_price + (tp3 - entry_price) * 2 / 3
            else:
                tp1 = entry_price - (entry_price - tp3) / 3
                tp2 = entry_price - (entry_price - tp3) * 2 / 3
        else:
            # XXX: fixed-percentage TPs/SL from fill price
            strat_params = self.strategies[symbol].get_params()
            sl_pct  = strat_params.get("slPct",  0.005)
            tp1_pct = strat_params.get("tp1Pct", 0.010)
            tp2_pct = strat_params.get("tp2Pct", 0.015)
            tp3_pct = strat_params.get("tp3Pct", 0.020)
            if direction == "LONG":
                tp1 = entry_price * (1 + tp1_pct)
                tp2 = entry_price * (1 + tp2_pct)
                tp3 = entry_price * (1 + tp3_pct)
                sl_level = entry_price * (1 - sl_pct)   # override state.sl_level
            else:
                tp1 = entry_price * (1 - tp1_pct)
                tp2 = entry_price * (1 - tp2_pct)
                tp3 = entry_price * (1 - tp3_pct)
                sl_level = entry_price * (1 + sl_pct)   # override state.sl_level

        # ── Step C: Calculate qty splits ───────────────────────────────────
        pct1 = state.tp1_qty_pct if hasattr(state, "tp1_qty_pct") else 1 / 3
        pct2 = state.tp2_qty_pct if hasattr(state, "tp2_qty_pct") else 1 / 3
        tp1_qty, tp2_qty, tp3_qty = _calc_tp_qtys(qty, pct1, pct2)

        logger.info(
            f"  Bracket: SL={sl_level:.4f}  "
            f"TP1={tp1:.4f}(x{tp1_qty})  "
            f"TP2={tp2:.4f}(x{tp2_qty})  "
            f"TP3={tp3:.4f}(x{tp3_qty})"
        )

        # ── Step D: Place bracket orders ───────────────────────────────────

        # SL — full position qty
        sl_order = await self.api.place_order(
            contract_id=self._cid(symbol),
            side=close_side,
            quantity=qty,
            order_type="STOP",
            stop_price=sl_level,
            comment=f"{self.active_strategy_name} SL {direction}",
        )

        # TP1
        tp1_order = None
        if tp1_qty > 0:
            tp1_order = await self.api.place_order(
                contract_id=self._cid(symbol),
                side=close_side,
                quantity=tp1_qty,
                order_type="LIMIT",
                limit_price=tp1,
                comment=f"{self.active_strategy_name} TP1 {direction}",
            )

        # TP2
        tp2_order = None
        if tp2_qty > 0:
            tp2_order = await self.api.place_order(
                contract_id=self._cid(symbol),
                side=close_side,
                quantity=tp2_qty,
                order_type="LIMIT",
                limit_price=tp2,
                comment=f"{self.active_strategy_name} TP2 {direction}",
            )

        # TP3
        tp3_order = None
        if tp3_qty > 0:
            tp3_order = await self.api.place_order(
                contract_id=self._cid(symbol),
                side=close_side,
                quantity=tp3_qty,
                order_type="LIMIT",
                limit_price=tp3,
                comment=f"{self.active_strategy_name} TP3 {direction}",
            )

        # ── Step E: Store enhanced trade record ────────────────────────────
        now_utc = datetime.now(timezone.utc)
        trade: dict = {
            "symbol":            symbol,
            "session":           state.session,
            "direction":         direction,
            "entry_price":       entry_price,
            "sl_level":          sl_level,
            "tp1_level":         tp1,
            "tp2_level":         tp2,
            "tp3_level":         tp3,
            "tp1_qty":           tp1_qty,
            "tp2_qty":           tp2_qty,
            "tp3_qty":           tp3_qty,
            "qty":               qty,
            "qty_remaining":     qty,
            "entry_order_id":    entry_order.get("order_id"),
            "sl_order_id":       sl_order.get("order_id")  if sl_order  else None,
            "tp1_order_id":      tp1_order.get("order_id") if tp1_order else None,
            "tp2_order_id":      tp2_order.get("order_id") if tp2_order else None,
            "tp3_order_id":      tp3_order.get("order_id") if tp3_order else None,
            "tp1_filled":        False,
            "tp2_filled":        False,
            "tp3_filled":        False,
            # sl_order_current_id tracks the most recent SL order (steps as TPs fill)
            "sl_order_current_id": sl_order.get("order_id") if sl_order else None,
            "current_sl_level":  sl_level,
            "strategy":          self.active_strategy_name,
            "opened_at":         now_utc.isoformat(),
            "stage_sequence":    [0, 1, 2, 3, 4],
            "market_conditions": {
                "atr":          state.atr14,
                "range_size":   round(state.range_high - state.range_low, 4)
                                if state.range_high else 0.0,
                "time_ny":      datetime.now(NY_TZ).strftime("%H:%M"),
                "day_of_week":  datetime.now(NY_TZ).strftime("%A"),
                "session":      state.session,
            },
            "hermes_confidence": hermes_confidence,
            "claude_reasoning":  claude_reasoning,
            "close_reason":      None,
            "early_close_triggered": False,
        }

        self.open_trades[symbol] = trade
        self.daily_trades.append(trade)

        await self._log_trade_opened(trade)
        logger.info(
            f"✅ Trade opened: {symbol} {direction} @ {entry_price:.4f}  "
            f"[{self.active_strategy_name}]"
        )

    # ═════════════════════════════════════════════════════════════════════════
    # TRADE MONITORING — 3-TP BRACKET + STEPPED SL
    # ═════════════════════════════════════════════════════════════════════════

    async def _monitor_open_trades(self) -> None:
        """
        Detect partial TP fills, step the SL to protect capital, and handle
        full closes (TP3 hit, SL hit, early close).
        """
        if not self.open_trades:
            return

        try:
            # Fetch live order list — orders that have disappeared were filled
            open_orders = await self.api.get_open_orders()
            order_id_set = {
                o.get("order_id")
                for o in (open_orders or [])
                if o.get("status") not in ("CANCELLED", "REJECTED")
            }

            for symbol, trade in list(self.open_trades.items()):
                # ── TP1 fill check ─────────────────────────────────────────
                if not trade["tp1_filled"] and trade.get("tp1_order_id"):
                    if trade["tp1_order_id"] not in order_id_set:
                        await self._on_tp_filled(symbol, trade, tp_num=1)

                # ── TP2 fill check (only after TP1) ────────────────────────
                if (trade["tp1_filled"]
                        and not trade["tp2_filled"]
                        and trade.get("tp2_order_id")):
                    if trade["tp2_order_id"] not in order_id_set:
                        await self._on_tp_filled(symbol, trade, tp_num=2)

                # ── TP3 / full close check ─────────────────────────────────
                if trade["tp2_filled"] and trade.get("tp3_order_id"):
                    if trade["tp3_order_id"] not in order_id_set:
                        trade["tp3_filled"] = True
                        await self._handle_trade_close(symbol, close_reason="tp3")
                        continue  # trade removed from open_trades

                # Guard: trade may have been popped by _handle_trade_close above
                if symbol not in self.open_trades:
                    continue

                # ── SL hit / unexpected close ──────────────────────────────
                # If the position no longer exists but TP3 hasn't been marked filled
                positions = await self.api.get_positions()
                pos_symbols = {p.get("contract_id") for p in (positions or [])}
                if symbol not in pos_symbols and symbol in self.open_trades:
                    # Determine if this was SL or an untracked TP close
                    if not trade["tp3_filled"]:
                        close_reason = "sl"
                        if trade["tp1_filled"] or trade["tp2_filled"]:
                            close_reason = "partial_tp_then_sl"
                        await self._handle_trade_close(symbol, close_reason=close_reason)
                        continue

                # Guard: trade may have been popped
                if symbol not in self.open_trades:
                    continue

                # ── DTR invalidation mid-trade ─────────────────────────────
                if self.active_strategy_name == "DTR":
                    state = self.states.get(symbol)
                    if (state and state.invalidated
                            and not trade.get("early_close_triggered")):
                        trade["early_close_triggered"] = True
                        await self._early_close_trade(
                            symbol, trade, reason="dtr_invalidation"
                        )

        except Exception as exc:
            logger.error(f"❌ Monitor open trades error: {exc}", exc_info=True)

    async def _on_tp_filled(self, symbol: str, trade: dict, tp_num: int) -> None:
        """Handle a TP fill: update qty_remaining and step SL to protect capital."""
        close_side = "SELL" if trade["direction"] == "LONG" else "BUY"

        if tp_num == 1:
            trade["tp1_filled"]   = True
            trade["qty_remaining"] = max(0, trade["qty_remaining"] - trade["tp1_qty"])
            new_sl     = trade["entry_price"]   # break even
            new_sl_qty = trade["qty_remaining"]
            logger.info(
                f"✅ {symbol} TP1 filled — moving SL to break even @ {new_sl:.4f}"
            )
        elif tp_num == 2:
            trade["tp2_filled"]   = True
            trade["qty_remaining"] = max(0, trade["qty_remaining"] - trade["tp2_qty"])
            new_sl     = trade["tp1_level"]     # lock in TP1 profit
            new_sl_qty = trade["qty_remaining"]
            logger.info(
                f"✅ {symbol} TP2 filled — moving SL to TP1 @ {new_sl:.4f}"
            )
        else:
            logger.warning(f"_on_tp_filled called with unknown tp_num={tp_num}")
            return

        # Cancel old SL, place new STOP for remaining qty
        if trade.get("sl_order_current_id"):
            try:
                await self.api.cancel_order(trade["sl_order_current_id"])
            except Exception as exc:
                logger.warning(f"⚠️  Could not cancel old SL for {symbol}: {exc}")

        if new_sl_qty > 0:
            new_sl_order = await self.api.place_order(
                contract_id=self._cid(symbol),
                side=close_side,
                quantity=new_sl_qty,
                order_type="STOP",
                stop_price=new_sl,
                comment=f"{trade['strategy']} SL-step TP{tp_num}",
            )
            trade["sl_order_current_id"] = (
                new_sl_order.get("order_id") if new_sl_order else None
            )
            trade["current_sl_level"] = new_sl
        else:
            trade["sl_order_current_id"] = None

        # Persist TP fill status to Supabase
        await self._update_trade_tp_status(trade)

    async def _early_close_trade(
        self, symbol: str, trade: dict, reason: str
    ) -> None:
        """Cancel all bracket orders and market-close the remaining position."""
        close_side = "SELL" if trade["direction"] == "LONG" else "BUY"

        # Cancel all open bracket orders
        for oid_key in ("sl_order_current_id", "tp1_order_id", "tp2_order_id", "tp3_order_id"):
            oid = trade.get(oid_key)
            if oid:
                try:
                    await self.api.cancel_order(oid)
                except Exception:
                    pass   # best-effort; order may already be filled/cancelled

        # Market close remaining qty
        remaining = trade.get("qty_remaining", trade["qty"])
        if remaining > 0:
            await self.api.place_order(
                contract_id=self._cid(symbol),
                side=close_side,
                quantity=remaining,
                order_type="MARKET",
                comment=f"Early close: {reason}",
            )

        trade["close_reason"] = reason
        await self._handle_trade_close(symbol, close_reason=reason)
        logger.info(f"🔴 {symbol} early close: {reason}")

    async def _handle_trade_close(
        self, symbol: str, close_reason: str = "sl"
    ) -> None:
        """Trade has closed (fully or partially). Calculate PnL, log to Supabase, trigger Hermes."""
        trade = self.open_trades.pop(symbol, None)
        if not trade:
            return

        # Fetch last matching trade from ProjectX for exit fill price
        recent_trades = await self.api.search_trades(contract_id=self._cid(symbol), limit=5)
        exit_price = trade["entry_price"]   # fallback
        strategy_prefix = trade.get("strategy", "DTR")
        for t in recent_trades:
            comment = t.get("comment", "")
            if comment.startswith(strategy_prefix):
                exit_price = t.get("fill_price", exit_price)
                break

        # Calculate PnL based on qty that was actually closed
        point_value = INSTRUMENTS.get(symbol, {}).get("point_value", 10.0)
        qty = trade["qty"]
        if trade["direction"] == "LONG":
            points = exit_price - trade["entry_price"]
        else:
            points = trade["entry_price"] - exit_price
        pnl = points * point_value * qty

        # Determine outcome — account for partial TP fills
        tp1_filled = trade.get("tp1_filled", False)
        tp2_filled = trade.get("tp2_filled", False)
        tp3_filled = trade.get("tp3_filled", False)

        if tp3_filled:
            outcome = "WIN_FULL"
        elif tp2_filled and close_reason in ("sl", "partial_tp_then_sl"):
            outcome = "WIN_PARTIAL"
        elif tp1_filled and close_reason in ("sl", "partial_tp_then_sl"):
            outcome = "WIN_PARTIAL"
        elif pnl > 0.5:
            outcome = "WIN"
        elif pnl < -0.5:
            outcome = "LOSS"
        else:
            outcome = "BREAKEVEN"

        self.daily_pnl += pnl

        trade.update({
            "exit_price":    exit_price,
            "pnl":           round(pnl, 2),
            "outcome":       outcome,
            "close_reason":  close_reason,
            "closed_at":     datetime.now(timezone.utc).isoformat(),
        })

        win_icon = "🏆" if outcome.startswith("WIN") else ("⚖️" if outcome == "BREAKEVEN" else "❌")
        logger.info(
            f"{win_icon} Trade closed: {symbol} {trade['direction']} "
            f"PnL=${pnl:.2f} ({outcome}) reason={close_reason}"
        )

        await self._log_trade_closed(trade)

        # Drawdown monitor
        if self._drawdown_monitor:
            await self._drawdown_monitor.on_trade_closed(trade, self.daily_pnl, self)

        # Trigger Hermes after every trade close
        if self.mode == "CLAUDE+HERMES" and self._hermes_brain:
            asyncio.create_task(self._run_hermes_analysis(symbol))

    # ═════════════════════════════════════════════════════════════════════════
    # EQUITY SNAPSHOTS
    # ═════════════════════════════════════════════════════════════════════════

    async def _snapshot_equity(self) -> None:
        """Save daily equity snapshot to Supabase. Called at end of NY session (~12:00 PM)."""
        if not self._supabase:
            return
        try:
            balance = None
            account = await self._safe_get_account()
            if account:
                balance = account.get("balance")

            total = len(self.daily_trades)
            wins  = sum(1 for t in self.daily_trades if (t.get("outcome") or "").startswith("WIN"))
            win_rate = (wins / total) if total else 0.0

            self._supabase.table("performance_snapshots").upsert({
                "date":        datetime.now(NY_TZ).date().isoformat(),
                "account_id":  self.active_account_id,
                "balance":     balance,
                "daily_pnl":   round(self.daily_pnl, 2),
                "trade_count": total,
                "win_rate":    round(win_rate, 4),
            }, on_conflict="date,account_id").execute()
            logger.info(f"📸 Equity snapshot saved: balance={balance}, pnl={self.daily_pnl:.2f}")
        except Exception as exc:
            logger.error(f"❌ Equity snapshot error: {exc}")

    # ═════════════════════════════════════════════════════════════════════════
    # AI BRAINS
    # ═════════════════════════════════════════════════════════════════════════

    async def _run_hermes_analysis(self, symbol: str) -> None:
        """Run Hermes pattern analysis after a trade. Non-blocking background task."""
        try:
            current_context = await self._load_trading_context(symbol)
            recent_trades   = [t for t in self.daily_trades if t.get("symbol") == symbol]

            new_context = await self._hermes_brain.analyze_and_learn(
                trades=recent_trades,
                current_context=current_context,
                symbol=symbol,
            )

            # Check if Hermes is signalling an early close on another instrument
            if new_context and new_context.get("early_close_signal"):
                ec = new_context["early_close_signal"]
                sym_to_close = ec.get("symbol")
                close_reason = ec.get("reason", "hermes_early_close")
                if sym_to_close and sym_to_close in self.open_trades:
                    logger.info(
                        f"🧠 Hermes signals early close: {sym_to_close} ({close_reason})"
                    )
                    await self._early_close_trade(
                        sym_to_close, self.open_trades[sym_to_close], close_reason
                    )
                # Clear the signal before saving so it doesn't re-fire next tick
                new_context.pop("early_close_signal", None)

            await self._save_trading_context(symbol, new_context)
            logger.info(f"🧠 Hermes analysis complete for {symbol}")
        except Exception as exc:
            logger.error(f"❌ Hermes analysis error ({symbol}): {exc}")

    # ═════════════════════════════════════════════════════════════════════════
    # SUPABASE PERSISTENCE
    # ═════════════════════════════════════════════════════════════════════════

    def _init_supabase(self) -> None:
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not (url and key):
            logger.warning("⚠️  Supabase env vars missing — persistence disabled")
            return
        try:
            from supabase import create_client
            self._supabase = create_client(url, key)
            logger.info("✅ Supabase connected")
        except ImportError:
            logger.warning("⚠️  supabase-py not installed — persistence disabled")

    async def _load_trading_context(self, symbol: str) -> dict:
        if not self._supabase:
            return {}
        try:
            resp = (
                self._supabase.table("trading_context")
                .select("context")
                .eq("symbol", symbol)
                .maybe_single()
                .execute()
            )
            return resp.data["context"] if resp.data else {}
        except Exception as exc:
            logger.error(f"❌ Load trading context error: {exc}")
            return {}

    async def _save_trading_context(self, symbol: str, context: dict) -> None:
        if not self._supabase:
            return
        try:
            self._supabase.table("trading_context").upsert({
                "symbol":     symbol,
                "context":    context,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="symbol").execute()
        except Exception as exc:
            logger.error(f"❌ Save trading context error: {exc}")

    async def _log_trade_opened(self, trade: dict) -> None:
        if not self._supabase:
            return
        try:
            self._supabase.table("trades").insert({
                "symbol":            trade["symbol"],
                "session":           trade["session"],
                "direction":         trade["direction"],
                "entry_price":       trade["entry_price"],
                "sl_level":          trade["sl_level"],
                # 3-TP fields
                "tp1_level":         trade["tp1_level"],
                "tp2_level":         trade["tp2_level"],
                "tp3_level":         trade["tp3_level"],
                "tp1_qty":           trade["tp1_qty"],
                "tp2_qty":           trade["tp2_qty"],
                "tp3_qty":           trade["tp3_qty"],
                "strategy":          trade["strategy"],
                # Legacy field kept for backward compat
                "tp_level":          trade["tp3_level"],
                "stage_sequence":    trade["stage_sequence"],
                "market_conditions": trade["market_conditions"],
                "hermes_confidence": trade["hermes_confidence"],
                "claude_reasoning":  trade["claude_reasoning"],
                "opened_at":         trade["opened_at"],
            }).execute()
        except Exception as exc:
            logger.error(f"❌ Log trade opened error: {exc}")

    async def _log_trade_closed(self, trade: dict) -> None:
        if not self._supabase:
            return
        try:
            self._supabase.table("trades").update({
                "exit_price":   trade.get("exit_price"),
                "pnl":          trade.get("pnl"),
                "outcome":      trade.get("outcome"),
                "close_reason": trade.get("close_reason"),
                "closed_at":    trade.get("closed_at"),
                "tp1_filled":   trade.get("tp1_filled", False),
                "tp2_filled":   trade.get("tp2_filled", False),
                "tp3_filled":   trade.get("tp3_filled", False),
            }).eq("symbol", trade["symbol"]).eq("opened_at", trade["opened_at"]).execute()
        except Exception as exc:
            logger.error(f"❌ Log trade closed error: {exc}")

    async def _update_trade_tp_status(self, trade: dict) -> None:
        """Update TP fill flags and current SL level in Supabase after a TP steps."""
        if not self._supabase:
            return
        try:
            self._supabase.table("trades").update({
                "tp1_filled":        trade.get("tp1_filled", False),
                "tp2_filled":        trade.get("tp2_filled", False),
                "current_sl_level":  trade.get("current_sl_level"),
                "qty_remaining":     trade.get("qty_remaining"),
            }).eq("symbol", trade["symbol"]).eq("opened_at", trade["opened_at"]).execute()
        except Exception as exc:
            logger.error(f"❌ Update TP status error: {exc}")

    async def _log_agent_action(
        self, agent: str, action: str, symbol: str, result: dict
    ) -> None:
        if not self._supabase:
            return
        try:
            self._supabase.table("agent_audit_log").insert({
                "agent_name": agent,
                "action":     action,
                "symbol":     symbol,
                "result":     result,
            }).execute()
        except Exception as exc:
            logger.error(f"❌ Log agent action error: {exc}")

    # ═════════════════════════════════════════════════════════════════════════
    # HELPERS
    # ═════════════════════════════════════════════════════════════════════════

    def _load_ai_brains(self) -> None:
        try:
            from claude_brain import ClaudeBrain
            self._claude_brain = ClaudeBrain()
            logger.info("✅ Claude brain loaded")
        except ImportError:
            logger.warning("⚠️  claude_brain.py not found — AI validation disabled")

        try:
            from hermes_brain import HermesBrain
            self._hermes_brain = HermesBrain()
            logger.info("✅ Hermes brain loaded")
        except ImportError:
            logger.warning("⚠️  hermes_brain.py not found — pattern learning disabled")

    def _check_date_rollover(self) -> None:
        today = date.today()
        if self._trade_date != today:
            if self._trade_date is not None:
                # End-of-day: drawdown day-end check + Hermes daily digest
                asyncio.create_task(self._end_of_day())
            logger.info(f"📅 New trading day: {today} — resetting daily counters")
            self._trade_date = today
            self.daily_pnl    = 0.0
            self.daily_trades = []

    async def _end_of_day(self) -> None:
        """End-of-session tasks: drawdown day check + Hermes digest."""
        if self._drawdown_monitor:
            await self._drawdown_monitor.on_day_end(self.daily_pnl, self)

        if self.mode == "CLAUDE+HERMES" and self._hermes_brain:
            try:
                all_contexts: dict = {}
                for sym in INSTRUMENTS:
                    all_contexts[sym] = await self._load_trading_context(sym)
                await self._hermes_brain.daily_digest(self.daily_trades, all_contexts)
            except Exception as exc:
                logger.error(f"❌ Daily digest error: {exc}")

    def _build_instrument_snapshot(
        self, symbol: str, state: Optional[StrategyState]
    ) -> dict:
        """Build the per-instrument dict for the dashboard payload."""
        in_trade = symbol in self.open_trades
        trade    = self.open_trades.get(symbol)

        if state is None:
            return {
                "symbol":        symbol,
                "name":          INSTRUMENTS.get(symbol, {}).get("name", symbol),
                "stage":         0,
                "direction":     None,
                "session":       None,
                "bos_confirmed": False,
                "in_trade":      in_trade,
                "trade":         trade,
                "range_high":    0.0,
                "range_low":     0.0,
                "sl_level":      0.0,
                "tp_level":      0.0,
                "tp1_level":     0.0,
                "tp2_level":     0.0,
                "tp3_level":     0.0,
                "atr14":         0.0,
                "strategy":      self.active_strategy_name,
            }

        return {
            "symbol":              symbol,
            "name":                INSTRUMENTS.get(symbol, {}).get("name", symbol),
            "stage":               state.stage,
            "direction":           state.direction,
            "session":             state.session,
            "in_entry_window":     state.in_entry_window,
            "bos_confirmed":       state.bos_confirmed,
            "invalidated":         state.invalidated,
            "range_high":          round(state.range_high, 4),
            "range_low":           round(state.range_low, 4),
            "bias_candle_high":    round(state.bias_candle_high, 4),
            "bias_candle_low":     round(state.bias_candle_low, 4),
            "sl_level":            round(state.sl_level, 4),
            "tp_level":            round(state.tp_level, 4),        # backward compat
            "tp1_level":           round(state.tp1_level, 4),
            "tp2_level":           round(state.tp2_level, 4),
            "tp3_level":           round(state.tp3_level, 4),
            "atr14":               round(state.atr14, 4),
            "in_trade":            in_trade,
            "trade":               trade,
            "market_conditions":   state.market_conditions,
            "strategy":            self.active_strategy_name,
        }

    async def _safe_get_account(self) -> dict:
        try:
            return await self.api.get_account_summary() or {}
        except Exception:
            return {}


# ─────────────────────────────────────────────────────────────────────────────
# Singleton — Flask imports this
# ─────────────────────────────────────────────────────────────────────────────

orchestrator = MarketDataOrchestrator()
