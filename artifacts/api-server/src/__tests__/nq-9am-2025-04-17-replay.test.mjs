/**
 * Real-session replay test — NQ 9AM NY session, 2025-04-17
 *
 * Verifies that buildRbsSession correctly rejects this session under the
 * strict FVG gate introduced in the DTR strategy refactor.
 *
 * Fixture:  src/__tests__/fixtures/nq-9am-2025-04-17-real.json
 *
 * Historical TradingView reference output (old PineScript, no FVG gate):
 *   Signal:    LONG
 *   stopPrice: 19142   (= bias candle LOW, slMult=0)
 *   tp1Price:  19225   (= rangeHigh, opposing boundary)
 *   rangeHigh: 19225
 *   rangeLow:  19163
 *   atr14:     319/14 = 22.785714285714285  (last 14 of 43 true-ranges, 44 bars)
 *
 * Break bar trace (all 4 bars in 09:13–12:00 EDT window):
 *   13:13 UTC  sweep       close(19162) < rangeLow(19163) → stage 0→1
 *   13:14 UTC  bias candle body=50 ≥ 1.5×22.79=34.18 → stage 1→2; bcLow=19142
 *              FVG gate check: bias.l(19142) > sweep.h(19207)? NO → FVG FAILS → no signal
 *
 * Under the strict FVG gate (bias.l must be strictly > prevBar.h for LONG):
 *   bias.l=19142 is NOT > sweep.h=19207 → the FVG gap does not exist.
 *   The machine stays at stage 1 (awaiting a valid bias candle) and longSignal = null.
 *
 * Run: pnpm --filter @workspace/api-server test
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildRbsSession } from "../lib/dtr-strategy.js";

// ─── Load fixture ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "nq-9am-2025-04-17-real.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const { bars, session, expectedSignal } = fixture;

const {
  rangeEndMs,
  breakStartMs,
  breakEndMs,
  fvgSizeMult,
  slMult,
  minTick,
} = session;

const CURRENT_PRICE = 19204;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("NQ 9AM NY 2025-04-17 real-session replay — buildRbsSession vs TradingView", () => {

  const result = buildRbsSession(
    bars,
    rangeEndMs,
    breakStartMs,
    breakEndMs,
    fvgSizeMult,
    slMult,
    CURRENT_PRICE,
    minTick,
  );

  // ── ATR ─────────────────────────────────────────────────────────────────────

  test("atr14 matches reference (319/14 ≈ 22.786)", () => {
    const expected = 319 / 14;
    assert.ok(
      result.atr14 !== null && Math.abs(result.atr14 - expected) < 0.0001,
      `expected atr14 ≈ ${expected.toFixed(6)}, got ${result.atr14}`,
    );
  });

  // ── Range boundaries ────────────────────────────────────────────────────────

  test("rangeHigh equals 19225 (max bar high during 08:32–09:12 EDT)", () => {
    assert.equal(
      result.rangeHigh,
      expectedSignal.rangeHigh,
      `rangeHigh mismatch: expected ${expectedSignal.rangeHigh}, got ${result.rangeHigh}`,
    );
  });

  test("rangeLow equals 19163 (min bar low during 08:32–09:12 EDT)", () => {
    assert.equal(
      result.rangeLow,
      expectedSignal.rangeLow,
      `rangeLow mismatch: expected ${expectedSignal.rangeLow}, got ${result.rangeLow}`,
    );
  });

  // ── FVG gate blocks the signal ───────────────────────────────────────────────
  //
  // The 9AM session sweep bar: h=19207, l=19158
  // The bias bar:              h=19208, l=19142
  // FVG LONG condition: bias.l(19142) > sweep.h(19207) → FALSE
  // → machine stays at stage 1; no signal fires.

  test("no LONG signal fired — strict FVG gate blocks (bias.l=19142 ≤ sweep.h=19207)", () => {
    assert.equal(
      result.longSignal,
      null,
      "expected null longSignal: bias.l=19142 is not > sweep.h=19207, FVG gap absent",
    );
  });

  test("no SHORT signal fired in this session", () => {
    assert.equal(
      result.shortSignal,
      null,
      "no SHORT signal expected in this LONG-biased session",
    );
  });

  // ── State machine final state ────────────────────────────────────────────────

  test("longMachine remains at stage 1 after FVG gate rejection (awaiting valid bias)", () => {
    assert.equal(result.longMachine.stage, 1);
    assert.equal(result.longMachine.pending, false);
  });

  test("shortMachine remains at stage 0 (no sweep above rangeHigh in this session)", () => {
    assert.equal(result.shortMachine.stage, 0);
    assert.equal(result.shortMachine.pending, false);
  });
});
