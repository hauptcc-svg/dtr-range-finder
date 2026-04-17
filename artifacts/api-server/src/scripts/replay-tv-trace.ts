/**
 * TradingView Alert Replay — NQ 2AM Session Cross-Check
 *
 * Reads a CSV of 1-minute NQ OHLC bars (attached_assets/nq-2am-2025-04-17.csv),
 * replays them through the TypeScript RBS state machine, and compares the result
 * against the TradingView alert trace documented in:
 *   attached_assets/nq-2am-tv-alerts-2025-04-17.json
 *
 * The alert trace was produced by hand-tracing the PineScript source bar-by-bar
 * (DTR Time Range Scalper v3) — the same methodology as test suites 13-14.
 * Each entry in the JSON cites PineScript variable names and line numbers.
 *
 * PineScript source:
 *   attached_assets/Pasted--version-5-strategy-DTR-Time-Range-Scalper-v3-shorttitl_1776415752806.txt
 *
 * Run:
 *   node --import tsx/esm src/scripts/replay-tv-trace.ts
 *   (from the artifacts/api-server directory)
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  makeMachine,
  stepShortMachine,
  stepLongMachine,
  computeAtr14,
  buildRbsSession,
} from "../lib/dtr-strategy.js";
import type { Bar } from "../lib/projectx-client.js";
import type { RbsStateMachine } from "../lib/dtr-strategy.js";

// ─── Session parameters (2AM / "sess2" in PineScript) ────────────────────────

const RANGE_END_MS   = 1744870380000; // 2025-04-17T06:13:00Z = 02:13 EDT
const BREAK_START_MS = 1744870380000;
const BREAK_END_MS   = 1744876800000; // 2025-04-17T08:00:00Z = 04:00 EDT
const FVG_SIZE_MULT  = 1.5;
const SL_MULT        = 0;
const MIN_TICK       = 0.25;

// ─── Asset file paths ─────────────────────────────────────────────────────────

const ASSETS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../attached_assets",
);

const CSV_PATH      = resolve(ASSETS_DIR, "nq-2am-2025-04-17.csv");
const TV_ALERT_PATH = resolve(ASSETS_DIR, "nq-2am-tv-alerts-2025-04-17.json");

// ─── Types matching the TV alert JSON ────────────────────────────────────────

interface TvAlertFixture {
  computed: { rangeHigh: number; rangeLow: number; atr14: number };
  breakBarTrace: Array<{
    breakBarIdx: number;
    barTime: string;
    edtTime: string;
    role: string;
    pineScript: string;
    shortMachine: {
      stage: number;
      pending: boolean;
      bcBodyBot: number | null;
      slSource: number | null;
    };
  }>;
  alert: {
    firedAt: string;
    direction: string;
    slSource: number;
    stopPrice: number;
    tp1Price: number;
    rangeHigh: number;
    rangeLow: number;
  };
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsvBars(path: string): Bar[] {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .slice(1)
    .map(line => {
      const [time, o, h, l, c, v] = line.split(",");
      return { t: new Date(time).getTime(), o: +o, h: +h, l: +l, c: +c, v: +v };
    });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

const pad  = (s: string | number, w: number) => String(s).padEnd(w);
const rpad = (s: string | number, w: number) => String(s).padStart(w);
const ts   = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// ─── Main replay ─────────────────────────────────────────────────────────────

function runReplay() {
  console.log("=".repeat(72));
  console.log(" TradingView Alert Cross-Check: NQ 2AM Session 2025-04-17");
  console.log("=".repeat(72));

  const bars   = parseCsvBars(CSV_PATH);
  const tvFix  = JSON.parse(readFileSync(TV_ALERT_PATH, "utf-8")) as TvAlertFixture;

  console.log(`CSV bars loaded  : ${bars.length} (${ts(bars[0].t)} → ${ts(bars[bars.length-1].t)})`);
  console.log(`TV alert fixture : ${TV_ALERT_PATH.split("/").slice(-1)[0]}`);

  // ── Range ──────────────────────────────────────────────────────────────────
  const rangeBars = bars.filter(b => b.t < RANGE_END_MS);
  const rangeHigh = rangeBars.reduce((m, b) => Math.max(m, b.h), -Infinity);
  const rangeLow  = rangeBars.reduce((m, b) => Math.min(m, b.l),  Infinity);
  const atr14     = computeAtr14(bars)!;

  let allMatch = true;
  const check = (label: string, got: unknown, want: unknown, tol = 0): boolean => {
    const ok = tol > 0
      ? Math.abs(Number(got) - Number(want)) < tol
      : got === want;
    if (!ok) allMatch = false;
    return ok;
  };

  console.log("\nRANGE");
  let ok = check("rangeHigh", rangeHigh, tvFix.computed.rangeHigh);
  console.log(`  rangeHigh = ${rangeHigh}  [fixture: ${tvFix.computed.rangeHigh}]  ${ok ? "✓" : "✗ MISMATCH"}`);
  ok = check("rangeLow", rangeLow, tvFix.computed.rangeLow);
  console.log(`  rangeLow  = ${rangeLow}  [fixture: ${tvFix.computed.rangeLow}]  ${ok ? "✓" : "✗ MISMATCH"}`);

  // ── ATR ────────────────────────────────────────────────────────────────────
  ok = check("atr14", atr14, tvFix.computed.atr14, 0.001);
  console.log(`\nATR(14)`);
  console.log(`  computed  = ${atr14.toFixed(6)}`);
  console.log(`  fixture   = ${tvFix.computed.atr14.toFixed(6)}  ${ok ? "✓" : "✗ MISMATCH"}`);
  console.log(`  threshold = ${(FVG_SIZE_MULT * atr14).toFixed(4)} (fvgSizeMult=${FVG_SIZE_MULT})`);

  // ── Break-bar trace ────────────────────────────────────────────────────────
  const breakBars = bars.filter(b => b.t >= BREAK_START_MS && b.t < BREAK_END_MS);
  console.log(`\nBREAK WINDOW  (${ts(BREAK_START_MS)} → ${ts(BREAK_END_MS)})`);
  console.log(`  bars = ${breakBars.length}`);
  console.log();
  console.log(
    pad("idx",4) + pad("time(UTC)",22) + pad("role",12) +
    pad("sStg",6) + pad("sPend",7) + pad("bcBB",8) + pad("slSrc",8) +
    "  fix_sStg  fix_sPend  status"
  );
  console.log("-".repeat(100));

  let shortM: RbsStateMachine = makeMachine();
  let longM:  RbsStateMachine = makeMachine();
  let prevBcBodyBot: number | null = null;

  for (let i = 0; i < breakBars.length; i++) {
    const bbar = breakBars[i];
    shortM = stepShortMachine(shortM, bbar, rangeHigh, atr14, FVG_SIZE_MULT);
    longM  = stepLongMachine(longM,  bbar, rangeLow,  atr14, FVG_SIZE_MULT);

    const ex = tvFix.breakBarTrace[i];
    const stageOk   = shortM.stage   === ex?.shortMachine.stage;
    const pendingOk = shortM.pending  === ex?.shortMachine.pending;
    const bcBBOk    = (shortM.bcBodyBot ?? null) === (ex?.shortMachine.bcBodyBot ?? null);
    const slSrcOk   = (shortM.slSource  ?? null) === (ex?.shortMachine.slSource  ?? null);
    const rowMatch  = stageOk && pendingOk && bcBBOk && slSrcOk;
    if (!rowMatch) allMatch = false;

    if (shortM.bcBodyBot !== null) prevBcBodyBot = shortM.bcBodyBot;
    const displayBcBB = shortM.stage === 0 ? prevBcBodyBot : shortM.bcBodyBot;

    console.log(
      pad(i,4) +
      pad(ts(bbar.t),22) +
      pad(ex?.role ?? "?",12) +
      pad(shortM.stage,6) + pad(String(shortM.pending),7) +
      pad(String(displayBcBB ?? "null"),8) +
      pad(String(shortM.slSource ?? "null"),8) +
      `  ${rpad(ex?.shortMachine.stage ?? "?",6)}    ${rpad(String(ex?.shortMachine.pending ?? "?"),6)}    ${rowMatch ? "✓" : "✗ MISMATCH"}`
    );
  }

  // ── buildRbsSession integration ────────────────────────────────────────────
  console.log("\nBUILDRBSSESSION (integration)");
  const currentPrice = bars[bars.length - 1].c; // last bar close
  const result = buildRbsSession(
    bars, RANGE_END_MS, BREAK_START_MS, BREAK_END_MS,
    FVG_SIZE_MULT, SL_MULT, currentPrice, MIN_TICK,
  );

  const sig = result.shortSignal;
  const tv  = tvFix.alert;

  const fields: Array<[string, unknown, unknown]> = [
    ["shortSignal.direction", sig?.direction  ?? "null", tv.direction ],
    ["shortMachine.slSource", result.shortMachine.slSource,    tv.slSource  ],
    ["shortSignal.stopPrice", sig?.stopPrice  ?? "null", tv.stopPrice ],
    ["shortSignal.tp1Price",  sig?.tp1Price   ?? "null", tv.tp1Price  ],
    ["longSignal",            result.longSignal === null ? "null" : "SET", "null"],
  ];

  for (const [label, got, want] of fields) {
    const ok = check(label, got, want);
    console.log(`  ${label.padEnd(28)} = ${String(got).padEnd(8)}  [fixture: ${want}]  ${ok ? "✓" : "✗ MISMATCH"}`);
  }

  // ── PineScript citations for each break bar ────────────────────────────────
  console.log("\nPINESCRIPT REFERENCES");
  for (const entry of tvFix.breakBarTrace) {
    console.log(`  ${entry.edtTime} (${entry.role}): ${entry.pineScript}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(72));
  if (allMatch) {
    console.log(" RESULT: ALL CHECKS PASS — TypeScript engine matches TV alert trace ✓");
  } else {
    console.log(" RESULT: ✗ MISMATCHES DETECTED — see rows above");
    process.exit(1);
  }
  console.log("=".repeat(72));
}

runReplay();
