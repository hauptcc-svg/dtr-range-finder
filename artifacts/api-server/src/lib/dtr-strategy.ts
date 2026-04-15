/**
 * DTR (Draw The Range) Strategy Engine
 * 
 * Strategy logic:
 * 1. During the range window, collect 1-minute bars to identify range high/low
 * 2. Detect bias candle: the candle closing closest to range end time
 *    - Close > midpoint = bullish bias (favor longs)
 *    - Close < midpoint = bearish bias (favor shorts)
 * 3. In entry window, watch for price breaking out of range
 *    - Break above range high + bullish bias = LONG signal
 *    - Break below range low + bearish bias = SHORT signal
 * 4. Place bracket order: SL at opposite range boundary, TP = range width projection
 */

import { logger } from "./logger";
import type { Bar } from "./projectx-client";
import type { InstrumentConfig } from "./trading-config";

export type TradeDirection = "long" | "short";
export type TradeBias = "bullish" | "bearish" | "neutral";

export interface RangeData {
  high: number;
  low: number;
  midpoint: number;
  bias: TradeBias;
  biasCandle: Bar | null;
  width: number;
}

export interface EntrySignal {
  direction: TradeDirection;
  entryPrice: number;
  stopPrice: number;
  tp1Price: number;
  tp2Price: number;
  rangeHigh: number;
  rangeLow: number;
}

export interface InstrumentState {
  symbol: string;
  contractId: number | null;
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
}

/**
 * Compute range data from a set of 1-minute bars
 */
export function computeRange(bars: Bar[]): RangeData | null {
  if (bars.length === 0) return null;

  let high = -Infinity;
  let low = Infinity;

  for (const bar of bars) {
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
  }

  if (high === low) return null;

  const midpoint = (high + low) / 2;
  const biasCandle = bars[bars.length - 1]; // last bar in range window
  let bias: TradeBias = "neutral";
  if (biasCandle.c > midpoint) bias = "bullish";
  else if (biasCandle.c < midpoint) bias = "bearish";

  return {
    high,
    low,
    midpoint,
    bias,
    biasCandle,
    width: high - low,
  };
}

/**
 * Check if there is an entry signal given current price and range data
 */
export function checkEntrySignal(
  currentPrice: number,
  rangeData: RangeData,
  state: InstrumentState,
  config: InstrumentConfig
): EntrySignal | null {
  if (state.todayTrades >= config.maxTradesPerDay) {
    logger.debug({ symbol: state.symbol }, "Max daily trades reached");
    return null;
  }

  if (state.inPosition) {
    return null;
  }

  const { high, low, width } = rangeData;

  // Check for long breakout above range high — requires bullish bias
  if (
    rangeData.bias === "bullish" &&
    currentPrice > high &&
    state.longLosses < config.maxLossesPerDirection
  ) {
    const stopPrice = roundToTick(low - config.slAtrBuffer * width, config.minTick);
    const rangeTarget = high + width;
    const tp1Price = roundToTick(high + width * 0.5, config.minTick);
    const tp2Price = roundToTick(rangeTarget, config.minTick);

    return {
      direction: "long",
      entryPrice: currentPrice,
      stopPrice,
      tp1Price,
      tp2Price,
      rangeHigh: high,
      rangeLow: low,
    };
  }

  // Check for short breakout below range low — requires bearish bias
  if (
    rangeData.bias === "bearish" &&
    currentPrice < low &&
    state.shortLosses < config.maxLossesPerDirection
  ) {
    const stopPrice = roundToTick(high + config.slAtrBuffer * width, config.minTick);
    const rangeTarget = low - width;
    const tp1Price = roundToTick(low - width * 0.5, config.minTick);
    const tp2Price = roundToTick(rangeTarget, config.minTick);

    return {
      direction: "short",
      entryPrice: currentPrice,
      stopPrice,
      tp1Price,
      tp2Price,
      rangeHigh: high,
      rangeLow: low,
    };
  }

  return null;
}

/**
 * Calculate realized P&L for a closed trade
 */
export function calculatePnl(
  direction: TradeDirection,
  entryPrice: number,
  exitPrice: number,
  qty: number,
  pointValue: number
): number {
  const priceDiff = direction === "long"
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
  return priceDiff * qty * pointValue;
}

/**
 * Round a price to the nearest tick size
 */
export function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Create initial instrument state
 */
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
  };
}
