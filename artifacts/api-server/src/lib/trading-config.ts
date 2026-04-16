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
    MYMM6: {
      symbol: "MYMM6",
      name: "Micro Dow (MYM)",
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
      pointValue: 0.5,
      minTick: 1,
    },
    MCLK6: {
      symbol: "MCLK6",
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
      pointValue: 1.0,
      minTick: 0.01,
    },
    MGCM6: {
      symbol: "MGCM6",
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
      pointValue: 1.0,
      minTick: 0.1,
    },
    MNQM6: {
      symbol: "MNQM6",
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
      pointValue: 0.5,
      minTick: 0.25,
    },
  },
};

export function getInstrumentConfig(symbol: string): InstrumentConfig | null {
  return TRADING_CONFIG.instruments[symbol] || null;
}

/**
 * Convert an America/New_York "YYYY-MM-DD HH:MM" wall-clock time to a UTC Date.
 * Uses the Intl.DateTimeFormat offset method which is DST-safe on any host timezone.
 */
export function nyWallClockToUtc(nyDateStr: string, timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const [year, month, day] = nyDateStr.split("-").map(Number);

  // Binary-search for the UTC instant whose NY wall-clock time equals the target.
  // Start with a rough estimate: UTC = target - 5h (EST, non-DST).
  const roughUtcMs = Date.UTC(year, month - 1, day, h + 5, m, 0);
  const roughDate = new Date(roughUtcMs);

  // Read back what NY wall-clock the rough estimate maps to
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(roughDate);
  const partMap = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const roughNYMs = Date.UTC(
    Number(partMap.year),
    Number(partMap.month) - 1,
    Number(partMap.day),
    Number(partMap.hour) === 24 ? 0 : Number(partMap.hour),
    Number(partMap.minute),
    Number(partMap.second)
  );

  // The UTC offset in ms at this moment (positive = NY is behind UTC)
  const offsetMs = roughNYMs - roughDate.getTime();

  // True UTC = target NY wall-clock - NY offset
  const targetNYMs = Date.UTC(year, month - 1, day, h, m, 0);
  return new Date(targetNYMs - offsetMs);
}

/**
 * Parse time string "HH:MM" and create a Date for today in NY timezone.
 * Returns a proper UTC Date that represents that NY wall-clock moment today.
 */
export function todayAtNY(timeStr: string): Date {
  const nyDateStr = currentNYDate();
  return nyWallClockToUtc(nyDateStr, timeStr);
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
