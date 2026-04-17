/**
 * Real-session replay test — NQ 2AM session, 2025-04-17
 *
 * Verifies that buildRbsSession correctly rejects this session under the
 * strict FVG gate introduced in the DTR strategy refactor.
 *
 * Fixture:  src/__tests__/fixtures/nq-2am-2025-04-17-real.json
 * CSV src:  attached_assets/nq-2am-2025-04-17.csv
 * Alert src: attached_assets/nq-2am-tv-alerts-2025-04-17.json
 *
 * Historical TradingView reference output (old PineScript, no FVG gate):
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
 *              FVG gate check: bias.h(19440) < sweep.l(19404)? NO → FVG FAILS → no signal
 *
 * Under the strict FVG gate (bias.h must be strictly < prevBar.l for SHORT):
 *   bias.h=19440 is NOT < sweep.l=19404 → the FVG gap does not exist.
 *   The machine stays at stage 1 (awaiting a valid bias candle) and shortSignal = null.
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

const CURRENT_PRICE = 19376;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("NQ 2AM 2025-04-17 real-session replay — buildRbsSession vs TradingView", () => {

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

  // ── FVG gate blocks the signal ───────────────────────────────────────────────
  //
  // The 2AM session sweep bar: h=19434, l=19404
  // The bias bar:              h=19440, l=19370
  // FVG SHORT condition: bias.h(19440) < sweep.l(19404) → FALSE
  // → machine stays at stage 1; no signal fires.

  test("no SHORT signal fired — strict FVG gate blocks (bias.h=19440 ≥ sweep.l=19404)", () => {
    assert.equal(
      result.shortSignal,
      null,
      "expected null shortSignal: bias.h=19440 is not < sweep.l=19404, FVG gap absent",
    );
  });

  test("no LONG signal fired in this session", () => {
    assert.equal(
      result.longSignal,
      null,
      "no LONG signal expected in this SHORT-biased session",
    );
  });

  // ── State machine final state ────────────────────────────────────────────────

  test("shortMachine remains at stage 1 after FVG gate rejection (awaiting valid bias)", () => {
    assert.equal(result.shortMachine.stage, 1);
    assert.equal(result.shortMachine.pending, false);
  });
});
