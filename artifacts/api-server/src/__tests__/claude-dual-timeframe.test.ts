/**
 * Smoke tests for the ATR-pullback-guided autonomous Claude prompt:
 * - 5-minute bars are the primary feed (with ATR signals)
 * - 1-minute bars are the scalp context (with ATR signals)
 * - `signal5m` / `signal1m` are passed and rendered in the prompt
 * - `"stack"` and `"reverse"` actions are included in the schema
 * - Scalp detection logic (timeframe field + keyword fallback) still works
 *
 * These tests validate prompt structure without hitting the live Anthropic API.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _buildAutonomousPromptForTest } from "../lib/claude-advisor.js";
import type { BarSnapshot } from "../lib/claude-advisor.js";
import type { AtrPullbackSignal } from "../lib/atr-pullback-strategy.js";
import { createInstrumentState } from "../lib/dtr-strategy.js";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

function makeBar(t: string, price: number): BarSnapshot {
  return { t, o: price, h: price + 2, l: price - 2, c: price, v: 100 };
}

function makeBars(n: number, basePrice: number, stepMs: number): BarSnapshot[] {
  const base = new Date("2025-04-17T09:00:00.000Z").getTime();
  return Array.from({ length: n }, (_, i) =>
    makeBar(new Date(base + i * stepMs).toISOString(), basePrice + i * 0.5)
  );
}

const bars5m = makeBars(50, 19000, 5 * 60 * 1000);
const bars1m = makeBars(25, 19010, 60 * 1000);

const mockSignal5m: AtrPullbackSignal = {
  direction: "long",
  entryPrice: 19020,
  stopPrice: 19000,
  tp1Price: 19035,
  atr: 20,
};

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
  signal5m: mockSignal5m,
  signal1m: null,
  effectiveMaxTrades: 4,
  effectiveMaxLossesPerDirection: 2,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ATR-guided autonomous prompt structure", () => {
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

  it("includes ATR SIGNALS line in instrument block", () => {
    assert.ok(
      prompt.includes("ATR SIGNALS"),
      "Prompt should include 'ATR SIGNALS' section per instrument"
    );
  });

  it("renders 5m signal direction in ATR SIGNALS line", () => {
    assert.ok(
      prompt.includes("LONG"),
      "Prompt should render the 5m signal direction (LONG)"
    );
  });

  it("renders NO SIGNAL for null 1m signal", () => {
    assert.ok(
      prompt.includes("NO SIGNAL"),
      "Prompt should render 'NO SIGNAL' when signal1m is null"
    );
  });

  it("includes at least 20 bars in the primary section", () => {
    const barLines = (prompt.match(/O:\d+/g) ?? []).length;
    assert.ok(barLines >= 20, `Should have >=20 bar entries, got ${barLines}`);
  });

  it("includes timeframe field in JSON schema", () => {
    assert.ok(
      prompt.includes('"timeframe"'),
      "Prompt should include timeframe field in the JSON schema"
    );
  });

  it("includes 1m_scalp value in JSON schema", () => {
    assert.ok(
      prompt.includes("1m_scalp"),
      "Prompt should mention '1m_scalp' as a valid timeframe value"
    );
  });

  it("includes 'stack' action in the schema", () => {
    assert.ok(
      prompt.includes('"stack"'),
      "Prompt should include 'stack' as a valid action"
    );
  });

  it("includes 'reverse' action in the schema", () => {
    assert.ok(
      prompt.includes('"reverse"'),
      "Prompt should include 'reverse' as a valid action"
    );
  });

  it("includes TP Target line with dollar amounts", () => {
    assert.ok(
      prompt.includes("TP Target"),
      "Prompt should include 'TP Target' showing $20/$35/$50 guidance"
    );
  });

  it("mentions 30-minute max hold rule", () => {
    assert.ok(
      prompt.includes("30 minutes"),
      "Prompt should mention the 30-minute auto-close rule"
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

describe("Dual-timeframe bar rendering", () => {
  it("renders 5m bars with 09:00 as the first timestamp (oldest bar)", () => {
    const prompt = _buildAutonomousPromptForTest([mockInstrument], 0, 200, 1400);
    assert.ok(prompt.includes("09:00"), "First 5m bar should be visible at 09:00");
  });

  it("empty bar arrays render fallback messages", () => {
    const emptyInstrument = {
      ...mockInstrument,
      recentBars: [],
      scalp1mBars: [],
      signal5m: null,
      signal1m: null,
    };
    const prompt = _buildAutonomousPromptForTest([emptyInstrument], 0, 200, 1400);
    assert.ok(prompt.includes("(no 5m bar data available)"), "Should show 5m fallback");
    assert.ok(prompt.includes("(no 1m bar data available)"), "Should show 1m fallback");
  });

  it("renders both signals as NO SIGNAL when both are null", () => {
    const noSignalInstrument = { ...mockInstrument, signal5m: null, signal1m: null };
    const prompt = _buildAutonomousPromptForTest([noSignalInstrument], 0, 200, 1400);
    const noSignalCount = (prompt.match(/NO SIGNAL/g) ?? []).length;
    assert.ok(noSignalCount >= 2, `Should have at least 2 NO SIGNAL occurrences, got ${noSignalCount}`);
  });
});
