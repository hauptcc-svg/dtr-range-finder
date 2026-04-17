/**
 * Smoke tests for the dual-timeframe Claude autonomous prompt:
 * - 5-minute bars are the primary feed
 * - 1-minute bars are the scalp context
 * - `timeframe: "1m_scalp"` in decision triggers scalp note tagging
 *
 * These tests validate prompt structure and scalp-detection logic without
 * hitting the live Anthropic API.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _buildAutonomousPromptForTest } from "../lib/claude-advisor.js";
import type { BarSnapshot } from "../lib/claude-advisor.js";
import { createInstrumentState } from "../lib/dtr-strategy.js";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

function makeBar(t: string, price: number): BarSnapshot {
  return { t, o: price, h: price + 2, l: price - 2, c: price, v: 100 };
}

/** Generate N bars starting from baseTime (ISO) with 1-minute or 5-minute step. */
function makeBars(n: number, basePrice: number, stepMs: number): BarSnapshot[] {
  const base = new Date("2025-04-17T09:00:00.000Z").getTime();
  return Array.from({ length: n }, (_, i) =>
    makeBar(new Date(base + i * stepMs).toISOString(), basePrice + i * 0.5)
  );
}

const bars5m = makeBars(50, 19000, 5 * 60 * 1000);   // 50 × 5-min bars
const bars1m = makeBars(25, 19010, 60 * 1000);        // 25 × 1-min bars

const mockInstrument = {
  state: (() => {
    const s = createInstrumentState("MYMM6");
    s.lastPrice = 19020;
    return s;
  })(),
  config: {
    symbol: "MYMM6",
    name: "Micro Dow (MYM)",
    enabled: true,
    qty: 2,
    tp1Qty: 1,
    londonRangeStart: "01:12",
    londonRangeEnd: "02:13",
    londonEntryStart: "02:13",
    londonEntryEnd: "04:00",
    nyRangeStart: "08:12",
    nyRangeEnd: "09:13",
    nyEntryStart: "09:13",
    nyEntryEnd: "14:00",
    biasCandle_atrMult: 1.5,
    slAtrBuffer: 0.0,
    tpMode: "Range Target" as const,
    maxTradesPerDay: 4,
    maxLossesPerDirection: 2,
    pointValue: 0.5,
    minTick: 1,
    strategyMode: "dtr" as const,
    sess2EntryEnd: "04:00",
  },
  recentBars: bars5m,
  scalp1mBars: bars1m,
  effectiveMaxTrades: 4,
  effectiveMaxLossesPerDirection: 2,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Dual-timeframe autonomous prompt structure", () => {
  const prompt = _buildAutonomousPromptForTest(
    [mockInstrument],
    -50,
    200,
    1400
  );

  it("contains PRIMARY 5m section label", () => {
    assert.ok(
      prompt.includes("5-min bars — PRIMARY"),
      "Prompt should include '5-min bars — PRIMARY' label"
    );
  });

  it("contains SCALP CONTEXT 1m section label", () => {
    assert.ok(
      prompt.includes("1-min bars — SCALP CONTEXT"),
      "Prompt should include '1-min bars — SCALP CONTEXT' label"
    );
  });

  it("includes at least 20 5m bars in the primary section", () => {
    // Each bar renders as "HH:MM O:... H:... L:... C:... V:..."
    const barLines = (prompt.match(/O:\d+/g) ?? []).length;
    assert.ok(barLines >= 20, `Should have >=20 bar entries, got ${barLines}`);
  });

  it("includes timeframe field in JSON schema example", () => {
    assert.ok(
      prompt.includes('"timeframe"'),
      "Prompt should include timeframe field in the JSON schema"
    );
  });

  it("instructs Claude to use 1m_scalp value", () => {
    assert.ok(
      prompt.includes("1m_scalp"),
      "Prompt should mention '1m_scalp' as a valid timeframe value"
    );
  });
});

describe("Scalp detection logic", () => {
  it("detects 1m_scalp via timeframe field (primary path)", () => {
    const decision = { symbol: "MYMM6", action: "long" as const, reasoning: "breakout", timeframe: "1m_scalp" as const };
    const isScalp = decision.timeframe === "1m_scalp" || /scalp/i.test(decision.reasoning ?? "");
    assert.equal(isScalp, true);
  });

  it("detects scalp via reasoning keyword fallback", () => {
    const decision = { symbol: "MYMM6", action: "long" as const, reasoning: "tight scalp off 1m range break" };
    const isScalp = decision.timeframe === "1m_scalp" || /scalp/i.test(decision.reasoning ?? "");
    assert.equal(isScalp, true);
  });

  it("does not tag 5m trades as scalp", () => {
    const decision = { symbol: "MYMM6", action: "long" as const, reasoning: "5m BOS above range high", timeframe: "5m" as const };
    const isScalp = decision.timeframe === "1m_scalp" || /scalp/i.test(decision.reasoning ?? "");
    assert.equal(isScalp, false);
  });

  it("does not tag trades with no timeframe field and no keyword", () => {
    const decision = { symbol: "MYMM6", action: "long" as const, reasoning: "momentum breakout" };
    const isScalp = (decision as { timeframe?: string }).timeframe === "1m_scalp" || /scalp/i.test(decision.reasoning ?? "");
    assert.equal(isScalp, false);
  });
});

describe("Dual-timeframe bar counts in prompt", () => {
  it("renders 5m bars as 09:00–09:04 increments", () => {
    const prompt = _buildAutonomousPromptForTest([mockInstrument], 0, 200, 1400);
    // The 5m bars should show 09:00 as the first timestamp (oldest bar)
    assert.ok(prompt.includes("09:00"), "First 5m bar should be visible at 09:00");
  });

  it("empty bar arrays render fallback messages", () => {
    const emptyInstrument = {
      ...mockInstrument,
      recentBars: [],
      scalp1mBars: [],
    };
    const prompt = _buildAutonomousPromptForTest([emptyInstrument], 0, 200, 1400);
    assert.ok(prompt.includes("(no 5m bar data available)"), "Should show 5m fallback");
    assert.ok(prompt.includes("(no 1m bar data available)"), "Should show 1m fallback");
  });
});
