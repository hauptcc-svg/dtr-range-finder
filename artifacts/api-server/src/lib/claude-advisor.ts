/**
 * Claude AI Advisor
 *
 * Sends current instrument states to Claude Sonnet for analysis.
 * Claude reviews the DTR range data, bias, and price and decides
 * whether to enter a trade on each instrument.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { InstrumentState } from "./dtr-strategy";
import type { InstrumentConfig } from "./trading-config";

export interface ClaudeTradeDecision {
  symbol: string;
  action: "long" | "short" | "skip";
  reasoning: string;
}

export interface ClaudeAdvice {
  decisions: ClaudeTradeDecision[];
  summary: string;
  model: string;
}

function buildPrompt(
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

export async function getClaudeTradeAdvice(
  instruments: Array<{ state: InstrumentState; config: InstrumentConfig }>
): Promise<ClaudeAdvice> {
  const baseURL = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error("Anthropic integration not configured (missing env vars)");
  }

  const client = new Anthropic({ baseURL, apiKey });
  const model = "claude-sonnet-4-6";

  const prompt = buildPrompt(instruments);

  logger.info({ symbolCount: instruments.length }, "Sending market state to Claude for analysis");

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
    logger.warn({ text }, "Claude response was not valid JSON, attempting extraction");
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
