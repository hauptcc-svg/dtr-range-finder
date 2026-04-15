/**
 * DTR Multi-Instrument Trading Configuration
 * All times are in America/New_York timezone
 */

export interface InstrumentConfig {
  symbol: string;
  name: string;
  enabled: boolean;
  qty: number;
  tp1Qty: number;
  londonRangeStart: string; // HH:MM
  londonRangeEnd: string;
  londonEntryStart: string;
  londonEntryEnd: string;
  nyRangeStart: string;
  nyRangeEnd: string;
  nyEntryStart: string;
  nyEntryEnd: string;
  biasCandle_atrMult: number;
  slAtrBuffer: number;
  tpMode: "Range Target";
  maxTradesPerDay: number;
  maxLossesPerDirection: number;
  pointValue: number;
  minTick: number;
}

export interface TradingConfig {
  timezone: string;
  dailyLossLimit: number;
  dailyProfitTarget: number;
  tradingDays: number[]; // 0=Mon .. 4=Fri
  instruments: Record<string, InstrumentConfig>;
}

export const TRADING_CONFIG: TradingConfig = {
  timezone: "America/New_York",
  dailyLossLimit: 200,
  dailyProfitTarget: 1400,
  tradingDays: [0, 1, 2, 3, 4], // Monday–Friday

  instruments: {
    MYMM26: {
      symbol: "MYMM26",
      name: "Mini Yen",
      enabled: true,
      qty: 2,
      tp1Qty: 1,
      londonRangeStart: "01:12",
      londonRangeEnd: "02:13",
      londonEntryStart: "03:13",
      londonEntryEnd: "07:00",
      nyRangeStart: "08:12",
      nyRangeEnd: "09:13",
      nyEntryStart: "09:13",
      nyEntryEnd: "14:00",
      biasCandle_atrMult: 0.5,
      slAtrBuffer: 0.0,
      tpMode: "Range Target",
      maxTradesPerDay: 4,
      maxLossesPerDirection: 2,
      pointValue: 12.5,
      minTick: 0.01,
    },
    MCLK26: {
      symbol: "MCLK26",
      name: "Micro Crude Oil",
      enabled: true,
      qty: 2,
      tp1Qty: 1,
      londonRangeStart: "01:12",
      londonRangeEnd: "02:13",
      londonEntryStart: "03:13",
      londonEntryEnd: "07:00",
      nyRangeStart: "08:12",
      nyRangeEnd: "09:13",
      nyEntryStart: "09:13",
      nyEntryEnd: "14:00",
      biasCandle_atrMult: 0.5,
      slAtrBuffer: 0.0,
      tpMode: "Range Target",
      maxTradesPerDay: 4,
      maxLossesPerDirection: 2,
      pointValue: 10.0,
      minTick: 0.01,
    },
    MGCM26: {
      symbol: "MGCM26",
      name: "Micro Gold",
      enabled: true,
      qty: 2,
      tp1Qty: 1,
      londonRangeStart: "01:12",
      londonRangeEnd: "02:13",
      londonEntryStart: "03:13",
      londonEntryEnd: "07:00",
      nyRangeStart: "08:12",
      nyRangeEnd: "09:13",
      nyEntryStart: "09:13",
      nyEntryEnd: "14:00",
      biasCandle_atrMult: 0.5,
      slAtrBuffer: 0.0,
      tpMode: "Range Target",
      maxTradesPerDay: 4,
      maxLossesPerDirection: 2,
      pointValue: 10.0,
      minTick: 0.1,
    },
    MNQM26: {
      symbol: "MNQM26",
      name: "Micro NQ (Nasdaq 100)",
      enabled: true,
      qty: 3,
      tp1Qty: 1,
      londonRangeStart: "01:12",
      londonRangeEnd: "02:13",
      londonEntryStart: "03:13",
      londonEntryEnd: "07:00",
      nyRangeStart: "08:12",
      nyRangeEnd: "09:13",
      nyEntryStart: "09:13",
      nyEntryEnd: "14:00",
      biasCandle_atrMult: 0.5,
      slAtrBuffer: 0.0,
      tpMode: "Range Target",
      maxTradesPerDay: 4,
      maxLossesPerDirection: 2,
      pointValue: 20.0,
      minTick: 0.25,
    },
  },
};

export function getInstrumentConfig(symbol: string): InstrumentConfig | null {
  return TRADING_CONFIG.instruments[symbol] || null;
}

/**
 * Parse time string "HH:MM" and create a Date for today in NY timezone
 */
export function todayAtNY(timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  // Get current date in NY
  const nyDateStr = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [month, day, year] = nyDateStr.split("/").map(Number);
  // Create date in NY timezone
  const nyDate = new Date(
    Date.UTC(year, month - 1, day, h, m, 0) +
      getNYOffsetMs(new Date(Date.UTC(year, month - 1, day, h, m, 0)))
  );
  return nyDate;
}

/**
 * Get NY timezone offset in ms for a given UTC date
 */
function getNYOffsetMs(utcDate: Date): number {
  const nyStr = utcDate.toLocaleString("en-US", { timeZone: "America/New_York" });
  const nyDate = new Date(nyStr + " UTC"); // trick to get local NY time as UTC
  return utcDate.getTime() - nyDate.getTime();
}

/**
 * Get current time in NY as HH:MM
 */
export function currentNYTime(): string {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Check if current NY time is within a window [start, end)
 */
export function isInTimeWindow(start: string, end: string): boolean {
  const current = currentNYTime();
  return current >= start && current < end;
}

/**
 * Get day of week in NY (0=Monday, 4=Friday)
 */
export function currentNYDayOfWeek(): number {
  const now = new Date();
  const nyDay = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" })
      .replace("Mon", "0")
      .replace("Tue", "1")
      .replace("Wed", "2")
      .replace("Thu", "3")
      .replace("Fri", "4")
      .replace("Sat", "5")
      .replace("Sun", "6")
  );
  return nyDay;
}

/**
 * Get current date string in NY as YYYY-MM-DD
 */
export function currentNYDate(): string {
  const now = new Date();
  const [month, day, year] = now
    .toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    .split("/")
    .map(Number);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
