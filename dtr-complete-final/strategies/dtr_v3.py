"""
DTR v3 Strategy — RBS + 3CR State Machine
==========================================
Python translation of Pine Script DTR Time Range Scalper v3.
Strategy by DayTradingRauf. Implemented faithfully from the Pine Script source.

Each symbol runs FOUR parallel state machines:
  2AM_LONG, 2AM_SHORT, 9AM_LONG, 9AM_SHORT

State progression (per machine):
  0 → 1: candle CLOSES outside range (sweep, sets bias)
  1 → 2: first big bias candle (body >= ATR14 × fvgSizeMult)
  2 → 3: candle wicks into bias candle body (retest)
         OR skip directly to pending if same candle crosses body
  3 → 4: close beyond bias candle BODY extreme (BOS), while in BOS gate
         Invalidation: close past bias candle far-side → reset to Stage 1
  4:    BOS confirmed — entry fires on next bar open

Session windows (America/New_York):
  2AM: Range 01:12–02:12, Break/Entry 02:13–04:00, BOS gate 03:12 AM
  9AM: Range 08:12–09:12, Break/Entry 09:13–12:00, BOS gate 09:12 AM
"""

import logging
from datetime import datetime, time as dt_time
from typing import Optional

import pytz

from .base import BaseStrategy, StrategyState

logger = logging.getLogger(__name__)

TZ = pytz.timezone("America/New_York")

# Safe bounds for AI parameter adjustments
PARAM_BOUNDS = {
    "fvgSizeMult":  (0.5, 3.0),
    "slMult":       (0.0, 2.0),
    "maxTrades":    (2, 6),
    "maxLossDir":   (1, 4),
    "lossLimit":    (150.0, 500.0),
    "profitTarget": (500.0, 2000.0),
}

DEFAULT_PARAMS = {
    "fvgSizeMult":   1.5,
    "slMult":        0.0,
    "maxTrades":     4,
    "maxLossDir":    2,
    "lossLimit":     300.0,
    "profitTarget":  1000.0,
    "enableMon":     True,
    "enableTue":     True,
    "enableWed":     True,
    "enableThu":     True,
    "enableFri":     True,
}


def _atr(bars: list, period: int = 14) -> float:
    """Wilder's ATR."""
    if len(bars) < 2:
        return 0.0
    trs = []
    for i in range(1, min(len(bars), period + 1)):
        b, prev = bars[-i], bars[-(i + 1)]
        tr = max(b["high"] - b["low"],
                 abs(b["high"] - prev["close"]),
                 abs(b["low"]  - prev["close"]))
        trs.append(tr)
    if not trs:
        return 0.0
    atr_val = trs[0]
    for tr in trs[1:]:
        atr_val = (atr_val * (period - 1) + tr) / period
    return atr_val


def _ny_time(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = pytz.utc.localize(dt)
    return dt.astimezone(TZ)


def _in_window(now_ny: datetime, start_hhmm: str, end_hhmm: str) -> bool:
    sh, sm = int(start_hhmm[:2]), int(start_hhmm[3:])
    eh, em = int(end_hhmm[:2]), int(end_hhmm[3:])
    t = now_ny.time()
    s = dt_time(sh, sm)
    e = dt_time(eh, em)
    return s <= t < e


class _SessionMachine:
    """One directional state machine for one session (e.g. 2AM LONG)."""

    def __init__(self, direction: str, session: str):
        self.direction = direction  # 'LONG' or 'SHORT'
        self.session = session      # '2AM' or '9AM'
        self.reset()

    def reset(self):
        self.stage = 0
        self.bc_high: Optional[float] = None   # bias candle high
        self.bc_low:  Optional[float] = None   # bias candle low
        self.bc_body_top:    Optional[float] = None
        self.bc_body_bottom: Optional[float] = None
        self.pending = False       # BOS confirmed, entry next bar

    def process(self, bar: dict, prev_bar: dict, atr14: float,
                range_high: float, range_low: float,
                in_range_broken: bool, in_bos_gate: bool,
                params: dict) -> bool:
        """
        Process one bar. Returns True if a new BOS pending was just set.
        in_range_broken: whether this bar is in the break/entry window
        in_bos_gate: whether we are past the BOS gate time
        """
        if not in_range_broken:
            return False

        fvg_mult = params.get("fvgSizeMult", 1.5)
        o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]

        big_bull = c > o and (c - o) >= fvg_mult * atr14
        big_bear = c < o and (o - c) >= fvg_mult * atr14

        # Stage 0 → 1: sweep (close outside range)
        if self.stage == 0:
            if self.direction == "LONG" and c < range_low:
                self.stage = 1
            elif self.direction == "SHORT" and c > range_high:
                self.stage = 1
            return False

        # Stage 1 → 2: first big bias candle
        if self.stage == 1:
            if self.direction == "LONG" and big_bull:
                self.stage = 2
                self.bc_high = h
                self.bc_low  = l
                self.bc_body_top    = c   # bullish: body top = close
                self.bc_body_bottom = o   # bullish: body bottom = open
            elif self.direction == "SHORT" and big_bear:
                self.stage = 2
                self.bc_high = h
                self.bc_low  = l
                self.bc_body_top    = o   # bearish: body top = open
                self.bc_body_bottom = c   # bearish: body bottom = close
            return False

        # Stage 2: retest — wick touches bias candle body
        if self.stage == 2:
            if self.direction == "LONG":
                # Wick into body bottom (low <= body_bottom)
                if l <= self.bc_body_bottom:
                    if c > self.bc_body_top and in_bos_gate:
                        # Immediate BOS on same candle
                        self.pending = True
                        self.stage = 0
                        return True
                    else:
                        self.stage = 3
            elif self.direction == "SHORT":
                # Wick into body top (high >= body_top)
                if h >= self.bc_body_top:
                    if c < self.bc_body_bottom and in_bos_gate:
                        self.pending = True
                        self.stage = 0
                        return True
                    else:
                        self.stage = 3
            return False

        # Stage 3 → BOS pending OR invalidate
        if self.stage == 3:
            if self.direction == "LONG":
                if c > self.bc_body_top and in_bos_gate:
                    self.pending = True
                    self.stage = 0
                    return True
                elif c < self.bc_low:
                    # Bias candle low breached → reset to stage 1, look for new bias
                    self.stage = 1
                    self.bc_high = self.bc_low = self.bc_body_top = self.bc_body_bottom = None
            elif self.direction == "SHORT":
                if c < self.bc_body_bottom and in_bos_gate:
                    self.pending = True
                    self.stage = 0
                    return True
                elif c > self.bc_high:
                    self.stage = 1
                    self.bc_high = self.bc_low = self.bc_body_top = self.bc_body_bottom = None

        return False


class DTRv3Strategy(BaseStrategy):
    """
    DTR Time Range Scalper v3 — Python implementation.
    Manages 4 state machines per call to update().
    """

    # Session config
    SESSIONS = {
        "2AM": {
            "range_start":  "01:12",
            "range_end":    "02:12",
            "break_start":  "02:13",
            "break_end":    "04:00",
            "bos_gate":     "03:12",
            "force_close":  "04:00",
        },
        "9AM": {
            "range_start":  "08:12",
            "range_end":    "09:12",
            "break_start":  "09:13",
            "break_end":    "12:00",
            "bos_gate":     "09:12",
            "force_close":  "12:00",
        },
    }

    def __init__(self):
        self.symbol: Optional[str] = None
        self.params = DEFAULT_PARAMS.copy()
        self._state = StrategyState(
            symbol="", stage=0, direction=None, session=None,
            in_entry_window=False, bos_confirmed=False, invalidated=False,
            range_high=0.0, range_low=0.0,
            bias_candle_high=0.0, bias_candle_low=0.0,
            sl_level=0.0, tp_level=0.0,
            tp1_level=0.0, tp2_level=0.0, tp3_level=0.0,
            tp1_qty_pct=1/3, tp2_qty_pct=1/3, tp3_qty_pct=1/3,
            entry_price=None, atr14=0.0,
            strategy_name="DTR",
        )
        # Per-session state
        self._sess: dict[str, dict] = {}
        self._machines: dict[str, _SessionMachine] = {}
        self._bos_just_fired: Optional[tuple] = None  # (session, direction)
        self._last_bos_sl: float = 0.0
        self._last_bos_tp: float = 0.0

    def init(self, symbol: str, params: dict) -> None:
        self.symbol = symbol
        self.params = {**DEFAULT_PARAMS, **params}
        self._reset_sessions()
        logger.info(f"DTRv3 initialised for {symbol}")

    def _reset_sessions(self):
        for sess in ("2AM", "9AM"):
            self._sess[sess] = {
                "range_high": None,
                "range_low":  None,
                "in_range":   False,
                "in_break":   False,
                "invalidated": False,
                "brk_done_long":  False,
                "brk_done_short": False,
            }
            self._machines[f"{sess}_LONG"]  = _SessionMachine("LONG",  sess)
            self._machines[f"{sess}_SHORT"] = _SessionMachine("SHORT", sess)

    # ------------------------------------------------------------------

    def update(self, bars: list) -> None:
        if not bars or len(bars) < 16:
            return

        latest = bars[-1]
        prev   = bars[-2]
        atr14  = _atr(bars)

        # Parse bar timestamp
        ts_raw = latest.get("time") or latest.get("timestamp") or latest.get("t")
        if ts_raw is None:
            return
        if isinstance(ts_raw, (int, float)):
            bar_dt = datetime.utcfromtimestamp(ts_raw).replace(tzinfo=pytz.utc)
        else:
            bar_dt = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        now_ny = _ny_time(bar_dt)

        o = latest["open"]
        h = latest["high"]
        l = latest["low"]
        c = latest["close"]

        self._bos_just_fired = None

        for sess, cfg in self.SESSIONS.items():
            s = self._sess[sess]
            in_range = _in_window(now_ny, cfg["range_start"], cfg["range_end"])
            in_break = _in_window(now_ny, cfg["break_start"], cfg["break_end"])
            in_bos_gate = now_ny.time() >= dt_time(
                int(cfg["bos_gate"][:2]), int(cfg["bos_gate"][3:])
            )

            # Reset at range window open
            if in_range and not s["in_range"]:
                s["range_high"] = h
                s["range_low"]  = l
                s["in_range"]   = True
                s["in_break"]   = False
                s["invalidated"] = False
                s["brk_done_long"]  = False
                s["brk_done_short"] = False
                self._machines[f"{sess}_LONG"].reset()
                self._machines[f"{sess}_SHORT"].reset()

            # Extend range box
            if in_range and s["range_high"] is not None:
                s["range_high"] = max(s["range_high"], h)
                s["range_low"]  = min(s["range_low"],  l)

            s["in_range"] = in_range
            s["in_break"] = in_break

            rh = s["range_high"]
            rl = s["range_low"]
            if rh is None or rl is None:
                continue

            # Invalidation: both sides swept
            if in_break and not s["invalidated"]:
                if s["brk_done_long"]  and h >= rh:
                    s["invalidated"] = True
                if s["brk_done_short"] and l <= rl:
                    s["invalidated"] = True

            if s["invalidated"]:
                continue

            # Run LONG machine (triggered after low sweep)
            ml = self._machines[f"{sess}_LONG"]
            if not ml.pending and not s["brk_done_long"] and in_break and c < rl:
                s["brk_done_long"] = True
            fired_long = ml.process(
                latest, prev, atr14, rh, rl,
                in_range_broken=in_break and s["brk_done_long"],
                in_bos_gate=in_bos_gate,
                params=self.params
            )

            # Run SHORT machine (triggered after high sweep)
            ms = self._machines[f"{sess}_SHORT"]
            if not ms.pending and not s["brk_done_short"] and in_break and c > rh:
                s["brk_done_short"] = True
            fired_short = ms.process(
                latest, prev, atr14, rh, rl,
                in_range_broken=in_break and s["brk_done_short"],
                in_bos_gate=in_bos_gate,
                params=self.params
            )

            if fired_long and not fired_short:
                sl = (ml.bc_low or rl) - atr14 * self.params["slMult"]
                # Fallback to bc_low from before it was reset
                bc_l = self._get_bc_low_before_reset(f"{sess}_LONG") or rl
                sl = bc_l - atr14 * self.params["slMult"]
                tp = rh  # Range Target
                self._bos_just_fired = (sess, "LONG")
                self._last_bos_sl = sl
                self._last_bos_tp = tp
                logger.info(f"  BOS LONG {self.symbol} {sess} | SL={sl:.2f} TP={tp:.2f}")

            elif fired_short and not fired_long:
                bc_h = self._get_bc_high_before_reset(f"{sess}_SHORT") or rh
                sl = bc_h + atr14 * self.params["slMult"]
                tp = rl  # Range Target
                self._bos_just_fired = (sess, "SHORT")
                self._last_bos_sl = sl
                self._last_bos_tp = tp
                logger.info(f"  BOS SHORT {self.symbol} {sess} | SL={sl:.2f} TP={tp:.2f}")

        # Build public state
        sess_name, direction = self._bos_just_fired or (None, None)
        bos = self._bos_just_fired is not None

        # Determine active session context for the state
        active_sess = None
        for sess, cfg in self.SESSIONS.items():
            in_range = _in_window(now_ny, cfg["range_start"], cfg["range_end"])
            in_break = _in_window(now_ny, cfg["break_start"], cfg["break_end"])
            if in_range or in_break:
                active_sess = sess
                break

        # Find highest active stage across all machines for display
        max_stage = 0
        active_dir = None
        for key, mach in self._machines.items():
            if mach.stage > max_stage:
                max_stage = mach.stage
                active_dir = mach.direction

        if bos:
            max_stage = 4
            active_dir = direction

        # Range for active session
        rh_display = rl_display = 0.0
        bc_h_display = bc_l_display = 0.0
        if active_sess and self._sess[active_sess]["range_high"]:
            rh_display = self._sess[active_sess]["range_high"]
            rl_display = self._sess[active_sess]["range_low"]

        in_any_entry_window = any(
            _in_window(now_ny, cfg["break_start"], cfg["break_end"])
            for cfg in self.SESSIONS.values()
        )

        self._state = StrategyState(
            symbol=self.symbol,
            stage=max_stage,
            direction=active_dir,
            session=sess_name if bos else active_sess,
            in_entry_window=in_any_entry_window,
            bos_confirmed=bos,
            invalidated=any(self._sess[s]["invalidated"] for s in ("2AM", "9AM")),
            range_high=rh_display,
            range_low=rl_display,
            bias_candle_high=bc_h_display,
            bias_candle_low=bc_l_display,
            sl_level=self._last_bos_sl if bos else 0.0,
            tp_level=self._last_bos_tp if bos else 0.0,
            tp1_level=0.0,                                  # orchestrator computes after fill
            tp2_level=0.0,                                  # orchestrator computes after fill
            tp3_level=self._last_bos_tp if bos else 0.0,   # = range_high or range_low
            tp1_qty_pct=1/3,
            tp2_qty_pct=1/3,
            tp3_qty_pct=1/3,
            entry_price=None,
            atr14=atr14,
            strategy_name="DTR",
            market_conditions={
                "atr14": round(atr14, 4),
                "range_size": round(rh_display - rl_display, 4) if rh_display else 0,
                "time_ny": now_ny.strftime("%H:%M"),
                "day_of_week": now_ny.strftime("%A"),
                "session": active_sess,
            },
        )

    # SL/TP level helpers — store bc levels before machine resets
    def _get_bc_low_before_reset(self, key: str) -> Optional[float]:
        m = self._machines.get(key)
        return m.bc_low if m else None

    def _get_bc_high_before_reset(self, key: str) -> Optional[float]:
        m = self._machines.get(key)
        return m.bc_high if m else None

    def get_state(self) -> StrategyState:
        return self._state

    def get_params(self) -> dict:
        return self.params.copy()

    def set_params(self, new_params: dict) -> None:
        for key, val in new_params.items():
            if key in PARAM_BOUNDS:
                lo, hi = PARAM_BOUNDS[key]
                val = max(lo, min(hi, val))
            self.params[key] = val
        logger.info(f"DTRv3 {self.symbol} params updated: {self.params}")
