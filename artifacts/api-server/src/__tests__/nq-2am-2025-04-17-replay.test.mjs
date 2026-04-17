/**
 * Real-session replay test — NQ 2AM session, 2025-04-17
 *
 * Verifies that buildRbsSession produces the same signal that the DTR Time Range
 * Scalper v3 PineScript strategy generated on TradingView for this session.
 *
 * Fixture:  src/__tests__/fixtures/nq-2am-2025-04-17-real.json
 * CSV src:  attached_assets/nq-2am-2025-04-17.csv
 * Alert src: attached_assets/nq-2am-tv-alerts-2025-04-17.json
 *
 * TradingView reference output (verified, no mismatches):
 *   Signal:    SHORT
 *   stopPrice: 19440   (= bias candle HIGH, slMult=0)
 *   tp1Price:  19388   (= rangeLow, opposing boundary)
 *   rangeHigh: 19426
 *   rangeLow:  19388
 *   atr14:     23.357142857142858  (327/14 from last 14 of 64 true-ranges)
 *
 * Break bar trace (all 4 bars in 02:13–04:00 EDT window):
 *   06:13 UTC  sweep       close(19430) > rangeHigh(19426) → stage 0→1
 *   06:14 UTC  bias candle body=48 ≥ 1.5×23.36=35.04 → stage 1→2; bcHigh=19440
 *   06:15 UTC  retest      high(19383) ≥ bcBodyBot(19380), close not < 19380 → stage 2→3
 *   06:16 UTC  BOS         close(19376) < bcBodyBot(19380) → pending=true, slSource=19440
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
const fixturePath = path.join(__dirname, "fixtures", "nq-2am-2025-04-17-real.json");
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
const CURRENT_PRICE = 19376;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("NQ 2AM 2025-04-17 real-session replay — buildRbsSession vs TradingView", () => {

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

  test("atr14 matches TradingView reference (327/14 ≈ 23.357)", () => {
    const expected = 327 / 14;
    assert.ok(
      result.atr14 !== null && Math.abs(result.atr14 - expected) < 0.0001,
      `expected atr14 ≈ ${expected.toFixed(6)}, got ${result.atr14}`,
    );
  });

  // ── Range boundaries ────────────────────────────────────────────────────────

  test("rangeHigh equals 19426 (max bar high during 01:12–02:12 EDT)", () => {
    assert.equal(
      result.rangeHigh,
      expectedSignal.rangeHigh,
      `rangeHigh mismatch: expected ${expectedSignal.rangeHigh}, got ${result.rangeHigh}`,
    );
  });

  test("rangeLow equals 19388 (min bar low during 01:12–02:12 EDT)", () => {
    assert.equal(
      result.rangeLow,
      expectedSignal.rangeLow,
      `rangeLow mismatch: expected ${expectedSignal.rangeLow}, got ${result.rangeLow}`,
    );
  });

  // ── Signal fired ─────────────────────────────────────────────────────────────

  test("a SHORT signal fired (BOS bar at 02:16 EDT)", () => {
    assert.ok(
      result.shortSignal !== null,
      "expected a SHORT signal but shortSignal is null",
    );
  });

  test("no LONG signal fired in this session", () => {
    assert.equal(
      result.longSignal,
      null,
      "unexpected LONG signal — only short BOS should fire",
    );
  });

  // ── Signal values vs TradingView alert ───────────────────────────────────────

  test("signal direction is 'short'", () => {
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.direction, expectedSignal.direction);
  });

  test("stopPrice matches TradingView (19440 = biasCandle HIGH, slMult=0)", () => {
    assert.ok(result.shortSignal);
    assert.equal(
      result.shortSignal.stopPrice,
      expectedSignal.stopPrice,
      `stopPrice mismatch: TradingView=${expectedSignal.stopPrice}, engine=${result.shortSignal.stopPrice}`,
    );
  });

  test("tp1Price matches TradingView (19388 = rangeLow, opposing boundary)", () => {
    assert.ok(result.shortSignal);
    assert.equal(
      result.shortSignal.tp1Price,
      expectedSignal.tp1Price,
      `tp1Price mismatch: TradingView=${expectedSignal.tp1Price}, engine=${result.shortSignal.tp1Price}`,
    );
  });

  test("signal carries correct rangeHigh and rangeLow", () => {
    assert.ok(result.shortSignal);
    assert.equal(result.shortSignal.rangeHigh, expectedSignal.rangeHigh);
    assert.equal(result.shortSignal.rangeLow,  expectedSignal.rangeLow);
  });

  // ── State machine final state ────────────────────────────────────────────────

  test("shortMachine is reset to stage 0 after BOS (pending consumed)", () => {
    // After stepShortMachine processes the BOS bar, the machine resets to stage 0
    // and pending=true is set.  buildRbsSession snapshots the machine post-loop,
    // so pending is the value from the BOS bar step.
    assert.equal(result.shortMachine.stage, 0);
    assert.equal(result.shortMachine.pending, true);
    assert.equal(result.shortMachine.slSource, 19440);
  });
});
