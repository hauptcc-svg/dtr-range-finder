/**
 * Claude AI Advisor
 *
 * Two modes:
 * 1. DTR-Assist: Claude reviews current DTR range/bias state and decides to enter or skip.
 * 2. Autonomous: Claude has full freedom — it gets recent bars, current price, positions,
 *    and decides entries AND exits with no DTR rules required.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { InstrumentState } from "./dtr-strategy";
import type { InstrumentConfig } from "./trading-config";

export interface ClaudeTradeDecision {
  symbol: string;
  action: "long" | "short" | "close" | "skip";
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
// Autonomous mode — NO DTR rules, no ranges, Claude picks its own strategy
// ---------------------------------------------------------------------------

/** Compute a simple ATR approximation from bar data (true range average). */
function computeAtr(bars: BarSnapshot[], period = 14): number {
  if (bars.length < 2) return 0;
  const trs = bars.slice(1).map((b, i) => {
    const prev = bars[i];
    return Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
  });
  const slice = trs.slice(-period);
  return slice.reduce((a, v) => a + v, 0) / slice.length;
}
function buildAutonomousPrompt(
  instruments: Array<{
    state: InstrumentState;
    config: InstrumentConfig;
    recentBars: BarSnapshot[];      // 5-minute bars — primary strategy timeframe
    scalp1mBars: BarSnapshot[];     // 1-minute bars — scalp context only
    effectiveMaxTrades: number;
    effectiveMaxLossesPerDirection: number;
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): string {
  const remainingBudget = dailyLossLimit + dailyPnl;

  const instrumentBlocks = instruments
    .map(({ state, config, recentBars, scalp1mBars, effectiveMaxTrades, effectiveMaxLossesPerDirection }) => {
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

      // Derived stats from the 5m bar window
      const atr = last50_5m.length >= 2 ? computeAtr(last50_5m) : null;
      const periodHigh = last50_5m.length > 0 ? Math.max(...last50_5m.map((b) => b.h)) : null;
      const periodLow  = last50_5m.length > 0 ? Math.min(...last50_5m.map((b) => b.l)) : null;
      const firstClose = last50_5m[0]?.c;
      const lastClose  = last50_5m[last50_5m.length - 1]?.c;
      const trendDir =
        firstClose !== undefined && lastClose !== undefined
          ? lastClose > firstClose
            ? "up"
            : lastClose < firstClose
            ? "down"
            : "flat"
          : "unknown";

      const positionText = state.inPosition
        ? `YES — ${state.positionDirection?.toUpperCase()} ${state.positionQty} contract(s) @ entry ${state.positionEntryPrice}`
        : "None";

      const statsText = [
        atr !== null ? `ATR(14): ${atr.toFixed(config.minTick < 0.1 ? 3 : 2)}` : null,
        periodHigh !== null ? `5m-window High: ${periodHigh}` : null,
        periodLow  !== null ? `5m-window Low:  ${periodLow}` : null,
        `5m Trend: ${trendDir}`,
      ]
        .filter(Boolean)
        .join(" | ");

      return [
        `--- ${state.symbol} (${config.name}) ---`,
        `Current Price : ${state.lastPrice ?? "unknown"}`,
        `Open Position : ${positionText}`,
        `Trades Today  : ${state.todayTrades} / ${effectiveMaxTrades}`,
        `Long Losses   : ${state.longLosses} / ${effectiveMaxLossesPerDirection}`,
        `Short Losses  : ${state.shortLosses} / ${effectiveMaxLossesPerDirection}`,
        `Tick / Point  : ${config.minTick} tick | $${config.pointValue}/pt`,
        `Stats (5m)    : ${statsText}`,
        `5-min bars — PRIMARY (oldest → newest, up to 50 bars):`,
        bars5mText,
        `1-min bars — SCALP CONTEXT (last 25 candles):`,
        bars1mText,
      ].join("\n");
    })
    .join("\n\n");

  return `You are an autonomous futures trader with complete discretion. You choose your own strategy based purely on current market conditions — momentum, trend-following, breakout, mean-reversion, volume analysis, or any other approach you judge appropriate right now. There are no rules about ranges, sessions, or biases. Just read the market and act.

ACCOUNT:
  Daily P&L       : $${dailyPnl.toFixed(2)}
  Loss Limit      : -$${dailyLossLimit}  (hard floor — never breach)
  Profit Target   : +$${dailyProfitTarget}
  Remaining Budget: $${remainingBudget.toFixed(2)}

TIMEFRAME CONTEXT:
  Primary (5m): Use the 5-minute bars for all macro structure, trend direction, swing highs/lows, and DTR/RBS confluence. This is your main decision frame.
  Scalp (1m):   Use the 1-minute bars ONLY to pinpoint precise entries when a clean short-term setup (micro-BOS, exhaustion candle, tight range break) is visible and the 5m bias supports it. If you enter off the 1m view, include the word "scalp" prominently in your reasoning.

INSTRUMENTS:
${instrumentBlocks}

INSTRUCTIONS:
For each instrument output exactly one of:
  "long"  — enter a long now  (only when NOT in a position)
  "short" — enter a short now (only when NOT in a position)
  "close" — exit the open position now (only when IN a position)
  "skip"  — do nothing

Rules you must obey:
1. Never go long and short the same instrument simultaneously.
2. Never open a new trade if remaining budget < $50.
3. Never open a new trade if today's trade count is at the max.
4. Only output "close" for instruments that have an open position.
5. Only output "long"/"short" for instruments with no open position.
6. Explain your market logic in the "reasoning" field (2-3 sentences, name the specific pattern/setup you see).
7. Set "timeframe" to "1m_scalp" when your entry decision is driven by the 1-minute scalp window; otherwise set it to "5m".

Respond with ONLY this JSON — no markdown, no extra text:
{
  "decisions": [
    {
      "symbol": "SYMBOL",
      "action": "long" | "short" | "close" | "skip",
      "timeframe": "5m" | "1m_scalp",
      "reasoning": "your market analysis and the specific setup you identified"
    }
  ],
  "summary": "one sentence describing your overall read of current market conditions"
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
    recentBars: BarSnapshot[];      // 5-minute bars — primary strategy timeframe
    scalp1mBars: BarSnapshot[];     // 1-minute bars — scalp context
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
