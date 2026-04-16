"""
Continuous Trading System
=========================
Two modes that run continuously:

1. CLAUDE TRADE NOW MODE
   - Checks market every 5 minutes
   - Uses learned rules + AI analysis
   - Enters trades automatically (no button click needed)
   - Runs until you click "DTR RULES"

2. DTR RULES MODE  
   - Uses traditional DTR strategy
   - Checks market per session times (2AM London, 9AM NY)
   - Follows strict DTR rules
   - Runs until you click "CLAUDE TRADE NOW"

You toggle between them with button clicks
"""

import asyncio
import logging
from datetime import datetime, date, time, timedelta
from typing import Optional, Dict, Any, List
import json
import os
from enum import Enum

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# MODE ENUMERATION
# ═══════════════════════════════════════════════════════════════════════════

class TradingMode(Enum):
    """Trading mode selector"""
    CLAUDE_TRADE_NOW = "claude_trade_now"  # AI continuous mode
    DTR_RULES = "dtr_rules"                # Traditional DTR mode
    HALTED = "halted"                       # No trading


# ═══════════════════════════════════════════════════════════════════════════
# CONTINUOUS TRADING ENGINE
# ═══════════════════════════════════════════════════════════════════════════

class ContinuousTradingEngine:
    """
    Runs trading continuously in one of two modes:
    - CLAUDE_TRADE_NOW: Check every 5 minutes, trade when signal found
    - DTR_RULES: Follow DTR session times and rules
    """
    
    def __init__(self, api, learning_agent):
        self.api = api
        self.learning_agent = learning_agent
        self.mode = TradingMode.HALTED
        self.running = False
        self.current_hour = datetime.now().hour
        self.trades_today = []
        self.active_positions = {}
    
    # ═══════════════════════════════════════════════════════════════════════
    # MODE SWITCHING
    # ═══════════════════════════════════════════════════════════════════════
    
    async def switch_to_claude_mode(self):
        """Switch to CLAUDE TRADE NOW - continuous 5-min checking"""
        logger.info("\n" + "="*80)
        logger.info("🧠 SWITCHING TO: CLAUDE TRADE NOW MODE")
        logger.info("="*80)
        logger.info("Checking market every 5 minutes")
        logger.info("Entering trades automatically when signal found")
        logger.info("Press 'DTR RULES' button to switch modes")
        logger.info("="*80 + "\n")
        
        self.mode = TradingMode.CLAUDE_TRADE_NOW
        self.running = True
        
        # Start continuous trading loop
        await self.claude_continuous_loop()
    
    async def switch_to_dtr_mode(self):
        """Switch to DTR RULES - traditional DTR strategy"""
        logger.info("\n" + "="*80)
        logger.info("📈 SWITCHING TO: DTR RULES MODE")
        logger.info("="*80)
        logger.info("Trading during London session (3:13-7:00 AM NY)")
        logger.info("Trading during NY session (9:13-2:00 PM NY)")
        logger.info("Following strict DTR rules")
        logger.info("Press 'CLAUDE TRADE NOW' button to switch modes")
        logger.info("="*80 + "\n")
        
        self.mode = TradingMode.DTR_RULES
        self.running = True
        
        # Start DTR trading loop
        await self.dtr_continuous_loop()
    
    async def halt_trading(self):
        """Stop all trading"""
        logger.info("\n⏹️ HALTING ALL TRADING")
        logger.info("Close any open positions? (Currently not implemented)")
        
        self.mode = TradingMode.HALTED
        self.running = False
    
    # ═══════════════════════════════════════════════════════════════════════
    # MODE 1: CLAUDE TRADE NOW (5-minute continuous checking)
    # ═══════════════════════════════════════════════════════════════════════
    
    async def claude_continuous_loop(self):
        """
        CLAUDE TRADE NOW MODE
        
        Every 5 minutes:
        1. Fetch market data for all 4 instruments
        2. Analyze with Claude AI brain
        3. If signal found: Enter trade automatically
        4. Repeat until mode switched
        """
        
        logger.info("✅ CLAUDE TRADE NOW MODE ACTIVE")
        logger.info("Checking every 5 minutes for trades...\n")
        
        check_count = 0
        
        while self.mode == TradingMode.CLAUDE_TRADE_NOW and self.running:
            check_count += 1
            current_time = datetime.now().strftime("%H:%M:%S")
            
            logger.info(f"[{current_time}] CHECK #{check_count}")
            
            # Check all 4 instruments
            for symbol in ["MNQM26", "MYMM26", "MGCM26", "MCLK26"]:
                try:
                    # Get market data
                    bars = await self.api.get_bars(symbol, time_frame="5m", limit=50)
                    
                    if not bars:
                        continue
                    
                    # Get current hour
                    current_hour = datetime.now().hour
                    
                    # Claude analyzes market RIGHT NOW
                    decision = await self.learning_agent.claude_trade_now(
                        symbol=symbol,
                        bars=bars,
                        current_hour=current_hour,
                        current_setup="CONTINUOUS_SCAN"
                    )
                    
                    # If Claude says TRADE (not SKIP)
                    if decision['should_trade']:
                        logger.info(f"  ✅ {symbol}: SIGNAL FOUND")
                        logger.info(f"     Confidence: {decision['confidence']:.1%}")
                        logger.info(f"     Action: {decision['recommendation']}")
                        
                        # Enter trade automatically
                        trade_result = await self.execute_trade(
                            symbol=symbol,
                            decision=decision,
                            mode="CLAUDE"
                        )
                        
                        if trade_result:
                            logger.info(f"     ✓ TRADE ENTERED: Order #{trade_result}")
                    else:
                        logger.info(f"  ⏭️ {symbol}: No signal (confidence {decision['confidence']:.1%})")
                
                except Exception as e:
                    logger.error(f"  ❌ Error checking {symbol}: {e}")
            
            # Check daily limits
            if not self.check_daily_limits():
                logger.warning("⚠️ Daily limits hit - halting trades")
                break
            
            # Wait 5 minutes
            logger.info("Waiting 5 minutes until next check...\n")
            await asyncio.sleep(300)  # 5 minutes
    
    # ═══════════════════════════════════════════════════════════════════════
    # MODE 2: DTR RULES (Session-based traditional DTR)
    # ═══════════════════════════════════════════════════════════════════════
    
    async def dtr_continuous_loop(self):
        """
        DTR RULES MODE
        
        Checks during trading sessions:
        - London: 3:13-7:00 AM NY
        - NY: 9:13-2:00 PM NY
        
        Runs DTR strategy:
        - Range formation
        - Bias candle
        - 3CR BOS confirmation
        - Entry on next bar
        """
        
        logger.info("✅ DTR RULES MODE ACTIVE")
        logger.info("Trading during:")
        logger.info("  • London: 3:13-7:00 AM NY")
        logger.info("  • NY: 9:13-2:00 PM NY")
        logger.info("Following strict DTR rules\n")
        
        iteration = 0
        
        while self.mode == TradingMode.DTR_RULES and self.running:
            iteration += 1
            current_time = datetime.now()
            current_hour = current_time.hour
            current_minute = current_time.minute
            
            # Check if we're in trading session
            in_london_session = (3 <= current_hour <= 7) and not (current_hour == 7 and current_minute > 0)
            in_ny_session = 9 <= current_hour <= 14
            
            if not (in_london_session or in_ny_session):
                # Outside trading hours - wait until next session
                next_session = self.get_next_session_time()
                sleep_seconds = (next_session - current_time).total_seconds()
                
                logger.info(f"[{current_time.strftime('%H:%M')}] Outside trading hours")
                logger.info(f"Next session: {next_session.strftime('%H:%M')}")
                logger.info(f"Sleeping {int(sleep_seconds/60)} minutes...\n")
                
                await asyncio.sleep(min(sleep_seconds, 300))  # Max 5 min sleep
                continue
            
            # We're in a session - run DTR strategy
            session_name = "LONDON" if in_london_session else "NY"
            logger.info(f"[{current_time.strftime('%H:%M')}] {session_name} SESSION - Iteration #{iteration}")
            
            for symbol in ["MNQM26", "MYMM26", "MGCM26", "MCLK26"]:
                try:
                    # Get market data
                    bars = await self.api.get_bars(symbol, time_frame="1m", limit=100)
                    
                    if not bars:
                        continue
                    
                    # Run DTR strategy
                    signal = await self.run_dtr_strategy(symbol, bars, session_name)
                    
                    if signal:
                        logger.info(f"  ✅ {symbol}: DTR SIGNAL - {signal['setup']}")
                        logger.info(f"     Side: {signal['side']}")
                        logger.info(f"     Entry: {signal['entry_price']}")
                        
                        # Enter trade
                        trade_result = await self.execute_trade(
                            symbol=symbol,
                            decision={
                                'should_trade': True,
                                'recommendation': signal['side'],
                                'confidence': 0.75,  # DTR has fixed confidence
                                'suggested_contracts': signal.get('contracts', 2),
                                'stop_loss_pips': signal.get('sl_pips', 20),
                                'take_profit_pips': signal.get('tp_pips', 50)
                            },
                            mode="DTR"
                        )
                    else:
                        logger.info(f"  ⏭️ {symbol}: No DTR signal")
                
                except Exception as e:
                    logger.error(f"  ❌ Error with {symbol}: {e}")
            
            # Check limits
            if not self.check_daily_limits():
                logger.warning("⚠️ Daily limits hit")
                break
            
            # In DTR mode, check more frequently (1-2 min)
            logger.info("Waiting 1 minute until next check...\n")
            await asyncio.sleep(60)
    
    # ═══════════════════════════════════════════════════════════════════════
    # EXECUTION
    # ═══════════════════════════════════════════════════════════════════════
    
    async def execute_trade(
        self,
        symbol: str,
        decision: Dict[str, Any],
        mode: str
    ) -> Optional[str]:
        """
        Execute a trade automatically
        
        Returns order ID or None if failed
        """
        
        try:
            # Get current price
            bars = await self.api.get_bars(symbol, limit=1)
            if not bars:
                return None
            
            current_price = bars[-1]['close']
            
            # Place order
            order = await self.api.place_order(
                contract_id=symbol,
                side=decision['recommendation'],
                quantity=decision['suggested_contracts'],
                order_type="MARKET",
                comment=f"AUTO_{mode}"
            )
            
            if order:
                order_id = order.get('id', 'UNKNOWN')
                
                # Log trade
                trade_data = {
                    "timestamp": datetime.now().isoformat(),
                    "symbol": symbol,
                    "mode": mode,
                    "side": decision['recommendation'],
                    "entry_price": current_price,
                    "qty": decision['suggested_contracts'],
                    "sl": decision['stop_loss_pips'],
                    "tp": decision['take_profit_pips'],
                    "order_id": order_id,
                    "confidence": decision['confidence']
                }
                
                # Save trade log
                trades_file = f"data/daily_trades/{date.today()}.json"
                with open(trades_file, 'a') as f:
                    f.write(json.dumps(trade_data) + "\n")
                
                self.trades_today.append(trade_data)
                
                logger.info(f"     ✓ Order placed: {order_id}")
                return order_id
        
        except Exception as e:
            logger.error(f"Error executing trade: {e}")
        
        return None
    
    # ═══════════════════════════════════════════════════════════════════════
    # DTR STRATEGY CHECK
    # ═══════════════════════════════════════════════════════════════════════
    
    async def run_dtr_strategy(
        self,
        symbol: str,
        bars: List[Dict],
        session: str
    ) -> Optional[Dict[str, Any]]:
        """
        Run DTR strategy and return signal if found
        
        Returns:
        {
            'setup': 'RANGE_BREAK',
            'side': 'BUY' or 'SELL',
            'entry_price': float,
            'sl_pips': int,
            'tp_pips': int,
            'contracts': int
        }
        """
        
        if len(bars) < 50:
            return None
        
        # This is simplified - in real use would have full DTR logic
        # For now, return None (no signal found)
        # In production, would check:
        # 1. Range formation (20 bars)
        # 2. Range break (price outside)
        # 3. Bias candle (body > 0.5 * ATR)
        # 4. 3CR BOS confirmation
        # 5. Entry next bar
        
        return None
    
    # ═══════════════════════════════════════════════════════════════════════
    # UTILITIES
    # ═══════════════════════════════════════════════════════════════════════
    
    def check_daily_limits(self) -> bool:
        """Check if daily trading limits are hit"""
        # Implement daily loss limit check
        # If daily P&L < -$200, return False (stop trading)
        return True
    
    def get_next_session_time(self) -> datetime:
        """Get time of next trading session"""
        now = datetime.now()
        
        # If before 3:13 AM, next session is London at 3:13 AM
        if now.hour < 3 or (now.hour == 3 and now.minute < 13):
            return now.replace(hour=3, minute=13, second=0)
        
        # If after 7:00 AM, next session is NY at 9:13 AM
        if now.hour >= 7:
            if now.hour < 9 or (now.hour == 9 and now.minute < 13):
                return now.replace(hour=9, minute=13, second=0)
        
        # Tomorrow's London session
        tomorrow = now + timedelta(days=1)
        return tomorrow.replace(hour=3, minute=13, second=0)
    
    def get_status(self) -> Dict[str, Any]:
        """Get current trading status"""
        return {
            "mode": self.mode.value,
            "running": self.running,
            "trades_today": len(self.trades_today),
            "current_hour": datetime.now().hour,
            "active_positions": len(self.active_positions)
        }


# ═══════════════════════════════════════════════════════════════════════════
# USAGE EXAMPLE
# ═══════════════════════════════════════════════════════════════════════════

async def example_usage():
    """How to use the continuous trading system"""
    
    # Initialize
    engine = ContinuousTradingEngine(api=your_api, learning_agent=your_agent)
    
    # Start CLAUDE TRADE NOW mode
    await engine.switch_to_claude_mode()
    # Now it checks every 5 minutes and trades automatically
    
    # Later: User clicks DTR RULES button
    await engine.switch_to_dtr_mode()
    # Now it trades per DTR rules during sessions
    
    # Later: User clicks HALT
    await engine.halt_trading()
    # Trading stops
    
    # Check status anytime
    status = engine.get_status()
    # Returns: {"mode": "dtr_rules", "running": True, "trades_today": 3, ...}
