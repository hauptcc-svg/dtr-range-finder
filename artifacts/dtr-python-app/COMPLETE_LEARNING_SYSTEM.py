"""
Complete Self-Learning Trading System
======================================
Option B (Daily Learning) + Option C (Claude Trade Now AI Brain)

Two modes:
1. AUTOMATED (runs each session) - learns from trades, improves rules
2. MANUAL (Claude Trade Now button) - uses learned rules to make smart decision

Author: Claude
"""

import json
import logging
from datetime import datetime, date, timedelta
from typing import Dict, List, Optional, Any, Tuple
from collections import defaultdict
import statistics
import os

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════
# PART 1: DAILY LEARNING ENGINE (Option B - Automated)
# ═══════════════════════════════════════════════════════════════════════════

class DailyLearningEngine:
    """
    Runs automatically at end of each trading session
    Analyzes all trades, generates improved rules
    """
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.ensure_directories()
    
    def ensure_directories(self):
        """Create necessary directories"""
        os.makedirs(f"{self.data_dir}/daily_trades", exist_ok=True)
        os.makedirs(f"{self.data_dir}/learned_rules", exist_ok=True)
        os.makedirs(f"{self.data_dir}/performance_reports", exist_ok=True)
    
    def load_daily_trades(self, trading_date: date) -> List[Dict[str, Any]]:
        """Load all trades from a specific date"""
        try:
            with open(f"{self.data_dir}/daily_trades/{trading_date}.json", 'r') as f:
                return [json.loads(line) for line in f if line.strip()]
        except FileNotFoundError:
            logger.warning(f"No trades found for {trading_date}")
            return []
    
    def analyze_by_symbol(self, trades: List[Dict]) -> Dict[str, Dict]:
        """Calculate win rates and performance by symbol"""
        stats = {}
        
        for symbol in ["MNQM26", "MYMM26", "MGCM26", "MCLK26"]:
            symbol_trades = [t for t in trades if t['symbol'] == symbol]
            
            if not symbol_trades:
                continue
            
            wins = sum(1 for t in symbol_trades if t['win'])
            total_pnl = sum(t['pnl'] for t in symbol_trades)
            avg_pnl = total_pnl / len(symbol_trades) if symbol_trades else 0
            
            stats[symbol] = {
                "trades": len(symbol_trades),
                "wins": wins,
                "losses": len(symbol_trades) - wins,
                "win_rate": wins / len(symbol_trades) if symbol_trades else 0,
                "total_pnl": total_pnl,
                "avg_pnl": avg_pnl,
                "best_trade": max((t['pnl'] for t in symbol_trades), default=0),
                "worst_trade": min((t['pnl'] for t in symbol_trades), default=0)
            }
        
        return stats
    
    def analyze_by_time(self, trades: List[Dict]) -> Dict[str, Dict]:
        """Calculate win rates by hour of day"""
        stats = defaultdict(lambda: {"wins": 0, "trades": 0, "pnls": []})
        
        for trade in trades:
            try:
                time_str = trade['time_of_day']  # Format: "HH:MM"
                hour = time_str.split(":")[0]
                
                stats[hour]["trades"] += 1
                stats[hour]["pnls"].append(trade['pnl'])
                if trade['win']:
                    stats[hour]["wins"] += 1
            except:
                pass
        
        # Calculate rates
        result = {}
        for hour, data in stats.items():
            result[hour] = {
                "trades": data["trades"],
                "wins": data["wins"],
                "losses": data["trades"] - data["wins"],
                "win_rate": data["wins"] / data["trades"] if data["trades"] > 0 else 0,
                "avg_pnl": sum(data["pnls"]) / len(data["pnls"]) if data["pnls"] else 0,
                "total_pnl": sum(data["pnls"])
            }
        
        return result
    
    def analyze_by_setup(self, trades: List[Dict]) -> Dict[str, Dict]:
        """Calculate win rates by setup type"""
        stats = defaultdict(lambda: {"wins": 0, "trades": 0, "pnls": []})
        
        for trade in trades:
            setup = trade.get('setup', 'UNKNOWN')
            stats[setup]["trades"] += 1
            stats[setup]["pnls"].append(trade['pnl'])
            if trade['win']:
                stats[setup]["wins"] += 1
        
        result = {}
        for setup, data in stats.items():
            result[setup] = {
                "trades": data["trades"],
                "wins": data["wins"],
                "losses": data["trades"] - data["wins"],
                "win_rate": data["wins"] / data["trades"] if data["trades"] > 0 else 0,
                "avg_pnl": sum(data["pnls"]) / len(data["pnls"]) if data["pnls"] else 0,
                "total_pnl": sum(data["pnls"])
            }
        
        return result
    
    def find_golden_patterns(self, trades: List[Dict]) -> List[Dict]:
        """Find best performing symbol+time+setup combinations"""
        patterns = defaultdict(lambda: {"wins": 0, "trades": 0, "pnls": []})
        
        for trade in trades:
            symbol = trade['symbol']
            time_str = trade['time_of_day']
            hour = time_str.split(":")[0]
            setup = trade.get('setup', 'UNKNOWN')
            
            key = f"{symbol}_{hour}_{setup}"
            patterns[key]["trades"] += 1
            patterns[key]["pnls"].append(trade['pnl'])
            if trade['win']:
                patterns[key]["wins"] += 1
        
        # Filter for statistically significant patterns (5+ trades)
        golden = []
        for pattern_key, data in patterns.items():
            if data["trades"] >= 5:  # Need at least 5 trades
                win_rate = data["wins"] / data["trades"]
                avg_pnl = sum(data["pnls"]) / len(data["pnls"])
                
                if win_rate > 0.65:  # > 65% win rate
                    symbol, hour, setup = pattern_key.split("_")
                    golden.append({
                        "pattern": pattern_key,
                        "symbol": symbol,
                        "hour": hour,
                        "setup": setup,
                        "trades": data["trades"],
                        "wins": data["wins"],
                        "win_rate": win_rate,
                        "avg_pnl": avg_pnl,
                        "total_pnl": sum(data["pnls"])
                    })
        
        # Sort by win rate
        golden.sort(key=lambda x: x['win_rate'], reverse=True)
        return golden
    
    def identify_problems(self, trades: List[Dict]) -> List[Dict]:
        """Find worst performing patterns to avoid"""
        patterns = defaultdict(lambda: {"wins": 0, "trades": 0, "pnls": []})
        
        for trade in trades:
            symbol = trade['symbol']
            time_str = trade['time_of_day']
            hour = time_str.split(":")[0]
            setup = trade.get('setup', 'UNKNOWN')
            
            key = f"{symbol}_{hour}_{setup}"
            patterns[key]["trades"] += 1
            patterns[key]["pnls"].append(trade['pnl'])
            if trade['win']:
                patterns[key]["wins"] += 1
        
        # Find patterns to avoid
        avoid = []
        for pattern_key, data in patterns.items():
            if data["trades"] >= 3:  # Even 3 trades shows pattern
                win_rate = data["wins"] / data["trades"]
                
                if win_rate < 0.40:  # < 40% win rate = avoid
                    symbol, hour, setup = pattern_key.split("_")
                    avoid.append({
                        "pattern": pattern_key,
                        "symbol": symbol,
                        "hour": hour,
                        "setup": setup,
                        "trades": data["trades"],
                        "win_rate": win_rate,
                        "reason": "Low win rate"
                    })
        
        avoid.sort(key=lambda x: x['win_rate'])
        return avoid
    
    def generate_daily_report(self, trading_date: date) -> str:
        """Generate comprehensive daily learning report"""
        
        trades = self.load_daily_trades(trading_date)
        
        if not trades:
            return f"No trades to analyze for {trading_date}"
        
        symbol_stats = self.analyze_by_symbol(trades)
        time_stats = self.analyze_by_time(trades)
        setup_stats = self.analyze_by_setup(trades)
        golden_patterns = self.find_golden_patterns(trades)
        problem_patterns = self.identify_problems(trades)
        
        # Calculate overall stats
        total_trades = len(trades)
        total_wins = sum(1 for t in trades if t['win'])
        total_pnl = sum(t['pnl'] for t in trades)
        overall_win_rate = total_wins / total_trades if total_trades > 0 else 0
        
        report = f"""
╔════════════════════════════════════════════════════════════════════════════╗
║                    DAILY LEARNING REPORT - {trading_date}                      ║
╚════════════════════════════════════════════════════════════════════════════╝

📊 OVERALL PERFORMANCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total Trades:    {total_trades}
Wins:            {total_wins} ({overall_win_rate:.1%})
Losses:          {total_trades - total_wins} ({1 - overall_win_rate:.1%})
Daily P&L:       +${total_pnl:.2f}
Avg Trade P&L:   +${total_pnl/total_trades:.2f}

🏆 BEST PERFORMING INSTRUMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
        
        for symbol, stats in sorted(symbol_stats.items(), 
                                   key=lambda x: x[1]['win_rate'], 
                                   reverse=True):
            report += f"""
{symbol}:
  Win Rate:   {stats['win_rate']:.1%} ({stats['wins']}/{stats['trades']})
  Avg P&L:    +${stats['avg_pnl']:.2f}
  Total P&L:  +${stats['total_pnl']:.2f}
  Best:       +${stats['best_trade']:.2f}  |  Worst:  ${stats['worst_trade']:.2f}
"""
        
        report += "\n⏰ BEST TRADING TIMES\n" + "━" * 80 + "\n"
        for hour in sorted(time_stats.keys(), key=lambda h: time_stats[h]['win_rate'], reverse=True)[:3]:
            stats = time_stats[hour]
            report += f"{hour}:00 - {stats['win_rate']:.1%} ({stats['wins']}/{stats['trades']}) - Avg: +${stats['avg_pnl']:.2f}\n"
        
        report += "\n🎯 BEST SETUPS\n" + "━" * 80 + "\n"
        for setup in sorted(setup_stats.keys(), key=lambda s: setup_stats[s]['win_rate'], reverse=True)[:3]:
            stats = setup_stats[setup]
            report += f"{setup}: {stats['win_rate']:.1%} ({stats['wins']}/{stats['trades']}) - Avg: +${stats['avg_pnl']:.2f}\n"
        
        report += "\n💎 GOLDEN PATTERNS (HIGH CONFIDENCE)\n" + "━" * 80 + "\n"
        if golden_patterns:
            for pattern in golden_patterns[:3]:
                report += f"{pattern['pattern']}: {pattern['win_rate']:.1%} ({pattern['wins']}/{pattern['trades']}) - Avg: +${pattern['avg_pnl']:.2f}\n"
        else:
            report += "No golden patterns identified yet (need more data)\n"
        
        report += "\n⚠️ PATTERNS TO AVOID (LOW WIN RATE)\n" + "━" * 80 + "\n"
        if problem_patterns:
            for pattern in problem_patterns[:3]:
                report += f"❌ {pattern['pattern']}: {pattern['win_rate']:.1%} - AVOID\n"
        else:
            report += "No clear problem patterns identified\n"
        
        report += "\n📋 TOMORROW'S RECOMMENDATIONS\n" + "━" * 80 + "\n"
        report += self._generate_recommendations(symbol_stats, time_stats, setup_stats, golden_patterns)
        
        return report
    
    def _generate_recommendations(self, symbol_stats, time_stats, setup_stats, golden_patterns) -> str:
        """Generate actionable recommendations"""
        
        recommendations = ""
        
        # Best instruments
        best_symbols = sorted(symbol_stats.items(), 
                            key=lambda x: x[1]['win_rate'], 
                            reverse=True)[:2]
        if best_symbols:
            symbols_list = ", ".join([s[0] for s in best_symbols])
            recommendations += f"1. FOCUS on: {symbols_list}\n"
        
        # Best times
        best_times = sorted(time_stats.items(), 
                          key=lambda x: x[1]['win_rate'], 
                          reverse=True)[:2]
        if best_times:
            times_list = ", ".join([f"{t[0]}:00" for t in best_times])
            recommendations += f"2. BEST HOURS: {times_list}\n"
        
        # Best setups
        best_setups = sorted(setup_stats.items(), 
                           key=lambda x: x[1]['win_rate'], 
                           reverse=True)[:2]
        if best_setups:
            setups_list = ", ".join([s[0] for s in best_setups])
            recommendations += f"3. PRIORITIZE: {setups_list}\n"
        
        # Golden patterns
        if golden_patterns:
            top_pattern = golden_patterns[0]
            recommendations += f"4. GOLDEN COMBO: {top_pattern['pattern']} ({top_pattern['win_rate']:.1%})\n"
            recommendations += f"   → Use 4 contracts when this setup appears\n"
        
        # Worst times
        worst_times = sorted(time_stats.items(), 
                           key=lambda x: x[1]['win_rate'])[:2]
        if worst_times:
            times_to_avoid = ", ".join([f"{t[0]}:00" for t in worst_times])
            recommendations += f"5. AVOID: {times_to_avoid} (low win rate)\n"
        
        # Position sizing guidance
        recommendations += "\n📊 POSITION SIZING:\n"
        recommendations += "  • Golden patterns: 4 contracts (high confidence)\n"
        recommendations += "  • Best symbols: 3 contracts\n"
        recommendations += "  • Medium setups: 2 contracts\n"
        recommendations += "  • Avoid patterns: 1 contract or skip\n"
        
        return recommendations
    
    def save_daily_report(self, trading_date: date, report: str):
        """Save report to file"""
        report_file = f"{self.data_dir}/performance_reports/{trading_date}_report.txt"
        with open(report_file, 'w') as f:
            f.write(report)
        logger.info(f"✓ Daily report saved: {report_file}")
    
    def save_learned_rules(self, trading_date: date, symbol_stats, time_stats, setup_stats, golden_patterns):
        """Save learned rules as JSON for tomorrow's trading"""
        
        rules = {
            "date_generated": str(trading_date),
            "symbol_performance": symbol_stats,
            "time_performance": time_stats,
            "setup_performance": setup_stats,
            "golden_patterns": golden_patterns,
            "recommendations": {
                "best_symbols": [s for s, d in sorted(symbol_stats.items(), 
                                                      key=lambda x: x[1]['win_rate'], 
                                                      reverse=True)[:2]],
                "best_hours": [h for h, d in sorted(time_stats.items(), 
                                                   key=lambda x: x[1]['win_rate'], 
                                                   reverse=True)[:3]],
                "best_setups": [s for s, d in sorted(setup_stats.items(), 
                                                    key=lambda x: x[1]['win_rate'], 
                                                    reverse=True)[:2]],
                "avoid_patterns": [p['pattern'] for p in golden_patterns[:3]] if golden_patterns else []
            }
        }
        
        rules_file = f"{self.data_dir}/learned_rules/{trading_date}_rules.json"
        with open(rules_file, 'w') as f:
            json.dump(rules, f, indent=2)
        logger.info(f"✓ Learned rules saved: {rules_file}")
        
        return rules


# ═══════════════════════════════════════════════════════════════════════════
# PART 2: CLAUDE TRADE NOW AI BRAIN (Option C - Manual)
# ═══════════════════════════════════════════════════════════════════════════

class ClaudeTradeNowAIBrain:
    """
    Activates when you click "Claude Trade Now"
    Uses learned rules + real-time analysis to make smart decision
    """
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = data_dir
        self.learned_rules = self.load_latest_rules()
    
    def load_latest_rules(self) -> Dict:
        """Load the most recent learned rules"""
        rules_dir = f"{self.data_dir}/learned_rules"
        
        try:
            # Find most recent rules file
            rule_files = [f for f in os.listdir(rules_dir) if f.endswith('_rules.json')]
            if not rule_files:
                logger.warning("No learned rules found, using defaults")
                return self._default_rules()
            
            latest_file = sorted(rule_files)[-1]
            with open(f"{rules_dir}/{latest_file}", 'r') as f:
                return json.load(f)
        except:
            return self._default_rules()
    
    def _default_rules(self) -> Dict:
        """Default rules if no learning data yet"""
        return {
            "recommendations": {
                "best_symbols": ["MNQM26", "MGCM26"],
                "best_hours": ["09", "08", "10"],
                "best_setups": ["VWAP_REVERSION", "ASIAN_HL"],
                "avoid_patterns": []
            },
            "symbol_performance": {},
            "time_performance": {},
            "setup_performance": {}
        }
    
    async def analyze_and_decide(
        self,
        symbol: str,
        bars: List[Dict],
        current_hour: int,
        current_setup: str
    ) -> Dict[str, Any]:
        """
        CLAUDE TRADE NOW - Intelligent decision making
        
        Returns:
        {
            "should_trade": bool,
            "confidence": float (0-1),
            "reasoning": str,
            "recommendation": "BUY" | "SELL" | "SKIP",
            "suggested_contracts": int,
            "stop_loss_pips": int,
            "take_profit_pips": int
        }
        """
        
        logger.info(f"🧠 CLAUDE ANALYZING {symbol}...")
        
        # Score the current opportunity
        symbol_score = self._score_symbol(symbol)
        time_score = self._score_time(current_hour)
        setup_score = self._score_setup(current_setup)
        technical_score = self._score_technical(bars, symbol)
        
        # Combined confidence
        combined_confidence = (symbol_score + time_score + setup_score + technical_score) / 4
        
        logger.info(f"Symbol score: {symbol_score:.2f}")
        logger.info(f"Time score: {time_score:.2f}")
        logger.info(f"Setup score: {setup_score:.2f}")
        logger.info(f"Technical score: {technical_score:.2f}")
        logger.info(f"Combined confidence: {combined_confidence:.2%}")
        
        # Decision threshold: need 60%+ confidence
        threshold = 0.60
        should_trade = combined_confidence > threshold
        
        # Generate reasoning
        reasoning = self._generate_reasoning(
            symbol, current_hour, current_setup,
            symbol_score, time_score, setup_score, technical_score
        )
        
        # Recommendation
        if not should_trade:
            return {
                "should_trade": False,
                "confidence": combined_confidence,
                "reasoning": reasoning,
                "recommendation": "SKIP",
                "suggested_contracts": 0,
                "stop_loss_pips": 0,
                "take_profit_pips": 0
            }
        
        # Determine BUY/SELL based on technical analysis
        recommendation = self._determine_direction(bars)
        
        # Position sizing based on confidence
        contracts = self._determine_position_size(combined_confidence)
        
        # SL/TP based on setup type
        sl_pips, tp_pips = self._determine_sl_tp(current_setup, bars)
        
        return {
            "should_trade": True,
            "confidence": combined_confidence,
            "reasoning": reasoning,
            "recommendation": recommendation,
            "suggested_contracts": contracts,
            "stop_loss_pips": sl_pips,
            "take_profit_pips": tp_pips
        }
    
    def _score_symbol(self, symbol: str) -> float:
        """Score symbol based on learned performance"""
        best_symbols = self.learned_rules['recommendations'].get('best_symbols', [])
        
        if symbol in best_symbols:
            return 0.85  # High score if proven winner
        else:
            # Check actual performance
            perf = self.learned_rules.get('symbol_performance', {}).get(symbol, {})
            win_rate = perf.get('win_rate', 0.5)
            return max(win_rate, 0.4)  # Min 0.4 score
    
    def _score_time(self, hour: int) -> float:
        """Score time of day based on learned performance"""
        best_hours = [int(h) for h in self.learned_rules['recommendations'].get('best_hours', [])]
        
        if hour in best_hours:
            return 0.90  # High score if best time
        else:
            # Check performance
            perf = self.learned_rules.get('time_performance', {}).get(f"{hour:02d}", {})
            win_rate = perf.get('win_rate', 0.5)
            return max(win_rate, 0.3)  # Min 0.3 score
    
    def _score_setup(self, setup: str) -> float:
        """Score setup type based on learned performance"""
        best_setups = self.learned_rules['recommendations'].get('best_setups', [])
        
        if setup in best_setups:
            return 0.85
        else:
            perf = self.learned_rules.get('setup_performance', {}).get(setup, {})
            win_rate = perf.get('win_rate', 0.5)
            return max(win_rate, 0.4)
    
    def _score_technical(self, bars: List[Dict], symbol: str) -> float:
        """Score based on real-time technical analysis"""
        if len(bars) < 5:
            return 0.5
        
        closes = [b['close'] for b in bars]
        highs = [b['high'] for b in bars]
        lows = [b['low'] for b in bars]
        
        # Simple technical scoring
        recent_trend = self._detect_trend(closes[-10:])
        volatility = self._calculate_volatility(closes[-20:])
        mean_reversion = self._check_mean_reversion(closes[-20:])
        
        score = 0.5
        
        if recent_trend in ["UP", "DOWN"]:  # Has direction
            score += 0.15
        
        if 0.3 < volatility < 0.7:  # Optimal volatility
            score += 0.15
        
        if mean_reversion > 0.6:  # Strong mean reversion signal
            score += 0.20
        
        return min(score, 1.0)
    
    def _detect_trend(self, closes: List[float]) -> str:
        """Quick trend detection"""
        if len(closes) < 3:
            return "FLAT"
        
        recent_avg = sum(closes[-3:]) / 3
        past_avg = sum(closes[:3]) / 3
        
        if recent_avg > past_avg * 1.01:
            return "UP"
        elif recent_avg < past_avg * 0.99:
            return "DOWN"
        return "FLAT"
    
    def _calculate_volatility(self, closes: List[float]) -> float:
        """Calculate volatility"""
        if len(closes) < 2:
            return 0.5
        
        returns = [abs(closes[i] - closes[i-1]) / closes[i-1] 
                  for i in range(1, len(closes))]
        return sum(returns) / len(returns) if returns else 0.5
    
    def _check_mean_reversion(self, closes: List[float]) -> float:
        """Check if price is overextended from mean"""
        if len(closes) < 10:
            return 0.5
        
        mean = sum(closes) / len(closes)
        std = (sum((x - mean) ** 2 for x in closes) / len(closes)) ** 0.5
        
        if std == 0:
            return 0.5
        
        z_score = abs((closes[-1] - mean) / std)
        return min(z_score / 2, 1.0)  # Normalize
    
    def _generate_reasoning(self, symbol, hour, setup, s_score, t_score, u_score, tech_score) -> str:
        """Generate explanation for the decision"""
        
        reasons = []
        
        if s_score > 0.8:
            reasons.append(f"✓ {symbol} is a proven winner (learned)")
        elif s_score < 0.5:
            reasons.append(f"✗ {symbol} has low win rate")
        
        if t_score > 0.8:
            reasons.append(f"✓ {hour}:00 is optimal trading hour")
        elif t_score < 0.4:
            reasons.append(f"✗ {hour}:00 historically poor")
        
        if u_score > 0.8:
            reasons.append(f"✓ {setup} is proven high-confidence setup")
        elif u_score < 0.5:
            reasons.append(f"✗ {setup} has mixed results")
        
        if tech_score > 0.7:
            reasons.append(f"✓ Technical setup looks strong")
        elif tech_score < 0.4:
            reasons.append(f"✗ Technical setup is weak")
        
        return " | ".join(reasons) if reasons else "Mixed signals"
    
    def _determine_direction(self, bars: List[Dict]) -> str:
        """Determine BUY or SELL"""
        closes = [b['close'] for b in bars]
        
        if len(closes) < 5:
            return "SKIP"
        
        # Simple: price below MA = BUY, above MA = SELL
        ma_10 = sum(closes[-10:]) / 10
        
        if closes[-1] < ma_10:
            return "BUY"
        else:
            return "SELL"
    
    def _determine_position_size(self, confidence: float) -> int:
        """Position sizing based on confidence"""
        if confidence > 0.80:
            return 4  # High confidence
        elif confidence > 0.70:
            return 3  # Good confidence
        elif confidence > 0.60:
            return 2  # Medium confidence
        else:
            return 1  # Low confidence
    
    def _determine_sl_tp(self, setup: str, bars: List[Dict]) -> Tuple[int, int]:
        """Determine SL and TP in pips"""
        if len(bars) < 5:
            return (20, 40)
        
        closes = [b['close'] for b in bars]
        volatility = self._calculate_volatility(closes)
        
        # Scale based on setup and volatility
        if setup == "VWAP_REVERSION":
            sl = max(15, int(volatility * 25))
            tp = max(30, int(volatility * 50))
        elif setup == "ASIAN_HL":
            sl = max(20, int(volatility * 30))
            tp = max(40, int(volatility * 60))
        else:
            sl = max(15, int(volatility * 25))
            tp = max(30, int(volatility * 50))
        
        return (sl, tp)


# ═══════════════════════════════════════════════════════════════════════════
# INTEGRATION: MAIN TRADING AGENT
# ═══════════════════════════════════════════════════════════════════════════

class SelfLearningTradingAgent:
    """
    Complete integrated agent with both:
    - Option B: Daily automated learning
    - Option C: Claude Trade Now AI brain
    """
    
    def __init__(self, data_dir: str = "data"):
        self.daily_learner = DailyLearningEngine(data_dir)
        self.claude_brain = ClaudeTradeNowAIBrain(data_dir)
        self.data_dir = data_dir
    
    async def end_of_session_learning(self, trading_date: date):
        """
        OPTION B: Runs automatically at end of trading day
        Analyzes trades, generates reports, saves learned rules
        """
        
        logger.info(f"\n{'='*80}")
        logger.info(f"END OF SESSION LEARNING - {trading_date}")
        logger.info(f"{'='*80}\n")
        
        # Generate and save report
        report = self.daily_learner.generate_daily_report(trading_date)
        logger.info(report)
        self.daily_learner.save_daily_report(trading_date, report)
        
        # Extract and save learned rules
        trades = self.daily_learner.load_daily_trades(trading_date)
        symbol_stats = self.daily_learner.analyze_by_symbol(trades)
        time_stats = self.daily_learner.analyze_by_time(trades)
        setup_stats = self.daily_learner.analyze_by_setup(trades)
        golden = self.daily_learner.find_golden_patterns(trades)
        
        self.daily_learner.save_learned_rules(
            trading_date,
            symbol_stats,
            time_stats,
            setup_stats,
            golden
        )
        
        logger.info(f"\n✅ Learning complete for {trading_date}")
        logger.info(f"Tomorrow's agent will use improved rules\n")
    
    async def claude_trade_now(
        self,
        symbol: str,
        bars: List[Dict],
        current_hour: int,
        current_setup: str
    ) -> Dict[str, Any]:
        """
        OPTION C: Manual override - "Claude Trade Now" button
        
        Uses learned rules + real-time analysis to decide
        whether to trade RIGHT NOW
        """
        
        logger.info(f"\n{'='*80}")
        logger.info(f"CLAUDE TRADE NOW - {symbol} at {current_hour}:00")
        logger.info(f"{'='*80}\n")
        
        decision = await self.claude_brain.analyze_and_decide(
            symbol=symbol,
            bars=bars,
            current_hour=current_hour,
            current_setup=current_setup
        )
        
        logger.info(f"\n📊 DECISION:")
        logger.info(f"  Should Trade: {decision['should_trade']}")
        logger.info(f"  Confidence: {decision['confidence']:.1%}")
        logger.info(f"  Recommendation: {decision['recommendation']}")
        if decision['should_trade']:
            logger.info(f"  Contracts: {decision['suggested_contracts']}")
            logger.info(f"  SL: {decision['stop_loss_pips']} pips")
            logger.info(f"  TP: {decision['take_profit_pips']} pips")
        logger.info(f"  Reasoning: {decision['reasoning']}\n")
        
        return decision


# ═══════════════════════════════════════════════════════════════════════════
# USAGE EXAMPLE
# ═══════════════════════════════════════════════════════════════════════════

async def example_usage():
    """How to use the complete system"""
    
    agent = SelfLearningTradingAgent()
    
    # OPTION B: At end of trading session
    await agent.end_of_session_learning(date.today())
    
    # OPTION C: When user clicks "Claude Trade Now"
    decision = await agent.claude_trade_now(
        symbol="MNQM26",
        bars=[...],  # Your market data
        current_hour=9,
        current_setup="VWAP_REVERSION"
    )
    
    if decision['should_trade']:
        # Execute trade with decision['recommended_contracts']
        pass
