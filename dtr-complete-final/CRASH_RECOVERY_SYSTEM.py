"""
Persistent State Manager & Crash Recovery
==========================================
Survives Replit crashes by maintaining state on disk
Implements retry logic for failed executions
Health checks and monitoring

Features:
- Save trade attempts to disk
- Resume from last state after crash
- Automatic retry on failure
- Health monitoring
- Telegram alerts on system issues
"""

import json
import logging
from datetime import datetime, date, timedelta
from typing import Dict, Any, Optional, List
import os
from enum import Enum

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# STATE ENUMS
# ═══════════════════════════════════════════════════════════════════════════

class TradeState(Enum):
    """Trade execution state"""
    PENDING = "pending"           # Decision made, awaiting execution
    EXECUTING = "executing"       # Attempting to execute
    EXECUTED = "executed"         # Successfully placed on platform
    FILLED = "filled"             # Order filled
    EXITING = "exiting"           # Exit order in progress
    CLOSED = "closed"             # Trade complete
    FAILED = "failed"             # Execution failed
    RETRY = "retry"               # Pending retry


class SystemState(Enum):
    """System health state"""
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"
    RECOVERING = "recovering"


# ═══════════════════════════════════════════════════════════════════════════
# PERSISTENT STATE MANAGER
# ═══════════════════════════════════════════════════════════════════════════

class PersistentStateManager:
    """
    Saves system state to disk for crash recovery
    
    Can resume trading after Replit crashes
    """
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.state_dir = f"{data_dir}/state"
        self.ensure_directories()
    
    def ensure_directories(self):
        """Create state directories"""
        os.makedirs(self.state_dir, exist_ok=True)
        os.makedirs(f"{self.state_dir}/trades", exist_ok=True)
        os.makedirs(f"{self.state_dir}/system", exist_ok=True)
    
    def save_trade_state(self, trade_id: str, state: Dict[str, Any]) -> bool:
        """
        Save trade state to disk
        
        Args:
            trade_id: Unique trade identifier
            state: Trade state dict
        
        Returns:
            True if saved successfully
        """
        
        try:
            state_file = f"{self.state_dir}/trades/{trade_id}.json"
            
            # Add timestamp
            state['last_updated'] = datetime.now().isoformat()
            
            with open(state_file, 'w') as f:
                json.dump(state, f, indent=2)
            
            logger.info(f"✓ Trade state saved: {trade_id}")
            return True
        
        except Exception as e:
            logger.error(f"❌ Error saving trade state: {e}")
            return False
    
    def load_trade_state(self, trade_id: str) -> Optional[Dict[str, Any]]:
        """Load trade state from disk"""
        
        try:
            state_file = f"{self.state_dir}/trades/{trade_id}.json"
            
            if os.path.exists(state_file):
                with open(state_file, 'r') as f:
                    state = json.load(f)
                
                logger.info(f"✓ Trade state loaded: {trade_id}")
                return state
            
            return None
        
        except Exception as e:
            logger.error(f"❌ Error loading trade state: {e}")
            return None
    
    def get_pending_trades(self) -> List[Dict[str, Any]]:
        """Get all trades awaiting execution or retry"""
        
        try:
            trades_dir = f"{self.state_dir}/trades"
            pending = []
            
            if os.path.exists(trades_dir):
                for filename in os.listdir(trades_dir):
                    if filename.endswith('.json'):
                        trade = self.load_trade_state(filename.replace('.json', ''))
                        
                        if trade:
                            state = trade.get('state', '')
                            
                            # Get trades that need action
                            if state in [TradeState.PENDING.value, TradeState.RETRY.value]:
                                pending.append(trade)
            
            logger.info(f"Found {len(pending)} pending trades to retry")
            return pending
        
        except Exception as e:
            logger.error(f"❌ Error getting pending trades: {e}")
            return []
    
    def save_system_state(self, state: Dict[str, Any]) -> bool:
        """Save overall system state"""
        
        try:
            state_file = f"{self.state_dir}/system/current_state.json"
            
            state['last_update'] = datetime.now().isoformat()
            
            with open(state_file, 'w') as f:
                json.dump(state, f, indent=2)
            
            logger.info(f"✓ System state saved")
            return True
        
        except Exception as e:
            logger.error(f"❌ Error saving system state: {e}")
            return False
    
    def load_system_state(self) -> Optional[Dict[str, Any]]:
        """Load system state from disk"""
        
        try:
            state_file = f"{self.state_dir}/system/current_state.json"
            
            if os.path.exists(state_file):
                with open(state_file, 'r') as f:
                    state = json.load(f)
                
                logger.info(f"✓ System state loaded")
                return state
            
            return None
        
        except Exception as e:
            logger.error(f"❌ Error loading system state: {e}")
            return None


# ═══════════════════════════════════════════════════════════════════════════
# RETRY MANAGER
# ═══════════════════════════════════════════════════════════════════════════

class RetryManager:
    """
    Handles automatic retries for failed executions
    
    Exponential backoff:
    - Attempt 1: Immediate
    - Attempt 2: 30 seconds
    - Attempt 3: 2 minutes
    - Attempt 4: 5 minutes
    - Attempt 5: Stop (manual review)
    """
    
    def __init__(self, max_retries: int = 5):
        self.max_retries = max_retries
        self.retry_delays = {
            1: 0,      # Immediate
            2: 30,     # 30 sec
            3: 120,    # 2 min
            4: 300,    # 5 min
            5: 1800    # 30 min
        }
    
    def should_retry(self, trade_state: Dict[str, Any]) -> bool:
        """
        Check if trade should be retried
        
        Args:
            trade_state: Current trade state
        
        Returns:
            True if retry should happen
        """
        
        attempt = trade_state.get('attempt_count', 0)
        last_attempt = trade_state.get('last_attempt_time', '')
        
        if attempt >= self.max_retries:
            logger.warning(f"Max retries reached for trade")
            return False
        
        if attempt == 0:
            return True  # First attempt
        
        # Check if enough time has passed
        try:
            last_time = datetime.fromisoformat(last_attempt)
            elapsed = (datetime.now() - last_time).total_seconds()
            delay = self.retry_delays.get(attempt + 1, 3600)
            
            if elapsed >= delay:
                logger.info(f"Ready to retry (attempt {attempt + 1})")
                return True
        
        except:
            pass
        
        return False
    
    def get_retry_delay(self, attempt: int) -> int:
        """Get delay (seconds) before next retry"""
        return self.retry_delays.get(attempt, 3600)
    
    def update_retry_attempt(self, trade_state: Dict[str, Any]) -> Dict[str, Any]:
        """Update trade state for retry"""
        
        trade_state['attempt_count'] = trade_state.get('attempt_count', 0) + 1
        trade_state['last_attempt_time'] = datetime.now().isoformat()
        trade_state['state'] = TradeState.RETRY.value
        
        return trade_state


# ═══════════════════════════════════════════════════════════════════════════
# HEALTH MONITOR
# ═══════════════════════════════════════════════════════════════════════════

class HealthMonitor:
    """
    Monitors system health
    Sends alerts if issues detected
    """
    
    def __init__(self, notifier=None):
        self.notifier = notifier
        self.last_check = datetime.now()
        self.consecutive_errors = 0
        self.max_consecutive_errors = 5
    
    async def check_system_health(
        self,
        api_connected: bool,
        trades_executing: bool,
        replit_memory_ok: bool
    ) -> Dict[str, Any]:
        """
        Check overall system health
        
        Args:
            api_connected: Is ProjectX API responding
            trades_executing: Are trades being executed
            replit_memory_ok: Is Replit memory usage OK
        
        Returns:
            Health status report
        """
        
        status = {
            "timestamp": datetime.now().isoformat(),
            "api_connected": api_connected,
            "trades_executing": trades_executing,
            "memory_ok": replit_memory_ok,
            "health": "GOOD"
        }
        
        # Detect issues
        if not api_connected:
            self.consecutive_errors += 1
            status['health'] = "ERROR"
            status['issue'] = "API not responding"
            
            logger.error("❌ API connection lost")
            
            if self.notifier and self.consecutive_errors == 1:
                await self.notifier.send_message(
                    "<b>🚨 SYSTEM ALERT</b>\n\n"
                    "API connection lost\n"
                    "Trading may be affected"
                )
        
        elif not replit_memory_ok:
            self.consecutive_errors += 1
            status['health'] = "WARNING"
            status['issue'] = "Memory usage high"
            
            logger.warning("⚠️ Memory usage high")
            
            if self.notifier and self.consecutive_errors == 1:
                await self.notifier.send_message(
                    "<b>⚠️ SYSTEM WARNING</b>\n\n"
                    "Memory usage is high\n"
                    "System may need restart"
                )
        
        else:
            self.consecutive_errors = 0
            status['health'] = "GOOD"
        
        # Critical alert after 5 consecutive errors
        if self.consecutive_errors >= self.max_consecutive_errors:
            status['health'] = "CRITICAL"
            
            if self.notifier:
                await self.notifier.send_message(
                    "<b>🚨 CRITICAL ALERT</b>\n\n"
                    f"System has {self.consecutive_errors} consecutive errors\n"
                    "Manual intervention required!"
                )
        
        return status
    
    async def send_heartbeat(self, notifier=None):
        """Send periodic heartbeat to confirm system is running"""
        
        try:
            if notifier:
                await notifier.send_message(
                    f"💓 System heartbeat\n"
                    f"Time: {datetime.now().strftime('%H:%M:%S')}\n"
                    f"Status: Running"
                )
        
        except Exception as e:
            logger.error(f"Error sending heartbeat: {e}")


# ═══════════════════════════════════════════════════════════════════════════
# CRASH RECOVERY HANDLER
# ═══════════════════════════════════════════════════════════════════════════

class CrashRecoveryHandler:
    """
    Handles recovery after Replit crashes
    Resumes pending trades and retries
    """
    
    def __init__(self, state_manager: PersistentStateManager, retry_manager: RetryManager):
        self.state_manager = state_manager
        self.retry_manager = retry_manager
    
    def get_recovery_tasks(self) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get all tasks that need to be completed after crash recovery
        
        Returns:
            {
                "pending": [trades waiting to execute],
                "retry": [trades needing retry]
            }
        """
        
        pending = self.state_manager.get_pending_trades()
        
        retry_tasks = []
        
        for trade in pending:
            if trade.get('state') == TradeState.RETRY.value:
                if self.retry_manager.should_retry(trade):
                    retry_tasks.append(trade)
        
        return {
            "pending": [t for t in pending if t.get('state') == TradeState.PENDING.value],
            "retry": retry_tasks
        }
    
    async def recover_after_crash(self, api, notifier=None) -> Dict[str, Any]:
        """
        Recover from crash and resume trading
        
        Args:
            api: ProjectX API client
            notifier: Telegram notifier
        
        Returns:
            Recovery result
        """
        
        logger.info("\n" + "="*80)
        logger.info("🔄 CRASH RECOVERY IN PROGRESS")
        logger.info("="*80)
        
        recovery_tasks = self.get_recovery_tasks()
        
        result = {
            "timestamp": datetime.now().isoformat(),
            "recovered_pending": 0,
            "recovered_retry": 0,
            "failed": 0,
            "details": []
        }
        
        # Process pending trades
        for trade in recovery_tasks['pending']:
            try:
                logger.info(f"Recovering pending trade: {trade.get('symbol')}")
                
                # Place order
                order = await api.place_order(
                    contract_id=trade['symbol'],
                    side=trade['side'],
                    quantity=trade['qty'],
                    order_type="MARKET",
                    comment=f"RECOVERY_{trade.get('original_id', 'UNKNOWN')}"
                )
                
                if order:
                    trade['state'] = TradeState.EXECUTED.value
                    trade['order_id'] = order.get('id')
                    trade['recovered_at'] = datetime.now().isoformat()
                    
                    self.state_manager.save_trade_state(trade.get('id'), trade)
                    
                    result['recovered_pending'] += 1
                    logger.info(f"✓ Recovered: {trade.get('symbol')}")
                    
                    if notifier:
                        await notifier.send_message(
                            f"<b>✓ Trade Recovered</b>\n\n"
                            f"{trade['symbol']} {trade['side']}\n"
                            f"Qty: {trade['qty']}\n"
                            f"Order: {order.get('id')}"
                        )
                
                else:
                    result['failed'] += 1
                    result['details'].append(f"Failed: {trade.get('symbol')}")
            
            except Exception as e:
                result['failed'] += 1
                result['details'].append(f"Error: {str(e)}")
                logger.error(f"❌ Recovery failed: {e}")
        
        # Process retry trades
        for trade in recovery_tasks['retry']:
            try:
                logger.info(f"Retrying trade: {trade.get('symbol')} (attempt {trade.get('attempt_count')})")
                
                order = await api.place_order(
                    contract_id=trade['symbol'],
                    side=trade['side'],
                    quantity=trade['qty'],
                    order_type="MARKET",
                    comment=f"RETRY_{trade.get('attempt_count')}"
                )
                
                if order:
                    trade['state'] = TradeState.EXECUTED.value
                    trade['order_id'] = order.get('id')
                    
                    self.state_manager.save_trade_state(trade.get('id'), trade)
                    
                    result['recovered_retry'] += 1
                    logger.info(f"✓ Retried: {trade.get('symbol')}")
                
                else:
                    # Increment retry counter
                    self.retry_manager.update_retry_attempt(trade)
                    self.state_manager.save_trade_state(trade.get('id'), trade)
            
            except Exception as e:
                logger.error(f"❌ Retry failed: {e}")
        
        # Send recovery summary
        if notifier:
            await notifier.send_message(
                f"<b>🔄 Crash Recovery Complete</b>\n\n"
                f"Recovered pending: {result['recovered_pending']}\n"
                f"Recovered retry: {result['recovered_retry']}\n"
                f"Failed: {result['failed']}\n"
                f"Time: {datetime.now().strftime('%H:%M:%S')}"
            )
        
        logger.info("="*80)
        logger.info(f"Recovery complete: {result}")
        logger.info("="*80 + "\n")
        
        return result
