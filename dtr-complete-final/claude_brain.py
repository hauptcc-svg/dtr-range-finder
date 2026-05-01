"""
Claude Tactical Brain
=====================
Real-time entry validation for the DTR autonomous trading platform.
Model: claude-haiku-4-5 via Anthropic SDK with prompt caching.

Called before every entry. Reads Hermes's trading_context from Supabase,
validates the current DTR signal, and returns GO/NO-GO + optional param tweaks.

Param adjustments are applied only if within PARAM_BOUNDS (dtr_v3.py).
"""

import json
import logging
import os
from typing import Any, Optional

import anthropic

from strategies import StrategyState
from strategies.dtr_v3 import PARAM_BOUNDS

logger = logging.getLogger(__name__)

MODEL = "claude-haiku-4-5"

SYSTEM_PROMPT = """You are the tactical execution brain for an autonomous DTR (Day Trading Rauf) futures trading system.

Your role: validate whether a live DTR signal qualifies as a high-probability trade, given the strategy's current state machine reading AND the historical pattern memory provided by Hermes (the master strategic brain).

DTR Strategy Logic (rules you enforce):
• Stage 0→1: Candle closes OUTSIDE the session range (sweep). Sets bias direction.
• Stage 1→2: First large "bias candle" (body ≥ ATR14 × fvgSizeMult). Confirms institutional direction.
• Stage 2→3: Retest — candle wicks back INTO the bias candle body. Smart money accumulating.
• Stage 3→4 (BOS): Candle CLOSES beyond the bias candle body extreme after the BOS gate time. This is the signal.
• Entry: NEXT bar open after BOS confirmed.
• SL: Bias candle far-side ± ATR × slMult
• TP: Opposing range boundary

HIGH-PROBABILITY conditions to ENTER:
✓ Session has clear directional sweep (one side only, not both)
✓ ATR is within normal range (not extreme spike or dead market)
✓ Range size is meaningful (not micro-range, not extreme)
✓ Hermes has no "avoid_patterns" matching this exact setup
✓ Hermes shows ≥60% win rate for this session+direction+day combination
✓ Market regime is TRENDING or mildly RANGING (not chaotic VOLATILE)

LOW-PROBABILITY conditions to SKIP:
✗ Both sides of range swept (invalidation risk)
✗ ATR extreme (>3× normal) — erratic market, stop hunt risk
✗ Range too small (<0.5× ATR) — low energy setup
✗ Hermes "avoid_patterns" matches this setup
✗ Market regime is VOLATILE with no clear directional bias
✗ Win rate for this session+direction+day is <40% over ≥6 samples

Parameter adjustments (apply only within safe bounds):
• fvgSizeMult: if recent bias candles are too small → lower; too large → raise (range: 0.5–3.0)
• slMult: if stops being hit on valid setups → raise; if too wide → lower (range: 0.0–2.0)

Always respond with valid JSON only. No markdown, no explanation outside the JSON."""

USER_TEMPLATE = """\
Current DTR Signal:
{signal_json}

Hermes Trading Context for {symbol}:
{context_json}

Respond with this exact JSON structure:
{{
  "decision": "ENTER" | "SKIP",
  "confidence": <float 0.0–1.0>,
  "reasoning": "<one concise sentence>",
  "param_adjustments": {{}}
}}

"param_adjustments" should be an empty object unless you have a specific reason to adjust within safe bounds."""


class ClaudeBrain:
    """
    Validates DTR entry signals in real-time using Claude haiku-4-5.

    Uses Anthropic prompt caching: the system prompt is cached ephemerally
    (saves ~80% of input tokens on repeated calls).
    """

    def __init__(self) -> None:
        self._client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        logger.info(f"✅ Claude brain ready (model={MODEL})")

    async def validate_entry(
        self,
        state: StrategyState,
        trading_context: dict,
    ) -> dict:
        """
        Validate a BOS-confirmed DTR signal.

        Returns dict with keys: decision, confidence, reasoning, param_adjustments.
        On any error, defaults to ENTER (fail-open) with confidence=0.5.
        """
        signal = _state_to_dict(state)
        user_content = USER_TEMPLATE.format(
            signal_json  = json.dumps(signal, indent=2),
            context_json = json.dumps(trading_context, indent=2, default=str),
            symbol       = state.symbol,
        )

        try:
            response = self._client.messages.create(
                model=MODEL,
                max_tokens=512,
                system=[{
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{
                    "role": "user",
                    "content": user_content,
                }],
            )

            raw = response.content[0].text.strip()

            # Strip markdown code fences if present
            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]

            result = json.loads(raw)
            result = _validate_result(result, state)
            _apply_safe_param_bounds(result)

            logger.debug(
                f"🧠 Claude: {result['decision']} {state.symbol} "
                f"conf={result['confidence']:.2f}  {result['reasoning']}"
            )
            return result

        except json.JSONDecodeError as exc:
            logger.error(f"❌ Claude JSON parse error: {exc}  raw={raw[:200]}")
            return _default_result("ENTER", "JSON parse error — defaulting to ENTER")

        except anthropic.APIError as exc:
            logger.error(f"❌ Claude API error: {exc}")
            return _default_result("ENTER", f"API error — defaulting to ENTER: {exc}")

        except Exception as exc:
            logger.error(f"❌ Claude brain unexpected error: {exc}", exc_info=True)
            return _default_result("ENTER", f"Unexpected error — defaulting to ENTER")

    def optimize_params(
        self,
        symbol: str,
        recent_trades: list,
        current_params: dict,
    ) -> Optional[dict]:
        """
        Suggest parameter tweaks based on recent trade performance.
        Returns new params dict or None if no changes recommended.
        Called by Hermes after session analysis.
        """
        if len(recent_trades) < 5:
            return None

        wins   = sum(1 for t in recent_trades if t.get("outcome") == "WIN")
        losses = sum(1 for t in recent_trades if t.get("outcome") == "LOSS")
        win_rate = wins / (wins + losses) if (wins + losses) > 0 else 0.0

        # Straightforward rule: if win rate < 40%, tighten bias candle filter
        if win_rate < 0.40:
            new_mult = min(current_params.get("fvgSizeMult", 1.5) + 0.2, PARAM_BOUNDS["fvgSizeMult"][1])
            logger.info(f"📊 Auto-tightening fvgSizeMult → {new_mult:.2f} (WR={win_rate:.1%})")
            return {**current_params, "fvgSizeMult": new_mult}

        return None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _state_to_dict(state: StrategyState) -> dict:
    return {
        "symbol":            state.symbol,
        "stage":             state.stage,
        "direction":         state.direction,
        "session":           state.session,
        "range_high":        state.range_high,
        "range_low":         state.range_low,
        "range_size":        round(state.range_high - state.range_low, 4),
        "bias_candle_high":  state.bias_candle_high,
        "bias_candle_low":   state.bias_candle_low,
        "sl_level":          state.sl_level,
        "tp_level":          state.tp_level,
        "atr14":             state.atr14,
        "in_entry_window":   state.in_entry_window,
        "bos_confirmed":     state.bos_confirmed,
        "invalidated":       state.invalidated,
        "market_conditions": state.market_conditions,
    }


def _validate_result(result: dict, state: StrategyState) -> dict:
    """Ensure required keys exist and types are correct."""
    decision = result.get("decision", "ENTER")
    if decision not in ("ENTER", "SKIP"):
        decision = "ENTER"
    return {
        "decision":          decision,
        "confidence":        float(result.get("confidence", 0.5)),
        "reasoning":         str(result.get("reasoning", "")),
        "param_adjustments": result.get("param_adjustments") or {},
    }


def _apply_safe_param_bounds(result: dict) -> None:
    """Clip any param adjustments to PARAM_BOUNDS. Modifies in-place."""
    adj = result.get("param_adjustments", {})
    for key, value in list(adj.items()):
        bounds = PARAM_BOUNDS.get(key)
        if bounds is None:
            del adj[key]
            continue
        lo, hi = bounds
        adj[key] = max(lo, min(hi, value))


def _default_result(decision: str, reasoning: str) -> dict:
    return {
        "decision":          decision,
        "confidence":        0.5,
        "reasoning":         reasoning,
        "param_adjustments": {},
    }
