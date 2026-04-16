"""
Updated Flask App - Autonomous Trading Integration
===================================================
DTR Mode: Auto-executes on stage 5
Claude Mode: Auto-executes on signal + exits on bias conflict
Both modes: No manual clicks needed, continuous monitoring
"""

from flask import Flask, render_template, jsonify, request
from AUTONOMOUS_TRADING_ENGINE import MasterTradingOrchestrator
import asyncio
import os
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# INITIALIZE ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════════════════

# These should be initialized from your existing modules
api = None  # ProjectXAPI instance
learning_agent = None  # Learning agent instance
notifier = None  # Telegram notifier instance
pl_tracker = None  # P&L tracker instance

orchestrator = None

def init_orchestrator():
    """Initialize after all components ready"""
    global orchestrator
    orchestrator = MasterTradingOrchestrator(api, learning_agent, notifier)
    logger.info("✓ Orchestrator initialized")

# ═══════════════════════════════════════════════════════════════════════════
# DTR MODE ENDPOINTS (Auto-Execute)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/dtr', methods=['POST'])
async def switch_to_dtr():
    """
    Switch to DTR rules mode
    Auto-executes trades when stage 5 + entry window met
    No manual clicks after this
    Continuous monitoring every 30 seconds
    """
    try:
        await orchestrator.switch_to_dtr_mode()
        
        return jsonify({
            'success': True,
            'mode': 'dtr',
            'message': 'DTR auto-execution started',
            'auto_execution': True,
            'monitoring_interval': 30,
            'status': 'Running - checking every 30 seconds'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# CLAUDE MODE ENDPOINTS (Auto-Execute)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/claude', methods=['POST'])
async def switch_to_claude():
    """
    Switch to Claude AI mode
    Auto-executes on Claude signals (60%+ confidence)
    Auto-exits on bias conflicts
    No manual clicks after this
    Continuous monitoring every 30 seconds
    """
    try:
        await orchestrator.switch_to_claude_mode()
        
        return jsonify({
            'success': True,
            'mode': 'claude',
            'message': 'Claude auto-execution started',
            'auto_execution': True,
            'bias_conflict_exit': True,
            'monitoring_interval': 30,
            'status': 'Running - checking every 30 seconds'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ═══════════════════════════════════════════════════════════════════════════
# HALT ENDPOINT
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/mode/halt', methods=['POST'])
async def halt_trading():
    """Stop all auto-execution"""
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
        'daily_trades': {
            'dtr': status['dtr_daily_trades'],
            'claude': status['claude_daily_trades']
        },
        'message': f"Mode: {status['mode'].upper()}, Auto: {'ON' if status['auto_executing'] else 'OFF'}"
    })

@app.route('/api/orchestrator/status')
def orchestrator_status():
    """Get full orchestrator status"""
    status = orchestrator.get_status()
    
    status_text = {
        'halted': '⏹️ HALTED - No trading',
        'dtr': f"📊 DTR AUTO - Running ({status['monitor_interval']}s checks)",
        'claude': f"🧠 CLAUDE AUTO - Running ({status['monitor_interval']}s checks)"
    }
    
    return jsonify({
        'success': True,
        'status': status,
        'human_readable': status_text[status['mode']],
        'auto_execution_active': status['auto_executing']
    })

# ═══════════════════════════════════════════════════════════════════════════
# DASHBOARD ENDPOINT (Real-Time Updates)
# ═══════════════════════════════════════════════════════════════════════════

@app.route('/api/live/dashboard')
def live_dashboard():
    """
    Get complete dashboard data
    Updates every 2 seconds in browser (WebSocket would be better)
    Shows orchestrator status + P&L
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
    Orchestrator monitors and auto-executes when stage 5
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
    """
    try:
        data = request.json
        bias_data = data.get('bias_data')  # {'MNQM26': 'BULLISH', ...}
        
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
    """Main dashboard with mode controls"""
    return render_template('dashboard_autonomous.html')

# ═══════════════════════════════════════════════════════════════════════════
# STARTUP
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("\n" + "="*80)
    print("AUTONOMOUS TRADING ENGINE")
    print("="*80)
    print("✓ DTR Mode: Auto-executes on stage 5")
    print("✓ Claude Mode: Auto-executes on signal + exits on bias conflict")
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
