/**
 * CCHOAS21 — ATR Volume Pullback Strategy
 *
 * Applies to US30 (MYMM6) and Nas100 (MNQM6) only.
 *
 * Logic (ported from Pine Script CCHOAS21! strategy):
 *  - EMA 20/50/200 trend filter
 *  - ADX >= 15 (trending filter)
 *  - Pullback to EMA 20 (within 0.5×ATR zone) on previous bar
 *  - Reversal candle on current bar
 *  - Volume >= 0.8× 20-bar SMA
 *  - RSI in range (35–72 long, 28–65 short)
 *  - Session: 09:30–15:30 NY
 *  - Max 5 trades per instrument per day
 *
 * Exit levels:
 *  - Stop Loss : 1.0×ATR from entry
 *  - Take Profit: 0.75×ATR from entry
 */

import type { Bar } from "./projectx-client";

export interface AtrPullbackSignal {
  direction: "long" | "short";
  entryPrice: number;
  stopPrice: number;
  tp1Price: number;
  atr: number;
}

export interface AtrPullbackParams {
  emaFast: number;
  emaSlow: number;
  ema200: number;
  use200: boolean;
  atrLen: number;
  atrSL: number;
  atrTP: number;
  rsiLen: number;
  rsiLoL: number;
  rsiHiL: number;
  rsiLoS: number;
  rsiHiS: number;
  volMult: number;
  zoneMult: number;
  adxMin: number;
  maxDailyTrades: number;
}

export const DEFAULT_ATR_PULLBACK_PARAMS: AtrPullbackParams = {
  emaFast: 20,
  emaSlow: 50,
  ema200: 200,
  use200: true,
  atrLen: 14,
  atrSL: 1.0,
  atrTP: 0.75,
  rsiLen: 14,
  rsiLoL: 35,
  rsiHiL: 72,
  rsiLoS: 28,
  rsiHiS: 65,
  volMult: 0.8,
  zoneMult: 0.5,
  adxMin: 15,
  maxDailyTrades: 5,
};

// ─── Indicator helpers ─────────────────────────────────────────────────────

/**
 * Standard EMA: output[k] maps to input[k].
 * First value is seeded as the first input value.
 */
function calcEMA(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * Wilder's ATR.
 * result[0] = Wilder average of the first `period` TRs (starts at bars[period]).
 * result[k] maps to bars[k + period].
 */
function calcATR(bars: Bar[], period: number): number[] {
  if (bars.length < 2) return [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c)
      )
    );
  }
  if (trs.length < period) return [];
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [val];
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
    result.push(val);
  }
  return result;
}

/**
 * Wilder's RSI.
 * result[0] maps to bars[period], result[k] maps to bars[k + period].
 */
function calcRSI(closes: number[], period: number): number[] {
  if (closes.length <= period) return [];
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d;
    else al -= d;
  }
  ag /= period;
  al /= period;
  const result: number[] = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return result;
}

/**
 * Wilder's ADX (same period for DI and ADX smoothing).
 * result[0] maps to bars[2*period - 1], result[k] maps to bars[k + 2*period - 1].
 */
function calcADX(bars: Bar[], period: number): number[] {
  if (bars.length < period * 2 + 2) return [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const dn = bars[i - 1].l - bars[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(
      Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c)
      )
    );
  }
  if (trs.length < period) return [];

  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    if (i > period - 1) {
      sTR = sTR - sTR / period + trs[i];
      sPDM = sPDM - sPDM / period + plusDM[i];
      sMDM = sMDM - sMDM / period + minusDM[i];
    }
    const pDI = (sPDM / sTR) * 100;
    const mDI = (sMDM / sTR) * 100;
    const denom = pDI + mDI;
    dxArr.push(denom === 0 ? 0 : (Math.abs(pDI - mDI) / denom) * 100);
  }

  if (dxArr.length < period) return [];
  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: number[] = [adxVal];
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
    result.push(adxVal);
  }
  return result;
}

/**
 * Simple Moving Average.
 * result[0] = avg of values[0..period-1]; maps to index period-1.
 * result[k] maps to values[k + period - 1].
 */
function calcSMA(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    result.push(
      values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
    );
  }
  return result;
}

// ─── Signal detection ──────────────────────────────────────────────────────

/**
 * Evaluate the ATR Volume Pullback signal on the provided bars.
 *
 * `bars`        — 1-minute OHLCV bars, oldest first. Need 250+ for accurate EMA 200.
 * `todayTrades` — trades already executed today for this instrument.
 * `params`      — strategy parameters (defaults to CCHOAS21 spec values).
 *
 * Returns a signal if all conditions are met, otherwise null.
 */
export function checkAtrPullbackSignal(
  bars: Bar[],
  todayTrades: number,
  params: AtrPullbackParams = DEFAULT_ATR_PULLBACK_PARAMS
): AtrPullbackSignal | null {
  // Need at minimum: EMA200 warmup + ATR period + a couple of extra bars
  const minBars = params.ema200 + params.atrLen + 5;
  if (bars.length < minBars) return null;

  if (todayTrades >= params.maxDailyTrades) return null;

  const closes = bars.map((b) => b.c);
  const opens = bars.map((b) => b.o);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const volumes = bars.map((b) => b.v);

  // Compute all indicators
  const emaFastArr = calcEMA(closes, params.emaFast);
  const emaSlowArr = calcEMA(closes, params.emaSlow);
  const ema200Arr = calcEMA(closes, params.ema200);
  const atrArr = calcATR(bars, params.atrLen);   // result[k] → bars[k + atrLen]
  const rsiArr = calcRSI(closes, params.rsiLen); // result[k] → bars[k + rsiLen]
  const adxArr = calcADX(bars, 14);              // result[k] → bars[k + 2*14 - 1]
  const volSMA = calcSMA(volumes, 20);           // result[k] → bars[k + 19]

  // Index alignment for the last bar
  const n = bars.length - 1;

  const emaFastCurr = emaFastArr[n];
  const emaFastPrev = emaFastArr[n - 1];
  const emaSlowCurr = emaSlowArr[n];
  const ema200Curr = ema200Arr[n];

  // ATR: result[k] → bars[k + atrLen], so bars[n] → result[n - atrLen]
  const atrIdx = n - params.atrLen;
  if (atrIdx < 0 || atrIdx >= atrArr.length) return null;
  const atrCurr = atrArr[atrIdx];

  // RSI: result[k] → bars[k + rsiLen], so bars[n] → result[n - rsiLen]
  const rsiIdx = n - params.rsiLen;
  if (rsiIdx < 0 || rsiIdx >= rsiArr.length) return null;
  const rsiCurr = rsiArr[rsiIdx];

  // ADX: result[k] → bars[k + 2*14 - 1], so bars[n] → result[n - 27]
  const adxIdx = n - (2 * 14 - 1);
  if (adxIdx < 0 || adxIdx >= adxArr.length) return null;
  const adxCurr = adxArr[adxIdx];

  // Vol SMA: result[k] → bars[k + 19], so bars[n] → result[n - 19]
  const volSMAIdx = n - 19;
  if (volSMAIdx < 0 || volSMAIdx >= volSMA.length) return null;
  const volAvg = volSMA[volSMAIdx];

  // Current and previous bar values
  const closeCurr = closes[n];
  const openCurr = opens[n];
  const highPrev = highs[n - 1];
  const lowPrev = lows[n - 1];

  // ── Trend conditions ──────────────────────────────────────────────────────
  const uptrend = emaFastCurr > emaSlowCurr && closeCurr > emaSlowCurr;
  const downtrend = emaFastCurr < emaSlowCurr && closeCurr < emaSlowCurr;
  const macroL = !params.use200 || closeCurr > ema200Curr;
  const macroS = !params.use200 || closeCurr < ema200Curr;
  const trending = adxCurr >= params.adxMin;

  // ── Pullback zone ─────────────────────────────────────────────────────────
  const zone = params.zoneMult * atrCurr;

  // Previous bar touched within zone of EMA fast
  const pbLong = lowPrev <= emaFastPrev + zone;
  const pbShort = highPrev >= emaFastPrev - zone;

  // Reversal candle: close on the correct side of EMA and candle is directional
  const revLong = closeCurr > emaFastCurr && closeCurr > openCurr;
  const revShort = closeCurr < emaFastCurr && closeCurr < openCurr;

  // ── Additional filters ───────────────────────────────────────────────────
  const hiVol = volumes[n] >= params.volMult * volAvg;
  const rsiOkL = rsiCurr >= params.rsiLoL && rsiCurr <= params.rsiHiL;
  const rsiOkS = rsiCurr >= params.rsiLoS && rsiCurr <= params.rsiHiS;

  // ── Entry signals ─────────────────────────────────────────────────────────
  if (uptrend && macroL && trending && pbLong && revLong && hiVol && rsiOkL) {
    const entry = closeCurr;
    return {
      direction: "long",
      entryPrice: entry,
      stopPrice: entry - params.atrSL * atrCurr,
      tp1Price: entry + params.atrTP * atrCurr,
      atr: atrCurr,
    };
  }

  if (downtrend && macroS && trending && pbShort && revShort && hiVol && rsiOkS) {
    const entry = closeCurr;
    return {
      direction: "short",
      entryPrice: entry,
      stopPrice: entry + params.atrSL * atrCurr,
      tp1Price: entry - params.atrTP * atrCurr,
      atr: atrCurr,
    };
  }

  return null;
}
