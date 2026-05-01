"""
Drawdown Monitor
================
Watches daily P&L and rolling win rate. Fires emergency halt + Telegram alert
when safety thresholds are breached.

Thresholds:
  • Daily loss > lossLimit ($200 default) → HALT
  • Win rate < 40% over last 10 completed trades → HALT
  • 3 consecutive losing days → ESCALATE (Telegram escalation message)
  • Daily profit >= profitTarget ($1,400 default) → HALT (lock in the day)

Resume: Craig sets mode via dashboard or /resume Telegram command.
"""

import logging
from collections import deque
from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from market_data_orchestrator import MarketDataOrchestrator

logger = logging.getLogger(__name__)

DEFAULT_LOSS_LIMIT      = 200.0   # USD daily loss limit
DEFAULT_PROFIT_TARGET   = 1400.0  # USD daily profit target
WIN_RATE_WINDOW         = 10      # trades for rolling win rate check
WIN_RATE_THRESHOLD      = 0.40    # halt if below this
CONSECUTIVE_LOSS_DAYS   = 3       # days before escalation


class DrawdownMonitor:
    """
    Passive monitor called on every trade close.
    Calls orchestrator.emergency_halt() when a threshold is breached.
    Does NOT execute trades — read-only on the orchestrator state.
    """

    def __init__(
        self,
        loss_limit:    float = DEFAULT_LOSS_LIMIT,
        profit_target: float = DEFAULT_PROFIT_TARGET,
    ) -> None:
        self.loss_limit    = loss_limit
        self.profit_target = profit_target

        # Rolling trade outcomes (most recent WIN_RATE_WINDOW trades)
        self._recent_outcomes: deque = deque(maxlen=WIN_RATE_WINDOW)

        # Day-over-day tracking for consecutive loss detection
        self._daily_results:   list  = []     # list of (date, pnl)
        self._checked_date: Optional[date] = None

        # Avoid spamming Telegram on repeated checks
        self._last_halt_reason: str = ""

    # ─────────────────────────────────────────────────────────────────────────
    # Called by orchestrator after every trade closes
    # ─────────────────────────────────────────────────────────────────────────

    async def on_trade_closed(
        self,
        trade:        dict,
        daily_pnl:    float,
        orchestrator: "MarketDataOrchestrator",
    ) -> None:
        """
        Evaluate all breach conditions after a trade closes.
        Calls orchestrator.emergency_halt() if any threshold is exceeded.
        """
        outcome = trade.get("outcome", "LOSS")
        self._recent_outcomes.append(outcome)

        # ── 1. Daily loss limit ────────────────────────────────────────────
        if daily_pnl <= -abs(self.loss_limit):
            reason = f"Daily loss limit hit: ${daily_pnl:.2f} ≤ -${self.loss_limit:.0f}"
            await self._halt(orchestrator, reason, trade, daily_pnl)
            return

        # ── 2. Daily profit target (lock in the day) ───────────────────────
        if daily_pnl >= self.profit_target:
            reason = f"Daily profit target reached: ${daily_pnl:.2f} ≥ ${self.profit_target:.0f}"
            await self._halt(orchestrator, reason, trade, daily_pnl)
            return

        # ── 3. Rolling win rate ────────────────────────────────────────────
        if len(self._recent_outcomes) >= WIN_RATE_WINDOW:
            wins    = sum(1 for o in self._recent_outcomes if o == "WIN")
            win_rate = wins / WIN_RATE_WINDOW
            if win_rate < WIN_RATE_THRESHOLD:
                reason = (
                    f"Win rate dropped to {win_rate:.0%} over last {WIN_RATE_WINDOW} trades "
                    f"(threshold: {WIN_RATE_THRESHOLD:.0%})"
                )
                await self._halt(orchestrator, reason, trade, daily_pnl)
                return

    async def on_day_end(
        self,
        daily_pnl:    float,
        orchestrator: "MarketDataOrchestrator",
    ) -> None:
        """
        Called at end of each trading day. Checks consecutive losing days.
        """
        today = date.today()
        if self._checked_date == today:
            return
        self._checked_date = today

        self._daily_results.append((today, daily_pnl))

        # Keep only the last N+1 days
        if len(self._daily_results) > CONSECUTIVE_LOSS_DAYS + 1:
            self._daily_results = self._daily_results[-(CONSECUTIVE_LOSS_DAYS + 1):]

        # Check last N days all negative
        if len(self._daily_results) >= CONSECUTIVE_LOSS_DAYS:
            last_n = self._daily_results[-CONSECUTIVE_LOSS_DAYS:]
            if all(pnl < 0 for _, pnl in last_n):
                total = sum(pnl for _, pnl in last_n)
                reason = (
                    f"{CONSECUTIVE_LOSS_DAYS} consecutive losing days detected. "
                    f"Total loss: ${total:.2f}"
                )
                await self._escalate(orchestrator, reason, daily_pnl)

    # ─────────────────────────────────────────────────────────────────────────
    # State inspection
    # ─────────────────────────────────────────────────────────────────────────

    def current_win_rate(self) -> Optional[float]:
        """Return rolling win rate over last N trades, or None if insufficient data."""
        if len(self._recent_outcomes) < WIN_RATE_WINDOW:
            return None
        wins = sum(1 for o in self._recent_outcomes if o == "WIN")
        return wins / WIN_RATE_WINDOW

    def status(self) -> dict:
        wr = self.current_win_rate()
        return {
            "loss_limit":       self.loss_limit,
            "profit_target":    self.profit_target,
            "win_rate_window":  WIN_RATE_WINDOW,
            "current_win_rate": round(wr, 4) if wr is not None else None,
            "recent_outcomes":  list(self._recent_outcomes),
            "last_halt_reason": self._last_halt_reason,
            "daily_results":    [(str(d), p) for d, p in self._daily_results],
        }

    # ─────────────────────────────────────────────────────────────────────────
    # Internal
    # ─────────────────────────────────────────────────────────────────────────

    async def _halt(
        self,
        orchestrator: "MarketDataOrchestrator",
        reason:       str,
        trade:        dict,
        daily_pnl:    float,
    ) -> None:
        """Halt trading and send Telegram alert."""
        if self._last_halt_reason == reason:
            return   # don't spam the same halt
        self._last_halt_reason = reason

        orchestrator.emergency_halt(reason)

        logger.warning(f"🚨 DRAWDOWN HALT: {reason}")

        msg = (
            f"🚨 *DTR TRADING HALTED*\n"
            f"─────────────────────\n"
            f"*Reason:* {reason}\n"
            f"*Daily P&L:* ${daily_pnl:+.2f}\n"
            f"*Last trade:* {trade.get('symbol')} {trade.get('direction')} → "
            f"{trade.get('outcome')} (${trade.get('pnl', 0):+.2f})\n"
            f"─────────────────────\n"
            f"Resume trading via the dashboard or /resume command."
        )
        await _send_telegram(msg, orchestrator)

    async def _escalate(
        self,
        orchestrator: "MarketDataOrchestrator",
        reason:       str,
        daily_pnl:    float,
    ) -> None:
        """Escalation alert for multi-day losing streak (does not halt — just warns)."""
        logger.warning(f"⚠️  ESCALATION: {reason}")

        msg = (
            f"⚠️ *DTR ESCALATION ALERT*\n"
            f"─────────────────────\n"
            f"*{reason}*\n"
            f"Today's P&L: ${daily_pnl:+.2f}\n"
            f"─────────────────────\n"
            f"Trading continues but review strategy parameters.\n"
            f"Hermes analysis has been triggered."
        )
        await _send_telegram(msg, orchestrator)


# ─────────────────────────────────────────────────────────────────────────────
# Telegram helper (standalone so drawdown_monitor has no import dep on notifier)
# ─────────────────────────────────────────────────────────────────────────────

async def _send_telegram(text: str, orchestrator: "MarketDataOrchestrator") -> None:
    """Send a Telegram message via Hermes brain if available."""
    try:
        hermes = getattr(orchestrator, "_hermes_brain", None)
        if hermes:
            await hermes._send_telegram(text)
    except Exception as exc:
        logger.error(f"❌ Drawdown Telegram error: {exc}")
