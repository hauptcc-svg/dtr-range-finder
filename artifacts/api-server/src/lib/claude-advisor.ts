/**
 * Claude AI Advisor
 *
 * Two modes:
 * 1. DTR-Assist: Claude reviews current DTR range/bias state and decides to enter or skip.
 * 2. Autonomous: Claude gets ATR pullback signals (1m + 5m) for all instruments and
 *    decides entries, exits, stacking (pyramid same direction), and reversals.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { InstrumentState } from "./dtr-strategy";
import type { InstrumentConfig } from "./trading-config";
import type { AtrPullbackSignal } from "./atr-pullback-strategy";

export interface ClaudeTradeDecision {
  symbol: string;
  action: "long" | "short" | "close" | "skip" | "stack" | "reverse";
  reasoning: string;
  /** Set to "1m_scalp" when the entry is driven by the 1-min scalp window; defaults to "5m". */
  timeframe?: "5m" | "1m_scalp";
}

export interface ClaudeAdvice {
  decisions: ClaudeTradeDecision[];
  summary: string;
  model: string;
}

export interface BarSnapshot {
  t: string; // ISO timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** ATR pullback signal snapshot passed to Claude for one timeframe */
export interface AtrSignalInfo {
  timeframe: "1m" | "5m";
  signal: AtrPullbackSignal | null;
}

// ---------------------------------------------------------------------------
// DTR-Assist mode — requires range data, honours DTR constraints
// ---------------------------------------------------------------------------
function buildDTRPrompt(
  instruments: Array<{ state: InstrumentState; config: InstrumentConfig; effectiveMaxTrades: number; effectiveMaxLossesPerDirection: number }>
): string {
  const instrumentBlocks = instruments
    .map(({ state, config, effectiveMaxTrades, effectiveMaxLossesPerDirection }) => {
      const r = state.rangeData;
      return [
        `Instrument: ${state.symbol} (${config.name})`,
        `  Last Price: ${state.lastPrice ?? "unknown"}`,
        `  Range High: ${r?.high ?? "not set"}`,
        `  Range Low: ${r?.low ?? "not set"}`,
        `  Range Midpoint: ${r?.midpoint ?? "not set"}`,
        `  Bias: ${r?.bias ?? "unknown"}`,
        `  In Position: ${state.inPosition ? `YES (${state.positionDirection})` : "No"}`,
        `  Trades Today: ${state.todayTrades} / ${effectiveMaxTrades}`,
        `  Long Losses Today: ${state.longLosses} / ${effectiveMaxLossesPerDirection}`,
        `  Short Losses Today: ${state.shortLosses} / ${effectiveMaxLossesPerDirection}`,
        `  Point Value: $${config.pointValue}`,
        `  Min Tick: ${config.minTick}`,
      ].join("\n");
    })
    .join("\n\n");

  return `You are a professional futures trader specializing in the DTR (Draw The Range) strategy with a Fair Value Gap (FVG) entry model.

The DTR strategy works as follows:
1. SESSION RANGE — a high/low range is established during a defined time window (rangeHigh / rangeLow).
2. SWEEP — price breaks out of the session boundary (above rangeHigh for SHORT, below rangeLow for LONG), trapping breakout traders.
3. BIAS CANDLE (FVG) — after the sweep, a large impulse candle reverses sharply and creates a price gap (Fair Value Gap) between itself and the sweep bar. For a SHORT setup the bias candle's HIGH must be strictly below the sweep bar's LOW; for LONG the bias candle's LOW must be strictly above the sweep bar's HIGH.
4. RETEST — price retraces back into the bias candle's body (FVG zone), creating the entry opportunity.
5. BOS (Break of Structure) — price closes through the bias candle body in the bias direction, confirming the setup and triggering entry.
6. STOP LOSS — placed at the bias candle's extreme (bcHigh for SHORT, bcLow for LONG), optionally extended by a small ATR buffer.
7. TAKE PROFIT — targets the opposing range boundary (rangeLow for SHORT, rangeHigh for LONG).

CURRENT STATE OF INSTRUMENTS:
${instrumentBlocks}

TASK: For each instrument listed above, decide whether to ENTER a trade RIGHT NOW or SKIP.
Only recommend a trade if ALL of the following are true:
1. There is a clear range established (rangeHigh and rangeLow are set)
2. A sweep beyond the range boundary has occurred in the bias direction
3. A strong FVG bias candle has formed after the sweep (true price gap between bias candle and sweep bar)
4. Price has retested the bias candle body (FVG zone) and a BOS has closed through it confirming entry
5. The instrument is not already in a position
6. The instrument has not exceeded its daily trade/loss limits

Respond with a JSON object in this exact format (no markdown, no explanation outside the JSON):
{
  "decisions": [
    {
      "symbol": "MYMM6",
      "action": "long" | "short" | "skip",
      "reasoning": "brief reason"
    }
  ],
  "summary": "one sentence overall market summary"
}`;
}

// ---------------------------------------------------------------------------
// Autonomous mode — ATR pullback signal-guided, with stacking + reversal
// ---------------------------------------------------------------------------

/** Compute a simple ATR approximation from bar data (true range average). */
export function computeAtr(bars: BarSnapshot[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs = bars.slice(1).map((b, i) => {
    const prev = bars[i];
    return Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  });
  const slice = trs.slice(-period);
  return slice.reduce((a, v) => a + v, 0) / slice.length;
}

function formatSignal(sig: AtrPullbackSignal | null, minTick: number): string {
  if (!sig) return "NO SIGNAL";
  const dp = minTick < 0.1 ? 3 : 2;
  return `${sig.direction.toUpperCase()} | ATR ${sig.atr.toFixed(dp)} | Stop ${sig.stopPrice.toFixed(dp)} | TP ${sig.tp1Price.toFixed(dp)}`;
}

function buildAutonomousPrompt(
  instruments: Array<{
    state: InstrumentState;
    config: InstrumentConfig;
    recentBars: BarSnapshot[];
    scalp1mBars: BarSnapshot[];
    signal5m: AtrPullbackSignal | null;
    signal1m: AtrPullbackSignal | null;
    effectiveMaxTrades: number;
    effectiveMaxLossesPerDirection: number;
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): string {
  const remainingBudget = dailyLossLimit + dailyPnl;
  const MAX_STACK = 2; // total positions per instrument (initial + 1 add-on)

  const instrumentBlocks = instruments
    .map(({ state, config, recentBars, scalp1mBars, signal5m, signal1m, effectiveMaxTrades, effectiveMaxLossesPerDirection }) => {
      const last50_5m = recentBars.slice(-50);
      const last25_1m = scalp1mBars.slice(-25);

      const bars5mText =
        last50_5m.length > 0
          ? last50_5m
              .map((b) => `  ${b.t.slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c} V:${b.v}`)
              .join("\n")
          : "  (no 5m bar data available)";

      const bars1mText =
        last25_1m.length > 0
          ? last25_1m
              .map((b) => `  ${b.t.slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c} V:${b.v}`)
              .join("\n")
          : "  (no 1m bar data available)";

      const atr = last50_5m.length >= 2 ? computeAtr(last50_5m) : null;
      const periodHigh = last50_5m.length > 0 ? Math.max(...last50_5m.map((b) => b.h)) : null;
      const periodLow  = last50_5m.length > 0 ? Math.min(...last50_5m.map((b) => b.l)) : null;
      const firstClose = last50_5m[0]?.c;
      const lastClose  = last50_5m[last50_5m.length - 1]?.c;
      const trendDir =
        firstClose !== undefined && lastClose !== undefined
          ? lastClose > firstClose ? "up" : lastClose < firstClose ? "down" : "flat"
          : "unknown";

      const stackInfo = state.isClaudePosition
        ? ` | Stack: ${state.positionStackCount + 1}/${MAX_STACK}`
        : "";
      const positionText = state.inPosition
        ? `YES — ${state.positionDirection?.toUpperCase()} ${state.positionQty} contract(s) @ entry ${state.positionEntryPrice}${stackInfo}`
        : "None";

      const statsText = [
        atr !== null ? `ATR(14): ${atr.toFixed(config.minTick < 0.1 ? 3 : 2)}` : null,
        periodHigh !== null ? `5m-window High: ${periodHigh}` : null,
        periodLow  !== null ? `5m-window Low:  ${periodLow}` : null,
        `5m Trend: ${trendDir}`,
      ].filter(Boolean).join(" | ");

      // Target P&L info for this instrument
      const tpPts35 = (35 / (config.pointValue * config.qty)).toFixed(config.minTick < 0.1 ? 2 : 1);
      const tpPts20 = (20 / (config.pointValue * config.qty)).toFixed(config.minTick < 0.1 ? 2 : 1);
      const tpPts50 = (50 / (config.pointValue * config.qty)).toFixed(config.minTick < 0.1 ? 2 : 1);

      return [
        `--- ${state.symbol} (${config.name}) ---`,
        `Current Price : ${state.lastPrice ?? "unknown"}`,
        `Open Position : ${positionText}`,
        `Trades Today  : ${state.todayTrades} / ${effectiveMaxTrades}`,
        `Long Losses   : ${state.longLosses} / ${effectiveMaxLossesPerDirection}`,
        `Short Losses  : ${state.shortLosses} / ${effectiveMaxLossesPerDirection}`,
        `Tick / Point  : ${config.minTick} tick | $${config.pointValue}/pt | Qty: ${config.qty}`,
        `TP Target     : ~${tpPts35} pts for $35 (min ${tpPts20} pts/$20 — max ${tpPts50} pts/$50)`,
        `Stats (5m)    : ${statsText}`,
        `ATR SIGNALS   : 5m → ${formatSignal(signal5m, config.minTick)} | 1m → ${formatSignal(signal1m, config.minTick)}`,
        `5-min bars — PRIMARY (oldest → newest, up to 50 bars):`,
        bars5mText,
        `1-min bars — SCALP CONTEXT (last 25 candles):`,
        bars1mText,
      ].join("\n");
    })
    .join("\n\n");

  return `You are an autonomous futures scalp trader using the ATR Pullback strategy on 1-minute and 5-minute bars.

ACCOUNT:
  Daily P&L       : $${dailyPnl.toFixed(2)}
  Loss Limit      : -$${dailyLossLimit}  (hard floor — never breach)
  Profit Target   : +$${dailyProfitTarget}
  Remaining Budget: $${remainingBudget.toFixed(2)}

STRATEGY:
  You use the ATR Volume Pullback strategy on BOTH 1m and 5m bars. A signal fires when:
  - EMA 20 > EMA 50 (uptrend) OR EMA 20 < EMA 50 (downtrend)
  - ADX >= 15 (trending market)
  - Previous bar pulled back into EMA 20 zone (within 0.5×ATR)
  - Current bar is a reversal candle (closes on correct side of EMA 20)
  - Volume >= 0.8× 20-bar SMA
  - RSI within range (35–72 long, 28–65 short)
  Each instrument's pre-computed signal is shown as "ATR SIGNALS" — use this as PRIMARY decision input.
  The 5m signal is preferred for higher conviction. The 1m signal adds scalp precision.

PROFIT TARGET: $20–$50 per trade (~$35 midpoint). The system will auto-size TP to ~$35.
  You decide direction; the agent computes the exact stop and TP from the ATR signal.
  Each trade holds a MAXIMUM of 30 minutes — positions auto-close at the 30-minute mark.
  Factor this time constraint into your entry conviction: only enter when the signal is fresh.

INSTRUMENTS:
${instrumentBlocks}

INSTRUCTIONS:
For each instrument output exactly one of:
  "long"    — enter long (only when NOT in a position AND 5m or 1m ATR signal is LONG)
  "short"   — enter short (only when NOT in a position AND 5m or 1m ATR signal is SHORT)
  "close"   — exit the open position now (only when IN a position)
  "stack"   — add to the existing position in the SAME direction (only when IN a position,
              signal direction matches current position direction, stack < ${MAX_STACK})
  "reverse" — close existing position and immediately enter in the OPPOSITE direction
              (only when IN a position and signal direction is OPPOSITE to current position)
  "skip"    — do nothing

Rules you must obey:
1. Never open or add to a position if remaining budget < $50.
2. Never open a new trade if today's trade count is at the max.
3. Only use "long"/"short" when NOT in a position; only use "close"/"stack"/"reverse" when IN a position.
4. Only use "stack" when the ATR signal direction MATCHES the current position direction.
5. Only use "reverse" when the ATR signal direction is OPPOSITE to the current position direction.
6. If no ATR signal (both 1m and 5m show NO SIGNAL), output "skip" or "close" only.
7. If an instrument shows "Stack: 2/2" in Open Position, do NOT stack further — output "skip" or "close".
8. Explain your signal interpretation in "reasoning" (reference whether 1m or 5m signal fired).
9. Set "timeframe" to "1m_scalp" when your entry is driven by the 1-min signal; otherwise "5m".

Respond with ONLY this JSON — no markdown, no extra text:
{
  "decisions": [
    {
      "symbol": "SYMBOL",
      "action": "long" | "short" | "close" | "skip" | "stack" | "reverse",
      "timeframe": "5m" | "1m_scalp",
      "reasoning": "your signal interpretation and market logic"
    }
  ],
  "summary": "one sentence describing your overall read of current ATR signal conditions"
}`;
}

// ---------------------------------------------------------------------------
// Test-only export (prefixed with _ to signal internal use)
// ---------------------------------------------------------------------------
export { buildAutonomousPrompt as _buildAutonomousPromptForTest };

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

function getAnthropicClient(): Anthropic {
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (!baseURL || !apiKey) {
    throw new Error("Anthropic integration not configured (missing AI_INTEGRATIONS_ANTHROPIC_BASE_URL / AI_INTEGRATIONS_ANTHROPIC_API_KEY)");
  }
  return new Anthropic({ baseURL, apiKey });
}

async function callClaude(prompt: string): Promise<ClaudeAdvice> {
  const client = getAnthropicClient();
  const model = "claude-sonnet-4-6";

  logger.info("Sending prompt to Claude");

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";
  logger.debug({ responseText: text }, "Claude raw response");

  let parsed: { decisions: ClaudeTradeDecision[]; summary: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ text }, "Claude response not valid JSON — attempting extraction");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Claude returned non-JSON response: ${text.slice(0, 200)}`);
    }
    parsed = JSON.parse(jsonMatch[0]);
  }

  return {
    decisions: parsed.decisions ?? [],
    summary: parsed.summary ?? "",
    model,
  };
}

export async function getClaudeTradeAdvice(
  instruments: Array<{ state: InstrumentState; config: InstrumentConfig; effectiveMaxTrades: number; effectiveMaxLossesPerDirection: number }>
): Promise<ClaudeAdvice> {
  const prompt = buildDTRPrompt(instruments);
  return callClaude(prompt);
}

export async function getClaudeAutonomousAdvice(
  instruments: Array<{
    state: InstrumentState;
    config: InstrumentConfig;
    recentBars: BarSnapshot[];
    scalp1mBars: BarSnapshot[];
    signal5m: AtrPullbackSignal | null;
    signal1m: AtrPullbackSignal | null;
    effectiveMaxTrades: number;
    effectiveMaxLossesPerDirection: number;
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): Promise<ClaudeAdvice> {
  const prompt = buildAutonomousPrompt(instruments, dailyPnl, dailyLossLimit, dailyProfitTarget);
  return callClaude(prompt);
}
