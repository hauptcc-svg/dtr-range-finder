"""
Trade Logger & Telegram Notifier
=================================
Comprehensive trade logging:
- Every trade logged with full details
- Comparison tracking (Claude decision vs actual execution)
- Telegram notifications for all events
- Trade verification against platform
- Historical audit trail

Telegram Bot: @hauptfxbot
"""

import json
import logging
import asyncio
from datetime import datetime, date
from typing import Dict, Any, Optional, List
import os
from enum import Enum
import aiohttp

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# TELEGRAM NOTIFIER
# ═══════════════════════════════════════════════════════════════════════════

class TelegramNotifier:
    """
    Sends real-time Telegram notifications for all trading events
    """
    
    def __init__(self, bot_token: str, chat_id: str):
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.api_url = f"https://api.telegram.org/bot{bot_token}"
    
    async def send_message(self, message: str, parse_mode: str = "HTML") -> bool:
        """Send message to Telegram"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{self.api_url}/sendMessage",
                    json={
                        "chat_id": self.chat_id,
                        "text": message,
                        "parse_mode": parse_mode
                    }
                ) as response:
                    if response.status == 200:
                        logger.info(f"✓ Telegram message sent")
                        return True
                    else:
                        logger.error(f"❌ Telegram error: {response.status}")
                        return False
        except Exception as e:
            logger.error(f"❌ Telegram error: {e}")
            return False
    
    async def notify_trade_entry(self, trade_data: Dict[str, Any]) -> bool:
        """Notify when trade enters"""
        
        message = f"""
<b>📈 TRADE ENTRY</b>

<b>Symbol:</b> {trade_data['symbol']}
<b>Side:</b> {trade_data['side']}
<b>Quantity:</b> {trade_data['qty']}
<b>Entry Price:</b> {trade_data['entry_price']:.2f}
<b>SL:</b> {trade_data['sl_pips']} pips
<b>TP:</b> {trade_data['tp_pips']} pips
<b>Confidence:</b> {trade_data.get('confidence', 0):.1%}
<b>Mode:</b> {trade_data.get('mode', 'UNKNOWN')}
<b>Time:</b> {datetime.now().strftime('%H:%M:%S')}

<b>Order ID:</b> <code>{trade_data.get('order_id', 'PENDING')}</code>
"""
        
        return await self.send_message(message)
    
    async def notify_trade_exit(self, trade_data: Dict[str, Any]) -> bool:
        """Notify when trade exits"""
        
        pnl = trade_data['pnl']
        pnl_emoji = "✅" if pnl >= 0 else "❌"
        
        message = f"""
<b>{pnl_emoji} TRADE EXIT</b>

<b>Symbol:</b> {trade_data['symbol']}
<b>Side:</b> {trade_data['side']}
<b>Quantity:</b> {trade_data['qty']}
<b>Entry:</b> {trade_data['entry_price']:.2f}
<b>Exit:</b> {trade_data['exit_price']:.2f}
<b>P&L:</b> <b>{'+' if pnl >= 0 else ''}{pnl:.2f}</b>
<b>Reason:</b> {trade_data.get('exit_reason', 'UNKNOWN')}
<b>Duration:</b> {trade_data.get('duration_minutes', 0)} min

<b>Order ID:</b> <code>{trade_data.get('order_id', 'UNKNOWN')}</code>
"""
        
        return await self.send_message(message)
    
    async def notify_daily_summary(self, summary: Dict[str, Any]) -> bool:
        """Send daily trading summary"""
        
        pnl = summary['daily_pnl']
        pnl_emoji = "✅" if pnl >= 0 else "❌"
        
        message = f"""
<b>{pnl_emoji} DAILY SUMMARY</b>

<b>Date:</b> {summary.get('date', date.today())}

<b>Total Trades:</b> {summary['total_trades']}
<b>Wins:</b> {summary['wins']}
<b>Losses:</b> {summary['losses']}
<b>Win Rate:</b> {summary.get('win_rate', 0):.1%}

<b>Daily P&L:</b> <b>{'+' if pnl >= 0 else ''}{pnl:.2f}</b>
<b>P&L %:</b> {summary.get('pnl_percent', 0):.2f}%

<b>By Pair:</b>
"""
        
        for symbol, stats in summary.get('by_pair', {}).items():
            pair_pnl = stats.get('pnl', 0)
            pair_emoji = "+" if pair_pnl >= 0 else ""
            message += f"\n{symbol}: {pair_emoji}{pair_pnl:.2f}"
        
        return await self.send_message(message)
    
    async def notify_mode_change(self, mode: str) -> bool:
        """Notify when trading mode changes"""
        
        emoji = "🧠" if mode == "claude" else "📈" if mode == "dtr" else "⏹️"
        mode_text = "CLAUDE TRADE NOW" if mode == "claude" else "DTR RULES" if mode == "dtr" else "HALTED"
        
        message = f"""
<b>{emoji} MODE CHANGED</b>

Mode: <b>{mode_text}</b>
Time: {datetime.now().strftime('%H:%M:%S')}
"""
        
        return await self.send_message(message)
    
    async def notify_daily_limits_hit(self, limit_type: str, value: float) -> bool:
        """Notify when daily limits are hit"""
        
        message = f"""
<b>🚨 DAILY LIMIT HIT</b>

Limit: {limit_type}
Value: {value:.2f}
Time: {datetime.now().strftime('%H:%M:%S')}

<b>All trading has been halted.</b>
"""
        
        return await self.send_message(message)

    async def notify_hermes_digest(
        self,
        trades:        List[Dict[str, Any]],
        contexts:      Dict[str, Any],
        daily_pnl:     float,
        param_proposals: List[Dict[str, Any]] = None,
    ) -> bool:
        """
        Hermes end-of-day digest with golden setups, avoid patterns,
        and optional inline approve/reject buttons for parameter proposals.
        """
        total  = len(trades)
        wins   = sum(1 for t in trades if t.get("outcome") == "WIN")
        losses = sum(1 for t in trades if t.get("outcome") == "LOSS")
        wr     = (wins / total * 100) if total else 0.0
        pnl_emoji = "🟢" if daily_pnl >= 0 else "🔴"

        # Collect insights across all symbols
        golden_lines = []
        avoid_lines  = []
        for sym, ctx in contexts.items():
            for g in ctx.get("golden_setups", [])[:2]:
                golden_lines.append(
                    f"• {g.get('symbol')} {g.get('session')} {g.get('direction')} "
                    f"({g.get('win_rate', 0)*100:.0f}% WR, {g.get('sample_size', '?')} trades)"
                )
            for a in ctx.get("avoid_patterns", [])[:1]:
                avoid_lines.append(
                    f"• {a.get('symbol')} {a.get('session')} {a.get('direction')} "
                    f"— {a.get('reason', '')}"
                )

        golden_text = "\n".join(golden_lines[:3]) or "No patterns yet"
        avoid_text  = "\n".join(avoid_lines[:2])  or "None"

        message = (
            f"<b>📊 DTR Daily Summary — {date.today().strftime('%d %b %Y')}</b>\n"
            f"─────────────────────\n"
            f"Trades: {total} | Wins: {wins} | Losses: {losses} | WR: {wr:.0f}%\n"
            f"Daily P&amp;L: {pnl_emoji} <b>${daily_pnl:+.2f}</b>\n"
            f"─────────────────────\n"
            f"<b>🔮 Hermes Insights:</b>\n"
            f"<b>Golden setups:</b>\n{golden_text}\n\n"
            f"<b>Avoid:</b>\n{avoid_text}"
        )

        await self.send_message(message)

        # Send param proposals as a separate message with inline buttons
        if param_proposals:
            for p in param_proposals:
                param     = p.get("param", "?")
                current   = p.get("current", "?")
                suggested = p.get("suggested", "?")
                symbol    = p.get("symbol", "ALL")
                reasoning = p.get("reasoning", "")

                proposal_msg = (
                    f"<b>⚙️ Parameter Proposal — {symbol}</b>\n"
                    f"<code>{param}</code>: {current} → {suggested}\n"
                    f"<i>{reasoning}</i>"
                )
                inline_keyboard = {"inline_keyboard": [[
                    {"text": f"✅ Approve", "callback_data": f"APPROVE_{symbol}_{param}_{suggested}"},
                    {"text": f"❌ Reject",  "callback_data": f"REJECT_{symbol}_{param}"},
                ]]}

                try:
                    async with aiohttp.ClientSession() as sess:
                        await sess.post(
                            f"{self.api_url}/sendMessage",
                            json={
                                "chat_id":      self.chat_id,
                                "text":         proposal_msg,
                                "parse_mode":   "HTML",
                                "reply_markup": inline_keyboard,
                            }
                        )
                except Exception as e:
                    logger.error(f"❌ Telegram proposal send error: {e}")

        return True


# ═══════════════════════════════════════════════════════════════════════════
# COMPREHENSIVE TRADE LOGGER
# ═══════════════════════════════════════════════════════════════════════════

class ComprehensiveTradeLogger:
    """
    Logs all trades with complete details for audit trail and comparison
    """
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.ensure_directories()
    
    def ensure_directories(self):
        """Create necessary directories"""
        os.makedirs(f"{self.data_dir}/trade_logs", exist_ok=True)
        os.makedirs(f"{self.data_dir}/trade_logs/raw_entries", exist_ok=True)
        os.makedirs(f"{self.data_dir}/trade_logs/raw_exits", exist_ok=True)
        os.makedirs(f"{self.data_dir}/trade_logs/complete_trades", exist_ok=True)
        os.makedirs(f"{self.data_dir}/trade_logs/daily_summaries", exist_ok=True)
        os.makedirs(f"{self.data_dir}/trade_logs/comparison", exist_ok=True)
    
    def log_trade_entry(self, trade_entry: Dict[str, Any]) -> str:
        """
        Log trade entry with full details
        
        Returns order_id
        """
        
        entry_data = {
            "timestamp": datetime.now().isoformat(),
            "symbol": trade_entry['symbol'],
            "side": trade_entry['side'],
            "qty": trade_entry['qty'],
            "entry_price": trade_entry['entry_price'],
            "sl_pips": trade_entry.get('sl_pips', 0),
            "tp_pips": trade_entry.get('tp_pips', 0),
            "confidence": trade_entry.get('confidence', 0),
            "mode": trade_entry.get('mode', 'UNKNOWN'),
            "reason": trade_entry.get('reason', 'Auto-signal'),
            "order_id": trade_entry.get('order_id', 'PENDING'),
            "platform_confirmation": trade_entry.get('platform_confirmation', False),
            "claude_decision": {
                "should_trade": trade_entry.get('should_trade', True),
                "confidence": trade_entry.get('confidence', 0),
                "reasoning": trade_entry.get('reasoning', '')
            }
        }
        
        # Save to entries log
        entries_file = f"{self.data_dir}/trade_logs/raw_entries/{date.today()}_entries.jsonl"
        with open(entries_file, 'a') as f:
            f.write(json.dumps(entry_data) + "\n")
        
        # Save to daily trades (for learning)
        daily_file = f"{self.data_dir}/daily_trades/{date.today()}.json"
        with open(daily_file, 'a') as f:
            f.write(json.dumps({
                **entry_data,
                "status": "OPEN",
                "exit_price": None,
                "exit_time": None,
                "pnl": None,
                "duration_minutes": None
            }) + "\n")
        
        order_id = entry_data['order_id']
        logger.info(f"✓ Trade entry logged: {trade_entry['symbol']} {trade_entry['side']} - Order: {order_id}")
        
        return order_id
    
    def log_trade_exit(self, trade_exit: Dict[str, Any]) -> bool:
        """
        Log trade exit and calculate P&L
        """
        
        exit_data = {
            "timestamp": datetime.now().isoformat(),
            "symbol": trade_exit['symbol'],
            "order_id": trade_exit.get('order_id', 'UNKNOWN'),
            "exit_price": trade_exit['exit_price'],
            "pnl": trade_exit.get('pnl', 0),
            "pnl_pips": trade_exit.get('pnl_pips', 0),
            "exit_reason": trade_exit.get('exit_reason', 'UNKNOWN'),
            "duration_minutes": trade_exit.get('duration_minutes', 0),
            "platform_confirmed": trade_exit.get('platform_confirmed', False),
            "slippage": trade_exit.get('slippage', 0),
        }
        
        # Save to exits log
        exits_file = f"{self.data_dir}/trade_logs/raw_exits/{date.today()}_exits.jsonl"
        with open(exits_file, 'a') as f:
            f.write(json.dumps(exit_data) + "\n")
        
        # Update daily trades with exit info
        self._update_trade_with_exit(trade_exit)
        
        # Create complete trade record
        complete_trade = {
            "entry": trade_exit.get('entry_data', {}),
            "exit": exit_data,
            "net_pnl": trade_exit.get('pnl', 0),
            "closed_timestamp": datetime.now().isoformat()
        }
        
        complete_file = f"{self.data_dir}/trade_logs/complete_trades/{date.today()}_complete.jsonl"
        with open(complete_file, 'a') as f:
            f.write(json.dumps(complete_trade) + "\n")
        
        logger.info(f"✓ Trade exit logged: {trade_exit['symbol']} - P&L: ${trade_exit.get('pnl', 0):.2f}")
        
        return True
    
    def _update_trade_with_exit(self, exit_data: Dict[str, Any]):
        """Update daily trades file with exit data"""
        
        daily_file = f"{self.data_dir}/daily_trades/{date.today()}.json"
        
        try:
            trades = []
            with open(daily_file, 'r') as f:
                trades = [json.loads(line) for line in f if line.strip()]
            
            # Find and update the trade
            for trade in trades:
                if trade.get('order_id') == exit_data.get('order_id'):
                    trade['status'] = 'CLOSED'
                    trade['exit_price'] = exit_data['exit_price']
                    trade['exit_time'] = exit_data['timestamp']
                    trade['pnl'] = exit_data.get('pnl', 0)
                    trade['duration_minutes'] = exit_data.get('duration_minutes', 0)
                    trade['win'] = exit_data.get('pnl', 0) >= 0
                    break
            
            # Rewrite file
            with open(daily_file, 'w') as f:
                for trade in trades:
                    f.write(json.dumps(trade) + "\n")
        
        except Exception as e:
            logger.error(f"Error updating trade with exit: {e}")
    
    def create_daily_summary(self, date_to_summarize: date = None) -> Dict[str, Any]:
        """Create daily trading summary"""
        
        if date_to_summarize is None:
            date_to_summarize = date.today()
        
        daily_file = f"{self.data_dir}/daily_trades/{date_to_summarize}.json"
        
        trades = []
        if os.path.exists(daily_file):
            with open(daily_file, 'r') as f:
                trades = [json.loads(line) for line in f if line.strip()]
        
        if not trades:
            return {
                "date": str(date_to_summarize),
                "total_trades": 0,
                "wins": 0,
                "losses": 0,
                "win_rate": 0.0,
                "daily_pnl": 0.0,
                "by_pair": {}
            }
        
        closed_trades = [t for t in trades if t.get('status') == 'CLOSED']
        wins = [t for t in closed_trades if t.get('win', False)]
        losses = [t for t in closed_trades if not t.get('win', False)]
        
        # Per-pair stats
        by_pair = {}
        for trade in closed_trades:
            symbol = trade.get('symbol', 'UNKNOWN')
            if symbol not in by_pair:
                by_pair[symbol] = {
                    "trades": 0,
                    "wins": 0,
                    "losses": 0,
                    "pnl": 0.0
                }
            
            by_pair[symbol]['trades'] += 1
            by_pair[symbol]['pnl'] += trade.get('pnl', 0)
            
            if trade.get('win', False):
                by_pair[symbol]['wins'] += 1
            else:
                by_pair[symbol]['losses'] += 1
        
        summary = {
            "date": str(date_to_summarize),
            "total_trades": len(closed_trades),
            "wins": len(wins),
            "losses": len(losses),
            "win_rate": (len(wins) / len(closed_trades) * 100) if closed_trades else 0,
            "daily_pnl": sum(t.get('pnl', 0) for t in closed_trades),
            "pnl_percent": (sum(t.get('pnl', 0) for t in closed_trades) / 150000 * 100) if closed_trades else 0,
            "by_pair": by_pair,
            "open_trades": len([t for t in trades if t.get('status') == 'OPEN'])
        }
        
        # Save summary
        summary_file = f"{self.data_dir}/trade_logs/daily_summaries/{date_to_summarize}_summary.json"
        with open(summary_file, 'w') as f:
            json.dump(summary, f, indent=2)
        
        return summary
    
    def get_comparison_report(self, date_to_compare: date = None) -> Dict[str, Any]:
        """
        Compare Claude decisions vs actual executed trades
        (For verification against platform)
        """
        
        if date_to_compare is None:
            date_to_compare = date.today()
        
        daily_file = f"{self.data_dir}/daily_trades/{date_to_compare}.json"
        
        trades = []
        if os.path.exists(daily_file):
            with open(daily_file, 'r') as f:
                trades = [json.loads(line) for line in f if line.strip()]
        
        comparison = {
            "date": str(date_to_compare),
            "total_trades": len(trades),
            "claude_decisions": {
                "total": len(trades),
                "correct": 0,  # Won trades
                "incorrect": 0,  # Lost trades
                "pending": len([t for t in trades if t.get('status') == 'OPEN'])
            },
            "execution_data": {
                "total_executed": len([t for t in trades if t.get('platform_confirmed', False)]),
                "pending_confirmation": len([t for t in trades if not t.get('platform_confirmed', False)]),
                "mismatches": []
            },
            "trades": trades
        }
        
        # Calculate correctness
        closed = [t for t in trades if t.get('status') == 'CLOSED']
        comparison['claude_decisions']['correct'] = len([t for t in closed if t.get('win', False)])
        comparison['claude_decisions']['incorrect'] = len([t for t in closed if not t.get('win', False)])
        
        # Save comparison report
        comparison_file = f"{self.data_dir}/trade_logs/comparison/{date_to_compare}_comparison.json"
        with open(comparison_file, 'w') as f:
            json.dump(comparison, f, indent=2)
        
        return comparison
    
    def verify_against_platform(self, platform_trades: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Verify logged trades against actual platform trades
        """
        
        daily_file = f"{self.data_dir}/daily_trades/{date.today()}.json"
        
        logged_trades = []
        if os.path.exists(daily_file):
            with open(daily_file, 'r') as f:
                logged_trades = [json.loads(line) for line in f if line.strip()]
        
        verification = {
            "timestamp": datetime.now().isoformat(),
            "logged_trades": len(logged_trades),
            "platform_trades": len(platform_trades),
            "matches": 0,
            "mismatches": [],
            "missing_on_platform": [],
            "extra_on_platform": []
        }
        
        # Create dict for easy lookup
        logged_dict = {t.get('order_id'): t for t in logged_trades}
        platform_dict = {t.get('order_id'): t for t in platform_trades}
        
        # Check for matches
        for order_id, logged in logged_dict.items():
            if order_id in platform_dict:
                platform = platform_dict[order_id]
                
                # Compare key fields
                if (logged['symbol'] == platform['symbol'] and
                    logged['side'] == platform['side'] and
                    logged['qty'] == platform['qty']):
                    verification['matches'] += 1
                else:
                    verification['mismatches'].append({
                        "order_id": order_id,
                        "logged": logged,
                        "platform": platform
                    })
            else:
                verification['missing_on_platform'].append({
                    "order_id": order_id,
                    "symbol": logged['symbol'],
                    "side": logged['side']
                })
        
        # Check for extra on platform
        for order_id in platform_dict:
            if order_id not in logged_dict:
                verification['extra_on_platform'].append({
                    "order_id": order_id,
                    "symbol": platform_dict[order_id]['symbol']
                })
        
        logger.info(f"Verification complete: {verification['matches']} matches, {len(verification['mismatches'])} mismatches")
        
        return verification


# ═══════════════════════════════════════════════════════════════════════════
# INTEGRATED TRADE EXECUTOR WITH LOGGING & NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════════════════

class TradeExecutorWithLogging:
    """
    Executes trades and logs everything with Telegram notifications
    """
    
    def __init__(self, api, telegram_bot_token: str, telegram_chat_id: str):
        self.api = api
        self.logger = ComprehensiveTradeLogger()
        self.notifier = TelegramNotifier(telegram_bot_token, telegram_chat_id)
    
    async def execute_and_log_trade(self, trade_signal: Dict[str, Any]) -> Optional[str]:
        """
        Execute trade and log everything
        
        Returns order_id
        """
        
        try:
            # Log the Claude decision
            trade_entry = {
                **trade_signal,
                "timestamp": datetime.now().isoformat(),
                "order_id": "PENDING"
            }
            
            # Execute trade
            order = await self.api.place_order(
                contract_id=trade_signal['symbol'],
                side=trade_signal['recommendation'],
                quantity=trade_signal['suggested_contracts'],
                order_type="MARKET",
                comment=f"AUTO_{trade_signal.get('mode', 'UNKNOWN')}"
            )
            
            if order:
                order_id = order.get('id', 'UNKNOWN')
                trade_entry['order_id'] = order_id
                trade_entry['platform_confirmation'] = True
                
                # Log entry
                self.logger.log_trade_entry(trade_entry)
                
                # Send Telegram notification
                await self.notifier.notify_trade_entry({
                    **trade_entry,
                    "entry_price": trade_signal.get('current_price', 0)
                })
                
                logger.info(f"✓ Trade executed and logged: {order_id}")
                
                return order_id
            else:
                # Log failed execution
                logger.error(f"❌ Order execution failed for {trade_signal['symbol']}")
                return None
        
        except Exception as e:
            logger.error(f"Error executing and logging trade: {e}")
            return None
    
    async def exit_and_log_trade(self, exit_data: Dict[str, Any]) -> bool:
        """
        Exit trade and log everything
        """
        
        try:
            # Calculate P&L
            entry_price = exit_data['entry_price']
            exit_price = exit_data['exit_price']
            qty = exit_data['qty']
            side = exit_data['side']
            point_value = self._get_point_value(exit_data['symbol'])
            
            if side == "BUY":
                pnl_pts = exit_price - entry_price
            else:
                pnl_pts = entry_price - exit_price
            
            pnl = pnl_pts * point_value * qty
            
            # Log exit
            self.logger.log_trade_exit({
                **exit_data,
                "pnl": pnl,
                "pnl_pips": pnl_pts * 10,  # Convert to pips
                "platform_confirmed": True
            })
            
            # Send Telegram notification
            await self.notifier.notify_trade_exit({
                **exit_data,
                "pnl": pnl
            })
            
            logger.info(f"✓ Trade exit logged: {exit_data['symbol']} P&L: ${pnl:.2f}")
            
            return True
        
        except Exception as e:
            logger.error(f"Error exiting and logging trade: {e}")
            return False
    
    async def send_daily_summary(self):
        """Generate and send daily summary"""
        
        try:
            summary = self.logger.create_daily_summary()
            
            # Send to Telegram
            await self.notifier.notify_daily_summary(summary)
            
            logger.info(f"✓ Daily summary sent to Telegram")
            
            return summary
        
        except Exception as e:
            logger.error(f"Error sending daily summary: {e}")
            return None
    
    def _get_point_value(self, symbol: str) -> float:
        """Get point value for symbol"""
        point_values = {
            "MNQM26": 20.0,
            "MYMM26": 12.50,
            "MGCM26": 10.0,
            "MCLK26": 10.0,
        }
        return point_values.get(symbol, 1.0)


# ═══════════════════════════════════════════════════════════════════════════
# FILE STRUCTURE
# ═══════════════════════════════════════════════════════════════════════════

"""
Trade Log Structure:

data/
├── trade_logs/
│   ├── raw_entries/
│   │   ├── 2024-01-15_entries.jsonl (all entry decisions)
│   │   └── ...
│   │
│   ├── raw_exits/
│   │   ├── 2024-01-15_exits.jsonl (all exit executions)
│   │   └── ...
│   │
│   ├── complete_trades/
│   │   ├── 2024-01-15_complete.jsonl (full trade lifecycle)
│   │   └── ...
│   │
│   ├── daily_summaries/
│   │   ├── 2024-01-15_summary.json (daily stats)
│   │   └── ...
│   │
│   └── comparison/
│       ├── 2024-01-15_comparison.json (Claude vs Platform)
│       └── ...
│
└── daily_trades/
    ├── 2024-01-15.json (for learning system)
    └── ...

Each trade record includes:
- Entry decision (Claude's confidence, reasoning)
- Execution data (order ID, timestamp, platform confirmation)
- Exit data (exit price, P&L, duration)
- Verification data (matches against platform)
"""
