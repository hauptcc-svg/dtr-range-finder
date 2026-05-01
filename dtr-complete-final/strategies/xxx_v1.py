"""
XXX v1 Strategy — ALMA Crossover Scalper
=========================================
Signal: ALMA(2, offset=0.85, sigma=5) crossover on 8-minute bars
aggregated from 1-minute bars.

Entry logic:
  LONG  — ALMA(close) crosses above ALMA(open) on the completed 8M bar,
           latest 1M close > EMA(144), bar is within London/NY session.
  SHORT — ALMA(close) crosses below ALMA(open) on the completed 8M bar,
           latest 1M close < EMA(144), bar is within London/NY session.

Session: 01:00–17:00 America/New_York (London open → NY close).

Risk (% from estimated entry — orchestrator recalculates after actual fill):
  SL  : 0.50% from entry  (stepped SL managed by orchestrator)
  TP1 : 1.00% from entry  → 50% of position
  TP2 : 1.50% from entry  → 30% of position
  TP3 : 2.00% from entry  → 20% of position

bos_confirmed is a ONE-SHOT flag: it is set True when a crossover passes all
filters, then reset to False at the start of the NEXT call to update().
The orchestrator must read the flag and act within the same bar cycle.
"""

import logging
import math
from datetime import datetime
from typing import Optional

import pytz

from .base import BaseStrategy, StrategyState

logger = logging.getLogger(__name__)

TZ_NY = pytz.timezone("America/New_York")

# ---------------------------------------------------------------------------
# Tunable defaults and safe AI bounds
# ---------------------------------------------------------------------------

DEFAULT_PARAMS_XXX: dict = {
    "htfMult":    8,
    "almaOffset": 0.85,
    "almaSigma":  5,
    "slPct":      0.005,
    "tp1Pct":     0.010,
    "tp2Pct":     0.015,
    "tp3Pct":     0.020,
    "emaPeriod":  144,
    "maxTrades":  4,
    "enableMon":  True,
    "enableTue":  True,
    "enableWed":  True,
    "enableThu":  True,
    "enableFri":  True,
}

PARAM_BOUNDS_XXX: dict = {
    "htfMult":    (4,      16),
    "almaOffset": (0.5,    0.95),
    "almaSigma":  (2,      10),
    "slPct":      (0.0025, 0.01),
    "tp1Pct":     (0.005,  0.02),
    "tp2Pct":     (0.01,   0.03),
    "tp3Pct":     (0.015,  0.04),
    "emaPeriod":  (50,     200),
    "maxTrades":  (2,      6),
}


# ---------------------------------------------------------------------------
# Pure helper functions
# ---------------------------------------------------------------------------

def _alma(values: list[float], length: int = 2, offset: float = 0.85,
          sigma: float = 5) -> float:
    """Arnaud Legoux Moving Average for a window of `length` bars."""
    if len(values) < length:
        return values[-1] if values else 0.0
    m = offset * (length - 1)
    s = length / sigma
    weights = [math.exp(-((i - m) ** 2) / (2 * s * s)) for i in range(length)]
    src = values[-length:]
    total_w = sum(weights)
    return sum(src[i] * weights[i] for i in range(length)) / total_w if total_w else 0.0


def _ema(values: list[float], period: int) -> float:
    """Exponential moving average over entire values list."""
    if not values:
        return 0.0
    k = 2.0 / (period + 1)
    ema = values[0]
    for v in values[1:]:
        ema = v * k + ema * (1 - k)
    return ema


def _aggregate_htf(bars_1m: list, htf_mult: int = 8) -> list:
    """
    Aggregate a list of 1-minute OHLC bars into `htf_mult`-minute bars.
    Each bar dict must have 'open', 'high', 'low', 'close' and one of
    'time' | 'timestamp' | 't' (epoch seconds or ISO string).
    Returns bars sorted oldest→newest.
    """
    agg: dict = {}
    for bar in bars_1m:
        ts_raw = bar.get("time") or bar.get("timestamp") or bar.get("t")
        if ts_raw is None:
            continue
        if isinstance(ts_raw, (int, float)):
            ts = datetime.utcfromtimestamp(ts_raw)
        else:
            ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        minute_bucket = (ts.minute // htf_mult) * htf_mult
        key = ts.replace(minute=minute_bucket, second=0, microsecond=0)
        if key not in agg:
            agg[key] = {
                "time":  key.isoformat(),
                "open":  bar["open"],
                "high":  bar["high"],
                "low":   bar["low"],
                "close": bar["close"],
            }
        else:
            agg[key]["high"]  = max(agg[key]["high"], bar["high"])
            agg[key]["low"]   = min(agg[key]["low"],  bar["low"])
            agg[key]["close"] = bar["close"]
    return sorted(agg.values(), key=lambda x: x["time"])


def _in_london_ny_session(bar_time) -> bool:
    """
    Return True when bar_time falls within 01:00–17:00 America/New_York
    (covers London open through NY afternoon close).
    """
    if isinstance(bar_time, (int, float)):
        dt = datetime.utcfromtimestamp(bar_time).replace(tzinfo=pytz.utc)
    else:
        dt = datetime.fromisoformat(str(bar_time).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=pytz.utc)
    ny = dt.astimezone(TZ_NY)
    h = ny.hour + ny.minute / 60.0
    return 1.0 <= h < 17.0


def _day_enabled(bar_time, params: dict) -> bool:
    """Return True if the day-of-week filter passes for this bar's date."""
    if isinstance(bar_time, (int, float)):
        dt = datetime.utcfromtimestamp(bar_time).replace(tzinfo=pytz.utc)
    else:
        dt = datetime.fromisoformat(str(bar_time).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=pytz.utc)
    ny = dt.astimezone(TZ_NY)
    dow = ny.weekday()  # 0=Mon … 4=Fri
    keys = ["enableMon", "enableTue", "enableWed", "enableThu", "enableFri"]
    if dow > 4:
        return False
    return bool(params.get(keys[dow], True))


# ---------------------------------------------------------------------------
# Strategy class
# ---------------------------------------------------------------------------

class XXXv1Strategy(BaseStrategy):
    """
    XXX v1 — ALMA crossover on 8M bars with EMA(144) + session filter.
    Extends BaseStrategy; designed to run alongside DTRv3Strategy inside
    the same orchestrator loop.
    """

    def __init__(self) -> None:
        self.symbol: Optional[str] = None
        self.params: dict = DEFAULT_PARAMS_XXX.copy()

        # One-shot flag: True for exactly one update() cycle
        self._signal_pending: bool = False
        self._pending_direction: Optional[str] = None
        self._pending_sl: float = 0.0
        self._pending_tp1: float = 0.0
        self._pending_tp2: float = 0.0
        self._pending_tp3: float = 0.0
        self._pending_close: float = 0.0  # proxy entry used for level calc

        # Persistent state used across update() calls
        self._prev_alma_close: Optional[float] = None
        self._prev_alma_open:  Optional[float] = None

        self._state: StrategyState = self._blank_state()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _blank_state(self) -> StrategyState:
        return StrategyState(
            symbol=self.symbol or "",
            stage=0,
            direction=None,
            session=None,
            in_entry_window=False,
            bos_confirmed=False,
            invalidated=False,
            range_high=0.0,
            range_low=0.0,
            bias_candle_high=0.0,
            bias_candle_low=0.0,
            sl_level=0.0,
            tp_level=0.0,
            tp1_level=0.0,
            tp2_level=0.0,
            tp3_level=0.0,
            tp1_qty_pct=0.50,
            tp2_qty_pct=0.30,
            tp3_qty_pct=0.20,
            entry_price=None,
            atr14=0.0,
            strategy_name="XXX",
            market_conditions={},
        )

    def _compute_levels(self, direction: str, ref_price: float) -> tuple[float, float, float, float]:
        """
        Compute SL, TP1, TP2, TP3 from ref_price (proxy entry = latest 1M close).
        Returns (sl, tp1, tp2, tp3).
        Orchestrator recalculates tp1/tp2/tp3 after actual fill; sl is also
        recalculated from actual fill, but we store the estimate here so the
        orchestrator has a sensible default before the fill response arrives.
        """
        sl_pct  = self.params["slPct"]
        tp1_pct = self.params["tp1Pct"]
        tp2_pct = self.params["tp2Pct"]
        tp3_pct = self.params["tp3Pct"]

        if direction == "LONG":
            sl  = ref_price * (1.0 - sl_pct)
            tp1 = ref_price * (1.0 + tp1_pct)
            tp2 = ref_price * (1.0 + tp2_pct)
            tp3 = ref_price * (1.0 + tp3_pct)
        else:  # SHORT
            sl  = ref_price * (1.0 + sl_pct)
            tp1 = ref_price * (1.0 - tp1_pct)
            tp2 = ref_price * (1.0 - tp2_pct)
            tp3 = ref_price * (1.0 - tp3_pct)

        return sl, tp1, tp2, tp3

    # ------------------------------------------------------------------
    # BaseStrategy interface
    # ------------------------------------------------------------------

    def init(self, symbol: str, params: dict) -> None:
        self.symbol = symbol
        self.params = {**DEFAULT_PARAMS_XXX, **params}
        self._prev_alma_close = None
        self._prev_alma_open  = None
        self._signal_pending  = False
        self._state = self._blank_state()
        logger.info(f"XXXv1 initialised for {symbol}")

    def update(self, bars: list) -> None:
        """
        Called every 1M bar.  bars is sorted oldest→newest, each element:
        {'open': f, 'high': f, 'low': f, 'close': f, 'time': str|epoch}
        """
        # Consume any pending signal from the previous cycle first
        # (bos_confirmed was True last call — reset it now)
        prev_bos = self._signal_pending
        self._signal_pending = False

        if not bars or len(bars) < max(self.params["emaPeriod"] + 1,
                                       self.params["htfMult"] * 3 + 1):
            self._state = self._blank_state()
            return

        latest_1m = bars[-1]
        latest_close = latest_1m["close"]
        bar_time = (latest_1m.get("time") or latest_1m.get("timestamp")
                    or latest_1m.get("t"))

        # --- Session filter ---
        in_session = _in_london_ny_session(bar_time)
        session_label: Optional[str] = "LONDON_NY" if in_session else None

        # --- Day-of-week filter ---
        day_ok = _day_enabled(bar_time, self.params)

        # --- EMA(144) on 1M closes ---
        closes_1m = [b["close"] for b in bars]
        ema144 = _ema(closes_1m, self.params["emaPeriod"])

        # --- Aggregate 1M → 8M ---
        htf_bars = _aggregate_htf(bars, htf_mult=self.params["htfMult"])

        # Need at least 3 completed 8M bars to get a reliable crossover
        # (current bar may still be forming, so use [-3], [-2] as completed)
        if len(htf_bars) < 3:
            self._state = self._blank_state()
            return

        # Use the two most recently completed HTF bars for crossover detection.
        # htf_bars[-1] is the bar currently forming; htf_bars[-2] is the last
        # completed bar; htf_bars[-3] is the one before that.
        prev_htf = htf_bars[-3]
        curr_htf = htf_bars[-2]

        # Build ALMA inputs from a window of HTF bars for each series
        htf_closes = [b["close"] for b in htf_bars[:-1]]  # exclude forming bar
        htf_opens  = [b["open"]  for b in htf_bars[:-1]]

        alma_close_curr = _alma(htf_closes, length=self.params["htfMult"] // 4 or 2,
                                offset=self.params["almaOffset"],
                                sigma=self.params["almaSigma"])
        alma_open_curr  = _alma(htf_opens,  length=self.params["htfMult"] // 4 or 2,
                                offset=self.params["almaOffset"],
                                sigma=self.params["almaSigma"])

        # For crossover we need the previous ALMA values (one bar back)
        alma_close_prev: float
        alma_open_prev: float
        if self._prev_alma_close is not None and self._prev_alma_open is not None:
            alma_close_prev = self._prev_alma_close
            alma_open_prev  = self._prev_alma_open
        else:
            # Bootstrap: compute from the bar before curr
            htf_closes_prev = [b["close"] for b in htf_bars[:-2]]
            htf_opens_prev  = [b["open"]  for b in htf_bars[:-2]]
            alma_close_prev = _alma(htf_closes_prev,
                                    length=self.params["htfMult"] // 4 or 2,
                                    offset=self.params["almaOffset"],
                                    sigma=self.params["almaSigma"])
            alma_open_prev  = _alma(htf_opens_prev,
                                    length=self.params["htfMult"] // 4 or 2,
                                    offset=self.params["almaOffset"],
                                    sigma=self.params["almaSigma"])

        # Persist for next call
        self._prev_alma_close = alma_close_curr
        self._prev_alma_open  = alma_open_curr

        # --- Crossover detection ---
        # LONG : prev close <= prev open  AND  curr close > curr open
        # SHORT: prev close >= prev open  AND  curr close < curr open
        long_cross  = (alma_close_prev <= alma_open_prev
                       and alma_close_curr > alma_open_curr)
        short_cross = (alma_close_prev >= alma_open_prev
                       and alma_close_curr < alma_open_curr)

        # --- Filter: session + day-of-week + EMA trend ---
        new_signal_direction: Optional[str] = None

        if long_cross and in_session and day_ok and latest_close > ema144:
            new_signal_direction = "LONG"
        elif short_cross and in_session and day_ok and latest_close < ema144:
            new_signal_direction = "SHORT"

        # --- Compute levels (proxy entry = latest 1M close) ---
        bos_confirmed = False
        sl = tp1 = tp2 = tp3 = 0.0
        direction: Optional[str] = None

        if new_signal_direction is not None:
            direction = new_signal_direction
            sl, tp1, tp2, tp3 = self._compute_levels(direction, latest_close)
            bos_confirmed = True
            self._signal_pending = True
            self._pending_direction = direction
            self._pending_sl  = sl
            self._pending_tp1 = tp1
            self._pending_tp2 = tp2
            self._pending_tp3 = tp3
            self._pending_close = latest_close
            logger.info(
                f"XXXv1 {self.symbol} {direction} signal | "
                f"entry~{latest_close:.4f} SL={sl:.4f} "
                f"TP1={tp1:.4f} TP2={tp2:.4f} TP3={tp3:.4f}"
            )

        # --- Build public state ---
        self._state = StrategyState(
            symbol=self.symbol or "",
            stage=1 if bos_confirmed else 0,
            direction=direction,
            session=session_label,
            in_entry_window=in_session,
            bos_confirmed=bos_confirmed,
            invalidated=False,
            range_high=0.0,
            range_low=0.0,
            bias_candle_high=0.0,   # not used by XXX
            bias_candle_low=0.0,    # not used by XXX
            sl_level=sl if bos_confirmed else 0.0,
            tp_level=tp3 if bos_confirmed else 0.0,
            tp1_level=tp1 if bos_confirmed else 0.0,
            tp2_level=tp2 if bos_confirmed else 0.0,
            tp3_level=tp3 if bos_confirmed else 0.0,
            tp1_qty_pct=0.50,
            tp2_qty_pct=0.30,
            tp3_qty_pct=0.20,
            entry_price=None,
            atr14=0.0,
            strategy_name="XXX",
            market_conditions={
                "ema144":          round(ema144, 4),
                "alma_close_curr": round(alma_close_curr, 4),
                "alma_open_curr":  round(alma_open_curr, 4),
                "in_session":      in_session,
                "latest_close":    round(latest_close, 4),
                "htf_bars_count":  len(htf_bars),
            },
        )

    def get_state(self) -> StrategyState:
        return self._state

    def get_params(self) -> dict:
        return self.params.copy()

    def set_params(self, new_params: dict) -> None:
        for key, val in new_params.items():
            if key in PARAM_BOUNDS_XXX:
                lo, hi = PARAM_BOUNDS_XXX[key]
                val = max(lo, min(hi, val))
            self.params[key] = val
        # Reset cached ALMA values so they are recomputed cleanly
        self._prev_alma_close = None
        self._prev_alma_open  = None
        logger.info(f"XXXv1 {self.symbol} params updated: {self.params}")
