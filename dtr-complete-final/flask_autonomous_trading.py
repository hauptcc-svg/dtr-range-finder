"""
Updated Flask App - With Position Limits Integrated
===================================================
CORRECTED VERSION - Use this file in Replit

Changes:
1. Imports MasterTradingOrchestratorWithLimits (not old version)
2. Position limits enforced (one per symbol)
3. Daily loss limit: -$200
4. Daily profit limit: +$1,400
"""

from flask import Flask, render_template, jsonify, request
from POSITION_AND_LIMIT_MANAGER import PositionAndLimitManager
from AUTONOMOUS_TRADING_ENGINE_WITH_LIMITS import MasterTradingOrchestratorWithLimits
import asyncio
import os
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# INITIALIZE ORCHESTRATOR WITH POSITION LIMITS
# ═══════════════════════════════════════════════════════════════════════════

# These should be initialized from your existing modules
api = None  # ProjectXAPI instance
learning_agent = None  # Learning agent instance
notifier = None  # Telegram notifier instance
pl_tracker = None  # P&L tracker instance

orchestrator = None

def init_orchestrator():
    """Initialize orchestrator with position limits"""
    global orchestrator
    orchestrator = MasterTradingOrchestratorWithLimits(api, learning_agent, notifier)
    logger.info("✓ Orchestrator initialized WITH POSITION LIMITS")

# ═══════════════════════════════════════════════════════════════════════════
# DTR MODE ENDPOINTS (Auto-Execute with Position Limits)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/dtr', methods=['POST'])
async def switch_to_dtr():
    """
    Switch to DTR rules mode with position limits
    Auto-executes trades when stage 5 + entry window met
    Enforces: One position per symbol, daily loss limit (-$200), daily profit limit (+$1,400)
    """
    try:
        await orchestrator.switch_to_dtr_mode()
        
        return jsonify({
            'success': True,
            'mode': 'dtr',
            'message': 'DTR auto-execution started WITH POSITION LIMITS',
            'auto_execution': True,
            'monitoring_interval': 30,
            'position_limits': {
                'one_per_symbol': True,
                'loss_limit': -200,
                'profit_limit': 1400
            },
            'status': 'Running - checking every 30 seconds'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# CLAUDE MODE ENDPOINTS (Auto-Execute with Position Limits)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/claude', methods=['POST'])
async def switch_to_claude():
    """
    Switch to Claude AI mode with position limits
    Auto-executes on Claude signals (60%+ confidence)
    Auto-exits on bias conflicts
    Enforces: One position per symbol, daily loss limit (-$200), daily profit limit (+$1,400)
    """
    try:
        await orchestrator.switch_to_claude_mode()
        
        return jsonify({
            'success': True,
            'mode': 'claude',
            'message': 'Claude auto-execution started WITH POSITION LIMITS',
            'auto_execution': True,
            'bias_conflict_exit': True,
            'monitoring_interval': 30,
            'position_limits': {
                'one_per_symbol': True,
                'loss_limit': -200,
                'profit_limit': 1400
            },
            'status': 'Running - checking every 30 seconds'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# HALT ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/halt', methods=['POST'])
async def halt_trading():
    """Stop all auto-execution and trading"""
    try:
        await orchestrator.halt_trading()
        
        return jsonify({
            'success': True,
            'mode': 'halted',
            'message': 'Trading halted',
            'auto_execution': False,
            'status': 'All monitoring stopped'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# STATUS ENDPOINTS
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/status')
def mode_status():
    """Get current mode and auto-execution status"""
    status = orchestrator.get_status()
    
    return jsonify({
        'success': True,
        'mode': status['mode'],
        'auto_executing': status['auto_executing'],
        'monitoring_interval': status['monitor_interval'],
        'position_limits': status['position_limits'],
        'message': f"Mode: {status['mode'].upper()}, Auto: {'ON' if status['auto_executing'] else 'OFF'}"
    })

@app.route('/api/orchestrator/status')
def orchestrator_status():
    """Get full orchestrator status"""
    status = orchestrator.get_status()
    
    status_text = {
        'halted': '⏹️ HALTED - No trading',
        'dtr': f"📊 DTR AUTO - Running ({status['monitor_interval']}s checks) - Position limits ENFORCED",
        'claude': f"🧠 CLAUDE AUTO - Running ({status['monitor_interval']}s checks) - Position limits ENFORCED"
    }
    
    return jsonify({
        'success': True,
        'status': status,
        'human_readable': status_text[status['mode']],
        'auto_execution_active': status['auto_executing'],
        'position_limits_enforced': True,
        'loss_limit': -200,
        'profit_limit': 1400
    })

# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARD ENDPOINT (Real-Time Updates with Position Limits)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/live/dashboard')
def live_dashboard():
    """
    Get complete dashboard data with position limits
    Updates every 2 seconds in browser
    Shows orchestrator status + P&L + position limits
    """
    
    try:
        orchestrator_status = orchestrator.get_status()
        pl_data = pl_tracker.get_dashboard_data() if pl_tracker else {}
        
        dashboard = {
            'success': True,
            'timestamp': orchestrator_status['timestamp'],
            'orchestrator': orchestrator_status,
            'trading': {
                'mode': orchestrator_status['mode'],
                'auto_executing': orchestrator_status['auto_executing'],
                'monitoring_interval': orchestrator_status['monitor_interval'],
                'status_text': f"{orchestrator_status['mode'].upper()} - Auto: {'ON' if orchestrator_status['auto_executing'] else 'OFF'}"
            },
            'position_limits': {
                'one_per_symbol': True,
                'loss_limit': -200,
                'profit_limit': 1400,
                'enforced': True
            },
            'p_and_l': pl_data,
            'refresh_note': 'Dashboard auto-refreshes - no manual refresh needed'
        }
        
        return jsonify(dashboard)
    
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# DTR STATE UPDATE ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/dtr/state/update', methods=['POST'])
def update_dtr_state():
    """
    Update DTR state (called by DTR strategy)
    Orchestrator monitors and auto-executes when stage 5 + entry window
    Position limits enforced
    """
    try:
        data = request.json
        symbol = data.get('symbol')
        state = data.get('state')
        
        orchestrator.update_dtr_state(symbol, state)
        
        return jsonify({
            'success': True,
            'symbol': symbol,
            'stage': state.get('stage'),
            'in_entry_window': state.get('in_entry_window'),
            'bias': state.get('bias'),
            'message': f"DTR state updated for {symbol}"
        })
    
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# MARKET BIAS UPDATE ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/market/bias/update', methods=['POST'])
def update_market_bias():
    """
    Update market bias (called by Claude analysis)
    Orchestrator monitors and exits if position conflicts
    Position limits enforced
    """
    try:
        data = request.json
        bias_data = data.get('bias_data')
        
        orchestrator.update_market_bias(bias_data)
        
        return jsonify({
            'success': True,
            'bias_updates': len(bias_data),
            'message': f"Market bias updated"
        })
    
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# MAIN DASHBOARD
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/')
def dashboard():
    """Main dashboard with mode controls and position limits"""
    return render_template('dashboard_autonomous.html')

# ═══════════════════════════════════════════════════════════════════════════
# STARTUP
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("\n" + "="*80)
    print("AUTONOMOUS TRADING ENGINE WITH POSITION LIMITS")
    print("="*80)
    print("✓ DTR Mode: Auto-executes on stage 5")
    print("✓ Claude Mode: Auto-executes on signal + exits on bias conflict")
    print("✓ Position Limits: One per symbol ENFORCED")
    print("✓ Daily Loss Limit: -$200 (auto-close all)")
    print("✓ Daily Profit Limit: +$1,400 (auto-close all)")
    print("✓ Continuous Monitoring: Every 30 seconds")
    print("✓ No Manual Clicks: Fully autonomous after mode selection")
    print("="*80 + "\n")
    
    # Initialize components (replace with your actual initialization)
    # from projectx_api import ProjectXAPI
    # from COMPLETE_LEARNING_SYSTEM import SelfLearningTradingAgent
    # from TRADE_LOGGER_TELEGRAM import TelegramNotifier
    # from LIVE_PL_TRACKER import LivePLTracker
    
    # api = ProjectXAPI(...)
    # learning_agent = SelfLearningTradingAgent(...)
    # notifier = TelegramNotifier(...)
    # pl_tracker = LivePLTracker(...)
    
    # init_orchestrator()
    
    app.run(host='0.0.0.0', port=5000, debug=False)
