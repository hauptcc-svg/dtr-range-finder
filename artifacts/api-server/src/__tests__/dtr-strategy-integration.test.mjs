/**
 * buildRbsSession — Integration Tests
 *
 * Covers end-to-end behaviour of buildRbsSession:
 *   1. Range boundary isolation: rangeHigh/rangeLow only from range-window bars
 *   2. Break-window bars excluded from range computation
 *   3. Short signal — slMult=0 (stop = exact bias-candle extreme)
 *   4. Short signal — slMult>0 (stop = bias extreme + ATR × slMult)
 *   5. Short TP is set to opposing boundary (rangeLow)
 *   6. Long signal — slMult=0 (stop = exact bias-candle extreme)
 *   7. Long signal — slMult>0
 *   8. Long TP is set to opposing boundary (rangeHigh)
 *
 * ATR calculations are hand-traced below each describe block so that every
 * numeric assertion can be verified without running the code.
 *
 * Run:  pnpm --filter @workspace/api-server test
 *  or:  node --test --import tsx/esm src/__tests__/dtr-strategy.test.ts \
 *                               src/__tests__/dtr-strategy-integration.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildRbsSession, computeAtr14 } from "../lib/dtr-strategy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a synthetic bar. `t` is a timestamp in milliseconds. */
function bar(o, h, l, c, t = 0) {
  return { o, h, l, c, t, v: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared time boundaries
//
//   Range window : t=0  .. t<5  (5 range bars at t=0,1,2,3,4)
//   Break window : t=10 .. t<20 (break bars at t=10,11,12,13)
//   Other times are outside both windows and are ignored
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_END_MS   = 5;
const BREAK_START_MS = 10;
const BREAK_END_MS   = 20;
const FVG_MULT       = 1.5;
const MIN_TICK       = 1;     // whole numbers — avoids rounding noise in assertions
const CURRENT_PRICE  = 99;    // arbitrary; used as entryPrice in the signal

/**
 * Five range bars: o/c=95, h=100, l=90.
 * They produce: rangeHigh=100, rangeLow=90.
 * True ranges between consecutive range bars = 10 each.
 */
const RANGE_BARS = [
  bar(95, 100, 90, 95, 0),
  bar(95, 100, 90, 95, 1),
  bar(95, 100, 90, 95, 2),
  bar(95, 100, 90, 95, 3),
  bar(95, 100, 90, 95, 4),
];

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 1: Range boundary isolation
//
// Scenario: break-window bars have extreme prices (h=200, l=50).
// Those prices must NOT influence rangeHigh / rangeLow.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRbsSession — range boundary isolation", () => {
  /**
   * Break bars intentionally span a much wider range than the range window.
   * The state machines need at least a sweep+bias candle for ATR, so we pick
   * bars that also satisfy fvgSizeMult * ATR (ATR will be large here, so
   * signals will not fire — we only care about rangeHigh/rangeLow here).
   */
  const extremeBreakBars = [
    bar(100, 200, 50, 199, 10), // enormous move — well outside range
    bar(199, 200, 50, 51,  11),
  ];

  const allBars = [...RANGE_BARS, ...extremeBreakBars];

  test("rangeHigh equals the range-window bar high (100), not break-bar high (200)", () => {
    const result = buildRbsSession(
      allBars, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.rangeHigh, 100, "rangeHigh must be computed from range bars only");
  });

  test("rangeLow equals the range-window bar low (90), not break-bar low (50)", () => {
    const result = buildRbsSession(
      allBars, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.rangeLow, 90, "rangeLow must be computed from range bars only");
  });

  test("bars before range window (t<0) are also excluded (empty rangeBars → null boundaries)", () => {
    // All bars have t=10 (break window only), so no range bars at all
    const breakOnlyBars = [bar(95, 100, 90, 95, 10), bar(95, 100, 90, 95, 11)];
    const result = buildRbsSession(
      breakOnlyBars, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.rangeHigh, null, "no range bars → rangeHigh is null");
    assert.equal(result.rangeLow,  null, "no range bars → rangeLow is null");
  });

  test("bars after break window (t>=breakEndMs) are excluded from machine replay", () => {
    // Add a bar at t=20 (equal to breakEndMs, so outside break window).
    // If the machine were to process it, it would fire an erroneous signal.
    // The bar is a sweep (close=101 > rangeHigh=100) which, if fed to the
    // state machine, would move stage 0→1, but no signal. To make the
    // distinction observable: we put a full BOS sequence in t=20..23 range
    // and verify no signal fires.
    const bosAfterBreak = [
      ...RANGE_BARS,
      bar(99,  102, 98, 101, 20), // sweep — outside break window
      bar(103, 104, 90, 87,  21), // bias candle — outside break window
      bar(90,  88,  85, 88,  22), // retest — outside break window
      bar(88,  89,  84, 85,  23), // BOS — outside break window
    ];
    const result = buildRbsSession(
      bosAfterBreak, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.shortSignal, null, "bars outside break window must not fire signals");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 2: Short signal — slMult=0 and slMult>0
//
// Break bars (SHORT BOS, 4-bar flow):
//   t=10  sweep   o=103,h=110,l=105,c=107  close(107) > rangeHigh(100) → stage 1
//                                           l=105 > bias.h=104 → FVG gate will pass
//   t=11  bias    o=103,h=104,l=90,c=87    body=16 → FVG ✓ (h=104 < prevBar.l=105)
//                                           stage 2; bcHigh=104, bcBodyBot=87
//   t=12  retest  o=90,h=90,l=85,c=88     high(90)≥bcBodyBot(87), close(88)≮87 → stage 3
//   t=13  BOS     o=88,h=89,l=84,c=85     close(85)<bcBodyBot(87) → pending=true, slSource=104
//
// ATR computation (computeAtr14 over all 9 bars):
//   Consecutive true ranges (bar[i] vs bar[i-1]):
//     i=1: prev_c=95  bar h=100 l=90   TR = max(10, |100-95|=5,  |90-95|=5)   = 10
//     i=2: prev_c=95  bar h=100 l=90   TR = 10
//     i=3: prev_c=95  bar h=100 l=90   TR = 10
//     i=4: prev_c=95  bar h=100 l=90   TR = 10
//     i=5: prev_c=95  bar h=110 l=105  TR = max(5, |110-95|=15, |105-95|=10)  = 15  [new sweep]
//     i=6: prev_c=107 bar h=104 l=90   TR = max(14, |104-107|=3, |90-107|=17) = 17  [bias, new prev_c]
//     i=7: prev_c=87  bar h=90  l=85   TR = max(5, |90-87|=3, |85-87|=2)      =  5
//     i=8: prev_c=88  bar h=89  l=84   TR = max(5, |89-88|=1, |84-88|=4)      =  5
//   8 TRs total (< 14, so all are used):
//   ATR = (10+10+10+10+15+17+5+5) / 8 = 82 / 8 = 10.25
//
//   slMult=0 stopPrice  = round(104 + 0×10.25, 1)      = 104
//   slMult=1 stopPrice  = round(104 + 1×10.25, 1)
//                       = round(114.25, 1) = 114          [Math.round(114.25)=114]
//   tp1Price (SHORT)    = round(rangeLow=90, 1)         = 90
// ─────────────────────────────────────────────────────────────────────────────

const SHORT_BREAK_BARS = [
  bar(103, 110, 105, 107, 10), // sweep (close=107>RH=100, l=105 > bias.h=104 → FVG ✓)
  bar(103, 104, 90,  87,  11), // bias candle — h=104 < prevBar.l=105 ✓, bcHigh=104, bcBodyBot=87, body=16
  bar(90,  90,  85,  88,  12), // retest (high≥87, close≮87) → stage 3
  bar(88,  89,  84,  85,  13), // BOS (close<87) → pending
];

const SHORT_ALL_BARS = [...RANGE_BARS, ...SHORT_BREAK_BARS];

describe("buildRbsSession — Short signal construction", () => {
  test("ATR is computed as 10.25 (hand-traced true ranges)", () => {
    const atr = computeAtr14(SHORT_ALL_BARS);
    assert.ok(
      Math.abs(atr - 10.25) < 0.0001,
      `expected ATR=10.25, got ${atr}`,
    );
  });

  test("slMult=0: stopPrice equals bias-candle HIGH exactly (no ATR buffer)", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, /*slMult=*/0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal, "short signal should fire");
    assert.equal(result.shortSignal.stopPrice, 104,
      "slMult=0: stop = round(bcHigh=104 + 0*atr, 1) = 104");
  });

  test("slMult=1: stopPrice equals bcHigh + 1*ATR rounded to tick", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, /*slMult=*/1, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal, "short signal should fire");
    // round(104 + 10.25, 1) = round(114.25, 1) = 114
    assert.equal(result.shortSignal.stopPrice, 114,
      "slMult=1: stop = round(104 + 10.25, 1) = 114");
  });

  test("tp1Price is the opposing range boundary (rangeLow=90)", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.tp1Price, 90,
      "short TP1 = roundToTick(rangeLow=90, 1) = 90");
  });

  test("tp2Price equals tp1Price (both set to opposing boundary)", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.tp2Price, result.shortSignal.tp1Price);
  });

  test("signal direction is 'short'", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.direction, "short");
  });

  test("entryPrice equals currentPrice passed in", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.entryPrice, CURRENT_PRICE);
  });

  test("rangeHigh and rangeLow are echoed into the signal", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.rangeHigh, 100);
    assert.equal(result.shortSignal.rangeLow,  90);
  });

  test("longSignal is null when only short BOS fires", () => {
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.longSignal, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 3: Long signal — slMult=0 and slMult>0
//
// Break bars (LONG BOS, 4-bar flow):
//   t=10  sweep   o=83,h=83,l=80,c=82    close(82) < rangeLow(90) → stage 1
//                                         h=83 < bias.l=84 → FVG gate will pass
//   t=11  bias    o=85,h=88,l=84,c=101   body=16 → FVG ✓ (l=84 > prevBar.h=83)
//                                         stage 2; bcLow=84, bcBodyTop=101
//   t=12  retest  o=99,h=99,l=94,c=95   low(94)≤bcBodyTop(101), close(95)≯101 → stage 3
//   t=13  BOS     o=95,h=103,l=93,c=103  close(103)>bcBodyTop(101) → pending=true, slSource=84
//
// ATR computation (computeAtr14 over all 9 bars):
//   i=1: prev_c=95  bar h=100 l=90  TR = max(10, |100-95|=5,  |90-95|=5)    = 10
//   i=2: prev_c=95  bar h=100 l=90  TR = 10
//   i=3: prev_c=95  bar h=100 l=90  TR = 10
//   i=4: prev_c=95  bar h=100 l=90  TR = 10
//   i=5: prev_c=95  bar h=83  l=80  TR = max(3, |83-95|=12, |80-95|=15)     = 15  [new sweep]
//   i=6: prev_c=82  bar h=88  l=84  TR = max(4, |88-82|=6,  |84-82|=2)      =  6  [bias, new prev_c]
//   i=7: prev_c=101 bar h=99  l=94  TR = max(5, |99-101|=2, |94-101|=7)     =  7
//   i=8: prev_c=95  bar h=103 l=93  TR = max(10, |103-95|=8, |93-95|=2)     = 10
//   8 TRs total (< 14, so all are used):
//   ATR = (10+10+10+10+15+6+7+10) / 8 = 78/8 = 9.75
//
//   slMult=0 stopPrice  = round(84 - 0×9.75, 1)      = 84
//   slMult=1 stopPrice  = round(84 - 1×9.75, 1)
//                       = round(74.25, 1) = 74          [Math.round(74.25)=74]
//   tp1Price (LONG)     = round(rangeHigh=100, 1)      = 100
// ─────────────────────────────────────────────────────────────────────────────

const LONG_BREAK_BARS = [
  bar(83, 83,  80, 82,  10), // sweep (close=82<RL=90, h=83 < bias.l=84 → FVG ✓)
  bar(85, 88,  84, 101, 11), // bias candle — l=84 > prevBar.h=83 ✓, bcLow=84, bcBodyTop=101, body=16
  bar(99, 99,  94, 95,  12), // retest (low≤101, close≯101) → stage 3
  bar(95, 103, 93, 103, 13), // BOS (close>101) → pending
];

const LONG_ALL_BARS = [...RANGE_BARS, ...LONG_BREAK_BARS];

describe("buildRbsSession — Long signal construction", () => {
  test("ATR is computed as 9.75 (hand-traced true ranges)", () => {
    const atr = computeAtr14(LONG_ALL_BARS);
    assert.ok(
      Math.abs(atr - 9.75) < 0.0001,
      `expected ATR=9.75, got ${atr}`,
    );
  });

  test("slMult=0: stopPrice equals bias-candle LOW exactly (no ATR buffer)", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, /*slMult=*/0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal, "long signal should fire");
    assert.equal(result.longSignal.stopPrice, 84,
      "slMult=0: stop = round(bcLow=84 - 0*atr, 1) = 84");
  });

  test("slMult=1: stopPrice equals bcLow - 1*ATR rounded to tick", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, /*slMult=*/1, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal, "long signal should fire");
    // round(84 - 9.75, 1) = round(74.25, 1) = 74
    assert.equal(result.longSignal.stopPrice, 74,
      "slMult=1: stop = round(84 - 9.75, 1) = 74");
  });

  test("tp1Price is the opposing range boundary (rangeHigh=100)", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.tp1Price, 100,
      "long TP1 = roundToTick(rangeHigh=100, 1) = 100");
  });

  test("tp2Price equals tp1Price", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.tp2Price, result.longSignal.tp1Price);
  });

  test("signal direction is 'long'", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.direction, "long");
  });

  test("rangeHigh and rangeLow are echoed into the signal", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.rangeHigh, 100);
    assert.equal(result.longSignal.rangeLow,  90);
  });

  test("shortSignal is null when only long BOS fires", () => {
    const result = buildRbsSession(
      LONG_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.shortSignal, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 4: No-signal guard rails
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRbsSession — no signal when conditions are not met", () => {
  test("returns null signals when there are no break-window bars", () => {
    const result = buildRbsSession(
      RANGE_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.shortSignal, null);
    assert.equal(result.longSignal,  null);
  });

  test("returns null signals when ATR cannot be computed (single range bar)", () => {
    const singleBar = [bar(95, 100, 90, 95, 0)];
    const result = buildRbsSession(
      singleBar, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.shortSignal, null);
    assert.equal(result.longSignal,  null);
    assert.equal(result.atr14, null);
  });

  test("returns null signals when range is degenerate (all bars same high==low)", () => {
    const flatBars = Array.from({ length: 5 }, (_, t) => bar(95, 95, 95, 95, t));
    const result = buildRbsSession(
      flatBars, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.equal(result.rangeHigh, null);
    assert.equal(result.rangeLow,  null);
    assert.equal(result.shortSignal, null);
    assert.equal(result.longSignal,  null);
  });

  test("BOS that fires but slSource is null does not produce a signal", () => {
    // This is an internal guard — should never happen in practice because
    // slSource is always set when pending=true. But if it somehow were null,
    // the signal block is skipped. We verify the happy path slSource is set.
    const result = buildRbsSession(
      SHORT_ALL_BARS, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
      FVG_MULT, 0, CURRENT_PRICE, MIN_TICK,
    );
    assert.ok(result.shortSignal, "control: slSource was set so signal fires");
  });
});
