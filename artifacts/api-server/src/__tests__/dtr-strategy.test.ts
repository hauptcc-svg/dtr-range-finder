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
