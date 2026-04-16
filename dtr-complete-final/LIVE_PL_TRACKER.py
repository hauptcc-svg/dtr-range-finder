"""
Live Account Balance & P&L Tracker
===================================
Real-time tracking of:
- Account balance from Topstep/ProjectX
- Live P&L for each open position
- Per-pair P&L (today, weekly, monthly)
- Total daily P&L
- Account equity updates

Updates every 10 seconds
"""

import asyncio
import json
from datetime import datetime, date, timedelta
from typing import Dict, List, Optional, Any
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# LIVE P&L TRACKER
# ═══════════════════════════════════════════════════════════════════════════

class LivePLTracker:
    """
    Tracks real-time P&L for all positions and pairs
    Updates every tick of price data
    """
    
    def __init__(self, api):
        self.api = api
        self.positions = {}  # Open positions
        self.closed_trades = []  # Completed trades
        self.account_balance = 150000.00
        self.account_equity = 150000.00
        self.daily_pnl = 0.0
        self.weekly_pnl = 0.0
        self.monthly_pnl = 0.0
        
        # Per-pair tracking
        self.pair_stats = {
            "MNQM26": {"wins": 0, "losses": 0, "daily_pnl": 0.0, "avg_win": 0.0, "avg_loss": 0.0},
            "MYMM26": {"wins": 0, "losses": 0, "daily_pnl": 0.0, "avg_win": 0.0, "avg_loss": 0.0},
            "MGCM26": {"wins": 0, "losses": 0, "daily_pnl": 0.0, "avg_win": 0.0, "avg_loss": 0.0},
            "MCLK26": {"wins": 0, "losses": 0, "daily_pnl": 0.0, "avg_win": 0.0, "avg_loss": 0.0},
        }
    
    async def update_account_balance(self):
        """Fetch current account balance from ProjectX"""
        try:
            account = await self.api.get_account_summary()
            
            if account:
                self.account_balance = account.get('balance', self.account_balance)
                self.account_equity = account.get('equity', self.account_equity)
                
                logger.debug(f"Account updated: Balance=${self.account_balance:,.2f}, Equity=${self.account_equity:,.2f}")
                
                return {
                    "balance": self.account_balance,
                    "equity": self.account_equity,
                    "timestamp": datetime.now().isoformat()
                }
        except Exception as e:
            logger.error(f"Error updating account balance: {e}")
        
        return None
    
    async def update_open_positions(self, open_positions: List[Dict]):
        """
        Update all open positions with current prices
        Calculate unrealized P&L
        """
        
        total_unrealized = 0.0
        updated_positions = {}
        
        for position in open_positions:
            symbol = position.get('symbol', 'UNKNOWN')
            
            try:
                # Get current price
                bars = await self.api.get_bars(symbol, limit=1)
                
                if not bars:
                    continue
                
                current_price = bars[-1]['close']
                entry_price = position['entry_price']
                qty = position['qty']
                side = position['side']
                
                # Calculate unrealized P&L
                if side == "BUY":
                    unrealized_pts = current_price - entry_price
                else:  # SELL
                    unrealized_pts = entry_price - current_price
                
                # Get point value from config
                point_value = self._get_point_value(symbol)
                unrealized_pnl = unrealized_pts * point_value * qty
                
                updated_positions[symbol] = {
                    "symbol": symbol,
                    "side": side,
                    "qty": qty,
                    "entry_price": entry_price,
                    "current_price": current_price,
                    "unrealized_pts": unrealized_pts,
                    "unrealized_pnl": unrealized_pnl,
                    "entry_time": position.get('entry_time', datetime.now().isoformat())
                }
                
                total_unrealized += unrealized_pnl
                
            except Exception as e:
                logger.error(f"Error updating position for {symbol}: {e}")
        
        self.positions = updated_positions
        
        return {
            "positions": updated_positions,
            "total_unrealized": total_unrealized,
            "timestamp": datetime.now().isoformat()
        }
    
    def add_closed_trade(self, trade: Dict[str, Any]):
        """
        Record a closed trade
        Updates daily P&L and pair statistics
        """
        
        symbol = trade.get('symbol', 'UNKNOWN')
        pnl = trade.get('pnl', 0.0)
        win = trade.get('win', False)
        trade_date = trade.get('timestamp', datetime.now().isoformat())
        
        # Add to closed trades
        self.closed_trades.append(trade)
        
        # Update daily P&L
        self.daily_pnl += pnl
        
        # Update per-pair stats
        if symbol in self.pair_stats:
            self.pair_stats[symbol]['daily_pnl'] += pnl
            
            if win:
                self.pair_stats[symbol]['wins'] += 1
                self.pair_stats[symbol]['avg_win'] = (
                    (self.pair_stats[symbol]['avg_win'] * (self.pair_stats[symbol]['wins'] - 1) + pnl) /
                    self.pair_stats[symbol]['wins']
                )
            else:
                self.pair_stats[symbol]['losses'] += 1
                self.pair_stats[symbol]['avg_loss'] = (
                    (self.pair_stats[symbol]['avg_loss'] * (self.pair_stats[symbol]['losses'] - 1) + pnl) /
                    self.pair_stats[symbol]['losses']
                )
        
        # Update weekly/monthly P&L
        trade_datetime = datetime.fromisoformat(trade_date)
        days_ago = (datetime.now() - trade_datetime).days
        
        if days_ago < 7:
            self.weekly_pnl += pnl
        
        if days_ago < 30:
            self.monthly_pnl += pnl
        
        logger.info(f"Trade recorded: {symbol} {'+' if win else '-'}${abs(pnl):.2f}")
    
    def get_dashboard_data(self) -> Dict[str, Any]:
        """Get all data for dashboard display"""
        
        total_unrealized = sum(pos['unrealized_pnl'] for pos in self.positions.values())
        total_pnl = self.daily_pnl + total_unrealized
        
        return {
            "account": {
                "balance": self.account_balance,
                "equity": self.account_equity,
                "buying_power": self.account_equity * 10,  # Typical Topstep leverage
                "timestamp": datetime.now().isoformat()
            },
            "daily": {
                "realized_pnl": self.daily_pnl,
                "unrealized_pnl": total_unrealized,
                "total_pnl": total_pnl,
                "total_pnl_percent": (total_pnl / self.account_balance * 100) if self.account_balance else 0
            },
            "weekly": {
                "pnl": self.weekly_pnl,
                "pnl_percent": (self.weekly_pnl / self.account_balance * 100) if self.account_balance else 0
            },
            "monthly": {
                "pnl": self.monthly_pnl,
                "pnl_percent": (self.monthly_pnl / self.account_balance * 100) if self.account_balance else 0
            },
            "positions": {
                "open": self.positions,
                "count": len(self.positions),
                "total_unrealized": total_unrealized
            },
            "pairs": self.pair_stats
        }
    
    def get_pair_summary(self) -> Dict[str, Any]:
        """Get summary for each pair"""
        
        summary = {}
        
        for symbol, stats in self.pair_stats.items():
            total_trades = stats['wins'] + stats['losses']
            win_rate = (stats['wins'] / total_trades * 100) if total_trades > 0 else 0
            
            summary[symbol] = {
                "symbol": symbol,
                "daily_pnl": stats['daily_pnl'],
                "trades": total_trades,
                "wins": stats['wins'],
                "losses": stats['losses'],
                "win_rate": win_rate,
                "avg_win": stats['avg_win'],
                "avg_loss": stats['avg_loss'],
                "profit_factor": (
                    (stats['avg_win'] * stats['wins']) / abs(stats['avg_loss'] * stats['losses'])
                    if stats['losses'] > 0 and stats['avg_loss'] != 0 else 0
                )
            }
        
        return summary
    
    def _get_point_value(self, symbol: str) -> float:
        """Get point value for symbol"""
        point_values = {
            "MNQM26": 20.0,    # Micro NQ
            "MYMM26": 12.50,   # Mini Yen
            "MGCM26": 10.0,    # Micro Gold
            "MCLK26": 10.0,    # Micro Crude Oil
        }
        return point_values.get(symbol, 1.0)


# ═══════════════════════════════════════════════════════════════════════════
# CONTINUOUS P&L UPDATE ENGINE
# ═══════════════════════════════════════════════════════════════════════════

class ContinuousPLUpdater:
    """
    Continuously updates P&L data in background
    Fetches account balance every 10 seconds
    Updates position prices every 5 seconds
    """
    
    def __init__(self, api, tracker: LivePLTracker):
        self.api = api
        self.tracker = tracker
        self.running = False
    
    async def start(self):
        """Start continuous updates"""
        self.running = True
        
        logger.info("Starting continuous P&L updates...")
        
        while self.running:
            try:
                # Update account every 10 seconds
                await self.tracker.update_account_balance()
                
                # Get open positions
                positions = await self.api.get_open_positions()
                if positions:
                    await self.tracker.update_open_positions(positions)
                
                # Wait before next update
                await asyncio.sleep(10)
            
            except Exception as e:
                logger.error(f"Error in P&L updater: {e}")
                await asyncio.sleep(5)
    
    async def stop(self):
        """Stop continuous updates"""
        self.running = False
        logger.info("Stopping continuous P&L updates")


# ═══════════════════════════════════════════════════════════════════════════
# HISTORICAL P&L AGGREGATOR
# ═══════════════════════════════════════════════════════════════════════════

class HistoricalPLAggregator:
    """
    Aggregates historical P&L data by day, week, month
    Builds performance analytics
    """
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.daily_history = {}  # Date -> P&L
        self.weekly_history = {}  # Week -> P&L
        self.monthly_history = {}  # Month -> P&L
    
    def load_historical_data(self):
        """Load P&L from daily trade files"""
        
        try:
            trades_dir = f"{self.data_dir}/daily_trades"
            
            if not os.path.exists(trades_dir):
                return
            
            for date_file in os.listdir(trades_dir):
                if date_file.endswith('.json'):
                    date_str = date_file.replace('.json', '')
                    
                    try:
                        with open(f"{trades_dir}/{date_file}", 'r') as f:
                            trades = [json.loads(line) for line in f if line.strip()]
                        
                        daily_pnl = sum(trade['pnl'] for trade in trades)
                        self.daily_history[date_str] = daily_pnl
                    
                    except Exception as e:
                        logger.error(f"Error loading {date_file}: {e}")
        
        except Exception as e:
            logger.error(f"Error loading historical data: {e}")
    
    def get_period_pnl(self, days: int) -> float:
        """Get total P&L for last N days"""
        
        total = 0.0
        cutoff_date = datetime.now() - timedelta(days=days)
        
        for date_str, pnl in self.daily_history.items():
            try:
                trade_date = datetime.strptime(date_str, "%Y-%m-%d")
                if trade_date >= cutoff_date:
                    total += pnl
            except:
                pass
        
        return total
    
    def get_stats_for_period(self, days: int) -> Dict[str, Any]:
        """Get trading stats for last N days"""
        
        period_trades = []
        cutoff_date = datetime.now() - timedelta(days=days)
        
        try:
            trades_dir = f"{self.data_dir}/daily_trades"
            
            if os.path.exists(trades_dir):
                for date_file in os.listdir(trades_dir):
                    if date_file.endswith('.json'):
                        date_str = date_file.replace('.json', '')
                        
                        try:
                            trade_date = datetime.strptime(date_str, "%Y-%m-%d")
                            
                            if trade_date >= cutoff_date:
                                with open(f"{trades_dir}/{date_file}", 'r') as f:
                                    trades = [json.loads(line) for line in f if line.strip()]
                                    period_trades.extend(trades)
                        except:
                            pass
        except:
            pass
        
        if not period_trades:
            return {
                "trades": 0,
                "wins": 0,
                "losses": 0,
                "win_rate": 0.0,
                "avg_win": 0.0,
                "avg_loss": 0.0,
                "total_pnl": 0.0,
                "biggest_win": 0.0,
                "biggest_loss": 0.0
            }
        
        wins = [t for t in period_trades if t.get('win', False)]
        losses = [t for t in period_trades if not t.get('win', False)]
        
        return {
            "trades": len(period_trades),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": (len(wins) / len(period_trades) * 100) if period_trades else 0.0,
            "avg_win": sum(t['pnl'] for t in wins) / len(wins) if wins else 0.0,
            "avg_loss": sum(t['pnl'] for t in losses) / len(losses) if losses else 0.0,
            "total_pnl": sum(t['pnl'] for t in period_trades),
            "biggest_win": max((t['pnl'] for t in wins), default=0.0),
            "biggest_loss": min((t['pnl'] for t in losses), default=0.0)
        }


import os
