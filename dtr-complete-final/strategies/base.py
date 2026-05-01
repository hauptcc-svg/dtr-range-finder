"""
Strategy Plugin Interface
=========================
All trading strategies extend BaseStrategy and return StrategyState.
This contract is shared by the orchestrator, Claude brain, and Hermes brain.
"""

from dataclasses import dataclass, field
from typing import Optional
from abc import ABC, abstractmethod


@dataclass
class StrategyState:
    symbol: str
    stage: int                    # 0=idle, 1=swept, 2=bias_candle, 3=retest, 4=BOS_pending
    direction: Optional[str]      # 'LONG' | 'SHORT' | None
    session: Optional[str]        # '2AM' | '9AM' | None (DTR) or 'LONDON_NY' (XXX)
    in_entry_window: bool
    bos_confirmed: bool           # True when stage just reached 4 (fires entry next bar)
    invalidated: bool             # Both sides swept — no trade
    range_high: float
    range_low: float
    bias_candle_high: float
    bias_candle_low: float
    sl_level: float               # Initial SL from strategy logic
    tp_level: float               # TP3 (final target) — kept for backward compat
    tp1_level: float              # First partial exit level
    tp2_level: float              # Second partial exit level
    tp3_level: float              # Final target (= tp_level)
    tp1_qty_pct: float            # Fraction of position to close at TP1 (e.g. 0.33 or 0.50)
    tp2_qty_pct: float            # Fraction at TP2 (e.g. 0.33 or 0.30)
    tp3_qty_pct: float            # Remainder at TP3 (e.g. 0.34 or 0.20)
    entry_price: Optional[float]  # Filled when position is open
    atr14: float                  # Current ATR(14) value
    strategy_name: str = "DTR"    # "DTR" | "XXX"
    market_conditions: dict = field(default_factory=dict)


class BaseStrategy(ABC):
    """Interface every trading strategy must implement."""

    @abstractmethod
    def init(self, symbol: str, params: dict) -> None:
        """Called once on startup with symbol and initial parameters."""

    @abstractmethod
    def update(self, bars: list) -> None:
        """Called every tick/bar with list of OHLC dicts sorted oldest→newest.
        Each bar: {'open': f, 'high': f, 'low': f, 'close': f, 'time': str}
        """

    @abstractmethod
    def get_state(self) -> StrategyState:
        """Return current strategy state."""

    @abstractmethod
    def get_params(self) -> dict:
        """Return current tunable parameters."""

    @abstractmethod
    def set_params(self, params: dict) -> None:
        """Apply new parameters (from Claude or Hermes optimiser)."""
