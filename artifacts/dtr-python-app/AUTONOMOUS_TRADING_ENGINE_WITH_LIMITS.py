"""
Updated Autonomous Trading Engine with Position Limits
======================================================
Adds:
1. One position per symbol (no averaging down)
2. Daily loss limit: -$200 (close all, lock trading)
3. Daily profit limit: +$1,400 (close all, lock trading)
4. Hard stops when limits hit
"""

from POSITION_AND_LIMIT_MANAGER import PositionAndLimitManager
import asyncio
import logging
from datetime import datetime
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# DTR AUTO-EXECUTOR WITH POSITION LIMITS
# ═══════════════════════════════════════════════════════════════════════════

class DTRAutoExecutorWithLimits:
    """
    DTR auto-execution with position limits enforced
    
    Prevents:
    - Multiple positions per symbol
    - Averaging down
    - Over-trading on bad days
    """
    
    def __init__(self, api, notifier, position_manager):
        self.api = api
        self.notifier = notifier
        self.position_manager = position_manager
        self.dtr_state = {}
    
    def set_dtr_state(self, symbol: str, state: Dict[str, Any]):
        """Update DTR state for symbol"""
        self.dtr_state[symbol] = state
    
    async def check_and_execute(self, symbol: str) -> Optional[Dict[str, Any]]:
        """
        Check if can trade, then execute
        
        Enforces position limits
        """
        
        # STEP 1: Check if trading allowed (daily limits)
        can_trade, reason = await self.position_manager.check_can_trade()
        
        if not can_trade:
            logger.warning(f"Cannot trade {symbol}: {reason}")
            return None
        
        # STEP 2: Check position limits (one per symbol)
        state = self.dtr_state.get(symbol, {})
        stage = state.get('stage', 0)
        in_entry_window = state.get('in_entry_window', False)
        bias = state.get('bias', None)
        
        # Check DTR rules
        if stage != 5 or not in_entry_window or bias not in ['LONG', 'SHORT']:
            return None
        
        # Check can enter this position
        side = 'BUY' if bias == 'LONG' else 'SELL'
        can_enter, reason = await self.position_manager.can_enter_position(symbol, side)
        
        if not can_enter:
            logger.info(f"Cannot enter {symbol}: {reason}")
            return None
        
        # STEP 3: All checks passed - EXECUTE
        logger.warning(f"""
╔════════════════════════════════════════╗
║ ⚡ DTR AUTO-EXECUTION TRIGGERED       ║
╠════════════════════════════════════════╣
║ Symbol: {symbol}
║ Stage: 5 (BOS confirmed)
║ Side: {side}
║ Bias: {bias}
╚════════════════════════════════════════╝
        """)
        
        # Get current price (from API or state)
        current_price = state.get('current_price', 0)
        
        trade = await self.api.place_order(
            contract_id=symbol,
            side=side,
            quantity=3,
            order_type="MARKET",
            comment=f"DTR_AUTO_STAGE5_{bias}"
        )
        
        if trade:
            # Record position
            order_id = trade.get('id', 'UNKNOWN')
            await self.position_manager.enter_position(
                symbol, side, current_price, 3, order_id
            )
            
            await self.notifier.send_message(
                f"<b>⚡ DTR AUTO TRADE</b>\n\n"
                f"{symbol} {side}\n"
                f"Stage 5 Triggered\n"
                f"Time: {datetime.now().strftime('%H:%M:%S')}"
            )
            
            return trade
        
        return None
    
    async def continuous_monitor(self, symbols: List[str], interval: int = 30):
        """Continuously monitor and execute"""
        
        logger.info(f"Starting DTR monitor with position limits")
        
        while True:
            try:
                for symbol in symbols:
                    await self.check_and_execute(symbol)
                
                await asyncio.sleep(interval)
            
            except Exception as e:
                logger.error(f"Error in DTR monitor: {e}")
                await asyncio.sleep(interval)


# ═══════════════════════════════════════════════════════════════════════════
# CLAUDE AUTO-EXECUTOR WITH POSITION LIMITS
# ═══════════════════════════════════════════════════════════════════════════

class ClaudeAutoExecutorWithLimits:
    """
    Claude auto-execution with position limits enforced
    
    Prevents:
    - Multiple positions per symbol
    - Averaging down
    - Over-trading on bad days
    """
    
    def __init__(self, api, learning_agent, notifier, position_manager):
        self.api = api
        self.learning_agent = learning_agent
        self.notifier = notifier
        self.position_manager = position_manager
    
    async def check_and_execute(self) -> Optional[Dict[str, Any]]:
        """
        Check if can trade, then execute
        Enforces position limits and bias conflicts
        """
        
        # STEP 1: Check if trading allowed (daily limits)
        can_trade, reason = await self.position_manager.check_can_trade()
        
        if not can_trade:
            return None
        
        # STEP 2: Get current positions and market analysis
        positions = await self.api.get_open_positions()
        market_analysis = await self.learning_agent.analyze_market()
        
        # STEP 3: Check for position conflicts (bias mismatch)
        for symbol, position in positions.items():
            current_bias = market_analysis.get(symbol, {}).get('bias', None)
            confidence = market_analysis.get(symbol, {}).get('confidence', 0)
            
            if current_bias and confidence > 0.75:
                # Check conflict
                if (position['side'] == 'BUY' and current_bias == 'BEARISH') or \
                   (position['side'] == 'SELL' and current_bias == 'BULLISH'):
                    
                    logger.warning(f"""
╔════════════════════════════════════════╗
║ 🔄 BIAS CONFLICT - AUTO EXIT           ║
╠════════════════════════════════════════╣
║ Symbol: {symbol}
║ Position: {position['side']}
║ Bias: {current_bias}
║ Confidence: {confidence:.0%}
║ Action: EXIT and REVERSE
╚════════════════════════════════════════╝
                    """)
                    
                    # Close position
                    exit_price = market_analysis[symbol].get('current_price', 0)
                    pnl = position.get('unrealized_pnl', 0)
                    
                    await self.api.close_position(symbol=symbol)
                    await self.position_manager.exit_position(symbol, exit_price, pnl)
                    
                    # Brief pause
                    await asyncio.sleep(0.5)
                    
                    # Reverse
                    new_side = 'SELL' if position['side'] == 'BUY' else 'BUY'
                    
                    trade = await self.api.place_order(
                        contract_id=symbol,
                        side=new_side,
                        quantity=3,
                        order_type="MARKET",
                        comment=f"CLAUDE_BIAS_REVERSE"
                    )
                    
                    if trade:
                        await self.position_manager.enter_position(
                            symbol, new_side, exit_price, 3, trade.get('id')
                        )
                        
                        await self.notifier.send_message(
                            f"<b>🔄 BIAS CONFLICT</b>\n\n"
                            f"{symbol}\n"
                            f"{position['side']} → {new_side}\n"
                            f"P&L Exit: ${pnl:.2f}"
                        )
                        
                        return trade
        
        # STEP 4: Check for new entries (Claude signals)
        for symbol, analysis in market_analysis.items():
            
            # Can't enter if already in position
            can_enter, reason = await self.position_manager.can_enter_position(
                symbol,
                analysis.get('recommendation', 'BUY')
            )
            
            if not can_enter:
                continue
            
            confidence = analysis.get('confidence', 0)
            recommendation = analysis.get('recommendation', None)
            
            if confidence < 0.60 or recommendation not in ['BUY', 'SELL']:
                continue
            
            logger.info(f"""
╔════════════════════════════════════════╗
║ 🧠 CLAUDE ENTRY TRIGGERED              ║
╠════════════════════════════════════════╣
║ Symbol: {symbol}
║ Signal: {recommendation}
║ Confidence: {confidence:.0%}
╚════════════════════════════════════════╝
            """)
            
            current_price = analysis.get('current_price', 0)
            
            trade = await self.api.place_order(
                contract_id=symbol,
                side=recommendation,
                quantity=3,
                order_type="MARKET",
                comment=f"CLAUDE_AUTO_{confidence:.0%}"
            )
            
            if trade:
                await self.position_manager.enter_position(
                    symbol, recommendation, current_price, 3, trade.get('id')
                )
                
                await self.notifier.send_message(
                    f"<b>🧠 CLAUDE TRADE</b>\n\n"
                    f"{symbol} {recommendation}\n"
                    f"Confidence: {confidence:.0%}"
                )
                
                return trade
        
        return None
    
    async def continuous_monitor(self, interval: int = 30):
        """Continuously monitor and execute"""
        
        logger.info(f"Starting Claude monitor with position limits")
        
        while True:
            try:
                await self.check_and_execute()
                await asyncio.sleep(interval)
            
            except Exception as e:
                logger.error(f"Error in Claude monitor: {e}")
                await asyncio.sleep(interval)


# ═══════════════════════════════════════════════════════════════════════════
# UPDATED MASTER ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════════════════

class MasterTradingOrchestratorWithLimits:
    """
    Complete orchestrator with position limits
    
    Enforces:
    1. One position per symbol
    2. Daily loss limit: -$200
    3. Daily profit limit: +$1,400
    4. Trading lock when limits hit
    """
    
    def __init__(self, api, learning_agent, notifier):
        self.api = api
        self.learning_agent = learning_agent
        self.notifier = notifier
        
        self.position_manager = PositionAndLimitManager(notifier)
        
        self.dtr_executor = DTRAutoExecutorWithLimits(api, notifier, self.position_manager)
        self.claude_executor = ClaudeAutoExecutorWithLimits(
            api, learning_agent, notifier, self.position_manager
        )
        
        self.mode = "halted"
        self.monitor_task = None
        self.symbols = ['MNQM26', 'MYMM26', 'MGCM26', 'MCLK26']
    
    async def switch_to_dtr_mode(self):
        """Switch to DTR mode with position limits"""
        
        self.mode = "dtr"
        
        if self.monitor_task:
            self.monitor_task.cancel()
        
        self.monitor_task = asyncio.create_task(
            self.dtr_executor.continuous_monitor(self.symbols, interval=30)
        )
        
        await self.notifier.send_message(
            "<b>📊 DTR MODE ACTIVE</b>\n\n"
            "Auto-execution: ON\n"
            "Position limits: ENFORCED\n"
            "Loss limit: -$200\n"
            "Profit limit: +$1,400\n"
            "Lock when hit: YES"
        )
        
        logger.info("✓ DTR auto mode started with position limits")
    
    async def switch_to_claude_mode(self):
        """Switch to Claude mode with position limits"""
        
        self.mode = "claude"
        
        if self.monitor_task:
            self.monitor_task.cancel()
        
        self.monitor_task = asyncio.create_task(
            self.claude_executor.continuous_monitor(interval=30)
        )
        
        await self.notifier.send_message(
            "<b>🧠 CLAUDE MODE ACTIVE</b>\n\n"
            "Auto-execution: ON\n"
            "Bias conflict exit: ENABLED\n"
            "Position limits: ENFORCED\n"
            "Loss limit: -$200\n"
            "Profit limit: +$1,400\n"
            "Lock when hit: YES"
        )
        
        logger.info("✓ Claude auto mode started with position limits")
    
    async def halt_trading(self):
        """Halt trading"""
        
        self.mode = "halted"
        
        if self.monitor_task:
            self.monitor_task.cancel()
        
        await self.notifier.send_message("<b>⏹️ TRADING HALTED</b>")
        logger.info("Trading halted")
    
    def get_status(self) -> Dict[str, Any]:
        """Get orchestrator status"""
        
        position_summary = self.position_manager.get_summary()
        
        return {
            'mode': self.mode,
            'auto_executing': self.monitor_task is not None and not self.monitor_task.done(),
            'position_summary': position_summary,
            'timestamp': datetime.now().isoformat()
        }
    
    def update_dtr_state(self, symbol: str, state: Dict[str, Any]):
        """Update DTR state"""
        self.dtr_executor.set_dtr_state(symbol, state)
