"""
Trading Engine with Kelly Criterion Position Sizing
====================================================
Integrates dynamic position sizing into continuous trading system
"""

from KELLY_CRITERION_POSITION_SIZING import PositionSizingManager
from CONTINUOUS_TRADING_MODES import ContinuousTradingEngine
from TRADE_LOGGER_TELEGRAM import TradeExecutorWithLogging
from LIVE_PL_TRACKER import LivePLTracker
import logging
import json
from datetime import datetime, date

logger = logging.getLogger(__name__)


class EnhancedTradingEngine(ContinuousTradingEngine):
    """
    Enhanced trading engine with Kelly Criterion position sizing
    Automatically scales contracts up/down based on:
    - Win rate and risk/reward ratio
    - Win/loss streaks
    - Account growth
    - Confidence levels
    """
    
    def __init__(self, api, learning_agent, initial_balance: float = 150000.0):
        super().__init__(api, learning_agent)
        
        # Add position sizing manager
        self.pos_manager = PositionSizingManager(initial_balance=initial_balance)
        self.learning_agent = learning_agent
        
        # Store trade history for calculations
        self.daily_trades = []
        self.daily_pnl = 0.0
        self.pl_tracker = None
    
    async def get_optimal_position_size(self, confidence: float) -> int:
        """
        Calculate optimal position size using Kelly Criterion
        
        Args:
            confidence: Claude's confidence in the signal (0-1)
        
        Returns:
            Number of contracts to trade
        """
        
        try:
            # Get historical performance from learning agent
            learned_rules = self.learning_agent.claude_brain.learned_rules
            symbol_perf = learned_rules.get('symbol_performance', {})
            
            # Calculate overall stats
            total_trades = 0
            total_wins = 0
            total_pnl = 0
            total_pnl_abs = 0
            
            for symbol, perf in symbol_perf.items():
                total_trades += perf.get('trades', 0)
                total_wins += perf.get('wins', 0)
                total_pnl += perf.get('total_pnl', 0)
                total_pnl_abs += abs(perf.get('total_pnl', 0))
            
            # Calculate averages
            win_rate = (total_wins / total_trades) if total_trades > 0 else 0.5
            avg_win = (total_pnl / total_wins) if total_wins > 0 else 1000
            avg_loss = (total_pnl_abs / (total_trades - total_wins)) if (total_trades - total_wins) > 0 else 500
            
            logger.info(f"Position sizing calc: WR={win_rate:.1%}, Avg Win=${avg_win:.0f}, Avg Loss=${avg_loss:.0f}")
            
            # Get Kelly-based position size
            sizing = self.pos_manager.calculate_position_size(
                win_rate=win_rate,
                avg_win=avg_win,
                avg_loss=avg_loss,
                confidence=confidence,
                risk_reward_ratio=2.0  # Conservative 2:1 RR
            )
            
            contracts = sizing['recommended_contracts']
            
            logger.info(f"""
Position Sizing Decision:
├─ Base Kelly: {sizing['kelly_calculation']['base_contracts']} contracts
├─ Streak multiplier: {sizing['dynamic_scaling']['lot_multiplier']:.2f}x
├─ Account scaling: {sizing['account_scaling']['growth_multiplier']:.2f}x
└─ Final: {contracts} contracts
Confidence: {confidence:.1%}
""")
            
            return contracts
        
        except Exception as e:
            logger.error(f"Error calculating position size: {e}")
            return 2  # Fallback to 2 contracts
    
    async def execute_trade_with_sizing(
        self,
        symbol: str,
        decision: dict,
        mode: str
    ) -> dict:
        """
        Execute trade with Kelly-optimized position sizing
        
        Args:
            symbol: Trading pair
            decision: Claude's decision with confidence
            mode: Trading mode (CLAUDE or DTR)
        
        Returns:
            Execution result with actual contracts used
        """
        
        try:
            # Get optimal position size based on confidence
            contracts = await self.get_optimal_position_size(
                confidence=decision['confidence']
            )
            
            # Update decision with actual contracts
            decision['suggested_contracts'] = contracts
            
            logger.info(f"Executing {symbol} {decision['recommendation']} {contracts} contracts")
            
            # Get current price for entry
            bars = await self.api.get_bars(symbol, limit=1)
            current_price = bars[-1]['close'] if bars else 0
            
            # Place order
            order = await self.api.place_order(
                contract_id=symbol,
                side=decision['recommendation'],
                quantity=contracts,
                order_type="MARKET",
                comment=f"KELLY_{mode}_CF{decision['confidence']:.0%}"
            )
            
            if order:
                return {
                    "success": True,
                    "symbol": symbol,
                    "side": decision['recommendation'],
                    "contracts": contracts,
                    "entry_price": current_price,
                    "order_id": order.get('id', 'UNKNOWN'),
                    "confidence": decision['confidence'],
                    "kelly_calculated": True
                }
            else:
                return {"success": False, "error": "Order failed"}
        
        except Exception as e:
            logger.error(f"Error executing trade with sizing: {e}")
            return {"success": False, "error": str(e)}
    
    def record_trade_completion(self, trade_data: dict):
        """
        Record completed trade for position sizing learning
        
        Args:
            trade_data: Completed trade with P&L
        """
        
        try:
            # Update position manager
            self.pos_manager.record_trade_result({
                'pnl': trade_data.get('pnl', 0),
                'win': trade_data.get('win', False)
            })
            
            # Update daily totals
            self.daily_trades.append(trade_data)
            self.daily_pnl += trade_data.get('pnl', 0)
            
            # Log update
            metrics = self.pos_manager.lot_sizer.get_current_metrics()
            logger.info(f"""
Trade recorded for sizing:
├─ Win streak: {metrics['win_streak']}
├─ Loss streak: {metrics['loss_streak']}
├─ Recent win rate: {metrics['win_rate']:.1f}%
└─ Next trade will adjust to this streak
""")
        
        except Exception as e:
            logger.error(f"Error recording trade: {e}")
    
    def update_account_balance(self, new_balance: float):
        """
        Update account balance for automatic scaling
        
        Args:
            new_balance: Current account balance
        """
        
        try:
            self.pos_manager.update_balance(new_balance)
            self.pos_manager.scale_daily_limits()
            
            status = self.pos_manager.get_status()
            growth = status['account']['growth_percent']
            
            logger.info(f"""
Account Update for Scaling:
├─ New balance: ${new_balance:,.2f}
├─ Growth: +{growth:.2f}%
└─ Daily limits scaled accordingly
""")
        
        except Exception as e:
            logger.error(f"Error updating balance: {e}")
    
    def get_position_sizing_status(self) -> dict:
        """Get current position sizing status"""
        return self.pos_manager.get_status()
    
    def get_daily_summary_with_sizing(self) -> dict:
        """Get daily summary including position sizing metrics"""
        
        status = self.pos_manager.get_status()
        
        return {
            "date": str(date.today()),
            "trades": len(self.daily_trades),
            "daily_pnl": self.daily_pnl,
            "account": status['account'],
            "streaks": status['streaks'],
            "position_sizing": {
                "average_contracts": sum(t.get('qty', 0) for t in self.daily_trades) / len(self.daily_trades) if self.daily_trades else 0,
                "max_contracts": max((t.get('qty', 0) for t in self.daily_trades), default=0),
                "min_contracts": min((t.get('qty', 0) for t in self.daily_trades), default=0),
                "scaling_active": True,
                "kelly_applied": True
            }
        }


# ═══════════════════════════════════════════════════════════════════════════
# INTEGRATION WITH FLASK
# ═══════════════════════════════════════════════════════════════════════════

"""
To integrate into flask_with_logging_telegram.py:

1. Replace import:
   from CONTINUOUS_TRADING_MODES import ContinuousTradingEngine
   
   With:
   from KELLY_CRITERION_TRADING_ENGINE import EnhancedTradingEngine

2. Initialize:
   trading_engine = EnhancedTradingEngine(
       api=api,
       learning_agent=learning_agent,
       initial_balance=150000.0
   )

3. When executing trade:
   result = await trading_engine.execute_trade_with_sizing(
       symbol=symbol,
       decision=claude_decision,
       mode="CLAUDE"
   )

4. When trade completes:
   trading_engine.record_trade_completion({
       'pnl': pnl_amount,
       'win': pnl_amount >= 0,
       'qty': contracts_used
   })

5. When account updates:
   trading_engine.update_account_balance(new_balance_from_api)

6. Status endpoint:
   GET /api/position-sizing/status
   Returns Kelly sizing metrics and streak info
"""
