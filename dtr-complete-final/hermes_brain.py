"""
Hermes Strategic Brain
======================
Master trading brain. Model: nousresearch/hermes-3-llama-3.1-70b via OpenRouter.

Runs after every trade close and after every session window ends.
Analyzes historical patterns, extracts golden setups and failure patterns,
updates trading_context in Supabase, and proposes parameter changes.

Parameter changes within PARAM_BOUNDS are applied automatically.
Changes outside safe bounds require Craig's Telegram approval.

Architecture mirrors the Marketing CRM Hermes agent (brand_context → trading_context).
"""

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

import aiohttp

from strategies.dtr_v3 import PARAM_BOUNDS

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL          = "nousresearch/hermes-3-llama-3.1-70b"

QUALITY_THRESHOLD = 0.70   # composite quality score gate before saving

SYSTEM_PROMPT = """You are Hermes — the master algorithmic trading strategist and memory system for the DTR autonomous trading platform.

Your role: analyze completed trades, extract winning and losing patterns, understand market regime context, and propose parameter improvements for the DTR strategy.

DTR Strategy you analyze:
• 4 instruments: MYMM26 (Mini YM), MCLK26 (Micro Crude), MGCM26 (Micro Gold), MNQM26 (Micro NQ)
• 2 sessions per instrument: 2AM (London) and 9AM (NY)
• State machine: 0→1 (sweep) → 2 (bias candle) → 3 (retest) → 4 (BOS) → Entry
• SL = bias candle far-side ± ATR×slMult; TP = opposing range boundary

What you memorize and track:
• Win/loss rates by: symbol, session (2AM/9AM), direction (LONG/SHORT), day of week
• ATR conditions at time of entry (high/normal/low volatility)
• Range size relative to ATR (large/medium/small range)
• "Golden setups" = combinations with ≥70% win rate over ≥6 samples
• "Avoid patterns" = combinations with ≤40% win rate over ≥6 samples
• Market regime: TRENDING | RANGING | VOLATILE

Parameter optimization bounds (NEVER suggest outside these):
• fvgSizeMult: 0.5 – 3.0 (bias candle size filter)
• slMult: 0.0 – 2.0 (stop loss ATR buffer multiplier)
• maxTrades: 2 – 6 (max trades per day per instrument)
• maxLossDir: 1 – 4 (max losses per direction per session)

Changes within bounds → mark as "auto_apply: true" (Claude applies immediately)
Changes outside bounds → mark as "auto_apply: false" (requires Craig's Telegram approval)

Quality self-assessment: score your analysis on these 5 pillars (0.0–1.0 each):
1. pattern_accuracy: Do identified patterns reflect actual trade data?
2. completeness: Are all instruments and sessions with ≥3 trades analyzed?
3. reasoning_clarity: Is the reasoning specific and actionable?
4. risk_awareness: Are failure modes and exceptions noted?
5. data_sufficiency: Is there enough data to support the conclusions?

Always respond with valid JSON only."""

REPORT_SYSTEM_PROMPT = """You are Hermes — the master algorithmic trading strategist. You are generating an on-demand diagnostic feedback report.

You have access to the full trade history for this trading account. Your job is to provide deep, actionable insights.

Analyze the following dimensions:
1. win_rate_by_setup: Group by symbol × session × direction × day_of_week. Identify patterns.
2. best_instruments: Top 3 instruments by win rate (require min 3 trades). Include win %, trade count, avg PnL.
3. worst_instruments: Bottom 3 instruments by win rate (require min 3 trades).
4. param_recommendations: Suggest parameter changes (fvgSizeMult, slMult) with clear reasoning from the data.
5. early_close_analysis: For trades with close_reason = 'dtr_invalidation' or 'hermes_early_close': assess whether the early close was correct (trade would have hit SL anyway) or premature (trade would have hit TP).
6. news_correlation: Use your training knowledge of economic calendar events. NFP = first Friday of each month at 08:30 NY. FOMC = 8× per year (specific dates vary). CPI = ~2nd week of each month. Cross-reference trade timestamps vs these windows (±45 minutes). Flag any patterns like "3 of 4 losses on MNQM26 occurred within 45min of major news events". If no news correlation is found, say so clearly.

Return valid JSON only. Be specific and data-driven. Avoid vague statements.

Always respond with valid JSON only."""

ANALYSIS_TEMPLATE = """\
Recent trades for {symbol}:
{trades_json}

Current trading_context:
{context_json}

Today: {today}

Analyze these trades and return this exact JSON:
{{
  "golden_setups": [
    {{
      "pattern": "<description>",
      "symbol": "<symbol>",
      "session": "2AM|9AM",
      "direction": "LONG|SHORT",
      "day_of_week": "<Mon|Tue|...>",
      "win_rate": <float>,
      "sample_size": <int>,
      "conditions": {{}}
    }}
  ],
  "avoid_patterns": [
    {{
      "pattern": "<description>",
      "symbol": "<symbol>",
      "session": "2AM|9AM",
      "direction": "LONG|SHORT",
      "day_of_week": "<Mon|Tue|...>",
      "win_rate": <float>,
      "sample_size": <int>,
      "reason": "<why this fails>"
    }}
  ],
  "regime": "TRENDING|RANGING|VOLATILE",
  "regime_notes": "<one sentence>",
  "param_suggestions": [
    {{
      "param": "<param_name>",
      "current": <float>,
      "suggested": <float>,
      "reasoning": "<why>",
      "auto_apply": <bool>
    }}
  ],
  "session_summary": "<2–3 sentence plain-English summary of today's patterns>",
  "quality": {{
    "pattern_accuracy": <float>,
    "completeness": <float>,
    "reasoning_clarity": <float>,
    "risk_awareness": <float>,
    "data_sufficiency": <float>
  }}
}}"""

SESSION_REVIEW_TEMPLATE = """\
Session window just closed for {symbol} {session}.

Trades in this session:
{trades_json}

Current trading_context:
{context_json}

Provide a focused session review using the same JSON format as full analysis.
Focus only on this session's patterns. Keep golden_setups and avoid_patterns specific to {session}."""


class HermesBrain:
    """
    Strategic pattern analysis brain. Runs post-trade and post-session.
    Writes learned patterns to Supabase trading_context JSONB.
    Sends Telegram approval requests for parameter changes beyond safe bounds.
    """

    def __init__(self) -> None:
        self._api_key = os.environ["OPENROUTER_API_KEY"]
        self._telegram_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        self._telegram_chat_id   = os.environ.get("TELEGRAM_CHAT_ID")
        logger.info(f"✅ Hermes brain ready (model={MODEL})")

    async def analyze_and_learn(
        self,
        trades: list,
        current_context: dict,
        symbol: str,
    ) -> dict:
        """
        Full post-trade analysis. Called after every trade close.
        Returns updated trading_context dict (already merged with existing).
        """
        if not trades:
            return current_context

        prompt = ANALYSIS_TEMPLATE.format(
            symbol       = symbol,
            trades_json  = json.dumps(trades, indent=2, default=str),
            context_json = json.dumps(current_context, indent=2, default=str),
            today        = datetime.now().strftime("%A %Y-%m-%d"),
        )

        raw = await self._call_hermes(prompt)
        if not raw:
            return current_context

        result = _parse_hermes_response(raw)
        if not result:
            return current_context

        quality = _score_quality(result)
        result["quality"] = quality

        if quality["composite"] < QUALITY_THRESHOLD:
            logger.warning(
                f"⚠️  Hermes quality gate failed ({quality['composite']:.2f} < {QUALITY_THRESHOLD}) "
                f"— not saving context for {symbol}"
            )
            return current_context

        updated_context = _merge_context(current_context, result, symbol)

        # Send Telegram for any param proposals requiring approval
        proposals = [p for p in result.get("param_suggestions", []) if not p.get("auto_apply", True)]
        if proposals and self._telegram_bot_token:
            await self._send_approval_request(symbol, proposals, result.get("session_summary", ""))

        logger.info(
            f"🧠 Hermes analysis saved for {symbol}: "
            f"{len(result.get('golden_setups', []))} golden, "
            f"{len(result.get('avoid_patterns', []))} avoid, "
            f"regime={result.get('regime')}"
        )
        return updated_context

    async def session_review(
        self,
        symbol:   str,
        session:  str,
        trades:   list,
        current_context: dict,
    ) -> dict:
        """
        Lightweight review after a session window closes (2AM or 9AM).
        Returns updated context.
        """
        if not trades:
            return current_context

        prompt = SESSION_REVIEW_TEMPLATE.format(
            symbol       = symbol,
            session      = session,
            trades_json  = json.dumps(trades, indent=2, default=str),
            context_json = json.dumps(current_context, indent=2, default=str),
        )

        raw = await self._call_hermes(prompt)
        if not raw:
            return current_context

        result = _parse_hermes_response(raw)
        if not result:
            return current_context

        quality = _score_quality(result)
        if quality["composite"] < QUALITY_THRESHOLD:
            return current_context

        return _merge_context(current_context, result, symbol)

    async def daily_digest(
        self,
        all_trades: list,
        contexts:   dict,
    ) -> str:
        """
        Build and send the Hermes daily Telegram digest with performance summary
        and approve/reject buttons for any pending parameter proposals.
        Called at end of NY session (14:00 NY time).
        """
        if not self._telegram_bot_token:
            return ""

        wins   = sum(1 for t in all_trades if t.get("outcome") == "WIN")
        losses = sum(1 for t in all_trades if t.get("outcome") == "LOSS")
        total  = len(all_trades)
        wr     = (wins / total * 100) if total else 0
        daily_pnl = sum(t.get("pnl", 0) for t in all_trades)

        # Collect golden setups across all symbols
        golden = []
        avoid  = []
        for sym, ctx in contexts.items():
            golden.extend(ctx.get("golden_setups", [])[:2])
            avoid.extend(ctx.get("avoid_patterns",  [])[:1])

        golden_text = "\n".join(
            f"• {g.get('symbol')} {g.get('session')} {g.get('direction')} "
            f"({g.get('win_rate', 0)*100:.0f}% WR, {g.get('sample_size')} trades)"
            for g in golden[:3]
        ) or "No golden setups yet"

        avoid_text = "\n".join(
            f"• {a.get('symbol')} {a.get('session')} {a.get('direction')} "
            f"— {a.get('reason', '')}"
            for a in avoid[:2]
        ) or "No patterns to avoid"

        text = (
            f"📊 *DTR Daily Summary — {datetime.now().strftime('%d %b %Y')}*\n"
            f"─────────────────────\n"
            f"Trades: {total} | Wins: {wins} | Losses: {losses} | WR: {wr:.0f}%\n"
            f"Daily P&L: {'🟢' if daily_pnl >= 0 else '🔴'} ${daily_pnl:+.2f}\n"
            f"─────────────────────\n"
            f"🔮 *Hermes Insights:*\n"
            f"*Golden setups:*\n{golden_text}\n"
            f"*Avoid:*\n{avoid_text}"
        )

        await self._send_telegram(text)
        return text

    # ─────────────────────────────────────────────────────────────────────────
    # Feedback report (on-demand)
    # ─────────────────────────────────────────────────────────────────────────

    async def generate_feedback_report(
        self,
        trades: list,
        contexts: dict,
        period: str = "7d",
    ) -> dict:
        """
        Generate an on-demand diagnostic report covering:
        - Win rate by setup (symbol/session/direction/day)
        - Best/worst instruments
        - Parameter recommendations
        - Early close analysis
        - High-impact news correlation
        """
        if not trades:
            return {
                "error": "No trades to analyze",
                "period": period,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }

        prompt = self._build_report_prompt(trades, contexts, period)

        try:
            response_text = await self._openrouter_call(
                system_prompt=REPORT_SYSTEM_PROMPT,
                user_message=prompt,
                max_tokens=3000,
            )
            report = json.loads(response_text)
        except (json.JSONDecodeError, TypeError):
            # Extract JSON from response if surrounded by markdown
            match = re.search(r'\{.*\}', response_text or "", re.DOTALL)
            if match:
                report = json.loads(match.group())
            else:
                report = {"raw_response": response_text, "error": "JSON parse failed"}

        report["period"] = period
        report["trade_count"] = len(trades)
        report["generated_at"] = datetime.now(timezone.utc).isoformat()

        # Log to Supabase
        if hasattr(self, "_supabase") and self._supabase:
            try:
                self._supabase.table("agent_audit_log").insert({
                    "agent_name": "hermes",
                    "action":     "feedback_report",
                    "symbol":     "ALL",
                    "result":     report,
                }).execute()
            except Exception as exc:
                logger.warning(f"⚠️  Could not log report to Supabase: {exc}")

        # Send to Telegram
        try:
            await self._send_report_telegram(report, period)
        except Exception as exc:
            logger.warning(f"⚠️  Telegram report send failed: {exc}")

        return report

    def _build_report_prompt(self, trades: list, contexts: dict, period: str) -> str:
        """Build the user prompt for the feedback report."""
        # Summarize trades (don't send all raw data to avoid token overflow)
        trade_summary = []
        for t in trades[-100:]:  # last 100 trades max
            trade_summary.append({
                "symbol":       t.get("symbol"),
                "session":      t.get("session"),
                "direction":    t.get("direction"),
                "strategy":     t.get("strategy", "DTR"),
                "outcome":      t.get("outcome"),
                "pnl":          t.get("pnl"),
                "close_reason": t.get("close_reason"),
                "tp1_filled":   t.get("tp1_filled", False),
                "tp2_filled":   t.get("tp2_filled", False),
                "tp3_filled":   t.get("tp3_filled", False),
                "opened_at":    t.get("opened_at"),
                "day_of_week":  (
                    datetime.fromisoformat(t["opened_at"].replace("Z", "+00:00")).strftime("%A")
                    if t.get("opened_at") else None
                ),
            })

        ctx_summary = {sym: {
            "golden_setups_count": len(ctx.get("golden_setups", [])),
            "avoid_patterns_count": len(ctx.get("avoid_patterns", [])),
            "regime": ctx.get("regime"),
        } for sym, ctx in contexts.items()}

        return f"""Period: last {period}
Total trades in dataset: {len(trades)}

Trade history (last 100 trades):
{json.dumps(trade_summary, indent=2)}

Current Hermes context per symbol (summary):
{json.dumps(ctx_summary, indent=2)}

Today: {datetime.now(timezone.utc).strftime('%Y-%m-%d %A')}

Generate a comprehensive diagnostic report. Return this exact JSON structure:
{{
  "win_rate_by_setup": [
    {{"symbol": "MNQM26", "session": "9AM", "direction": "LONG", "day_of_week": "Wednesday", "trades": 8, "wins": 6, "win_rate": 0.75, "avg_pnl": 142.50}}
  ],
  "best_instruments": [
    {{"symbol": "MNQM26", "win_rate": 0.72, "trades": 18, "avg_pnl": 98.30, "note": "Strong London session bias"}}
  ],
  "worst_instruments": [
    {{"symbol": "MCLK26", "win_rate": 0.33, "trades": 9, "avg_pnl": -45.20, "note": "Oil volatile, many SL hits"}}
  ],
  "param_recommendations": [
    {{"param": "fvgSizeMult", "current": 1.5, "suggested": 1.8, "symbol": "MNQM26", "reasoning": "3 of 5 false BOS on NQ had bias candles below 1.8x ATR", "auto_apply": true}}
  ],
  "early_close_analysis": {{
    "total_early_closes": 4,
    "correct_closes": 3,
    "premature_closes": 1,
    "notes": "3 dtr_invalidation closes correctly avoided larger losses. 1 close at TP1 level — trade would have reached TP2."
  }},
  "news_correlation": {{
    "events_detected": ["NFP 2025-01-03", "CPI 2025-01-14"],
    "pattern": "2 of 3 NFP-day losses occurred within 45min of 08:30 NY. Recommend reducing position size or halting on NFP/CPI days.",
    "affected_symbols": ["MNQM26", "MGCM26"],
    "recommendation": "Add NFP/CPI calendar filter to prevent entries 60min before major releases."
  }},
  "overall_summary": "Win rate is 67% over the last 7 days. Key finding: NQ 9AM LONG on Wednesday is your golden setup at 75% WR. Avoid Oil SHORT on Tuesdays (33% WR). News events are a significant risk factor."
}}"""

    async def _send_report_telegram(self, report: dict, period: str) -> None:
        """Send formatted report to Telegram (reuses self._send_telegram)."""
        summary = report.get("overall_summary", "Report generated.")
        best    = report.get("best_instruments", [])
        worst   = report.get("worst_instruments", [])
        early   = report.get("early_close_analysis", {})
        news    = report.get("news_correlation", {})

        lines = [
            f"📊 *Hermes Feedback Report — {period}*",
            f"Trades analyzed: {report.get('trade_count', '?')}",
            f"Generated: {report.get('generated_at', '?')[:10]}",
            "─────────────────────",
            f"📌 *Summary:* {summary}",
            "─────────────────────",
        ]
        if best:
            lines.append("🏆 *Best:*")
            for b in best[:2]:
                lines.append(
                    f"  {b.get('symbol')}: {b.get('win_rate', 0)*100:.0f}% WR ({b.get('trades')} trades)"
                )
        if worst:
            lines.append("⚠️ *Worst:*")
            for w in worst[:2]:
                lines.append(
                    f"  {w.get('symbol')}: {w.get('win_rate', 0)*100:.0f}% WR ({w.get('trades')} trades)"
                )
        if early:
            lines.append(
                f"🔴 *Early Closes:* {early.get('total_early_closes', 0)} total, "
                f"{early.get('correct_closes', 0)} correct"
            )
        if news.get("events_detected"):
            lines.append(
                f"📰 *News:* {news.get('pattern', 'No significant news correlation found')}"
            )

        await self._send_telegram("\n".join(lines))

    # ─────────────────────────────────────────────────────────────────────────
    # OpenRouter API
    # ─────────────────────────────────────────────────────────────────────────

    async def _openrouter_call(
        self,
        system_prompt: str,
        user_message: str,
        max_tokens: int = 1500,
    ) -> Optional[str]:
        """Generic OpenRouter call with configurable system prompt."""
        payload = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_message},
            ],
            "max_tokens":  max_tokens,
            "temperature": 0.2,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type":  "application/json",
            "HTTP-Referer":  "https://dtr-trading.app",
            "X-Title":       "DTR Autonomous Trader",
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    OPENROUTER_URL,
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=90),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data["choices"][0]["message"]["content"]
                    err = await resp.text()
                    logger.error(f"❌ OpenRouter API error {resp.status}: {err[:200]}")
                    return None
        except Exception as exc:
            logger.error(f"❌ OpenRouter call failed: {exc}")
            return None

    async def _call_hermes(self, user_prompt: str) -> Optional[str]:
        payload = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_prompt},
            ],
            "max_tokens":  1500,
            "temperature": 0.2,
        }
        headers = {
            "Authorization":    f"Bearer {self._api_key}",
            "Content-Type":     "application/json",
            "HTTP-Referer":     "https://dtr-trading.app",
            "X-Title":          "DTR Autonomous Trader",
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    OPENROUTER_URL,
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        return data["choices"][0]["message"]["content"]
                    else:
                        err = await resp.text()
                        logger.error(f"❌ Hermes API error {resp.status}: {err[:200]}")
                        return None
        except Exception as exc:
            logger.error(f"❌ Hermes call failed: {exc}")
            return None

    # ─────────────────────────────────────────────────────────────────────────
    # Telegram
    # ─────────────────────────────────────────────────────────────────────────

    async def _send_telegram(self, text: str, reply_markup: Optional[dict] = None) -> bool:
        if not (self._telegram_bot_token and self._telegram_chat_id):
            return False
        payload: dict = {
            "chat_id":    self._telegram_chat_id,
            "text":       text,
            "parse_mode": "Markdown",
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"https://api.telegram.org/bot{self._telegram_bot_token}/sendMessage",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    return resp.status == 200
        except Exception as exc:
            logger.error(f"❌ Telegram send error: {exc}")
            return False

    async def _send_approval_request(
        self,
        symbol:   str,
        proposals: list,
        summary:  str,
    ) -> None:
        """Send Telegram message with inline approve/reject buttons for each proposal."""
        lines = [
            f"⚙️ *Parameter Change Request — {symbol}*",
            f"_{summary}_",
            "─────────────────────",
        ]
        inline_buttons = []

        for p in proposals:
            param     = p.get("param", "?")
            current   = p.get("current", "?")
            suggested = p.get("suggested", "?")
            reasoning = p.get("reasoning", "")
            lines.append(f"• `{param}`: {current} → {suggested}\n  _{reasoning}_")
            inline_buttons.append([
                {"text": f"✅ Approve {param}", "callback_data": f"APPROVE_{symbol}_{param}_{suggested}"},
                {"text": f"❌ Reject {param}",  "callback_data": f"REJECT_{symbol}_{param}"},
            ])

        text = "\n".join(lines)
        markup = {"inline_keyboard": inline_buttons} if inline_buttons else None
        await self._send_telegram(text, reply_markup=markup)


# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers
# ─────────────────────────────────────────────────────────────────────────────

def _parse_hermes_response(raw: str) -> Optional[dict]:
    """Parse and validate Hermes JSON response."""
    # Strip markdown code fences
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]

    try:
        result = json.loads(text)
        return result
    except json.JSONDecodeError as exc:
        logger.error(f"❌ Hermes JSON parse error: {exc}")
        return None


def _score_quality(result: dict) -> dict:
    """Calculate 5-pillar quality score."""
    q = result.get("quality", {})

    raw_scores = {
        "pattern_accuracy":  float(q.get("pattern_accuracy",  0.5)),
        "completeness":      float(q.get("completeness",      0.5)),
        "reasoning_clarity": float(q.get("reasoning_clarity", 0.5)),
        "risk_awareness":    float(q.get("risk_awareness",    0.5)),
        "data_sufficiency":  float(q.get("data_sufficiency",  0.5)),
    }

    # Validate each in [0,1]
    scores = {k: max(0.0, min(1.0, v)) for k, v in raw_scores.items()}

    # Penalize if golden_setups is not a list or is empty with <5 trades
    golden = result.get("golden_setups", [])
    if not isinstance(golden, list):
        scores["completeness"] *= 0.5

    composite = sum(scores.values()) / len(scores)
    scores["composite"] = round(composite, 3)
    scores["passed"]    = composite >= QUALITY_THRESHOLD

    return scores


def _merge_context(existing: dict, new_analysis: dict, symbol: str) -> dict:
    """
    Merge Hermes analysis into existing trading_context.
    Preserves historical patterns while updating with new findings.
    """
    ctx = dict(existing)

    # ── Golden setups: upsert by (session, direction, day_of_week) key ────
    existing_golden = {
        _pattern_key(p): p for p in ctx.get("golden_setups", [])
    }
    for p in new_analysis.get("golden_setups", []):
        key = _pattern_key(p)
        if key in existing_golden:
            # Weighted update: blend win rates
            old_n = existing_golden[key].get("sample_size", 1)
            new_n = p.get("sample_size", 1)
            total = old_n + new_n
            blended_wr = (
                existing_golden[key].get("win_rate", 0) * old_n +
                p.get("win_rate", 0) * new_n
            ) / total
            existing_golden[key] = {**p, "win_rate": blended_wr, "sample_size": total}
        else:
            existing_golden[key] = p

    ctx["golden_setups"] = list(existing_golden.values())

    # ── Avoid patterns: same merge logic ──────────────────────────────────
    existing_avoid = {_pattern_key(p): p for p in ctx.get("avoid_patterns", [])}
    for p in new_analysis.get("avoid_patterns", []):
        key = _pattern_key(p)
        if key in existing_avoid:
            old_n = existing_avoid[key].get("sample_size", 1)
            new_n = p.get("sample_size", 1)
            total = old_n + new_n
            blended_wr = (
                existing_avoid[key].get("win_rate", 0) * old_n +
                p.get("win_rate", 0) * new_n
            ) / total
            existing_avoid[key] = {**p, "win_rate": blended_wr, "sample_size": total}
        else:
            existing_avoid[key] = p

    ctx["avoid_patterns"] = list(existing_avoid.values())

    # ── Regime, last summary, auto-apply param suggestions ────────────────
    ctx["regime"]            = new_analysis.get("regime", ctx.get("regime", "RANGING"))
    ctx["regime_notes"]      = new_analysis.get("regime_notes", "")
    ctx["last_analysis"]     = datetime.now(timezone.utc).isoformat()
    ctx["last_summary"]      = new_analysis.get("session_summary", "")

    # ── Auto-apply param suggestions within bounds ─────────────────────────
    suggestions = [p for p in new_analysis.get("param_suggestions", []) if p.get("auto_apply")]
    if suggestions:
        ctx.setdefault("pending_params", {})
        for s in suggestions:
            param     = s.get("param")
            suggested = s.get("suggested")
            bounds    = PARAM_BOUNDS.get(param)
            if param and suggested is not None and bounds:
                clamped = max(bounds[0], min(bounds[1], float(suggested)))
                ctx["pending_params"][param] = clamped
                logger.info(f"✅ Hermes auto-apply: {param} → {clamped}")

    return ctx


def _pattern_key(pattern: dict) -> str:
    return f"{pattern.get('symbol','?')}_{pattern.get('session','?')}_{pattern.get('direction','?')}_{pattern.get('day_of_week','?')}"
