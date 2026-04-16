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
    recentBars: BarSnapshot[];
  }>,
  dailyPnl: number,
  dailyLossLimit: number,
  dailyProfitTarget: number
): string {
  const remainingBudget = dailyLossLimit + dailyPnl;

  const instrumentBlocks = instruments
    .map(({ state, config, recentBars }) => {
      const last30 = recentBars.slice(-30);

      const barsText =
        last30.length > 0
          ? last30
              .map(
                (b) =>
                  `  ${b.t.slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c} V:${b.v}`
              )
              .join("\n")
          : "  (no bar data available)";

      // Derived stats from the bar window
      const atr = last30.length >= 2 ? computeAtr(last30) : null;
      const periodHigh = last30.length > 0 ? Math.max(...last30.map((b) => b.h)) : null;
      const periodLow  = last30.length > 0 ? Math.min(...last30.map((b) => b.l)) : null;
      const firstClose = last30[0]?.c;
      const lastClose  = last30[last30.length - 1]?.c;
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
        periodHigh !== null ? `30-bar High: ${periodHigh}` : null,
        periodLow  !== null ? `30-bar Low:  ${periodLow}` : null,
        `30-bar Trend: ${trendDir}`,
      ]
        .filter(Boolean)
        .join(" | ");

      return [
        `--- ${state.symbol} (${config.name}) ---`,
        `Current Price : ${state.lastPrice ?? "unknown"}`,
        `Open Position : ${positionText}`,
        `Trades Today  : ${state.todayTrades} / ${config.maxTradesPerDay}`,
        `Tick / Point  : ${config.minTick} tick | $${config.pointValue}/pt`,
        `Stats         : ${statsText}`,
        `Recent 1-min bars (oldest → newest):`,
        barsText,
      ].join("\n");
    })
    .join("\n\n");

  return `You are an autonomous futures trader with complete discretion. You choose your own strategy based purely on current market conditions — momentum, trend-following, breakout, mean-reversion, volume analysis, or any other approach you judge appropriate right now. There are no rules about ranges, sessions, or biases. Just read the market and act.

ACCOUNT:
  Daily P&L       : $${dailyPnl.toFixed(2)}
  Loss Limit      : -$${dailyLossLimit}  (hard floor — never breach)
  Profit Target   : +$${dailyProfitTarget}
  Remaining Budget: $${remainingBudget.toFixed(2)}

INSTRUMENTS (1-minute bars, last 30 candles):
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

Respond with ONLY this JSON — no markdown, no extra text:
{
  "decisions": [
    {
      "symbol": "SYMBOL",
      "action": "long" | "short" | "close" | "skip",
      "reasoning": "your market analysis and the specific setup you identified"
    }
  ],
  "summary": "one sentence describing your overall read of current market conditions"
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
