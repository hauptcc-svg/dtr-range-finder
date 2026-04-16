"""
Position Limiter & Daily Limit Manager
======================================
Enforces:
1. One position per symbol (no averaging down)
2. No re-entry while in position
3. Daily loss limit: -$200 (hard stop, close all)
4. Daily profit limit: +$1,400 (hard stop, close all)
5. Auto-lock trading when limits hit
6. Track daily P&L in real-time
"""

import logging
from datetime import datetime, date
from typing import Dict, Any, Optional, List
from enum import Enum

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# DAILY LIMIT ENUMS
# ═══════════════════════════════════════════════════════════════════════════

class DailyLimitStatus(Enum):
    ACTIVE = "active"
    LOSS_LIMIT_HIT = "loss_limit_hit"
    PROFIT_LIMIT_HIT = "profit_limit_hit"
    LOCKED = "locked"

# ═══════════════════════════════════════════════════════════════════════════
# POSITION LIMITER
# ═══════════════════════════════════════════════════════════════════════════

class PositionLimiter:
    """
    Enforces position rules:
    - One position per symbol only
    - No averaging down
    - No adding to existing positions
    """
    
    def __init__(self):
        self.positions = {}  # {symbol: position_data}
        self.max_positions_per_symbol = 1
    
    def can_enter_position(self, symbol: str, side: str) -> tuple[bool, str]:
        """
        Check if we can enter a new position
        
        Returns:
            (allowed: bool, reason: str)
        """
        
        # Check if already in position for this symbol
        if symbol in self.positions:
            existing = self.positions[symbol]
            return False, f"Already in {existing['side']} position for {symbol}, cannot re-enter"
        
        # OK to enter
        return True, "Position allowed"
    
    def add_position(
        self,
        symbol: str,
        side: str,
        entry_price: float,
        quantity: int,
        order_id: str
    ) -> bool:
        """Record a new position"""
        
        can_enter, reason = self.can_enter_position(symbol, side)
        
        if not can_enter:
            logger.warning(f"Cannot enter {symbol}: {reason}")
            return False
        
        self.positions[symbol] = {
            'symbol': symbol,
            'side': side,
            'entry_price': entry_price,
            'quantity': quantity,
            'order_id': order_id,
            'entry_time': datetime.now().isoformat(),
            'unrealized_pnl': 0
        }
        
        logger.info(f"""
╔════════════════════════════════════════╗
║ ✓ POSITION OPENED                      ║
╠════════════════════════════════════════╣
║ Symbol: {symbol}
║ Side: {side}
║ Entry: {entry_price}
║ Qty: {quantity}
║ Time: {datetime.now().strftime('%H:%M:%S')}
╚════════════════════════════════════════╝
        """)
        
        return True
    
    def remove_position(self, symbol: str) -> bool:
        """Close a position"""
        
        if symbol not in self.positions:
            logger.warning(f"No position for {symbol} to close")
            return False
        
        position = self.positions[symbol]
        
        logger.info(f"""
╔════════════════════════════════════════╗
║ ✓ POSITION CLOSED                      ║
╠════════════════════════════════════════╣
║ Symbol: {symbol}
║ Side: {position['side']}
║ P&L: {position['unrealized_pnl']:.2f}
║ Time: {datetime.now().strftime('%H:%M:%S')}
╚════════════════════════════════════════╝
        """)
        
        del self.positions[symbol]
        return True
    
    def update_unrealized_pnl(self, symbol: str, current_price: float):
        """Update P&L for position"""
        
        if symbol not in self.positions:
            return
        
        position = self.positions[symbol]
        entry = position['entry_price']
        qty = position['quantity']
        
        if position['side'] == 'BUY':
            pnl = (current_price - entry) * qty * 20  # $20 per point
        else:  # SELL
            pnl = (entry - current_price) * qty * 20
        
        position['unrealized_pnl'] = pnl
    
    def get_position(self, symbol: str) -> Optional[Dict]:
        """Get position data"""
        return self.positions.get(symbol)
    
    def get_all_positions(self) -> Dict[str, Dict]:
        """Get all positions"""
        return self.positions.copy()
    
    def position_exists(self, symbol: str) -> bool:
        """Check if position exists"""
        return symbol in self.positions


# ═══════════════════════════════════════════════════════════════════════════
# DAILY LIMIT MANAGER
# ═══════════════════════════════════════════════════════════════════════════

class DailyLimitManager:
    """
    Manages daily P&L limits
    
    Hard stops:
    - Loss limit: -$200 (close all positions, lock trading)
    - Profit limit: +$1,400 (close all positions, lock trading)
    """
    
    def __init__(self):
        self.loss_limit = -200.00
        self.profit_limit = 1400.00
        
        self.reset_daily()
    
    def reset_daily(self):
        """Reset for new trading day"""
        
        self.current_date = date.today()
        self.realized_pnl = 0.0
        self.unrealized_pnl = 0.0
        self.status = DailyLimitStatus.ACTIVE
        self.limit_hit_time = None
        self.limit_hit_reason = None
        
        logger.info(f"""
╔════════════════════════════════════════╗
║ 📅 DAILY LIMITS RESET                  ║
╠════════════════════════════════════════╣
║ Date: {self.current_date}
║ Loss Limit: ${self.loss_limit}
║ Profit Limit: ${self.profit_limit}
║ Status: ACTIVE
╚════════════════════════════════════════╝
        """)
    
    def add_realized_pnl(self, pnl: float):
        """Add a closed trade's P&L"""
        self.realized_pnl += pnl
    
    def set_unrealized_pnl(self, pnl: float):
        """Update unrealized P&L"""
        self.unrealized_pnl = pnl
    
    def get_total_pnl(self) -> float:
        """Get total daily P&L (realized + unrealized)"""
        return self.realized_pnl + self.unrealized_pnl
    
    def check_daily_limits(self) -> tuple[DailyLimitStatus, Optional[str]]:
        """
        Check if daily limits have been hit
        
        Returns:
            (status: DailyLimitStatus, reason: str or None)
        """
        
        total = self.get_total_pnl()
        
        # Check loss limit
        if total <= self.loss_limit:
            self.status = DailyLimitStatus.LOSS_LIMIT_HIT
            self.limit_hit_time = datetime.now().isoformat()
            self.limit_hit_reason = f"Daily loss limit hit: ${total:.2f}"
            
            logger.error(f"""
╔════════════════════════════════════════╗
║ 🚫 DAILY LOSS LIMIT HIT                ║
╠════════════════════════════════════════╣
║ P&L: ${total:.2f}
║ Limit: ${self.loss_limit:.2f}
║ Action: CLOSE ALL, LOCK TRADING
║ Time: {datetime.now().strftime('%H:%M:%S')}
╚════════════════════════════════════════╝
            """)
            
            return self.status, self.limit_hit_reason
        
        # Check profit limit
        if total >= self.profit_limit:
            self.status = DailyLimitStatus.PROFIT_LIMIT_HIT
            self.limit_hit_time = datetime.now().isoformat()
            self.limit_hit_reason = f"Daily profit limit hit: ${total:.2f}"
            
            logger.warning(f"""
╔════════════════════════════════════════╗
║ 💰 DAILY PROFIT LIMIT HIT              ║
╠════════════════════════════════════════╣
║ P&L: ${total:.2f}
║ Limit: ${self.profit_limit:.2f}
║ Action: CLOSE ALL, LOCK TRADING
║ Time: {datetime.now().strftime('%H:%M:%S')}
╚════════════════════════════════════════╝
            """)
            
            return self.status, self.limit_hit_reason
        
        # All good
        return DailyLimitStatus.ACTIVE, None
    
    def is_trading_locked(self) -> bool:
        """Check if trading is locked due to daily limits"""
        return self.status != DailyLimitStatus.ACTIVE
    
    def get_status(self) -> Dict[str, Any]:
        """Get daily limit status"""
        
        total = self.get_total_pnl()
        
        return {
            'date': self.current_date.isoformat(),
            'realized_pnl': self.realized_pnl,
            'unrealized_pnl': self.unrealized_pnl,
            'total_pnl': total,
            'loss_limit': self.loss_limit,
            'profit_limit': self.profit_limit,
            'status': self.status.value,
            'is_locked': self.is_trading_locked(),
            'limit_hit_time': self.limit_hit_time,
            'limit_hit_reason': self.limit_hit_reason,
            'remaining_loss_buffer': self.loss_limit - total,  # How much more can lose
            'remaining_profit_buffer': self.profit_limit - total  # How much more can gain
        }


# ═══════════════════════════════════════════════════════════════════════════
# INTEGRATED POSITION & LIMIT MANAGER
# ═══════════════════════════════════════════════════════════════════════════

class PositionAndLimitManager:
    """
    Unified manager combining:
    1. Position rules (one per symbol)
    2. Daily P&L limits (hard stops)
    3. Trading lock when limits hit
    """
    
    def __init__(self, notifier=None):
        self.position_limiter = PositionLimiter()
        self.daily_limits = DailyLimitManager()
        self.notifier = notifier
    
    async def check_can_trade(self) -> tuple[bool, str]:
        """
        Master check: Can we trade right now?
        
        Returns:
            (can_trade: bool, reason: str)
        """
        
        # Check if daily limits locked
        status, reason = self.daily_limits.check_daily_limits()
        
        if self.daily_limits.is_trading_locked():
            message = f"Trading locked: {reason}"
            logger.error(message)
            
            if self.notifier:
                await self.notifier.send_message(
                    f"<b>🚫 TRADING LOCKED</b>\n\n{reason}"
                )
            
            return False, message
        
        return True, "Trading allowed"
    
    async def can_enter_position(self, symbol: str, side: str) -> tuple[bool, str]:
        """
        Check if we can enter a specific position
        
        Checks:
        1. Trading not locked
        2. Not already in position for symbol
        3. Daily limits allow
        """
        
        # First check if trading allowed
        can_trade, reason = await self.check_can_trade()
        if not can_trade:
            return False, reason
        
        # Check position limits
        can_enter, reason = self.position_limiter.can_enter_position(symbol, side)
        if not can_enter:
            return False, reason
        
        return True, "Position entry allowed"
    
    async def enter_position(
        self,
        symbol: str,
        side: str,
        entry_price: float,
        quantity: int,
        order_id: str
    ) -> bool:
        """Enter a new position (after all checks)"""
        
        return self.position_limiter.add_position(
            symbol, side, entry_price, quantity, order_id
        )
    
    async def exit_position(self, symbol: str, exit_price: float, pnl: float) -> bool:
        """Exit a position and record realized P&L"""
        
        result = self.position_limiter.remove_position(symbol)
        
        if result:
            # Add to realized P&L
            self.daily_limits.add_realized_pnl(pnl)
            
            # Check if limits hit
            status, reason = self.daily_limits.check_daily_limits()
            
            if self.daily_limits.is_trading_locked():
                if self.notifier:
                    await self.notifier.send_message(
                        f"<b>⏹️ DAILY LIMIT HIT</b>\n\n{reason}\n\n"
                        f"All positions closed\n"
                        f"Trading locked until tomorrow"
                    )
        
        return result
    
    async def close_all_positions(self, reason: str = "Daily limit hit"):
        """Force close all positions (used when limit hit)"""
        
        positions = self.position_limiter.get_all_positions()
        
        for symbol, position in positions.items():
            self.position_limiter.remove_position(symbol)
        
        logger.warning(f"All positions closed: {reason}")
        
        if self.notifier:
            await self.notifier.send_message(
                f"<b>🚫 ALL POSITIONS CLOSED</b>\n\n{reason}"
            )
    
    def update_unrealized_pnl(self, symbol: str, current_price: float):
        """Update unrealized P&L"""
        self.position_limiter.update_unrealized_pnl(symbol, current_price)
        
        # Update daily limits with total unrealized
        total_unrealized = sum(
            p['unrealized_pnl'] 
            for p in self.position_limiter.get_all_positions().values()
        )
        self.daily_limits.set_unrealized_pnl(total_unrealized)
    
    def get_status(self) -> Dict[str, Any]:
        """Get complete status"""
        
        return {
            'positions': self.position_limiter.get_all_positions(),
            'daily_limits': self.daily_limits.get_status(),
            'trading_allowed': not self.daily_limits.is_trading_locked(),
            'timestamp': datetime.now().isoformat()
        }
    
    def get_summary(self) -> Dict[str, Any]:
        """Get summary for dashboard"""
        
        positions = self.position_limiter.get_all_positions()
        daily = self.daily_limits.get_status()
        
        return {
            'open_positions': len(positions),
            'daily_pnl': daily['total_pnl'],
            'realized': daily['realized_pnl'],
            'unrealized': daily['unrealized_pnl'],
            'status': daily['status'],
            'trading_locked': daily['is_locked'],
            'loss_buffer': daily['remaining_loss_buffer'],
            'profit_buffer': daily['remaining_profit_buffer']
        }


# ═══════════════════════════════════════════════════════════════════════════
# USAGE EXAMPLE
# ═══════════════════════════════════════════════════════════════════════════

async def example_usage():
    """Example of position limiter in action"""
    
    manager = PositionAndLimitManager()
    
    print("\n" + "="*80)
    print("EXAMPLE 1: Enter Position")
    print("="*80)
    
    # Try to enter position
    can_enter, reason = await manager.can_enter_position('MNQM26', 'BUY')
    print(f"Can enter MNQM26 BUY? {can_enter} - {reason}")
    
    if can_enter:
        await manager.enter_position('MNQM26', 'BUY', 26450.00, 3, 'ORDER_001')
        print("✓ Position opened")
    
    # ─────────────────────────────────────────────────────────────────────
    
    print("\n" + "="*80)
    print("EXAMPLE 2: Try to Re-enter (Should Fail)")
    print("="*80)
    
    # Try to enter again (should fail)
    can_enter, reason = await manager.can_enter_position('MNQM26', 'SELL')
    print(f"Can enter MNQM26 SELL? {can_enter} - {reason}")
    # Output: False - Already in BUY position for MNQM26
    
    # ─────────────────────────────────────────────────────────────────────
    
    print("\n" + "="*80)
    print("EXAMPLE 3: Exit Position (Small Loss)")
    print("="*80)
    
    # Exit with loss
    await manager.exit_position('MNQM26', 26440.00, -60.00)
    print("✓ Position closed, realized P&L: -$60")
    print(f"Daily P&L: ${manager.daily_limits.get_total_pnl():.2f}")
    
    # ─────────────────────────────────────────────────────────────────────
    
    print("\n" + "="*80)
    print("EXAMPLE 4: Large Loss - Hit Daily Limit")
    print("="*80)
    
    # Simulate hitting loss limit
    manager.daily_limits.add_realized_pnl(-150.00)  # More losses
    print(f"Added losses, daily P&L: ${manager.daily_limits.get_total_pnl():.2f}")
    
    status, reason = manager.daily_limits.check_daily_limits()
    print(f"Status: {status.value}")
    print(f"Reason: {reason}")
    print(f"Trading locked: {manager.daily_limits.is_trading_locked()}")
    # Output: Trading locked: True (total -$210 < limit -$200)
    
    # ─────────────────────────────────────────────────────────────────────
    
    print("\n" + "="*80)
    print("EXAMPLE 5: Try to Trade When Locked")
    print("="*80)
    
    can_trade, reason = await manager.check_can_trade()
    print(f"Can trade? {can_trade}")
    print(f"Reason: {reason}")
    # Output: Trading locked: Daily loss limit hit
    
    # ─────────────────────────────────────────────────────────────────────
    
    print("\n" + "="*80)
    print("STATUS SUMMARY")
    print("="*80)
    
    summary = manager.get_summary()
    print(f"Open positions: {summary['open_positions']}")
    print(f"Daily P&L: ${summary['daily_pnl']:.2f}")
    print(f"Status: {summary['status']}")
    print(f"Trading locked: {summary['trading_locked']}")
    print(f"Loss buffer: ${summary['loss_buffer']:.2f}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(example_usage())
