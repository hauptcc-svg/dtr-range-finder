/**
 * DTR Strategy Engine — RBS + 3CR State Machine
 *
 * Implements DayTradingRauf methodology (DTR Time Range Scalper v3):
 *
 * SESSION FLOW (2AM example — same logic for 9AM):
 *   Range window  01:12–02:13  →  builds rangeHigh / rangeLow
 *   Break window  02:13–sess2End (default 04:00)  →  state machines run
 *
 * STATE MACHINE (runs separately for SHORT and LONG directions):
 *   Stage 0 → 1  Sweep: a candle CLOSES outside the range
 *                  Short: close > rangeHigh   Long: close < rangeLow
 *   Stage 1 → 2  Bias candle: first qualifying big candle after sweep
 *                  Bear candle (body ≥ ATR×mult) for short
 *                  Bull candle (body ≥ ATR×mult) for long
 *   Stage 2 → 3  Retest: any candle wicks into bias candle body
 *                  If same candle also fires BOS → jump to pending
 *   Stage 3 → pending  BOS: close breaks bias candle body near-side
 *                  while inside break window
 *                  Invalidation: close through bias candle far-side → back to stage 1
 *
 *   pending=true  →  Entry on next bar open (market order)
 *   SL  = bias candle far extreme ± ATR × slMult  (default slMult=0)
 *   TP  = opposing range boundary
 */

import { logger } from "./logger";
import type { Bar } from "./projectx-client";
import type { InstrumentConfig } from "./trading-config";

export type TradeDirection = "long" | "short";
export type TradeBias = "bullish" | "bearish" | "neutral";

// ─── Legacy RangeData — kept for display in dashboard ────────────────────────
export interface RangeData {
  high: number;
  low: number;
  midpoint: number;
  bias: TradeBias;
  biasCandle: Bar | null;
  width: number;
}

// ─── EntrySignal — returned when a trade should be placed ───────────────────
export interface EntrySignal {
  direction: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  tp1Price: number;
  tp2Price: number;
  rangeHigh: number;
  rangeLow: number;
}

// ─── RBS State Machine ───────────────────────────────────────────────────────
export interface RbsStateMachine {
  stage: 0 | 1 | 2 | 3;
  bcHigh: number | null;    // bias candle high
  bcLow: number | null;     // bias candle low
  bcBodyTop: number | null; // max(open, close) of bias candle
  bcBodyBot: number | null; // min(open, close) of bias candle
  pending: boolean;         // true on the bar BOS fires (consumed on next tick)
  slSource: number | null;  // shorts → bcHigh; longs → bcLow
}

export interface RbsSessionResult {
  rangeHigh: number | null;
  rangeLow: number | null;
  atr14: number | null;
  shortMachine: RbsStateMachine;
  longMachine: RbsStateMachine;
  shortSignal: EntrySignal | null;
  longSignal: EntrySignal | null;
}

// ─── InstrumentState ─────────────────────────────────────────────────────────
export interface InstrumentState {
  symbol: string;
  contractId: string | null;
  rangeData: RangeData | null;
  lastPrice: number | null;
  todayTrades: number;
  longLosses: number;
  shortLosses: number;
  inPosition: boolean;
  positionDirection: TradeDirection | null;
  positionQty: number;
  positionEntryPrice: number | null;
  positionOpenedAt: string | null;
  openTradeId: number | null;
  positionStopPrice: number | null;
  positionTp1Price: number | null;
  rbs2: RbsSessionResult | null;
  rbs9: RbsSessionResult | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function createInstrumentState(symbol: string): InstrumentState {
  return {
    symbol,
    contractId: null,
    rangeData: null,
    lastPrice: null,
    todayTrades: 0,
    longLosses: 0,
    shortLosses: 0,
    inPosition: false,
    positionDirection: null,
    positionQty: 0,
    positionEntryPrice: null,
    positionOpenedAt: null,
    openTradeId: null,
    positionStopPrice: null,
    positionTp1Price: null,
    rbs2: null,
    rbs9: null,
  };
}

export function makeMachine(): RbsStateMachine {
  return { stage: 0, bcHigh: null, bcLow: null, bcBodyTop: null, bcBodyBot: null, pending: false, slSource: null };
}

/**
 * Compute ATR(14) from a list of bars (uses last 14 true ranges).
 */
export function computeAtr14(bars: Bar[]): number | null {
  if (bars.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  if (trs.length === 0) return null;
  const recent = trs.slice(-14);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

/**
 * Step the SHORT state machine forward by one bar.
 * `pending` is reset to false at the start of each bar; it is only true if
 * BOS fires on THIS specific bar (consumed → place entry on next bar open).
 *
 * FVG gate (stage 1→2): the bias candle must leave a true price gap below the
 * preceding bar — its HIGH must be strictly below the prevBar's LOW.  Pass
 * prevBar=null to skip the gap check (e.g. first bar in sequence).
 */
export function stepShortMachine(
  machine: RbsStateMachine,
  bar: Bar,
  prevBar: Bar | null,
  rangeHigh: number,
  atr14: number,
  fvgSizeMult: number,
): RbsStateMachine {
  const m: RbsStateMachine = { ...machine, pending: false };
  const bigBear = bar.c < bar.o && (bar.o - bar.c) >= fvgSizeMult * atr14;
  const hasFvgGap = prevBar === null || bar.h < prevBar.l;

  switch (m.stage) {
    case 0:
      if (bar.c > rangeHigh) m.stage = 1;
      break;

    case 1:
      if (bigBear && hasFvgGap) {
        m.stage = 2;
        m.bcHigh = bar.h;
        m.bcLow = bar.l;
        m.bcBodyTop = bar.o; // bearish body top = open
        m.bcBodyBot = bar.c; // bearish body bot = close
      }
      break;

    case 2:
      // Candle wicks into bias candle body
      if (m.bcBodyBot !== null && bar.h >= m.bcBodyBot) {
        if (bar.c < m.bcBodyBot) {
          // Immediate retest + BOS on same candle
          m.pending = true;
          m.slSource = m.bcHigh;
          m.stage = 0;
        } else {
          m.stage = 3;
        }
      }
      break;

    case 3:
      if (m.bcBodyBot !== null && bar.c < m.bcBodyBot) {
        // BOS confirmed
        m.pending = true;
        m.slSource = m.bcHigh;
        m.stage = 0;
      } else if (m.bcHigh !== null && bar.c > m.bcHigh) {
        // Invalidated — look for new bias candle
        m.stage = 1;
        m.bcHigh = null; m.bcLow = null; m.bcBodyTop = null; m.bcBodyBot = null;
      }
      break;
  }
  return m;
}

/**
 * Step the LONG state machine forward by one bar.
 *
 * FVG gate (stage 1→2): the bias candle must leave a true price gap above the
 * preceding bar — its LOW must be strictly above the prevBar's HIGH.  Pass
 * prevBar=null to skip the gap check (e.g. first bar in sequence).
 */
export function stepLongMachine(
  machine: RbsStateMachine,
  bar: Bar,
  prevBar: Bar | null,
  rangeLow: number,
  atr14: number,
  fvgSizeMult: number,
): RbsStateMachine {
  const m: RbsStateMachine = { ...machine, pending: false };
  const bigBull = bar.c > bar.o && (bar.c - bar.o) >= fvgSizeMult * atr14;
  const hasFvgGap = prevBar === null || bar.l > prevBar.h;

  switch (m.stage) {
    case 0:
      if (bar.c < rangeLow) m.stage = 1;
      break;

    case 1:
      if (bigBull && hasFvgGap) {
        m.stage = 2;
        m.bcHigh = bar.h;
        m.bcLow = bar.l;
        m.bcBodyTop = bar.c; // bullish body top = close
        m.bcBodyBot = bar.o; // bullish body bot = open
      }
      break;

    case 2:
      if (m.bcBodyTop !== null && bar.l <= m.bcBodyTop) {
        if (bar.c > m.bcBodyTop) {
          // Immediate retest + BOS
          m.pending = true;
          m.slSource = m.bcLow;
          m.stage = 0;
        } else {
          m.stage = 3;
        }
      }
      break;

    case 3:
      if (m.bcBodyTop !== null && bar.c > m.bcBodyTop) {
        m.pending = true;
        m.slSource = m.bcLow;
        m.stage = 0;
      } else if (m.bcLow !== null && bar.c < m.bcLow) {
        // Invalidated
        m.stage = 1;
        m.bcHigh = null; m.bcLow = null; m.bcBodyTop = null; m.bcBodyBot = null;
      }
      break;
  }
  return m;
}

/**
 * Build the full RBS session result from a list of bars and time boundaries.
 *
 * @param bars          OHLCV bars from range start through current time (timeframe-agnostic; agent feeds 5-min bars)
 * @param rangeEndMs    UTC ms of range window end (02:13 or 09:13 NY today)
 * @param breakStartMs  UTC ms of break window start (= rangeEnd)
 * @param breakEndMs    UTC ms of break window end (sess2EntryEnd or sessionEnd)
 * @param fvgSizeMult   Bias candle body must be >= this × ATR(14)
 * @param slMult        SL = bias extreme ± ATR × slMult
 * @param currentPrice  Current last price (used as entry price in signal)
 * @param minTick       Instrument tick size for price rounding
 */
export function buildRbsSession(
  bars: Bar[],
  rangeEndMs: number,
  breakStartMs: number,
  breakEndMs: number,
  fvgSizeMult: number,
  slMult: number,
  currentPrice: number,
  minTick: number,
): RbsSessionResult {
  // Build range from bars inside the range window
  const rangeBars = bars.filter(b => b.t < rangeEndMs);
  let rangeHigh: number | null = null;
  let rangeLow: number | null = null;

  if (rangeBars.length > 0) {
    rangeHigh = rangeBars.reduce((m, b) => Math.max(m, b.h), -Infinity);
    rangeLow  = rangeBars.reduce((m, b) => Math.min(m, b.l),  Infinity);
    if (rangeHigh === rangeHigh && rangeLow === rangeLow && rangeHigh > rangeLow) {
      // valid range
    } else {
      rangeHigh = null; rangeLow = null;
    }
  }

  // ATR(14) from all bars available
  const atr14 = computeAtr14(bars);

  const defaultResult: RbsSessionResult = {
    rangeHigh, rangeLow, atr14,
    shortMachine: makeMachine(), longMachine: makeMachine(),
    shortSignal: null, longSignal: null,
  };

  if (!rangeHigh || !rangeLow || !atr14) return defaultResult;

  // Run state machines over break-window bars only
  const breakBars = bars.filter(b => b.t >= breakStartMs && b.t < breakEndMs);

  let shortMachine = makeMachine();
  let longMachine  = makeMachine();

  let prevBar: Bar | null = null;
  for (const bar of breakBars) {
    shortMachine = stepShortMachine(shortMachine, bar, prevBar, rangeHigh, atr14, fvgSizeMult);
    longMachine  = stepLongMachine(longMachine,  bar, prevBar, rangeLow,  atr14, fvgSizeMult);
    prevBar = bar;
  }

  // Build signals from pending machines
  let shortSignal: EntrySignal | null = null;
  let longSignal:  EntrySignal | null = null;

  if (shortMachine.pending && shortMachine.slSource !== null) {
    const stopPrice = roundToTick(shortMachine.slSource + slMult * atr14, minTick);
    const tp1Price  = roundToTick(rangeLow, minTick); // opposing boundary
    shortSignal = {
      direction: "short",
      entryPrice: currentPrice,
      stopPrice,
      tp1Price,
      tp2Price: tp1Price,
      rangeHigh,
      rangeLow,
    };
    logger.info({ firedSession: breakStartMs, rangeHigh, rangeLow, stopPrice, tp1Price }, "RBS SHORT BOS fired");
  }

  if (longMachine.pending && longMachine.slSource !== null) {
    const stopPrice = roundToTick(longMachine.slSource - slMult * atr14, minTick);
    const tp1Price  = roundToTick(rangeHigh, minTick); // opposing boundary
    longSignal = {
      direction: "long",
      entryPrice: currentPrice,
      stopPrice,
      tp1Price,
      tp2Price: tp1Price,
      rangeHigh,
      rangeLow,
    };
    logger.info({ firedSession: breakStartMs, rangeHigh, rangeLow, stopPrice, tp1Price }, "RBS LONG BOS fired");
  }

  return { rangeHigh, rangeLow, atr14, shortMachine, longMachine, shortSignal, longSignal };
}

// ─── Legacy helpers — kept for backward compatibility ────────────────────────

export function computeRange(bars: Bar[]): RangeData | null {
  if (bars.length === 0) return null;
  let high = -Infinity;
  let low  =  Infinity;
  for (const b of bars) {
    if (b.h > high) high = b.h;
    if (b.l < low)  low  = b.l;
  }
  if (high === low) return null;
  const midpoint = (high + low) / 2;
  const biasCandle = bars[bars.length - 1];
  let bias: TradeBias = "neutral";
  if (biasCandle.c > midpoint) bias = "bullish";
  else if (biasCandle.c < midpoint) bias = "bearish";
  return { high, low, midpoint, bias, biasCandle, width: high - low };
}

export function calculatePnl(
  direction: TradeDirection,
  entryPrice: number,
  exitPrice: number,
  qty: number,
  pointValue: number,
): number {
  const diff = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
  return diff * qty * pointValue;
}

export function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

// checkEntrySignal is kept only so old import references don't break.
// DTR instruments no longer use it — use buildRbsSession instead.
export function checkEntrySignal(
  _currentPrice: number,
  _rangeData: RangeData,
  _state: InstrumentState,
  _config: InstrumentConfig,
): EntrySignal | null {
  return null;
}
