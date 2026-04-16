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
  instruments: Array<{ state: InstrumentState; config: InstrumentConfig }>
): string {
  const instrumentBlocks = instruments
    .map(({ state, config }) => {
      const r = state.rangeData;
      return [
        `Instrument: ${state.symbol} (${config.name})`,
        `  Last Price: ${state.lastPrice ?? "unknown"}`,
        `  Range High: ${r?.high ?? "not set"}`,
        `  Range Low: ${r?.low ?? "not set"}`,
        `  Range Midpoint: ${r?.midpoint ?? "not set"}`,
        `  Bias: ${r?.bias ?? "unknown"}`,
        `  In Position: ${state.inPosition ? `YES (${state.positionDirection})` : "No"}`,
        `  Trades Today: ${state.todayTrades} / ${config.maxTradesPerDay}`,
        `  Long Losses Today: ${state.longLosses} / ${config.maxLossesPerDirection}`,
        `  Short Losses Today: ${state.shortLosses} / ${config.maxLossesPerDirection}`,
        `  Point Value: $${config.pointValue}`,
        `  Min Tick: ${config.minTick}`,
      ].join("\n");
    })
    .join("\n\n");

  return `You are a professional futures trader specializing in the DTR (Draw The Range) strategy.

The DTR strategy works as follows:
- We establish a range (high and low) during a defined time window
- A bias candle at the end of the range window tells us directional bias:
  - Bullish bias = price closed above midpoint → prefer LONG entries
  - Bearish bias = price closed below midpoint → prefer SHORT entries
- An entry signal occurs when price breaks above range high (for longs) or below range low (for shorts) matching the bias
- Stop loss is placed at the opposite range boundary
- Take profit targets a range-width projection beyond the breakout

CURRENT STATE OF INSTRUMENTS:
${instrumentBlocks}

TASK: For each instrument listed above, decide whether to ENTER a trade RIGHT NOW or SKIP.
Only recommend a trade if:
1. There is a clear range established (rangeHigh and rangeLow are set)
2. The current price is near or has broken out of the range boundary matching the bias direction
3. The instrument is not already in a position
4. The instrument has not exceeded its daily trade/loss limits

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
// Autonomous mode — no DTR rules, Claude trades freely with full bar context
// ---------------------------------------------------------------------------
function buildAutonomousPrompt(
  instruments: Array<{
    state: InstrumentState;
    config: InstrumentConfig;
    recentBars: BarSnapshot[];
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): string {
  const instrumentBlocks = instruments
    .map(({ state, config, recentBars }) => {
      const barsText =
        recentBars.length > 0
          ? recentBars
              .slice(-10)
              .map(
                (b) =>
                  `    ${b.t.slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c} V:${b.v}`
              )
              .join("\n")
          : "    No recent bars available";

      const positionText = state.inPosition
        ? `YES — ${state.positionDirection?.toUpperCase()} ${state.positionQty} contract(s) entered at ${state.positionEntryPrice}`
        : "No open position";

      return [
        `=== ${state.symbol} (${config.name}) ===`,
        `Current Price: ${state.lastPrice ?? "unknown"}`,
        `Position: ${positionText}`,
        `Trades Today: ${state.todayTrades} / ${config.maxTradesPerDay}`,
        `Long Losses Today: ${state.longLosses} / ${config.maxLossesPerDirection}`,
        `Short Losses Today: ${state.shortLosses} / ${config.maxLossesPerDirection}`,
        `Tick Size: ${config.minTick} | Point Value: $${config.pointValue}/pt`,
        `Recent 1-min bars (last 10):`,
        barsText,
      ].join("\n");
    })
    .join("\n\n");

  return `You are an expert futures day trader with full discretion to trade these micro futures contracts.
You are NOT constrained by any specific strategy — use your own analysis of price action, momentum, and market structure.

ACCOUNT STATUS:
  Daily P&L: $${dailyPnl.toFixed(2)}
  Daily Loss Limit: -$${dailyLossLimit} (HARD STOP — do not exceed)
  Daily Profit Target: +$${dailyProfitTarget}
  Remaining loss budget: $${(dailyLossLimit + dailyPnl).toFixed(2)}

INSTRUMENTS:
${instrumentBlocks}

YOUR TASK:
For each instrument, decide one of:
- "long"  — open a new long position now (only if NOT already in a position)
- "short" — open a new short position now (only if NOT already in a position)
- "close" — close the existing position now (only if IN a position)
- "skip"  — do nothing

Consider:
- Momentum and direction from recent bars
- Support/resistance levels visible in the bar data
- Risk/reward given current daily P&L
- Don't open new positions if daily loss limit is nearly hit (remaining < $50)
- Don't open new positions if daily profit target is already exceeded
- Only recommend "close" for instruments that have an open position
- Only recommend "long"/"short" for instruments with NO open position

Respond with ONLY a JSON object, no markdown, no preamble:
{
  "decisions": [
    {
      "symbol": "SYMBOL",
      "action": "long" | "short" | "close" | "skip",
      "reasoning": "1-2 sentence explanation of your analysis"
    }
  ],
  "summary": "one sentence overall market read"
}`;
}

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
  instruments: Array<{ state: InstrumentState; config: InstrumentConfig }>
): Promise<ClaudeAdvice> {
  const prompt = buildDTRPrompt(instruments);
  return callClaude(prompt);
}

export async function getClaudeAutonomousAdvice(
  instruments: Array<{
    state: InstrumentState;
    config: InstrumentConfig;
    recentBars: BarSnapshot[];
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): Promise<ClaudeAdvice> {
  const prompt = buildAutonomousPrompt(instruments, dailyPnl, dailyLossLimit, dailyProfitTarget);
  return callClaude(prompt);
}
