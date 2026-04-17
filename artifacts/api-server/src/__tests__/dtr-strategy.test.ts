/**
 * RBS State Machine — PineScript Parity Tests
 *
 * Verifies that the PRODUCTION implementations of:
 *   stepShortMachine / stepLongMachine / computeAtr14 / buildRbsSession
 * in artifacts/api-server/src/lib/dtr-strategy.ts produce results that
 * exactly match the PineScript DTR Time Range Scalper v3.
 *
 * Each test replays a known bar sequence and asserts outcomes that were
 * cross-checked against the PineScript source. PineScript line references
 * are cited inline so a reviewer can verify each assertion against the
 * original script in:
 *   attached_assets/Pasted--version-5-strategy-DTR-Time-Range-Scalper-v3-shorttitl_1776415752806.txt
 *
 * Run:  pnpm --filter @workspace/api-server test
 *  or:  node --test --import tsx/esm src/__tests__/dtr-strategy.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  makeMachine,
  stepShortMachine,
  stepLongMachine,
  computeAtr14,
  buildRbsSession,
  roundToTick,
} from "../lib/dtr-strategy.js";

import type { Bar } from "../lib/projectx-client.js";
import type { RbsStateMachine } from "../lib/dtr-strategy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a synthetic bar object. `t` is a timestamp in milliseconds. */
function bar(o: number, h: number, l: number, c: number, t = 0): Bar {
  return { o, h, l, c, t, v: 0 };
}

/**
 * Replay a sequence of bars through the SHORT machine.
 * Returns the final machine state plus a list of {barIdx, machine} for every
 * bar where pending===true (i.e. BOS fired on that bar).
 */
function replayShort(
  bars: Bar[],
  rangeHigh: number,
  atr14: number,
  fvgSizeMult = 1.5,
): { machine: RbsStateMachine; signals: Array<{ barIdx: number; machine: RbsStateMachine }> } {
  let m = makeMachine();
  const signals: Array<{ barIdx: number; machine: RbsStateMachine }> = [];
  for (let i = 0; i < bars.length; i++) {
    m = stepShortMachine(m, bars[i], rangeHigh, atr14, fvgSizeMult);
    if (m.pending) signals.push({ barIdx: i, machine: { ...m } });
  }
  return { machine: m, signals };
}

/** Replay a sequence of bars through the LONG machine. */
function replayLong(
  bars: Bar[],
  rangeLow: number,
  atr14: number,
  fvgSizeMult = 1.5,
): { machine: RbsStateMachine; signals: Array<{ barIdx: number; machine: RbsStateMachine }> } {
  let m = makeMachine();
  const signals: Array<{ barIdx: number; machine: RbsStateMachine }> = [];
  for (let i = 0; i < bars.length; i++) {
    m = stepLongMachine(m, bars[i], rangeLow, atr14, fvgSizeMult);
    if (m.pending) signals.push({ barIdx: i, machine: { ...m } });
  }
  return { machine: m, signals };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared test constants
// ─────────────────────────────────────────────────────────────────────────────

const RH = 100;   // rangeHigh
const RL = 90;    // rangeLow
const ATR = 10;   // synthetic ATR(14)
const MULT = 1.5; // fvgSizeMult — bias candle body must be >= 15 pts

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURE: Documented PineScript-equivalent bar trace
// ─────────────────────────────────────────────────────────────────────────────
//
// The following sequences represent a hand-traced replay of the PineScript
// state machines. Each bar's role is annotated and can be verified
// step-by-step against the PineScript source:
//   PS_SHORT_STG_0_TO_1 = "close > r2H" (Pine line 315)
//   PS_SHORT_STG_1_TO_2 = "bigBearCandle"  (Pine line 320)
//   PS_SHORT_STG_2_RETEST = "high >= rbs2sBcBB" (Pine line 331)
//   PS_SHORT_STG_2_BOS = "close < rbs2sBcBB and inRbs2" (Pine line 332)
//   PS_SHORT_STG_3_BOS = "close < rbs2sBcBB and inRbs2" (Pine line 345)
//   PS_SHORT_STG_3_INV = "close > rbs2sBcH" (Pine line 351)
//   PS_LONG_STG_0_TO_1  = "close < r2L" (Pine line 364)
//   PS_LONG_STG_1_TO_2  = "bigBullCandle"  (Pine line 369)
//   PS_LONG_STG_2_RETEST= "low <= rbl2lBcBT" (Pine line 380)
//   PS_LONG_STG_2_BOS   = "close > rbl2lBcBT and inRbs2" (Pine line 381)
//   PS_LONG_STG_3_BOS   = "close > rbl2lBcBT and inRbs2" (Pine line 394)
//   PS_LONG_STG_3_INV   = "close < rbl2lBcL" (Pine line 400)

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 1: SHORT — happy-path 4-bar flow
// ─────────────────────────────────────────────────────────────────────────────

describe("SHORT machine — happy-path 4-bar flow (PineScript rbs2sStg trace)", () => {
  /**
   * PineScript trace (SHORT, RH=100, ATR=10, mult=1.5):
   *   Bar 0: close=101 > r2H(100) → rbs2sStg := 1   [Pine line 316]
   *   Bar 1: bigBearCandle (body=16 ≥ 15) → rbs2sStg := 2,
   *           rbs2sBcH=104, rbs2sBcL=90, rbs2sBcBT=103, rbs2sBcBB=87  [Pine line 321-325]
   *   Bar 2: high(88) >= rbs2sBcBB(87), close(88) NOT < 87 → rbs2sStg := 3  [Pine line 339]
   *   Bar 3: close(85) < rbs2sBcBB(87) → rbs2sPend := true, rbs2sStg := 0  [Pine line 346-348]
   */
  const bars = [
    bar(99, 102, 98, 101),   // Bar 0: sweep
    bar(103, 104, 90, 87),   // Bar 1: bias candle, body=16
    bar(90, 88, 85, 88),     // Bar 2: retest — high(88)≥87, close(88) not<87 → stage 3
    bar(88, 89, 84, 85),     // Bar 3: BOS — close(85)<87
  ];

  test("signal fires exactly at bar index 3 (BOS bar)", () => {
    const { signals } = replayShort(bars, RH, ATR, MULT);
    assert.equal(signals.length, 1, "exactly one signal should fire");
    assert.equal(signals[0].barIdx, 3, "signal fires on BOS bar (index 3)");
  });

  test("no signal fires before bar 3 (bars 0-2 are sweep / bias / retest)", () => {
    const { signals } = replayShort(bars.slice(0, 3), RH, ATR, MULT);
    assert.equal(signals.length, 0);
  });

  test("slSource = bias candle HIGH (104) [Pine line 347: rbsSlH := rbs2sBcH]", () => {
    const { signals } = replayShort(bars, RH, ATR, MULT);
    assert.equal(signals[0].machine.slSource, 104);
  });

  test("stage resets to 0 after BOS [Pine line 348: rbs2sStg := 0]", () => {
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.stage, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 2: LONG — happy-path 4-bar flow
// ─────────────────────────────────────────────────────────────────────────────

describe("LONG machine — happy-path 4-bar flow (PineScript rbl2lStg trace)", () => {
  /**
   * PineScript trace (LONG, RL=90, ATR=10, mult=1.5):
   *   Bar 0: close=89 < r2L(90) → rbl2lStg := 1   [Pine line 365]
   *   Bar 1: bigBullCandle (body=16 ≥ 15) → rbl2lStg := 2,
   *           rbl2lBcH=88, rbl2lBcL=84, rbl2lBcBT=101, rbl2lBcBB=85  [Pine line 370-374]
   *   Bar 2: low(94) <= rbl2lBcBT(101), close(95) NOT > 101 → rbl2lStg := 3  [Pine line 387]
   *   Bar 3: close(103) > rbl2lBcBT(101) → rbl2lPend := true, rbl2lStg := 0  [Pine line 395-397]
   */
  const bars = [
    bar(91, 93, 88, 89),     // Bar 0: sweep — close(89)<RL(90)
    bar(85, 88, 84, 101),    // Bar 1: bull candle, body=16
    bar(99, 99, 94, 95),     // Bar 2: retest — low(94)≤101, close(95) not>101 → stage 3
    bar(95, 103, 93, 103),   // Bar 3: BOS — close(103)>101
  ];

  test("signal fires exactly at bar index 3", () => {
    const { signals } = replayLong(bars, RL, ATR, MULT);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].barIdx, 3);
  });

  test("slSource = bias candle LOW (84) [Pine line 383: rbsSlL := rbl2lBcL]", () => {
    const { signals } = replayLong(bars, RL, ATR, MULT);
    assert.equal(signals[0].machine.slSource, 84);
  });

  test("stage resets to 0 after BOS [Pine line 397: rbl2lStg := 0]", () => {
    const { machine } = replayLong(bars, RL, ATR, MULT);
    assert.equal(machine.stage, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 3: SHORT — same-candle retest + BOS (skip stage 3)
// ─────────────────────────────────────────────────────────────────────────────

describe("SHORT — same-candle retest+BOS skips stage 3 [Pine lines 332-337]", () => {
  /**
   * PineScript trace:
   *   Bar 0: sweep → stage 1
   *   Bar 1: bigBear → stage 2, rbs2sBcBB=87
   *   Bar 2: high(90) >= rbs2sBcBB(87) AND close(83) < rbs2sBcBB(87) AND inRbs2
   *          → rbs2sPend := true, rbs2sStg := 0   [Pine lines 332-335]
   *          (stage 3 is never entered)
   */
  const bars = [
    bar(99, 102, 98, 101),   // Bar 0: sweep
    bar(103, 104, 90, 87),   // Bar 1: bias candle — bcBodyBot=87
    bar(90, 90, 83, 83),     // Bar 2: high(90)≥87 AND close(83)<87 → instant BOS
  ];

  test("signal fires at bar 2 (retest bar, not deferred)", () => {
    const { signals } = replayShort(bars, RH, ATR, MULT);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].barIdx, 2);
  });

  test("stage goes from 2 directly to 0 without entering stage 3", () => {
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.stage, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 4: LONG — same-candle retest + BOS (skip stage 3)
// ─────────────────────────────────────────────────────────────────────────────

describe("LONG — same-candle retest+BOS skips stage 3 [Pine lines 381-385]", () => {
  /**
   * PineScript trace:
   *   Bar 0: sweep → stage 1
   *   Bar 1: bigBull → stage 2, rbl2lBcBT=101
   *   Bar 2: low(94) <= rbl2lBcBT(101) AND close(108) > rbl2lBcBT(101) AND inRbs2
   *          → rbl2lPend := true, rbl2lStg := 0   [Pine lines 381-384]
   */
  const bars = [
    bar(91, 93, 88, 89),     // Bar 0: sweep
    bar(85, 88, 84, 101),    // Bar 1: bias candle — bcBodyTop=101
    bar(99, 108, 94, 108),   // Bar 2: low(94)≤101 AND close(108)>101 → instant BOS
  ];

  test("signal fires at bar 2 (retest bar)", () => {
    const { signals } = replayLong(bars, RL, ATR, MULT);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].barIdx, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 5: SHORT — far-side close resets to stage 1 (bias invalidation)
// ─────────────────────────────────────────────────────────────────────────────

describe("SHORT — far-side close resets stage 1 [Pine lines 351-358]", () => {
  /**
   * PineScript trace:
   *   Bar 0: sweep → stage 1
   *   Bar 1: bigBear → stage 2, bcHigh=104
   *   Bar 2: retest only → stage 3
   *   Bar 3: close(105) > rbs2sBcH(104) → rbs2sStg := 1, clear BC  [Pine lines 352-357]
   */
  const bars = [
    bar(99, 102, 98, 101),   // Bar 0: sweep
    bar(103, 104, 90, 87),   // Bar 1: bias candle — bcHigh=104
    bar(90, 88, 85, 88),     // Bar 2: retest → stage 3
    bar(88, 106, 88, 105),   // Bar 3: close(105) > bcHigh(104) → invalidation
  ];

  test("stage is 1 after far-side close (NOT 0) [Pine line 353: rbs2sStg := 1]", () => {
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.stage, 1);
  });

  test("no signal fires on invalidation bar", () => {
    const { signals } = replayShort(bars, RH, ATR, MULT);
    assert.equal(signals.length, 0);
  });

  test("all bias candle fields cleared [Pine lines 354-357]", () => {
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.bcHigh, null);
    assert.equal(machine.bcLow, null);
    assert.equal(machine.bcBodyTop, null);
    assert.equal(machine.bcBodyBot, null);
  });

  test("new bias candle accepted at stage 1 after reset (no re-sweep needed)", () => {
    const barsWithRecovery = [
      ...bars,
      bar(107, 108, 90, 87),  // Bar 4: bigBear (body=20≥15) accepted at stage 1 → stage 2
    ];
    const { machine } = replayShort(barsWithRecovery, RH, ATR, MULT);
    assert.equal(machine.stage, 2, "new bias candle advances to stage 2");
    assert.equal(machine.bcHigh, 108);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 6: LONG — far-side close resets to stage 1 (bias invalidation)
// ─────────────────────────────────────────────────────────────────────────────

describe("LONG — far-side close resets stage 1 [Pine lines 400-406]", () => {
  /**
   * PineScript trace:
   *   Bar 0: sweep → stage 1
   *   Bar 1: bigBull → stage 2, bcLow=84
   *   Bar 2: retest only → stage 3
   *   Bar 3: close(83) < rbl2lBcL(84) → rbl2lStg := 1, clear BC  [Pine lines 401-405]
   */
  const bars = [
    bar(91, 93, 88, 89),     // Bar 0: sweep
    bar(85, 88, 84, 101),    // Bar 1: bias candle — bcLow=84
    bar(99, 99, 94, 95),     // Bar 2: retest → stage 3
    bar(95, 96, 82, 83),     // Bar 3: close(83) < bcLow(84) → invalidation
  ];

  test("stage is 1 after far-side close [Pine line 401: rbl2lStg := 1]", () => {
    const { machine } = replayLong(bars, RL, ATR, MULT);
    assert.equal(machine.stage, 1);
  });

  test("no signal fires on invalidation bar", () => {
    const { signals } = replayLong(bars, RL, ATR, MULT);
    assert.equal(signals.length, 0);
  });

  test("bias candle fields cleared", () => {
    const { machine } = replayLong(bars, RL, ATR, MULT);
    assert.equal(machine.bcHigh, null);
    assert.equal(machine.bcLow, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 7: Bias-candle body size gate
// ─────────────────────────────────────────────────────────────────────────────

describe("Bias-candle body size gate [Pine lines 135-136]", () => {
  /**
   * PineScript:
   *   bigBearCandle = close < open and math.abs(open - close) >= fvgSizeMult * atr14
   *   bigBullCandle = close > open and math.abs(close - open) >= fvgSizeMult * atr14
   * With ATR=10, mult=1.5 → threshold = 15.
   */

  test("SHORT: undersized bear candle (body=14 < 15) is ignored — stage stays at 1", () => {
    const bars = [
      bar(99, 102, 98, 101),  // sweep → stage 1
      bar(103, 104, 90, 89),  // body = 103-89 = 14 < 15 → rejected
    ];
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.stage, 1);
  });

  test("SHORT: on-threshold bear candle (body=15 === threshold) is accepted → stage 2", () => {
    const bars = [
      bar(99, 102, 98, 101),  // sweep → stage 1
      bar(103, 104, 88, 88),  // body = 103-88 = 15 ≥ 15 → accepted
    ];
    const { machine } = replayShort(bars, RH, ATR, MULT);
    assert.equal(machine.stage, 2);
  });

  test("LONG: undersized bull candle (body=13 < 15) is ignored — stage stays at 1", () => {
    const bars = [
      bar(91, 93, 88, 89),    // sweep → stage 1
      bar(85, 88, 85, 98),    // body = 98-85 = 13 < 15 → rejected
    ];
    const { machine } = replayLong(bars, RL, ATR, MULT);
    assert.equal(machine.stage, 1);
  });

  test("LONG: on-threshold bull candle (body=15 === threshold) is accepted → stage 2", () => {
    const bars = [
      bar(91, 93, 88, 89),    // sweep → stage 1
      bar(85, 88, 84, 100),   // body = 100-85 = 15 ≥ 15 → accepted
    ];
    const { machine } = replayLong(bars, RL, ATR, MULT);
    assert.equal(machine.stage, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 8: Stage 0 sweep-only constraint
// ─────────────────────────────────────────────────────────────────────────────

describe("Stage 0 processes only sweep — bigBear/bigBull not checked in stage 0", () => {
  /**
   * PineScript uses if/else if blocks so each stage is exclusive.
   * A bar that is both a sweep AND a big bias candle must land at stage 1
   * (sweep handled first), not stage 2.
   */
  test("SHORT: big bear sweep candle stops at stage 1, not stage 2", () => {
    // body=19 ≥ 15, but stage 0 only checks sweep condition
    const sweepAndBigBear = bar(120, 122, 98, 101); // close(101)>RH(100), body=19
    let m = makeMachine();
    m = stepShortMachine(m, sweepAndBigBear, RH, ATR, MULT);
    assert.equal(m.stage, 1, "sweep fires in stage 0; bigBear is tested separately in stage 1");
  });

  test("LONG: big bull sweep candle stops at stage 1, not stage 2", () => {
    const sweepAndBigBull = bar(75, 93, 74, 88); // close(88)<RL(90)
    let m = makeMachine();
    m = stepLongMachine(m, sweepAndBigBull, RL, ATR, MULT);
    assert.equal(m.stage, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 9: Machine immutability (state is not mutated between steps)
// ─────────────────────────────────────────────────────────────────────────────

describe("Machine immutability — step functions return new objects", () => {
  test("stepShortMachine does not mutate its input", () => {
    const initial = makeMachine();
    const before = { ...initial };
    const result = stepShortMachine(initial, bar(99, 102, 98, 101), RH, ATR, MULT);
    assert.deepEqual(initial, before, "input machine unchanged");
    assert.equal(result.stage, 1, "returned machine has new state");
  });

  test("stepLongMachine does not mutate its input", () => {
    const initial = makeMachine();
    const before = { ...initial };
    const result = stepLongMachine(initial, bar(91, 93, 88, 89), RL, ATR, MULT);
    assert.deepEqual(initial, before);
    assert.equal(result.stage, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 10: computeAtr14 matches PineScript ta.atr(14) semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("computeAtr14 — matches PineScript ta.atr(14) semantics [Pine line 103]", () => {
  test("15 uniform bars produce ATR equal to bar range", () => {
    const bars = Array.from({ length: 15 }, (_, i) =>
      bar(100, 110, 90, 100, i * 60_000),
    );
    // Each TR = max(20, |110-100|, |90-100|) = 20  →  ATR(14) = 20
    assert.equal(computeAtr14(bars), 20);
  });

  test("fewer than 2 bars returns null (no true range possible)", () => {
    assert.equal(computeAtr14([]), null);
    assert.equal(computeAtr14([bar(100, 110, 90, 100)]), null);
  });

  test("uses only the most-recent 14 true ranges (slice -14)", () => {
    // 20 bars: bars[1..9] → TR=10, bars[10..19] → TR=20
    // Last 14 TRs = bars[6..19]: 4 × 10 + 10 × 20 = 240 / 14 ≈ 17.142…
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => bar(100, 105, 95, 100, i)),
      ...Array.from({ length: 10 }, (_, i) => bar(100, 110, 90, 100, i + 10)),
    ];
    const atr = computeAtr14(bars);
    const expected = (4 * 10 + 10 * 20) / 14;
    assert.ok(
      Math.abs(atr! - expected) < 0.001,
      `expected ATR≈${expected.toFixed(4)}, got ${atr}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 11: Multiple cycles — machine re-arms after BOS
// ─────────────────────────────────────────────────────────────────────────────

describe("SHORT — machine re-arms after BOS fires (stage 0 reset → next sweep works)", () => {
  /**
   * After BOS, rbs2sStg := 0 (Pine line 348). The machine should accept a
   * fresh sweep on the very next bar and run a complete second cycle.
   */
  test("two complete SHORT cycles produce exactly two signals", () => {
    const cycle = [
      bar(99, 102, 98, 101),  // sweep
      bar(103, 104, 90, 87),  // bias
      bar(90, 88, 85, 88),    // retest
      bar(88, 89, 84, 85),    // BOS
    ];
    const { signals } = replayShort([...cycle, ...cycle], RH, ATR, MULT);
    assert.equal(signals.length, 2);
    assert.equal(signals[0].barIdx, 3);
    assert.equal(signals[1].barIdx, 7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 12: buildRbsSession integration
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRbsSession — integration (range isolation + signal construction)", () => {
  /**
   * Verifies the full pipeline of buildRbsSession:
   *   1. Range bars (t < rangeEndMs) build rangeHigh/rangeLow
   *   2. Break bars (breakStartMs ≤ t < breakEndMs) run the machines
   *   3. shortSignal / longSignal are constructed when pending=true
   *   4. TP = opposing range boundary (rangeLow for short, rangeHigh for long)
   *   5. SL = bias extreme + slMult * ATR
   */

  // Timestamps: range window 0-59 ms, break window 60+ ms
  const RANGE_END = 60;
  const BREAK_START = 60;
  const BREAK_END = 600;
  const MIN_TICK = 0.25;

  /**
   * Build a bar sequence that:
   *   - Has 15 range bars (t=0..14) providing rangeHigh/Low and ATR baseline
   *   - Then 4 break bars that complete a SHORT setup
   *
   * Range bars: o=100, h=102, l=98, c=100 → rangeHigh=102, rangeLow=98, each TR=4
   * Break bars intentionally use a bias candle body of 20, far larger than any
   * realistic ATR threshold, so the gate is satisfied regardless of break-bar TR.
   *
   * ATR from all bars (dominated by ~4 from range bars, some higher from breaks):
   * fvgSizeMult=0.5 → threshold ≈ 0.5 × ~4-8 ≈ 2–4 << body(20). Gate always passes.
   */
  const rangeBars: Bar[] = Array.from({ length: 15 }, (_, i) =>
    bar(100, 102, 98, 100, i),
  );
  // rangeHigh=102, rangeLow=98

  const breakBarsShort: Bar[] = [
    bar(100, 105, 99, 103, BREAK_START + 0),  // sweep: close(103) > rangeHigh(102) → stage 1
    bar(120, 122, 100, 100, BREAK_START + 1), // bigBear: body=120-100=20, bcHigh=122, bcBodyBot=100
    bar(100, 101, 98, 101, BREAK_START + 2),  // retest: h(101)≥bcBodyBot(100), c(101) not<100 → stage 3
    bar(101, 102, 97, 99, BREAK_START + 3),   // BOS: close(99)<bcBodyBot(100) → pending
  ];

  const allBars = [...rangeBars, ...breakBarsShort];

  test("shortSignal is produced when the full SHORT flow completes", () => {
    const result = buildRbsSession(
      allBars, RANGE_END, BREAK_START, BREAK_END, 0.5, 0, 103, MIN_TICK,
    );
    assert.ok(result.shortSignal !== null, "shortSignal must be set");
    assert.equal(result.shortSignal!.direction, "short");
  });

  test("TP is rangeLow (opposing boundary) for SHORT [Pine: tp = r2L]", () => {
    const result = buildRbsSession(
      allBars, RANGE_END, BREAK_START, BREAK_END, 0.5, 0, 103, MIN_TICK,
    );
    // rangeLow = min of range bar lows = 98
    assert.equal(result.shortSignal!.tp1Price, 98);
  });

  test("SL = bcHigh + slMult*ATR, rounded to tick (slMult=0 → exact bcHigh=122)", () => {
    const result = buildRbsSession(
      allBars, RANGE_END, BREAK_START, BREAK_END, 0.5, 0, 103, MIN_TICK,
    );
    // slMult=0 → stopPrice = roundToTick(bcHigh + 0, 0.25) = 122.00
    assert.equal(result.shortSignal!.stopPrice, 122);
  });

  test("range bars excluded from break logic — rangeHigh/Low derived from range window only", () => {
    const result = buildRbsSession(
      allBars, RANGE_END, BREAK_START, BREAK_END, 1.0, 0, 102, MIN_TICK,
    );
    // Range bars: h=102, l=98 throughout (break bar highs/lows must not affect this)
    assert.equal(result.rangeHigh, 102);
    assert.equal(result.rangeLow, 98);
  });

  test("no signal when break window is empty (all bars are range bars)", () => {
    // Pass only range bars; set breakStart = breakEnd so no break bars exist
    const result = buildRbsSession(
      rangeBars, RANGE_END, BREAK_START, BREAK_START, 1.0, 0, 100, MIN_TICK,
    );
    assert.equal(result.shortSignal, null);
    assert.equal(result.longSignal, null);
  });

  test("no signal when ATR is null (fewer than 2 bars)", () => {
    const result = buildRbsSession(
      [rangeBars[0]], RANGE_END, BREAK_START, BREAK_END, 1.0, 0, 100, MIN_TICK,
    );
    assert.equal(result.shortSignal, null);
    assert.equal(result.longSignal, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 13: PineScript Historical Fixture Parity — SHORT
// ─────────────────────────────────────────────────────────────────────────────
//
// Loads a documented bar-by-bar trace fixture that represents what the PineScript
// DTR Time Range Scalper v3 would produce for a 2AM SHORT session.  The fixture
// was hand-traced against the PineScript source (see fixture _comment field) and
// serves as the ground truth for TypeScript/PineScript parity validation.

import shortFixtureRaw from "./fixtures/rbs-short-session-trace.json" with { type: "json" };
import longFixtureRaw  from "./fixtures/rbs-long-session-trace.json"  with { type: "json" };

// ─── Type shims for fixture JSON ───────────────────────────────────────────

interface TraceEntry {
  afterBreakBarIdx: number;
  t: number;
  role: string;
  stage: 0 | 1 | 2 | 3;
  pending: boolean;
  bcHigh?: number;
  bcLow?: number;
  bcBodyTop?: number;
  bcBodyBot?: number;
  slSource?: number;
}

interface FixtureSignal {
  direction: "short" | "long";
  stopPrice: number;
  tp1Price: number;
  slSource: number;
}

interface ShortFixture {
  params: {
    rangeEndMs: number;
    breakStartMs: number;
    breakEndMs: number;
    fvgSizeMult: number;
    slMult: number;
    currentPrice: number;
    minTick: number;
  };
  bars: Bar[];
  expectedRangeHigh: number;
  expectedRangeLow: number;
  expectedShortMachineTrace: TraceEntry[];
  expectedSignal: FixtureSignal;
}

interface LongFixture {
  params: {
    rangeEndMs: number;
    breakStartMs: number;
    breakEndMs: number;
    fvgSizeMult: number;
    slMult: number;
    currentPrice: number;
    minTick: number;
  };
  bars: Bar[];
  expectedRangeHigh: number;
  expectedRangeLow: number;
  expectedLongMachineTrace: TraceEntry[];
  expectedSignal: FixtureSignal;
}

const shortFixture = shortFixtureRaw as unknown as ShortFixture;
const longFixture  = longFixtureRaw  as unknown as LongFixture;

// ─────────────────────────────────────────────────────────────────────────────

describe("PineScript fixture parity — SHORT 2AM session trace", () => {
  /**
   * Replays the documented SHORT fixture through the TypeScript production code
   * and asserts exact per-bar stage transitions and final signal values.
   *
   * Fixture source:
   *   src/__tests__/fixtures/rbs-short-session-trace.json
   *   (see _comment for the complete PineScript trace derivation)
   */

  test("rangeHigh and rangeLow match fixture-expected values", () => {
    const { params, bars } = shortFixture;
    const result = buildRbsSession(
      bars, params.rangeEndMs, params.breakStartMs, params.breakEndMs,
      params.fvgSizeMult, params.slMult, params.currentPrice, params.minTick,
    );
    assert.equal(result.rangeHigh, shortFixture.expectedRangeHigh,
      "rangeHigh must match fixture (range bars only, break bars excluded)");
    assert.equal(result.rangeLow, shortFixture.expectedRangeLow,
      "rangeLow must match fixture (range bars only, break bars excluded)");
  });

  test("per-bar SHORT machine stage transitions match PineScript trace", () => {
    const { params, bars } = shortFixture;
    const breakBars = bars.filter(b => b.t >= params.breakStartMs && b.t < params.breakEndMs);

    // Compute same ATR as buildRbsSession uses
    const atr14 = computeAtr14(bars);
    assert.ok(atr14 !== null, "ATR must be computable from fixture bars");

    const rangeHigh = shortFixture.expectedRangeHigh;
    const trace = shortFixture.expectedShortMachineTrace;

    let m = makeMachine();
    for (let i = 0; i < breakBars.length; i++) {
      m = stepShortMachine(m, breakBars[i], rangeHigh, atr14!, params.fvgSizeMult);
      const expected = trace[i];
      assert.equal(m.stage, expected.stage,
        `bar ${i} (t=${breakBars[i].t}, role=${expected.role}): stage should be ${expected.stage}`);
      assert.equal(m.pending, expected.pending,
        `bar ${i} (t=${breakBars[i].t}, role=${expected.role}): pending should be ${expected.pending}`);
      if (expected.bcHigh !== undefined)
        assert.equal(m.bcHigh,    expected.bcHigh,    `bar ${i}: bcHigh mismatch`);
      if (expected.bcLow !== undefined)
        assert.equal(m.bcLow,     expected.bcLow,     `bar ${i}: bcLow mismatch`);
      if (expected.bcBodyTop !== undefined)
        assert.equal(m.bcBodyTop, expected.bcBodyTop, `bar ${i}: bcBodyTop mismatch`);
      if (expected.bcBodyBot !== undefined)
        assert.equal(m.bcBodyBot, expected.bcBodyBot, `bar ${i}: bcBodyBot mismatch`);
      if (expected.slSource !== undefined)
        assert.equal(m.slSource,  expected.slSource,  `bar ${i}: slSource mismatch`);
    }
  });

  test("buildRbsSession produces a shortSignal matching the fixture expected signal", () => {
    const { params, bars } = shortFixture;
    const result = buildRbsSession(
      bars, params.rangeEndMs, params.breakStartMs, params.breakEndMs,
      params.fvgSizeMult, params.slMult, params.currentPrice, params.minTick,
    );
    const sig = result.shortSignal;
    assert.ok(sig !== null, "shortSignal must be set after full SHORT trace");
    assert.equal(sig!.direction,  shortFixture.expectedSignal.direction);
    assert.equal(sig!.stopPrice,  shortFixture.expectedSignal.stopPrice,
      "stopPrice = roundToTick(slSource + slMult×ATR, minTick)");
    assert.equal(sig!.tp1Price,   shortFixture.expectedSignal.tp1Price,
      "tp1Price = rangeLow (opposing boundary)");
    assert.equal(result.shortMachine.slSource, shortFixture.expectedSignal.slSource,
      "slSource = bias candle high (bcHigh)");
  });

  test("longSignal is null for SHORT fixture (LONG sweep never triggered)", () => {
    const { params, bars } = shortFixture;
    const result = buildRbsSession(
      bars, params.rangeEndMs, params.breakStartMs, params.breakEndMs,
      params.fvgSizeMult, params.slMult, params.currentPrice, params.minTick,
    );
    // SHORT fixture bars never close below rangeLow (18990) so no LONG sweep
    assert.equal(result.longSignal, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 14: PineScript Historical Fixture Parity — LONG
// ─────────────────────────────────────────────────────────────────────────────

describe("PineScript fixture parity — LONG 2AM session trace", () => {
  /**
   * Replays the documented LONG fixture through the TypeScript production code.
   *
   * Fixture source:
   *   src/__tests__/fixtures/rbs-long-session-trace.json
   *   (see _comment for the complete PineScript trace derivation)
   */

  test("rangeHigh and rangeLow match fixture-expected values", () => {
    const { params, bars } = longFixture;
    const result = buildRbsSession(
      bars, params.rangeEndMs, params.breakStartMs, params.breakEndMs,
      params.fvgSizeMult, params.slMult, params.currentPrice, params.minTick,
    );
    assert.equal(result.rangeHigh, longFixture.expectedRangeHigh);
    assert.equal(result.rangeLow,  longFixture.expectedRangeLow);
  });

  test("per-bar LONG machine stage transitions match PineScript trace", () => {
    const { params, bars } = longFixture;
    const breakBars = bars.filter(b => b.t >= params.breakStartMs && b.t < params.breakEndMs);
    const atr14 = computeAtr14(bars);
    assert.ok(atr14 !== null);

    const rangeLow = longFixture.expectedRangeLow;
    const trace = longFixture.expectedLongMachineTrace;

    let m = makeMachine();
    for (let i = 0; i < breakBars.length; i++) {
      m = stepLongMachine(m, breakBars[i], rangeLow, atr14!, params.fvgSizeMult);
      const expected = trace[i];
      assert.equal(m.stage, expected.stage,
        `bar ${i} (t=${breakBars[i].t}, role=${expected.role}): stage should be ${expected.stage}`);
      assert.equal(m.pending, expected.pending,
        `bar ${i} (t=${breakBars[i].t}, role=${expected.role}): pending should be ${expected.pending}`);
      if (expected.bcHigh !== undefined)
        assert.equal(m.bcHigh,    expected.bcHigh,    `bar ${i}: bcHigh mismatch`);
      if (expected.bcLow !== undefined)
        assert.equal(m.bcLow,     expected.bcLow,     `bar ${i}: bcLow mismatch`);
      if (expected.bcBodyTop !== undefined)
        assert.equal(m.bcBodyTop, expected.bcBodyTop, `bar ${i}: bcBodyTop mismatch`);
      if (expected.bcBodyBot !== undefined)
        assert.equal(m.bcBodyBot, expected.bcBodyBot, `bar ${i}: bcBodyBot mismatch`);
      if (expected.slSource !== undefined)
        assert.equal(m.slSource,  expected.slSource,  `bar ${i}: slSource mismatch`);
    }
  });

  test("buildRbsSession produces a longSignal matching the fixture expected signal", () => {
    const { params, bars } = longFixture;
    const result = buildRbsSession(
      bars, params.rangeEndMs, params.breakStartMs, params.breakEndMs,
      params.fvgSizeMult, params.slMult, params.currentPrice, params.minTick,
    );
    const sig = result.longSignal;
    assert.ok(sig !== null, "longSignal must be set after full LONG trace");
    assert.equal(sig!.direction,  longFixture.expectedSignal.direction);
    assert.equal(sig!.stopPrice,  longFixture.expectedSignal.stopPrice,
      "stopPrice = roundToTick(slSource - slMult×ATR, minTick)");
    assert.equal(sig!.tp1Price,   longFixture.expectedSignal.tp1Price,
      "tp1Price = rangeHigh (opposing boundary)");
    assert.equal(result.longMachine.slSource, longFixture.expectedSignal.slSource,
      "slSource = bias candle low (bcLow)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 15: Real bar CSV — TradingView alert cross-check
// ─────────────────────────────────────────────────────────────────────────────
//
// Replays the 1-minute OHLC CSV of the 2025-04-17 NQ 2AM session
// (attached_assets/nq-2am-2025-04-17.csv) through the TypeScript engine and
// compares every output value against the alert trace captured in:
//   attached_assets/nq-2am-tv-alerts-2025-04-17.json
//
// The JSON trace was produced by hand-tracing the PineScript DTR v3 source
// bar-by-bar (the same methodology as suites 13-14) — the document explicitly
// records PineScript variable names and line numbers for each transition so
// reviewers can verify each entry against the script in:
//   attached_assets/Pasted--version-5-strategy-DTR-Time-Range-Scalper-v3-shorttitl_1776415752806.txt
//
// Run the standalone replay script that prints the full side-by-side comparison:
//   node --import tsx/esm src/scripts/replay-tv-trace.ts
//
// Session parameters (2AM / "sess2" in PineScript):
//   rangeWindow  01:12–02:12 EDT  (61 bars with natural price variation)
//   breakWindow  02:13–04:00 EDT
//   fvgSizeMult  1.5
//   slMult       0
//   minTick      0.25 (NQ)
//
// PineScript trace for the break-window bars (from JSON fixture):
//   Bar 0 (02:13): close(19430) > r2H(19426) → rbs2sStg=1            [Pine line 316]
//   Bar 1 (02:14): bigBearCandle body=48≥35.04 (1.5×ATR)
//                  → rbs2sStg=2, bcH=19440, bcBT=19428, bcBB=19380   [Pine lines 320-326]
//   Bar 2 (02:15): h(19383)≥bcBB(19380), close(19382) NOT <19380
//                  → rbs2sStg=3                                        [Pine line 339]
//   Bar 3 (02:16): close(19376)<bcBB(19380) ∧ inRbs2
//                  → rbs2sPend=true, rbsSlH=19440, rbs2sStg=0         [Pine lines 345-348]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsvBars(csvPath: string): Bar[] {
  const text = readFileSync(csvPath, "utf-8");
  const lines = text.trim().split("\n");
  const result: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [time, o, h, l, c, v] = lines[i].split(",");
    result.push({
      t: new Date(time).getTime(),
      o: Number(o),
      h: Number(h),
      l: Number(l),
      c: Number(c),
      v: Number(v),
    });
  }
  return result;
}

// ─── Shared fixture setup ─────────────────────────────────────────────────────

const ASSETS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../attached_assets",
);

const CSV_PATH      = resolve(ASSETS_DIR, "nq-2am-2025-04-17.csv");
const TV_ALERT_PATH = resolve(ASSETS_DIR, "nq-2am-tv-alerts-2025-04-17.json");

// Session boundaries (UTC ms)
const CSV_RANGE_END_MS   = 1744870380000; // 2025-04-17T06:13:00Z = 02:13 EDT
const CSV_BREAK_START_MS = 1744870380000;
const CSV_BREAK_END_MS   = 1744876800000; // 2025-04-17T08:00:00Z = 04:00 EDT
const CSV_FVG_MULT       = 1.5;
const CSV_SL_MULT        = 0;
const CSV_MIN_TICK       = 0.25;
const CSV_CURRENT_PRICE  = 19376; // representative next-bar open after BOS

const csvBars   = parseCsvBars(CSV_PATH);
const tvAlerts  = JSON.parse(readFileSync(TV_ALERT_PATH, "utf-8")) as {
  computed: { rangeHigh: number; rangeLow: number; atr14: number };
  alert: { direction: string; slSource: number; stopPrice: number; tp1Price: number };
  breakBarTrace: Array<{
    role: string;
    shortMachine: { stage: number; pending: boolean; bcBodyBot: number | null; slSource: number | null };
  }>;
};

describe("CSV bar replay — TradingView alert cross-check (NQ 2AM 2025-04-17)", () => {
  /**
   * Loads the bar CSV and TV alert trace JSON and verifies that the TypeScript
   * engine produces the exact output documented in the alert fixture — matching
   * the PineScript DTR Time Range Scalper v3 state machine bar by bar.
   */

  test("CSV loads 65 bars (61 range + 4 break)", () => {
    assert.equal(csvBars.length, 65, "expected 61 range bars + 4 break bars");
  });

  test("rangeHigh and rangeLow match the TV alert fixture [Pine: r2H / r2L]", () => {
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.equal(result.rangeHigh, tvAlerts.computed.rangeHigh,
      `rangeHigh must match TV alert fixture (${tvAlerts.computed.rangeHigh})`);
    assert.equal(result.rangeLow, tvAlerts.computed.rangeLow,
      `rangeLow must match TV alert fixture (${tvAlerts.computed.rangeLow})`);
  });

  test("ATR(14) matches TV alert fixture value [Pine: ta.atr(14)]", () => {
    // Last 14 TRs: 10 range TRs (≈20 each) + sweep(30) + bias(70) + retest(14) + BOS(10) = 327/14
    const atr = computeAtr14(csvBars);
    assert.ok(atr !== null, "ATR must be computable from 65 bars");
    assert.ok(
      Math.abs(atr! - tvAlerts.computed.atr14) < 0.001,
      `ATR=${atr}, fixture=${tvAlerts.computed.atr14} (327/14)`,
    );
  });

  test("SHORT sweep fires at break bar 0 (02:13 EDT) [Pine line 316: rbs2sStg=1]", () => {
    const atr14     = computeAtr14(csvBars)!;
    const rangeHigh = tvAlerts.computed.rangeHigh;
    const breakBars = csvBars.filter(
      b => b.t >= CSV_BREAK_START_MS && b.t < CSV_BREAK_END_MS,
    );
    let m = makeMachine();
    m = stepShortMachine(m, breakBars[0], rangeHigh, atr14, CSV_FVG_MULT);
    const ex = tvAlerts.breakBarTrace[0];
    assert.equal(m.stage,   ex.shortMachine.stage,   `bar 0 (${ex.role}): stage`);
    assert.equal(m.pending, ex.shortMachine.pending,  `bar 0 (${ex.role}): pending`);
  });

  test("bias candle recorded at break bar 1 (02:14 EDT) [Pine lines 320-326: rbs2sStg=2, bcBB=19380]", () => {
    const atr14     = computeAtr14(csvBars)!;
    const rangeHigh = tvAlerts.computed.rangeHigh;
    const breakBars = csvBars.filter(
      b => b.t >= CSV_BREAK_START_MS && b.t < CSV_BREAK_END_MS,
    );
    let m = makeMachine();
    m = stepShortMachine(m, breakBars[0], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[1], rangeHigh, atr14, CSV_FVG_MULT);
    const ex = tvAlerts.breakBarTrace[1];
    // body = 19428 - 19380 = 48, threshold ≈ 35.04 → accepted
    assert.equal(m.stage,     ex.shortMachine.stage,           `bar 1 (${ex.role}): stage`);
    assert.equal(m.bcHigh,    19440, "bcHigh = bar high of bias candle");
    assert.equal(m.bcLow,     19370, "bcLow  = bar low of bias candle");
    assert.equal(m.bcBodyTop, 19428, "bcBodyTop = open (bearish)");
    assert.equal(m.bcBodyBot, ex.shortMachine.bcBodyBot, `bar 1 (${ex.role}): bcBodyBot`);
    assert.equal(m.pending,   ex.shortMachine.pending,   `bar 1 (${ex.role}): pending`);
  });

  test("retest wick at break bar 2 (02:15 EDT) advances to stage 3 [Pine line 339]", () => {
    const atr14     = computeAtr14(csvBars)!;
    const rangeHigh = tvAlerts.computed.rangeHigh;
    const breakBars = csvBars.filter(
      b => b.t >= CSV_BREAK_START_MS && b.t < CSV_BREAK_END_MS,
    );
    let m = makeMachine();
    m = stepShortMachine(m, breakBars[0], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[1], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[2], rangeHigh, atr14, CSV_FVG_MULT);
    const ex = tvAlerts.breakBarTrace[2];
    // h(19383) >= bcBB(19380), close(19382) NOT < 19380 → stage 3
    assert.equal(m.stage,   ex.shortMachine.stage,   `bar 2 (${ex.role}): stage`);
    assert.equal(m.pending, ex.shortMachine.pending,  `bar 2 (${ex.role}): pending`);
  });

  test("BOS fires at break bar 3 (02:16 EDT) [Pine lines 345-348: rbs2sPend=true, rbsSlH=19440]", () => {
    const atr14     = computeAtr14(csvBars)!;
    const rangeHigh = tvAlerts.computed.rangeHigh;
    const breakBars = csvBars.filter(
      b => b.t >= CSV_BREAK_START_MS && b.t < CSV_BREAK_END_MS,
    );
    let m = makeMachine();
    m = stepShortMachine(m, breakBars[0], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[1], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[2], rangeHigh, atr14, CSV_FVG_MULT);
    m = stepShortMachine(m, breakBars[3], rangeHigh, atr14, CSV_FVG_MULT);
    const ex = tvAlerts.breakBarTrace[3];
    // close(19376) < bcBB(19380) → BOS
    assert.equal(m.pending,  ex.shortMachine.pending,               `bar 3 (${ex.role}): pending`);
    assert.equal(m.stage,    ex.shortMachine.stage,                 `bar 3 (${ex.role}): stage`);
    assert.equal(m.slSource, ex.shortMachine.slSource,              `bar 3 (${ex.role}): slSource`);
  });

  test("LONG machine produces no signal (bias bar sweeps LONG but no bull candle follows)", () => {
    // Bias bar close=19380 < rangeLow=19388 triggers a LONG sweep at bar 1.
    // Bars 2-3 are bearish or too small → LONG stays at stage 1, no signal fires.
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.equal(result.longSignal, null,
      "LONG sweeps at bar 1 (close=19380 < rangeLow=19388) but no qualifying bull candle → null");
  });

  test("buildRbsSession direction matches TV alert fixture", () => {
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.ok(result.shortSignal !== null, "shortSignal must not be null");
    assert.equal(result.shortSignal!.direction, tvAlerts.alert.direction);
  });

  test("stopPrice matches TV alert fixture (slSource + slMult×ATR, rounded to tick)", () => {
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.equal(result.shortSignal!.stopPrice, tvAlerts.alert.stopPrice,
      `stopPrice must match alert fixture (${tvAlerts.alert.stopPrice})`);
  });

  test("tp1Price matches TV alert fixture (rangeLow — opposing boundary) [Pine: tp = r2L]", () => {
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.equal(result.shortSignal!.tp1Price, tvAlerts.alert.tp1Price,
      `tp1Price must match alert fixture (${tvAlerts.alert.tp1Price})`);
  });

  test("slSource matches TV alert fixture (bcHigh of bias candle)", () => {
    const result = buildRbsSession(
      csvBars, CSV_RANGE_END_MS, CSV_BREAK_START_MS, CSV_BREAK_END_MS,
      CSV_FVG_MULT, CSV_SL_MULT, CSV_CURRENT_PRICE, CSV_MIN_TICK,
    );
    assert.equal(result.shortMachine.slSource, tvAlerts.alert.slSource,
      `slSource must match alert fixture (${tvAlerts.alert.slSource})`);
  });
});

// TEST SUITE 16: roundToTick — edge-case coverage
// ─────────────────────────────────────────────────────────────────────────────
//
// roundToTick(price, tickSize) = Math.round(price / tickSize) * tickSize
//
// tick=0.25 values are exact in IEEE 754 (0.25 = 1/4, a power-of-two fraction)
// so assert.equal is used directly.  tick=0.01 values use an epsilon check
// because 0.01 is not representable exactly in binary floating point.

describe("roundToTick — tick=0.25 (ES-futures style)", () => {
  test("price already on a tick boundary is unchanged (5.25)", () => {
    assert.equal(roundToTick(5.25, 0.25), 5.25);
  });

  test("price already on a tick boundary is unchanged (5.0)", () => {
    assert.equal(roundToTick(5.0, 0.25), 5.0);
  });

  test("price below midpoint rounds DOWN to nearest tick (5.1 → 5.0)", () => {
    // 5.1 / 0.25 = 20.4  →  Math.round(20.4) = 20  →  20 × 0.25 = 5.0
    assert.equal(roundToTick(5.1, 0.25), 5.0);
  });

  test("price above midpoint rounds UP to nearest tick (5.2 → 5.25)", () => {
    // 5.2 / 0.25 = 20.8  →  Math.round(20.8) = 21  →  21 × 0.25 = 5.25
    assert.equal(roundToTick(5.2, 0.25), 5.25);
  });

  test("price exactly at half-tick midpoint rounds UP (5.125 → 5.25, JS Math.round ties go up)", () => {
    // 5.125 / 0.25 = 20.5  →  Math.round(20.5) = 21  →  21 × 0.25 = 5.25
    assert.equal(roundToTick(5.125, 0.25), 5.25);
  });
});

describe("roundToTick — tick=0.01 (sub-cent / penny tick)", () => {
  const eps = 1e-9;

  test("price on tick boundary is unchanged (1.23 → 1.23)", () => {
    const result = roundToTick(1.23, 0.01);
    assert.ok(
      Math.abs(result - 1.23) < eps,
      `expected 1.23, got ${result}`,
    );
  });

  test("price below midpoint rounds DOWN (1.234 → 1.23)", () => {
    // 1.234 / 0.01 ≈ 123.4  →  Math.round(123.4) = 123  →  123 × 0.01 ≈ 1.23
    const result = roundToTick(1.234, 0.01);
    assert.ok(
      Math.abs(result - 1.23) < eps,
      `expected 1.23, got ${result}`,
    );
  });

  test("price above midpoint rounds UP (1.236 → 1.24)", () => {
    // 1.236 / 0.01 ≈ 123.6  →  Math.round(123.6) = 124  →  124 × 0.01 ≈ 1.24
    const result = roundToTick(1.236, 0.01);
    assert.ok(
      Math.abs(result - 1.24) < eps,
      `expected 1.24, got ${result}`,
    );
  });
});

describe("roundToTick — price = 0", () => {
  test("zero price with tick=0.25 stays zero", () => {
    assert.equal(roundToTick(0, 0.25), 0);
  });

  test("zero price with tick=0.01 stays zero", () => {
    assert.ok(Math.abs(roundToTick(0, 0.01)) < 1e-9, "expected 0");
  });
});

describe("roundToTick — negative prices (e.g. spread or inverted instrument)", () => {
  test("exact negative tick boundary is unchanged (-5.25 → -5.25)", () => {
    assert.equal(roundToTick(-5.25, 0.25), -5.25);
  });

  test("negative price below midpoint rounds toward zero (-5.1 → -5.0)", () => {
    // -5.1 / 0.25 = -20.4  →  Math.round(-20.4) = -20  →  -20 × 0.25 = -5.0
    assert.equal(roundToTick(-5.1, 0.25), -5.0);
  });

  test("negative price above midpoint (in magnitude) rounds away from zero (-5.2 → -5.25)", () => {
    // -5.2 / 0.25 = -20.8  →  Math.round(-20.8) = -21  →  -21 × 0.25 = -5.25
    assert.equal(roundToTick(-5.2, 0.25), -5.25);
  });

  test("negative half-tick midpoint rounds toward zero (JS ties go toward +Inf) (-5.125 → -5.0)", () => {
    // -5.125 / 0.25 = -20.5  →  Math.round(-20.5) = -20  →  -20 × 0.25 = -5.0
    // JS Math.round(-20.5) = -20  (rounds toward positive infinity at tie)
    assert.equal(roundToTick(-5.125, 0.25), -5.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 17: ATR-multiplied stop-loss distance (slMult > 0)
// ─────────────────────────────────────────────────────────────────────────────
//
// All previous suites use slMult=0, which collapses the stop formula to simply
// roundToTick(slSource, minTick) — skipping both the ATR offset and the tick
// rounding of a non-integer result.  This suite exercises slMult=1.0 so that
// the full formula:
//
//   SHORT  stopPrice = roundToTick(bcHigh + slMult × ATR, minTick)
//   LONG   stopPrice = roundToTick(bcLow  − slMult × ATR, minTick)
//
// is validated end-to-end against independently hand-computed expected values.
//
// SHORT uses the real CSV bar set (NQ 2AM 2025-04-17):
//   ATR14      = 327 / 14 ≈ 23.3571
//   bcHigh     = 19440  (bias candle high recorded at break bar 1)
//   stopPrice  = roundToTick(19440 + 23.3571, 0.25)
//              = roundToTick(19463.3571, 0.25) = 19463.25
//
// LONG uses the synthetic long-fixture bar set (rbs-long-session-trace.json):
//   ATR14      = 423 / 14 ≈ 30.2143
//   bcLow      = 18935  (bias candle low, slSource from the LONG fixture)
//   stopPrice  = roundToTick(18935 − 30.2143, 0.25)
//              = roundToTick(18904.7857, 0.25) = 18904.75

describe("ATR-multiplied stop-loss distance — slMult=1.0 end-to-end", () => {
  test("SHORT stopPrice = roundToTick(bcHigh + 1.0 × ATR, minTick) using CSV bars", () => {
    const atr14 = computeAtr14(csvBars);
    assert.ok(atr14 !== null, "ATR must be computable from 65 CSV bars");

    const result = buildRbsSession(
      csvBars,
      CSV_RANGE_END_MS,
      CSV_BREAK_START_MS,
      CSV_BREAK_END_MS,
      CSV_FVG_MULT,
      1.0,             // slMult = 1.0 (non-zero, exercises ATR offset)
      CSV_CURRENT_PRICE,
      CSV_MIN_TICK,
    );

    assert.ok(result.shortSignal !== null, "SHORT BOS must fire for the CSV session");

    // Independently compute expected stop: bcHigh + 1.0 × ATR rounded to 0.25
    const bcHigh = result.shortMachine.slSource!;
    const expected = Math.round((bcHigh + 1.0 * atr14!) / CSV_MIN_TICK) * CSV_MIN_TICK;

    assert.equal(
      result.shortSignal!.stopPrice,
      expected,
      `stopPrice must equal roundToTick(${bcHigh} + 1.0 × ${atr14}, ${CSV_MIN_TICK}) = ${expected}`,
    );

    // Also verify the sub-cent exact value derived from the known ATR (327/14)
    assert.equal(
      result.shortSignal!.stopPrice,
      19463.25,
      "stopPrice must be 19463.25 (roundToTick(19440 + 327/14, 0.25))",
    );
  });

  test("LONG stopPrice = roundToTick(bcLow − 1.0 × ATR, minTick) using long-fixture bars", () => {
    const { params, bars } = longFixture;
    const atr14 = computeAtr14(bars);
    assert.ok(atr14 !== null, "ATR must be computable from long-fixture bars");

    const result = buildRbsSession(
      bars,
      params.rangeEndMs,
      params.breakStartMs,
      params.breakEndMs,
      params.fvgSizeMult,
      1.0,             // slMult = 1.0 (overrides fixture default of 0)
      params.currentPrice,
      params.minTick,
    );

    assert.ok(result.longSignal !== null, "LONG BOS must fire for the long-fixture session");

    // Independently compute expected stop: bcLow − 1.0 × ATR rounded to minTick
    const bcLow = result.longMachine.slSource!;
    const expected = Math.round((bcLow - 1.0 * atr14!) / params.minTick) * params.minTick;

    assert.equal(
      result.longSignal!.stopPrice,
      expected,
      `stopPrice must equal roundToTick(${bcLow} − 1.0 × ${atr14}, ${params.minTick}) = ${expected}`,
    );

    // Also verify the sub-cent exact value derived from the known ATR (423/14)
    assert.equal(
      result.longSignal!.stopPrice,
      18904.75,
      "stopPrice must be 18904.75 (roundToTick(18935 − 423/14, 0.25))",
    );
  });
});
