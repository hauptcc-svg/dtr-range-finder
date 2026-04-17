/**
 * Real-session replay test — NQ 9AM NY session, 2025-04-17
 *
 * Verifies that buildRbsSession produces the same signal that the DTR Time Range
 * Scalper v3 PineScript strategy generated on TradingView for this session.
 *
 * Fixture:  src/__tests__/fixtures/nq-9am-2025-04-17-real.json
 *
 * TradingView reference output (verified, no mismatches):
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
 *   13:15 UTC  retest      low(19185) ≤ bcBodyTop(19198), close not > 19198 → stage 2→3
 *   13:16 UTC  BOS         close(19204) > bcBodyTop(19198) → pending=true, slSource=19142
 *
 * Run: pnpm --filter @workspace/api-server test
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildRbsSession, computeAtr14 } from "../lib/dtr-strategy.js";

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

// Entry price is supplied as the current market price at signal evaluation time.
// The fixture does not capture the next-bar open, so we use the BOS bar close as
// a representative value.  entryPrice is not asserted in these tests because
// TradingView's strategy processes orders at bar-close (process_orders_on_close),
// which may differ from a live system's next-bar open.
const CURRENT_PRICE = 19204;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("NQ 9AM NY 2025-04-17 real-session replay — buildRbsSession vs TradingView", () => {

  // Pre-compute result once; each test uses the same instance.
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

  // ── Signal fired ─────────────────────────────────────────────────────────────

  test("a LONG signal fired (BOS bar at 09:16 EDT)", () => {
    assert.ok(
      result.longSignal !== null,
      "expected a LONG signal but longSignal is null",
    );
  });

  test("no SHORT signal fired in this session", () => {
    assert.equal(
      result.shortSignal,
      null,
      "unexpected SHORT signal — only long BOS should fire",
    );
  });

  // ── Signal values ─────────────────────────────────────────────────────────────

  test("signal direction is 'long'", () => {
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.direction, expectedSignal.direction);
  });

  test("stopPrice matches reference (19142 = biasCandle LOW, slMult=0)", () => {
    assert.ok(result.longSignal);
    assert.equal(
      result.longSignal.stopPrice,
      expectedSignal.stopPrice,
      `stopPrice mismatch: expected=${expectedSignal.stopPrice}, engine=${result.longSignal.stopPrice}`,
    );
  });

  test("tp1Price matches reference (19225 = rangeHigh, opposing boundary)", () => {
    assert.ok(result.longSignal);
    assert.equal(
      result.longSignal.tp1Price,
      expectedSignal.tp1Price,
      `tp1Price mismatch: expected=${expectedSignal.tp1Price}, engine=${result.longSignal.tp1Price}`,
    );
  });

  test("signal carries correct rangeHigh and rangeLow", () => {
    assert.ok(result.longSignal);
    assert.equal(result.longSignal.rangeHigh, expectedSignal.rangeHigh);
    assert.equal(result.longSignal.rangeLow,  expectedSignal.rangeLow);
  });

  // ── State machine final state ────────────────────────────────────────────────

  test("longMachine is reset to stage 0 after BOS (pending consumed)", () => {
    // After stepLongMachine processes the BOS bar, the machine resets to stage 0
    // and pending=true is set.  buildRbsSession snapshots the machine post-loop,
    // so pending is the value from the BOS bar step.
    assert.equal(result.longMachine.stage, 0);
    assert.equal(result.longMachine.pending, true);
    assert.equal(result.longMachine.slSource, 19142);
  });

  test("shortMachine remains at stage 0 (no sweep above rangeHigh in this session)", () => {
    assert.equal(result.shortMachine.stage, 0);
    assert.equal(result.shortMachine.pending, false);
  });
});
