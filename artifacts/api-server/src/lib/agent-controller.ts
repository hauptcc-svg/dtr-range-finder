/**
 * DTR Agent Controller
 * 
 * Singleton service that:
 * - Runs the trading loop on a 30-second tick
 * - Manages London + NY session lifecycle (range → entry → EOD flat)
 * - Checks daily P&L against loss limit (-$200) and profit target (+$1,400)
 * - Persists trade records and daily summary to the database
 */

import { logger } from "./logger";
import { getProjectXClient, type ProjectXClient, type OpenPosition } from "./projectx-client";
import { TRADING_CONFIG, isInTimeWindow, currentNYDate, currentNYDayOfWeek, todayAtNY } from "./trading-config";
import {
  computeRange,
  checkEntrySignal,
  createInstrumentState,
  calculatePnl,
  type InstrumentState,
} from "./dtr-strategy";
import { getClaudeTradeAdvice, getClaudeAutonomousAdvice, type ClaudeAdvice } from "./claude-advisor";
import { checkAtrPullbackSignal, DEFAULT_ATR_PULLBACK_PARAMS } from "./atr-pullback-strategy";
import { db, tradesTable, dailySummaryTable, instrumentConfigsTable, accountConfigsTable } from "@workspace/db";
import type { InstrumentConfig as DbInstrumentConfigRow } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

export type SessionPhase =
  | "idle"
  | "london_range"
  | "london_entry"
  | "ny_range"
  | "ny_entry"
  | "eod_flat"
  | "daily_limit_hit";

export interface AgentStatusData {
  running: boolean;
  sessionPhase: SessionPhase;
  dailyPnl: number;
  dailyLossLimit: number;
  dailyProfitTarget: number;
  tradeCount: number;
  lastUpdated: string;
  authenticatedWithProjectX: boolean;
  errorMessage: string | null;
  claudeAutonomousMode: boolean;
  lastClaudeAutonomousTick: string | null;
}

export interface InstrumentStatusData {
  symbol: string;
  name: string;
  enabled: boolean;
  position: string | null;
  positionSize: number;
  entryPrice: number | null;
  unrealizedPnl: number | null;
  positionOpenedAt: string | null;
  todayPnl: number;
  todayTrades: number;
  longLosses: number;
  shortLosses: number;
  rangeHigh: number | null;
  rangeLow: number | null;
  lastPrice: number | null;
}

class AgentController {
  private running = false;
  private sessionPhase: SessionPhase = "idle";
  private dailyPnl = 0;
  private tradeCount = 0;
  private lastUpdated = new Date().toISOString();
  private authenticatedWithProjectX = false;
  private errorMessage: string | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private client: ProjectXClient | null = null;
  private instrumentStates: Map<string, InstrumentState> = new Map();
  private currentDate: string = "";
  // Cache open positions from ProjectX
  private openPositionsCache: OpenPosition[] = [];
  // Previous position cache snapshot for detecting closes and reading realizedPnl
  private previousPositionsCache: OpenPosition[] = [];
  private lastPositionFetch = 0;
  // Runtime enabled/disabled overrides per instrument (persists until process restart)
  private instrumentEnabledOverrides: Map<string, boolean> = new Map();
  // Claude Autonomous Mode — bypasses all DTR rules, Claude decides freely
  private claudeAutonomousMode = false;
  private lastClaudeAutonomousTick = 0;
  // How often to call Claude in autonomous mode (ms)
  private readonly CLAUDE_AUTONOMOUS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  // Cached account info (updated on start and on demand)
  private cachedAccountInfo: { balance: number; accountId: number; accountName: string; canTrade: boolean } | null = null;
  // Deduplication: tracks the timestamp of the last bar that fired an ATR pullback signal per instrument
  private lastAtrSignalBarTs: Map<string, number> = new Map();
  // Runtime-editable risk settings (in-memory overrides; fall back to TRADING_CONFIG defaults)
  private runtimeSettings: {
    dailyLossLimit?: number;
    dailyProfitTarget?: number;
    maxTradesPerDay?: number;
    maxLossesPerDirection?: number;
    tradingLocked?: boolean;
  } = {};
  // DB-driven instrument configs (refreshed on startup and every 5 minutes)
  private dbConfigs: Map<string, DbInstrumentConfigRow> = new Map();
  private lastDbConfigRefresh = 0;
  private readonly DB_CONFIG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  constructor() {
    // InstrumentStates are populated after DB load in loadInstrumentConfigsFromDb().
    // Static TRADING_CONFIG is only used as seed source, not for live decisions.
  }

  /**
   * Returns the effective config for an instrument from DB only.
   * The DB is the sole source of truth for live trading decisions.
   * Static TRADING_CONFIG is ONLY used as a seed source on first startup.
   * Returns null if the instrument is not present in DB (e.g. deleted).
   */
  private getEffectiveConfig(symbol: string) {
    const dbRow = this.dbConfigs.get(symbol);
    if (!dbRow) return null;
    // Static config used ONLY for fields not yet in DB schema (strategy-specific params).
    const staticCfg = TRADING_CONFIG.instruments[symbol];
    return {
      symbol: dbRow.symbol,
      name: dbRow.name,
      enabled: dbRow.enabled,
      qty: dbRow.qty,
      pointValue: dbRow.pointValue,
      minTick: dbRow.minTick,
      maxTradesPerDay: dbRow.maxTradesPerDay,
      strategyMode: dbRow.strategyMode as "dtr" | "atr_pullback",
      sessionStart: dbRow.sessionStart,
      sessionEnd: dbRow.sessionEnd,
      // Strategy-specific fields not yet in DB — use static config if available, else defaults
      tp1Qty: staticCfg?.tp1Qty ?? 1,
      maxLossesPerDirection: staticCfg?.maxLossesPerDirection ?? 2,
      biasCandle_atrMult: staticCfg?.biasCandle_atrMult ?? 0.5,
      slAtrBuffer: staticCfg?.slAtrBuffer ?? 0.0,
      tpMode: (staticCfg?.tpMode ?? "Range Target") as "Range Target",
      londonRangeStart: staticCfg?.londonRangeStart ?? "01:12",
      londonRangeEnd: staticCfg?.londonRangeEnd ?? "02:13",
      londonEntryStart: staticCfg?.londonEntryStart ?? "03:13",
      londonEntryEnd: staticCfg?.londonEntryEnd ?? "07:00",
      nyRangeStart: staticCfg?.nyRangeStart ?? "08:12",
      nyRangeEnd: staticCfg?.nyRangeEnd ?? "09:13",
    };
  }

  /**
   * Seed DB with the 4 static instruments from TRADING_CONFIG ONLY when the
   * instrument_configs table is completely empty (i.e., very first run).
   * Subsequent startups skip seeding so user deletions and edits persist.
   */
  private async seedInstrumentConfigs(): Promise<void> {
    const existing = await db.select().from(instrumentConfigsTable);
    if (existing.length > 0) {
      logger.info({ count: existing.length }, "DB already has instrument configs — skipping seed");
      return;
    }
    for (const cfg of Object.values(TRADING_CONFIG.instruments)) {
      await db.insert(instrumentConfigsTable).values({
        symbol: cfg.symbol,
        name: cfg.name,
        enabled: cfg.enabled,
        qty: cfg.qty,
        pointValue: cfg.pointValue,
        minTick: cfg.minTick,
        maxTradesPerDay: cfg.maxTradesPerDay,
        strategyMode: cfg.strategyMode,
        sessionStart: cfg.nyEntryStart,
        sessionEnd: cfg.nyEntryEnd,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    logger.info({ count: Object.keys(TRADING_CONFIG.instruments).length }, "Seeded instrument configs from TRADING_CONFIG (first run)");
  }

  /**
   * Load all instrument configs from DB into memory. Initializes instrumentStates
   * for any symbols not yet present (e.g. newly-added instruments).
   */
  async loadInstrumentConfigsFromDb(): Promise<void> {
    const rows = await db.select().from(instrumentConfigsTable);
    this.dbConfigs = new Map(rows.map((r) => [r.symbol, r]));
    // Ensure instrumentStates exists for every DB symbol
    for (const row of rows) {
      if (!this.instrumentStates.has(row.symbol)) {
        this.instrumentStates.set(row.symbol, createInstrumentState(row.symbol));
      }
    }
    // Remove states for symbols deleted from DB (keep state in memory until process restart
    // to allow existing positions to reconcile — we just won't open new ones)
    this.lastDbConfigRefresh = Date.now();
    logger.info({ count: rows.length }, "Loaded instrument configs from DB");
  }

  /**
   * Public: called by CRUD API endpoints after a write to immediately reflect changes.
   */
  async refreshInstrumentConfigs(): Promise<void> {
    await this.loadInstrumentConfigsFromDb();
    // Resolve contract IDs for any new symbols
    if (this.client) {
      for (const symbol of this.dbConfigs.keys()) {
        if (!this.instrumentStates.get(symbol)?.contractId) {
          try {
            const contractId = await this.client.getContractId(symbol);
            const state = this.instrumentStates.get(symbol);
            if (state) state.contractId = contractId;
            if (contractId) logger.info({ symbol, contractId }, "Resolved contract ID for new instrument");
          } catch (err) {
            logger.warn({ err, symbol }, "Could not resolve contract ID for new instrument");
          }
        }
      }
    }
  }

  // ─── Telegram helper ──────────────────────────────────────────────────────
  private async sendTelegram(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      });
    } catch (err) {
      logger.warn({ err }, "Telegram send failed (non-fatal)");
    }
  }

  // ─── Public account info ──────────────────────────────────────────────────
  async getAccountInfo(): Promise<{ balance: number; accountId: number; accountName: string; canTrade: boolean } | null> {
    try {
      if (this.client) {
        // Agent is running — fetch fresh data from live client
        const info = await this.client.getAccountInfo();
        this.cachedAccountInfo = { balance: info.balance, accountId: info.id, accountName: info.name, canTrade: info.canTrade };
        return this.cachedAccountInfo;
      }
      // Agent not running — return cached value if we have it
      if (this.cachedAccountInfo) return this.cachedAccountInfo;
      // No cache and no running client — create a temporary client
      const tempClient = getProjectXClient();
      await tempClient.authenticate();
      const info = await tempClient.getAccountInfo();
      this.cachedAccountInfo = { balance: info.balance, accountId: info.id, accountName: info.name, canTrade: info.canTrade };
      return this.cachedAccountInfo;
    } catch (err) {
      logger.warn({ err }, "Failed to fetch account info");
      return this.cachedAccountInfo ?? null;
    }
  }

  /**
   * Returns effective enabled state from DB only (DB is sole source of truth).
   * Instruments deleted from DB are not in dbConfigs → returns false.
   * Runtime overrides (in-memory) take priority for the duration of the process.
   */
  isInstrumentEnabled(symbol: string): boolean {
    if (this.instrumentEnabledOverrides.has(symbol)) {
      return this.instrumentEnabledOverrides.get(symbol)!;
    }
    const dbRow = this.dbConfigs.get(symbol);
    // Not in DB → was deleted or never added; do not fall back to static config
    return dbRow?.enabled ?? false;
  }

  /** Toggle an instrument on or off at runtime without restarting the agent. */
  toggleInstrument(symbol: string, enabled: boolean): { success: boolean; message: string } {
    if (!this.dbConfigs.has(symbol)) {
      return { success: false, message: `Unknown instrument: ${symbol}` };
    }
    this.instrumentEnabledOverrides.set(symbol, enabled);
    logger.info({ symbol, enabled }, "Instrument toggled");
    return { success: true, message: `${symbol} ${enabled ? "enabled" : "disabled"}` };
  }

  /** Enable or disable Claude Autonomous Mode. */
  setAutonomousMode(enabled: boolean): { success: boolean; message: string } {
    this.claudeAutonomousMode = enabled;
    if (enabled) {
      // Force an immediate autonomous tick on next cycle
      this.lastClaudeAutonomousTick = 0;
    }
    logger.info({ claudeAutonomousMode: enabled }, "Trading mode changed");
    return {
      success: true,
      message: enabled
        ? "Claude Autonomous Mode enabled — DTR rules bypassed, Claude trading freely."
        : "DTR Rules Mode restored.",
    };
  }

  /** Returns the current trading mode. */
  getAutonomousMode(): boolean {
    return this.claudeAutonomousMode;
  }

  // ─── Runtime risk settings ────────────────────────────────────────────────

  private effectiveLossLimit(): number {
    return this.runtimeSettings.dailyLossLimit ?? TRADING_CONFIG.dailyLossLimit;
  }

  private effectiveProfitTarget(): number {
    return this.runtimeSettings.dailyProfitTarget ?? TRADING_CONFIG.dailyProfitTarget;
  }

  /** Returns the effective max-trades-per-day for a symbol (runtime override fully replaces config when set). */
  private effectiveMaxTrades(symbol: string): number {
    if (this.runtimeSettings.maxTradesPerDay !== undefined) {
      return this.runtimeSettings.maxTradesPerDay;
    }
    return TRADING_CONFIG.instruments[symbol]?.maxTradesPerDay ?? 4;
  }

  /** Returns the effective max-losses-per-direction for a symbol (runtime override fully replaces config when set). */
  private effectiveMaxLossesPerDirection(symbol: string): number {
    if (this.runtimeSettings.maxLossesPerDirection !== undefined) {
      return this.runtimeSettings.maxLossesPerDirection;
    }
    return TRADING_CONFIG.instruments[symbol]?.maxLossesPerDirection ?? 2;
  }

  /** Returns the current effective risk settings (runtime overrides merged with config defaults). */
  getSettings(): {
    dailyLossLimit: number;
    dailyProfitTarget: number;
    maxTradesPerDay: number;
    maxLossesPerDirection: number;
    tradingLocked: boolean;
  } {
    // Default per-instrument values when no global override is set
    const defaultMaxTrades = Math.min(
      ...Object.values(TRADING_CONFIG.instruments).map((c) => c.maxTradesPerDay)
    );
    const defaultMaxLosses = Math.min(
      ...Object.values(TRADING_CONFIG.instruments).map((c) => c.maxLossesPerDirection)
    );
    return {
      dailyLossLimit: this.effectiveLossLimit(),
      dailyProfitTarget: this.effectiveProfitTarget(),
      maxTradesPerDay: this.runtimeSettings.maxTradesPerDay ?? defaultMaxTrades,
      maxLossesPerDirection: this.runtimeSettings.maxLossesPerDirection ?? defaultMaxLosses,
      tradingLocked: this.runtimeSettings.tradingLocked ?? false,
    };
  }

  /** Applies partial runtime overrides to risk settings. */
  updateSettings(partial: {
    dailyLossLimit?: number;
    dailyProfitTarget?: number;
    maxTradesPerDay?: number | null;
    maxLossesPerDirection?: number | null;
  }): { success: boolean; message: string } {
    if (partial.dailyLossLimit !== undefined) {
      if (!Number.isFinite(partial.dailyLossLimit) || partial.dailyLossLimit <= 0) {
        return { success: false, message: "dailyLossLimit must be a positive number" };
      }
      this.runtimeSettings.dailyLossLimit = partial.dailyLossLimit;
    }
    if (partial.dailyProfitTarget !== undefined) {
      if (!Number.isFinite(partial.dailyProfitTarget) || partial.dailyProfitTarget <= 0) {
        return { success: false, message: "dailyProfitTarget must be a positive number" };
      }
      this.runtimeSettings.dailyProfitTarget = partial.dailyProfitTarget;
    }
    if ("maxTradesPerDay" in partial) {
      if (partial.maxTradesPerDay !== null) {
        if (!Number.isInteger(partial.maxTradesPerDay) || partial.maxTradesPerDay <= 0) {
          return { success: false, message: "maxTradesPerDay must be a positive integer or null" };
        }
      }
      this.runtimeSettings.maxTradesPerDay = partial.maxTradesPerDay ?? undefined;
    }
    if ("maxLossesPerDirection" in partial) {
      if (partial.maxLossesPerDirection !== null) {
        if (!Number.isInteger(partial.maxLossesPerDirection) || partial.maxLossesPerDirection <= 0) {
          return { success: false, message: "maxLossesPerDirection must be a positive integer or null" };
        }
      }
      this.runtimeSettings.maxLossesPerDirection = partial.maxLossesPerDirection ?? undefined;
    }
    logger.info({ runtimeSettings: this.runtimeSettings }, "Risk settings updated");
    return { success: true, message: "Settings updated" };
  }

  /** Closes all open positions immediately and returns. */
  async liquidateAll(): Promise<{ success: boolean; message: string }> {
    if (!this.client) {
      return { success: false, message: "Agent is not running — positions cannot be liquidated via API when offline." };
    }
    logger.warn("Manual liquidation requested via API");
    await this.flattenAllPositions("ended");
    this.sendTelegram(
      `🚨 <b>MANUAL LIQUIDATION</b> · DeclanCapital FX\n\n` +
      `All open positions closed by dashboard action.\n` +
      `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
      `<i>${new Date().toUTCString()}</i>`
    ).catch(() => {});
    return { success: true, message: "All positions liquidated." };
  }

  /** Locks trading for the rest of the session (sets phase to daily_limit_hit). */
  lockTrading(): { success: boolean; message: string } {
    this.runtimeSettings.tradingLocked = true;
    this.sessionPhase = "daily_limit_hit";
    logger.warn("Trading locked by dashboard action");
    this.sendTelegram(
      `🔒 <b>TRADING LOCKED</b> · DeclanCapital FX\n\n` +
      `Trading locked via dashboard. No new trades will be placed.\n` +
      `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
      `<i>${new Date().toUTCString()}</i>`
    ).catch(() => {});
    return { success: true, message: "Trading locked for the session. Restart the agent to unlock." };
  }

  /**
   * Switch the active trading account.
   * 1. Flattens all open positions on the current account.
   * 2. Updates the ProjectXClient's accountId.
   * 3. Resets all daily counters and instrument states.
   * 4. Validates the new account can trade.
   */
  async switchAccount(newAccountId: number): Promise<{ success: boolean; message: string }> {
    if (!this.client) {
      return { success: false, message: "Agent is not running — start it first before switching accounts." };
    }
    if (newAccountId === this.cachedAccountInfo?.accountId) {
      return { success: false, message: "That account is already active." };
    }

    logger.warn({ newAccountId }, "Account switch requested — flattening positions on current account");

    // 1. Flatten all open positions on the current account
    try {
      await this.flattenAllPositions("ended");
    } catch (err) {
      logger.error({ err }, "Failed to flatten positions before account switch");
      return { success: false, message: "Could not flatten positions on the current account." };
    }

    // 2. Capture the old account ID so we can revert on failure
    const oldAccountId = this.cachedAccountInfo?.accountId ?? null;

    // 3. Update the ProjectXClient with the new account ID
    this.client.setAccountId(newAccountId);

    // 4. Validate the new account — revert on failure
    let newInfo: { balance: number; id: number; name: string; canTrade: boolean };
    try {
      newInfo = await this.client.getAccountInfo();
    } catch (err) {
      // Revert client to old account
      if (oldAccountId !== null) this.client.setAccountId(oldAccountId);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, newAccountId, oldAccountId }, "Account validation failed — reverted to previous account");
      return { success: false, message: `Account validation failed: ${msg}` };
    }

    if (!newInfo.canTrade) {
      // Revert client to old account
      if (oldAccountId !== null) this.client.setAccountId(oldAccountId);
      logger.warn({ newAccountId }, "New account canTrade=false — reverted to previous account");
      return { success: false, message: `Account ${newAccountId} exists but canTrade=false.` };
    }

    // 5. Validation succeeded — reset daily counters and instrument states
    this.dailyPnl = 0;
    this.tradeCount = 0;
    this.sessionPhase = "idle";
    this.runtimeSettings.tradingLocked = false;
    for (const symbol of Array.from(this.instrumentStates.keys())) {
      this.instrumentStates.set(symbol, {
        ...createInstrumentState(symbol),
        contractId: this.instrumentStates.get(symbol)?.contractId ?? null,
      });
    }

    this.cachedAccountInfo = { balance: newInfo.balance, accountId: newInfo.id, accountName: newInfo.name, canTrade: newInfo.canTrade };
    logger.info({ accountId: newAccountId, accountName: newInfo.name, balance: newInfo.balance }, "Account switched successfully");

    this.sendTelegram(
      `🔄 <b>ACCOUNT SWITCHED</b> · DeclanCapital FX\n\n` +
      `<b>Active Account:</b> ${this.cachedAccountInfo?.accountName ?? newAccountId}\n` +
      `<b>Balance:</b> $${this.cachedAccountInfo?.balance?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}\n` +
      `<i>${new Date().toUTCString()}</i>`
    ).catch(() => {});

    return { success: true, message: `Account switched to ${this.cachedAccountInfo?.accountName ?? newAccountId}` };
  }

  /**
   * Seed account_configs from PROJECTX_ACCOUNT_ID env var on first run.
   * Called during start() — skipped if the table already has rows.
   */
  async seedAccountConfigs(): Promise<void> {
    const existing = await db.select().from(accountConfigsTable);
    if (existing.length > 0) {
      logger.info({ count: existing.length }, "DB already has account configs — skipping seed");
      return;
    }
    const envAccountId = parseInt(process.env.PROJECTX_ACCOUNT_ID ?? "0", 10);
    if (!envAccountId) {
      logger.warn("PROJECTX_ACCOUNT_ID not set — cannot seed account_configs");
      return;
    }
    const accountName = this.cachedAccountInfo?.accountName ?? String(envAccountId);
    await db.insert(accountConfigsTable).values({
      accountId: envAccountId,
      accountNumber: accountName,
      label: "Default Account",
      isActive: true,
    });
    logger.info({ envAccountId, accountName }, "Seeded account_configs from env var (first run)");
  }

  /**
   * Autonomous tick: fetch recent bars + prices for all enabled instruments,
   * send to Claude, execute its decisions (long/short/close/skip).
   * Rate-limited to CLAUDE_AUTONOMOUS_INTERVAL_MS.
   */
  private async autonomousTick(): Promise<void> {
    if (!this.client) return;
    const now = Date.now();
    if (now - this.lastClaudeAutonomousTick < this.CLAUDE_AUTONOMOUS_INTERVAL_MS) return;

    logger.info("Running Claude autonomous tick");

    const eligibleInstruments = Array.from(this.instrumentStates.entries())
      .filter(([symbol]) => this.isInstrumentEnabled(symbol))
      .map(([symbol, state]) => ({
        state,
        config: this.getEffectiveConfig(symbol),
      }))
      .filter(({ config }) => !!config);

    if (eligibleInstruments.length === 0) return;

    // Fetch recent 1-min bars (last 30 min) + current price for each instrument
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 30 * 60 * 1000);

    const instrumentsWithBars = await Promise.all(
      eligibleInstruments.map(async ({ state, config }) => {
        let recentBars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];
        if (state.contractId && this.client) {
          try {
            const bars = await this.client.getBars(state.contractId, windowStart, windowEnd);
            recentBars = bars.map((b) => ({
              t: new Date(b.t).toISOString(),
              o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
            }));
            if (recentBars.length > 0) {
              state.lastPrice = recentBars[recentBars.length - 1].c;
            }
          } catch (err) {
            logger.warn({ err, symbol: state.symbol }, "Failed to fetch bars for autonomous tick");
          }
        }
        return { state, config, recentBars };
      })
    );

    let advice: ClaudeAdvice;
    try {
      advice = await getClaudeAutonomousAdvice(
        instrumentsWithBars,
        this.dailyPnl,
        this.effectiveLossLimit(),
        this.effectiveProfitTarget()
      );
    } catch (err) {
      logger.error({ err }, "Claude autonomous advice failed");
      return;
    }

    this.lastClaudeAutonomousTick = Date.now();
    logger.info({ summary: advice.summary, decisions: advice.decisions }, "Claude autonomous advice");

    // Execute decisions
    for (const decision of advice.decisions) {
      const state = this.instrumentStates.get(decision.symbol);
      const config = this.getEffectiveConfig(decision.symbol);
      if (!state || !config || !state.contractId) continue;

      // Guard: daily limits
      if (this.dailyPnl <= -this.effectiveLossLimit()) break;

      if (decision.action === "close") {
        if (!state.inPosition) continue;
        try {
          await this.client!.closePositionForContract(state.contractId);
          logger.info({ symbol: decision.symbol, reasoning: decision.reasoning }, "Claude autonomous: closed position");
        } catch (err) {
          logger.error({ err, symbol: decision.symbol }, "Failed to close position (autonomous)");
        }
        continue;
      }

      if (decision.action === "skip") continue;

      // Long or short entry
      if (state.inPosition) continue;
      if (state.todayTrades >= this.effectiveMaxTrades(decision.symbol)) continue;

      const isBuy = decision.action === "long";
      const price = state.lastPrice;
      if (!price) continue;

      // Simple ATR-based stops: use 0.5% of price as stop, 1% as TP
      const stopDist = price * 0.005;
      const stopPrice = isBuy ? price - stopDist : price + stopDist;
      const tp1Price = isBuy ? price + stopDist * 2 : price - stopDist * 2;

      try {
        const orderResult = await this.client!.placeBracketOrder({
          contractId: state.contractId,
          isBuy,
          qty: config.qty,
          stopPrice,
          tp1Price,
        });

        const [trade] = await db
          .insert(tradesTable)
          .values({
            instrument: decision.symbol,
            direction: decision.action,
            entryPrice: price,
            exitPrice: null,
            qty: config.qty,
            pnl: null,
            stopPrice,
            tp1Price,
            tp2Price: null,
            session: "ny",
            status: "open",
            projectxOrderId: orderResult.orderId,
            entryTime: new Date(),
            exitTime: null,
            strategy: "claude",
          })
          .returning();

        state.inPosition = true;
        state.positionDirection = decision.action as "long" | "short";
        state.positionQty = config.qty;
        state.positionEntryPrice = price;
        state.positionOpenedAt = new Date().toISOString();
        state.openTradeId = trade.id;
        state.todayTrades++;
        this.tradeCount++;

        logger.info(
          { symbol: decision.symbol, action: decision.action, price, reasoning: decision.reasoning },
          "Claude autonomous: trade placed"
        );

        this.sendTelegram(
          `🧠 <b>TRADE ENTERED</b> · DeclanCapital FX\n\n` +
          `<b>${config.name ?? decision.symbol}</b> (${decision.symbol})\n` +
          `<b>Direction:</b> ${decision.action.toUpperCase()}\n` +
          `<b>Qty:</b> ${config.qty}\n` +
          `<b>Entry:</b> ${price.toFixed(2)}\n` +
          `<b>Stop:</b> ${stopPrice.toFixed(2)}\n` +
          `<b>TP1:</b> ${tp1Price.toFixed(2)}\n` +
          `<b>TP2:</b> —\n` +
          `<b>Mode:</b> Claude AI (Auto)\n` +
          `<b>Reasoning:</b> ${decision.reasoning ?? "—"}\n` +
          `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      } catch (err) {
        logger.error({ err, symbol: decision.symbol }, "Failed to place autonomous trade");
      }
    }
  }

  /**
   * Ask Claude to analyse the current DTR state for all enabled instruments
   * and immediately place trades where it recommends.
   * Does NOT require the agent to be running — fetches prices directly.
   */
  async claudeTradeNow(): Promise<{ success: boolean; advice: ClaudeAdvice | null; tradesPlaced: string[]; message: string }> {
    if (!this.client) {
      return { success: false, advice: null, tradesPlaced: [], message: "Agent is not running — start it first so prices are available." };
    }
    if (this.runtimeSettings.tradingLocked) {
      return { success: false, advice: null, tradesPlaced: [], message: "Trading is locked — no new entries are permitted until the next session." };
    }

    const eligibleInstruments = Array.from(this.instrumentStates.entries())
      .filter(([symbol]) => this.isInstrumentEnabled(symbol))
      .map(([symbol, state]) => ({
        state,
        config: this.getEffectiveConfig(symbol),
      }))
      .filter(({ config }) => !!config);

    if (eligibleInstruments.length === 0) {
      return { success: false, advice: null, tradesPlaced: [], message: "No enabled instruments available." };
    }

    // -------------------------------------------------------------------------
    // AUTONOMOUS MODE: fetch bars + use Claude's own strategy (no DTR context)
    // -------------------------------------------------------------------------
    if (this.claudeAutonomousMode) {
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 30 * 60 * 1000);

      const withBars = await Promise.all(
        eligibleInstruments.map(async ({ state, config }) => {
          let recentBars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];
          if (state.contractId && this.client) {
            try {
              const bars = await this.client.getBars(state.contractId, windowStart, windowEnd);
              recentBars = bars.map((b) => ({
                t: new Date(b.t).toISOString(),
                o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
              }));
              if (recentBars.length > 0) state.lastPrice = recentBars[recentBars.length - 1].c;
            } catch {
              // non-fatal
            }
          }
          return { state, config, recentBars };
        })
      );

      let advice: ClaudeAdvice;
      try {
        advice = await getClaudeAutonomousAdvice(
          withBars,
          this.dailyPnl,
          this.effectiveLossLimit(),
          this.effectiveProfitTarget()
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "Claude autonomous advisor error");
        return { success: false, advice: null, tradesPlaced: [], message: `Claude analysis failed: ${msg}` };
      }

      logger.info({ summary: advice.summary, decisions: advice.decisions }, "Claude autonomous advice (manual trigger)");

      const tradesPlaced: string[] = [];

      for (const decision of advice.decisions) {
        const state = this.instrumentStates.get(decision.symbol);
        const config = this.getEffectiveConfig(decision.symbol);
        if (!state || !config || !state.contractId) continue;

        if (decision.action === "close") {
          if (!state.inPosition) continue;
          try {
            await this.client!.closePositionForContract(state.contractId);
            tradesPlaced.push(`${decision.symbol} CLOSED`);
          } catch (err) {
            logger.error({ err, symbol: decision.symbol }, "Failed to close position (autonomous manual)");
          }
          continue;
        }

        if (decision.action === "skip") continue;
        if (state.inPosition) continue;
        if (state.todayTrades >= this.effectiveMaxTrades(decision.symbol)) continue;
        if (this.dailyPnl <= -this.effectiveLossLimit()) continue;

        const isBuy = decision.action === "long";
        const price = state.lastPrice;
        if (!price) continue;

        const stopDist = price * 0.005;
        const stopPrice = isBuy ? price - stopDist : price + stopDist;
        const tp1Price  = isBuy ? price + stopDist * 2 : price - stopDist * 2;

        try {
          const orderResult = await this.client!.placeBracketOrder({
            contractId: state.contractId,
            isBuy,
            qty: config.qty,
            stopPrice,
            tp1Price,
          });

          const [trade] = await db
            .insert(tradesTable)
            .values({
              instrument: decision.symbol,
              direction: decision.action,
              entryPrice: price,
              exitPrice: null,
              qty: config.qty,
              pnl: null,
              stopPrice,
              tp1Price,
              tp2Price: null,
              session: "ny",
              status: "open",
              projectxOrderId: orderResult.orderId,
              entryTime: new Date(),
              exitTime: null,
              strategy: "claude",
            })
            .returning();

          state.inPosition = true;
          state.positionDirection = decision.action as "long" | "short";
          state.positionQty = config.qty;
          state.positionEntryPrice = price;
          state.positionOpenedAt = new Date().toISOString();
          state.openTradeId = trade.id;
          state.todayTrades++;
          this.tradeCount++;

          tradesPlaced.push(`${decision.symbol} ${decision.action.toUpperCase()}`);
          logger.info({ symbol: decision.symbol, action: decision.action }, "Claude autonomous manual trade placed");
          this.sendTelegram(
            `🧠 <b>TRADE ENTERED</b> · DeclanCapital FX\n\n` +
            `<b>${config.name ?? decision.symbol}</b> (${decision.symbol})\n` +
            `<b>Direction:</b> ${decision.action.toUpperCase()}\n` +
            `<b>Qty:</b> ${config.qty}\n` +
            `<b>Entry:</b> ${price.toFixed(2)}\n` +
            `<b>Stop:</b> ${stopPrice.toFixed(2)}\n` +
            `<b>TP1:</b> ${tp1Price.toFixed(2)}\n` +
            `<b>TP2:</b> —\n` +
            `<b>Mode:</b> Claude AI (Manual)\n` +
            `<b>Reasoning:</b> ${decision.reasoning ?? "—"}\n` +
            `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
            `<i>${new Date().toUTCString()}</i>`
          ).catch(() => {});
        } catch (err) {
          logger.error({ err, symbol: decision.symbol }, "Error placing autonomous manual trade");
        }
      }

      await this.updateDailySummary();

      return {
        success: true,
        advice,
        tradesPlaced,
        message: tradesPlaced.length > 0
          ? `Placed ${tradesPlaced.length} trade(s): ${tradesPlaced.join(", ")}`
          : "Claude analysed the market but recommended no trades at this time.",
      };
    }

    // -------------------------------------------------------------------------
    // DTR RULES MODE: use range data for stops/targets
    // -------------------------------------------------------------------------

    // Update last prices before sending to Claude
    for (const { state } of eligibleInstruments) {
      if (state.contractId) {
        try {
          const p = await this.client.getLastPrice(state.contractId);
          if (p !== null) state.lastPrice = p;
        } catch {
          // non-fatal
        }
      }
    }

    let advice: ClaudeAdvice;
    try {
      advice = await getClaudeTradeAdvice(eligibleInstruments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "Claude advisor error");
      return { success: false, advice: null, tradesPlaced: [], message: `Claude analysis failed: ${msg}` };
    }

    logger.info({ summary: advice.summary, decisions: advice.decisions }, "Claude DTR advice received");

    const tradesPlaced: string[] = [];

    for (const decision of advice.decisions) {
      if (decision.action === "skip") continue;

      const state = this.instrumentStates.get(decision.symbol);
      const config = this.getEffectiveConfig(decision.symbol);
      if (!state || !config || !state.contractId) continue;
      if (state.inPosition) {
        logger.info({ symbol: decision.symbol }, "Skipping Claude trade — already in position");
        continue;
      }
      if (!state.rangeData) {
        logger.info({ symbol: decision.symbol }, "Skipping Claude trade — no range data");
        continue;
      }
      if (state.todayTrades >= this.effectiveMaxTrades(decision.symbol)) {
        logger.info({ symbol: decision.symbol }, "Skipping Claude trade — max trades reached");
        continue;
      }
      if (this.dailyPnl <= -this.effectiveLossLimit()) {
        logger.warn("Skipping Claude trade — daily loss limit hit");
        continue;
      }

      const { rangeData } = state;
      const isBuy = decision.action === "long";
      const entryPrice = state.lastPrice ?? (isBuy ? rangeData.high : rangeData.low);
      const stopPrice = isBuy ? rangeData.low : rangeData.high;
      const tp1Price = isBuy
        ? rangeData.high + rangeData.width * 0.5
        : rangeData.low - rangeData.width * 0.5;
      const tp2Price = isBuy
        ? rangeData.high + rangeData.width
        : rangeData.low - rangeData.width;

      try {
        const orderResult = await this.client.placeBracketOrder({
          contractId: state.contractId,
          isBuy,
          qty: config.qty,
          stopPrice,
          tp1Price,
          tp2Price,
        });

        const session = this.sessionPhase.startsWith("london") ? "london" : "ny";

        const [trade] = await db
          .insert(tradesTable)
          .values({
            instrument: decision.symbol,
            direction: decision.action,
            entryPrice,
            exitPrice: null,
            qty: config.qty,
            pnl: null,
            session: session as "london" | "ny",
            status: "open",
            entryTime: new Date(),
            exitTime: null,
            stopPrice,
            tp1Price,
            tp2Price,
            projectxOrderId: orderResult.orderId,
            strategy: this.claudeAutonomousMode ? "claude" : "dtr",
          })
          .returning();

        state.inPosition = true;
        state.positionDirection = decision.action as "long" | "short";
        state.positionQty = config.qty;
        state.positionEntryPrice = entryPrice;
        state.positionOpenedAt = new Date().toISOString();
        state.openTradeId = trade.id;
        state.todayTrades++;
        this.tradeCount++;

        tradesPlaced.push(`${decision.symbol} ${decision.action.toUpperCase()}`);
        logger.info({ symbol: decision.symbol, action: decision.action }, "Claude DTR trade placed");
        this.sendTelegram(
          `📊 <b>TRADE ENTERED</b> · DeclanCapital FX\n\n` +
          `<b>${config.name ?? decision.symbol}</b> (${decision.symbol})\n` +
          `<b>Direction:</b> ${decision.action.toUpperCase()}\n` +
          `<b>Qty:</b> ${config.qty}\n` +
          `<b>Entry:</b> ${entryPrice.toFixed(2)}\n` +
          `<b>Stop:</b> ${stopPrice.toFixed(2)}\n` +
          `<b>TP1:</b> ${tp1Price.toFixed(2)}\n` +
          `<b>TP2:</b> ${tp2Price.toFixed(2)}\n` +
          `<b>Mode:</b> Claude + DTR (Manual)\n` +
          `<b>Reasoning:</b> ${decision.reasoning ?? "—"}\n` +
          `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      } catch (err) {
        logger.error({ err, symbol: decision.symbol }, "Error placing Claude DTR trade");
      }
    }

    await this.updateDailySummary();

    return {
      success: true,
      advice,
      tradesPlaced,
      message: tradesPlaced.length > 0
        ? `Placed ${tradesPlaced.length} trade(s): ${tradesPlaced.join(", ")}`
        : "Claude analysed the market but recommended no trades at this time.",
    };
  }

  async start(): Promise<{ success: boolean; message: string }> {
    if (this.running) {
      return { success: false, message: "Agent is already running" };
    }

    logger.info("Starting DTR trading agent");

    try {
      this.client = getProjectXClient();
      await this.client.authenticate();
      this.authenticatedWithProjectX = true;
      logger.info("Authenticated with ProjectX");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.errorMessage = `Failed to authenticate with ProjectX: ${msg}`;
      logger.error({ err }, this.errorMessage);
      return { success: false, message: this.errorMessage };
    }

    // Load or create today's summary
    await this.loadDailySummary();

    // Cache account info early so seedAccountConfigs can use the name
    try {
      const info = await this.client!.getAccountInfo();
      this.cachedAccountInfo = { balance: info.balance, accountId: info.id, accountName: info.name, canTrade: info.canTrade };
    } catch (err) {
      logger.warn({ err }, "Could not pre-cache account info before seeding");
    }

    // Seed account_configs table on first run
    await this.seedAccountConfigs();

    // Restore the last active account from DB (may differ from the env-var default)
    try {
      const activeRows = await db.select().from(accountConfigsTable).where(eq(accountConfigsTable.isActive, true)).limit(1);
      if (activeRows.length > 0) {
        const activeAccountId = activeRows[0].accountId;
        const envAccountId = parseInt(process.env.PROJECTX_ACCOUNT_ID ?? "0", 10);
        if (activeAccountId !== envAccountId) {
          logger.info({ activeAccountId, envAccountId }, "Restoring last active account from DB (differs from env var)");
          this.client!.setAccountId(activeAccountId);
          // Refresh cached account info for the restored account
          try {
            const info = await this.client!.getAccountInfo();
            this.cachedAccountInfo = { balance: info.balance, accountId: info.id, accountName: info.name, canTrade: info.canTrade };
            logger.info({ accountId: info.id, accountName: info.name }, "Active account restored from DB");
          } catch (err) {
            logger.error({ err, activeAccountId }, "Could not fetch account info after restoring from DB — check account ID");
          }
        } else {
          logger.info({ activeAccountId }, "Active account in DB matches env var — no switch needed");
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to restore active account from DB — using env var default");
    }

    // Seed DB with static instruments if first run, then load from DB
    await this.seedInstrumentConfigs();
    await this.loadInstrumentConfigsFromDb();

    // Resolve contract IDs for all instruments
    await this.resolveContractIds();

    // Reconcile in-flight trades and positions from DB + broker on startup
    await this.reconcileOnStartup();

    this.running = true;
    this.errorMessage = null;

    // Cache account info after successful authentication
    try {
      const info = await this.client!.getAccountInfo();
      this.cachedAccountInfo = { balance: info.balance, accountId: info.id, accountName: info.name, canTrade: info.canTrade };
      logger.info({ balance: info.balance, accountName: info.name }, "Account info cached");
    } catch (err) {
      logger.warn({ err }, "Could not cache account info on start");
    }

    // Start the tick loop
    this.tickInterval = setInterval(() => {
      this.tick().catch((err) => {
        logger.error({ err }, "Error in agent tick");
        this.errorMessage = err instanceof Error ? err.message : String(err);
      });
    }, 30_000);

    // Run first tick immediately
    this.tick().catch((err) => {
      logger.error({ err }, "Error in first agent tick");
    });

    logger.info("DTR trading agent started");
    const modeLabel = this.claudeAutonomousMode ? "Claude AI" : "DTR Rules";
    this.sendTelegram(
      `🚀 <b>DeclanCapital FX Agent Started</b>\n\n` +
      `<b>Mode:</b> ${modeLabel}\n` +
      `<b>Account:</b> ${this.cachedAccountInfo?.accountName ?? "—"}\n` +
      `<b>Balance:</b> $${this.cachedAccountInfo?.balance?.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}\n` +
      `<i>${new Date().toUTCString()}</i>`
    ).catch(() => {});
    return { success: true, message: "Agent started successfully" };
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    if (!this.running) {
      return { success: false, message: "Agent is not running" };
    }

    logger.info("Stopping DTR trading agent");

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    this.running = false;
    this.sessionPhase = "idle";
    logger.info("DTR trading agent stopped");
    this.sendTelegram(
      `⏹ <b>DeclanCapital FX Agent Stopped</b>\n\n` +
      `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
      `<b>Trades today:</b> ${this.tradeCount}\n` +
      `<i>${new Date().toUTCString()}</i>`
    ).catch(() => {});

    return { success: true, message: "Agent stopped successfully" };
  }

  getStatus(): AgentStatusData {
    return {
      running: this.running,
      sessionPhase: this.sessionPhase,
      dailyPnl: this.dailyPnl,
      dailyLossLimit: this.effectiveLossLimit(),
      dailyProfitTarget: this.effectiveProfitTarget(),
      tradeCount: this.tradeCount,
      lastUpdated: this.lastUpdated,
      authenticatedWithProjectX: this.authenticatedWithProjectX,
      errorMessage: this.errorMessage,
      claudeAutonomousMode: this.claudeAutonomousMode,
      lastClaudeAutonomousTick:
        this.lastClaudeAutonomousTick > 0
          ? new Date(this.lastClaudeAutonomousTick).toISOString()
          : null,
    };
  }

  getInstrumentStatuses(): InstrumentStatusData[] {
    return Array.from(this.instrumentStates.values()).map((state) => {
      const config = this.getEffectiveConfig(state.symbol);
      // Find matching open position from cache
      const openPos = this.openPositionsCache.find(
        (p) => state.contractId !== null && p.contractId === state.contractId
      );
      let unrealizedPnl: number | null = null;
      if (openPos && state.lastPrice && state.positionEntryPrice && config) {
        const dir = state.positionDirection;
        if (dir) {
          const priceDiff =
            dir === "long"
              ? state.lastPrice - state.positionEntryPrice
              : state.positionEntryPrice - state.lastPrice;
          unrealizedPnl = priceDiff * state.positionQty * config.pointValue;
        }
      }

      return {
        symbol: state.symbol,
        name: config?.name ?? state.symbol,
        enabled: this.isInstrumentEnabled(state.symbol),
        position: state.positionDirection,
        positionSize: state.positionQty,
        entryPrice: state.positionEntryPrice,
        unrealizedPnl,
        positionOpenedAt: state.positionOpenedAt,
        todayPnl: 0, // computed from DB on demand
        todayTrades: state.todayTrades,
        longLosses: state.longLosses,
        shortLosses: state.shortLosses,
        rangeHigh: state.rangeData?.high ?? null,
        rangeLow: state.rangeData?.low ?? null,
        lastPrice: state.lastPrice,
      };
    });
  }

  /**
   * Returns instrument statuses with a fresh broker position fetch.
   * Used by the /positions endpoint to avoid serving stale cache data.
   * Falls back to cached data when the agent is not running or fetch fails.
   */
  async getInstrumentStatusesWithFresh(): Promise<InstrumentStatusData[]> {
    if (this.client && this.running) {
      try {
        this.previousPositionsCache = this.openPositionsCache;
        this.openPositionsCache = await this.client.getOpenPositions();
        this.lastPositionFetch = Date.now();
        // Sync position states based on fresh data
        await this.syncPositionStates();
      } catch (err) {
        logger.warn({ err }, "Failed to fetch fresh positions for /positions endpoint — using cache");
      }
    }
    return this.getInstrumentStatuses();
  }

  /**
   * Manually close an open position for a given instrument symbol.
   * Requires the agent to be running (needs an active ProjectX client).
   */
  async closePositionForSymbol(symbol: string): Promise<{ success: boolean; message: string }> {
    const state = this.instrumentStates.get(symbol);
    if (!state) {
      return { success: false, message: `Unknown instrument: ${symbol}` };
    }
    if (!state.contractId) {
      return { success: false, message: `No contract ID resolved for ${symbol} — agent may not be running` };
    }
    if (!this.client) {
      return { success: false, message: "Agent is not running — cannot close position" };
    }
    try {
      await this.client.closePositionForContract(state.contractId);
      logger.info({ symbol }, "Manual position close requested");
      return { success: true, message: `Close order sent for ${symbol}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, symbol }, "Failed to manually close position");
      return { success: false, message: `Failed to close ${symbol}: ${msg}` };
    }
  }

  private async resolveContractIds(): Promise<void> {
    if (!this.client) return;
    // DB is sole source of truth — only resolve IDs for DB-configured instruments
    const symbols = Array.from(this.dbConfigs.keys());
    for (const symbol of symbols) {
      try {
        const contractId = await this.client.getContractId(symbol);
        const state = this.instrumentStates.get(symbol);
        if (state) {
          state.contractId = contractId;
          if (contractId) {
            logger.info({ symbol, contractId }, "Resolved contract ID");
          } else {
            logger.warn({ symbol }, "Could not resolve contract ID");
          }
        }
      } catch (err) {
        logger.error({ err, symbol }, "Error resolving contract ID");
      }
    }
  }

  /**
   * On startup, reconcile any open trades in the DB against live broker positions
   * AND rebuild per-instrument counters (todayTrades, longLosses, shortLosses) from
   * today's closed trades. This ensures daily caps remain enforced after a restart.
   */
  private async reconcileOnStartup(): Promise<void> {
    if (!this.client) return;
    logger.info("Reconciling positions on startup");

    try {
      // Fetch live positions from broker
      const livePositions = await this.client.getOpenPositions();
      this.openPositionsCache = livePositions;
      this.previousPositionsCache = livePositions;
      this.lastPositionFetch = Date.now();

      const today = this.currentDate;

      // -----------------------------------------------------------------------
      // Rebuild per-instrument counters from today's closed trades in the DB.
      // This preserves daily caps (maxTradesPerDay, maxLossesPerDirection)
      // across process restarts.
      // -----------------------------------------------------------------------
      const closedTrades = await db
        .select()
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.status, "closed"),
            sql`date(entry_time) = ${today}`
          )
        );

      for (const trade of closedTrades) {
        const state = this.instrumentStates.get(trade.instrument);
        if (!state) continue;
        state.todayTrades++;
        if ((trade.pnl ?? 0) < 0) {
          if (trade.direction === "long") state.longLosses++;
          else if (trade.direction === "short") state.shortLosses++;
        }
      }

      logger.info(
        { closedCount: closedTrades.length },
        "Rebuilt per-instrument counters from today's closed trades"
      );

      // Find any open trades in the DB for today
      const openTrades = await db
        .select()
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.status, "open"),
            sql`date(entry_time) = ${today}`
          )
        );

      for (const trade of openTrades) {
        const state = this.instrumentStates.get(trade.instrument);
        if (!state || !state.contractId) continue;

        const livePos = livePositions.find(
          (p) => p.contractId === state.contractId
        );

        if (livePos && livePos.size !== 0) {
          // Still open on broker — restore state (also count this trade toward today's cap)
          state.inPosition = true;
          state.positionDirection = livePos.size > 0 ? "long" : "short";
          state.positionQty = Math.abs(livePos.size);
          state.positionEntryPrice = trade.entryPrice;
          state.positionOpenedAt = trade.entryTime.toISOString();
          state.openTradeId = trade.id;
          state.todayTrades++; // count this open trade toward the daily cap
          logger.info(
            { symbol: trade.instrument, tradeId: trade.id },
            "Restored open trade state from DB"
          );
        } else {
          // Position closed on broker but not in DB — mark it closed with last price
          const pnl = livePos?.realizedPnl ?? 0;
          await db
            .update(tradesTable)
            .set({
              status: "closed",
              exitPrice: trade.entryPrice,
              exitTime: new Date(),
              pnl,
            })
            .where(eq(tradesTable.id, trade.id));

          this.dailyPnl += pnl;
          logger.info(
            { symbol: trade.instrument, tradeId: trade.id, pnl },
            "Closed orphaned trade found on startup"
          );
        }
      }

      logger.info("Startup reconciliation complete");
    } catch (err) {
      logger.error({ err }, "Error during startup reconciliation");
    }
  }

  private async loadDailySummary(): Promise<void> {
    const today = currentNYDate();
    this.currentDate = today;

    const existing = await db
      .select()
      .from(dailySummaryTable)
      .where(eq(dailySummaryTable.date, today))
      .limit(1);

    if (existing.length > 0) {
      this.dailyPnl = existing[0].totalPnl;
      this.tradeCount = existing[0].tradeCount;
      logger.info({ date: today, dailyPnl: this.dailyPnl }, "Loaded daily summary");
    } else {
      await db.insert(dailySummaryTable).values({
        date: today,
        totalPnl: 0,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        status: "active",
        londonPnl: 0,
        nyPnl: 0,
        updatedAt: new Date(),
      });
      this.dailyPnl = 0;
      this.tradeCount = 0;
      logger.info({ date: today }, "Created new daily summary");
    }
  }

  private async checkDayRollover(): Promise<void> {
    const today = currentNYDate();
    if (today !== this.currentDate) {
      logger.info({ newDate: today }, "Day rollover detected, resetting state");
      this.currentDate = today;
      this.dailyPnl = 0;
      this.tradeCount = 0;
      this.sessionPhase = "idle";

      // Clear the trading lock on day rollover so a new session can trade
      if (this.runtimeSettings.tradingLocked) {
        this.runtimeSettings.tradingLocked = false;
        logger.info("Trading lock cleared on day rollover");
      }

      // Reset instrument states for all DB-managed symbols
      const symbols = Array.from(this.dbConfigs.keys());
      for (const symbol of symbols) {
        this.instrumentStates.set(symbol, {
          ...createInstrumentState(symbol),
          contractId: this.instrumentStates.get(symbol)?.contractId ?? null,
        });
      }

      await this.loadDailySummary();
    }
  }

  /**
   * Returns the latest sessionEnd across all enabled DTR instruments in DB.
   * This drives the NY entry window so new instruments with later sessions work correctly.
   * Falls back to "14:00" if no DTR instruments are configured.
   */
  private getNyEntryEnd(): string {
    let latest = "14:00";
    for (const row of this.dbConfigs.values()) {
      if (!row.enabled) continue;
      if (row.strategyMode === "atr_pullback") continue;
      if (row.sessionEnd > latest) latest = row.sessionEnd;
    }
    return latest;
  }

  private getCurrentPhase(): SessionPhase {
    // London range: 01:12–02:13
    if (isInTimeWindow("01:12", "02:13")) return "london_range";
    // London entry: 03:13–07:00
    if (isInTimeWindow("03:13", "07:00")) return "london_entry";
    // NY range: 08:12–09:13
    if (isInTimeWindow("08:12", "09:13")) return "ny_range";
    // NY entry: 09:13 until the latest sessionEnd across all enabled DTR instruments (from DB).
    // Per-instrument DB session windows are the primary gate within this broader phase.
    const nyEntryEnd = this.getNyEntryEnd();
    if (isInTimeWindow("09:13", nyEntryEnd)) return "ny_entry";
    // EOD flat: from nyEntryEnd until 21:00 (close out all remaining positions)
    if (isInTimeWindow(nyEntryEnd, "21:00")) return "eod_flat";
    return "idle";
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.client) return;

    await this.checkDayRollover();

    // Refresh DB instrument configs every 5 minutes
    if (Date.now() - this.lastDbConfigRefresh > this.DB_CONFIG_REFRESH_INTERVAL_MS) {
      await this.loadInstrumentConfigsFromDb();
    }

    this.lastUpdated = new Date().toISOString();

    // Guard: do not process trading sessions on non-trading days (weekends)
    const todayDow = currentNYDayOfWeek();
    if (!TRADING_CONFIG.tradingDays.includes(todayDow)) {
      if (this.sessionPhase !== "idle") {
        logger.debug({ todayDow }, "Non-trading day — skipping session processing");
        this.sessionPhase = "idle";
      }
      return;
    }

    // Check trading lock (manual dashboard lock)
    if (this.runtimeSettings.tradingLocked) {
      this.sessionPhase = "daily_limit_hit";
      return;
    }

    // Check daily limits
    if (this.dailyPnl <= -this.effectiveLossLimit()) {
      if (this.sessionPhase !== "daily_limit_hit") {
        logger.warn({ dailyPnl: this.dailyPnl }, "Daily loss limit hit, stopping trading");
        this.sessionPhase = "daily_limit_hit";
        await this.flattenAllPositions("loss_limit_hit");
        this.sendTelegram(
          `🚨 <b>DAILY LOSS LIMIT HIT</b> · DeclanCapital FX\n\n` +
          `<b>Daily P&amp;L:</b> $${this.dailyPnl.toFixed(2)}\n` +
          `<b>Limit:</b> -$${this.effectiveLossLimit()}\n` +
          `<b>All trading halted.</b>\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      }
      return;
    }

    if (this.dailyPnl >= this.effectiveProfitTarget()) {
      if (this.sessionPhase !== "daily_limit_hit") {
        logger.info({ dailyPnl: this.dailyPnl }, "Daily profit target hit, stopping trading");
        this.sessionPhase = "daily_limit_hit";
        await this.flattenAllPositions("profit_target_hit");
        this.sendTelegram(
          `🎯 <b>DAILY PROFIT TARGET HIT</b> · DeclanCapital FX\n\n` +
          `<b>Daily P&amp;L:</b> +$${this.dailyPnl.toFixed(2)}\n` +
          `<b>Target:</b> +$${this.effectiveProfitTarget()}\n` +
          `<b>All trading halted — great day!</b>\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      }
      return;
    }

    // Fetch open positions cache every 2 ticks (60s)
    const now = Date.now();
    if (now - this.lastPositionFetch > 60_000) {
      try {
        this.previousPositionsCache = this.openPositionsCache;
        this.openPositionsCache = await this.client.getOpenPositions();
        this.lastPositionFetch = now;
        await this.syncPositionStates();
      } catch (err) {
        logger.error({ err }, "Failed to fetch open positions");
      }
    }

    // --- CLAUDE AUTONOMOUS MODE: bypass all DTR rules ---
    if (this.claudeAutonomousMode) {
      this.sessionPhase = "idle"; // phase not meaningful in this mode
      await this.autonomousTick();
      return;
    }

    // --- DTR RULES MODE ---
    const phase = this.getCurrentPhase();
    this.sessionPhase = phase;

    switch (phase) {
      case "london_range":
      case "ny_range":
        await this.processRangePhase(phase === "london_range" ? "london" : "ny");
        break;

      case "london_entry":
        await this.processEntryPhase("london");
        break;

      case "ny_entry":
        await this.processEntryPhase("ny");
        break;

      case "eod_flat":
        await this.processEodFlat();
        break;

      case "idle":
        // Nothing to do outside trading hours
        break;
    }

    // ATR Pullback strategy runs independently for US30 + Nas100 (09:30–15:30 NY)
    await this.processAtrPullbackSignals();
  }

  /**
   * CCHOAS21 ATR Volume Pullback — runs for instruments with strategyMode="atr_pullback".
   * Session window comes from each instrument's DB sessionStart/sessionEnd.
   */
  private async processAtrPullbackSignals(): Promise<void> {
    if (!this.client) return;

    for (const [symbol, state] of this.instrumentStates) {
      const config = this.getEffectiveConfig(symbol);
      if (config?.strategyMode !== "atr_pullback") continue;
      // Per-instrument session window from DB is the primary gate for ATR pullback
      if (!isInTimeWindow(config.sessionStart, config.sessionEnd)) continue;
      if (!this.isInstrumentEnabled(symbol)) continue;
      if (!state.contractId) continue;
      if (state.inPosition) continue;
      if (state.todayTrades >= this.effectiveMaxTrades(symbol)) continue;

      try {
        // Fetch last 8 hours of 1-min bars (covers EMA200 warm-up)
        const now = new Date();
        const startTime = new Date(now.getTime() - 8 * 60 * 60 * 1000);
        const bars = await this.client.getBars(state.contractId, startTime, now);

        if (bars.length === 0) continue;

        // Update last price from the most recent bar
        const lastBar = bars[bars.length - 1];
        state.lastPrice = lastBar.c;

        // Deduplicate: don't fire twice on the same 1-minute bar
        const lastBarTs = lastBar.t;
        if (this.lastAtrSignalBarTs.get(symbol) === lastBarTs) continue;

        const signal = checkAtrPullbackSignal(bars, state.todayTrades, DEFAULT_ATR_PULLBACK_PARAMS);
        if (!signal) continue;

        // Mark this bar as fired
        this.lastAtrSignalBarTs.set(symbol, lastBarTs);

        logger.info({ symbol, signal }, "ATR Pullback signal detected, placing order");

        const orderResult = await this.client.placeBracketOrder({
          contractId: state.contractId,
          isBuy: signal.direction === "long",
          qty: config.qty,
          stopPrice: signal.stopPrice,
          tp1Price: signal.tp1Price,
        });

        // Record in DB
        const [trade] = await db
          .insert(tradesTable)
          .values({
            instrument: symbol,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            exitPrice: null,
            qty: config.qty,
            pnl: null,
            session: "ny",
            status: "open",
            entryTime: new Date(),
            exitTime: null,
            stopPrice: signal.stopPrice,
            tp1Price: signal.tp1Price,
            tp2Price: null,
            projectxOrderId: orderResult.orderId,
            strategy: "dtr", // tagged "dtr" because this is a rule-based strategy (not Claude)
          })
          .returning();

        state.inPosition = true;
        state.positionDirection = signal.direction;
        state.positionQty = config.qty;
        state.positionEntryPrice = signal.entryPrice;
        state.positionOpenedAt = new Date().toISOString();
        state.openTradeId = trade.id;
        state.todayTrades++;

        this.tradeCount++;
        await this.updateDailySummary();

        this.sendTelegram(
          `📈 <b>TRADE ENTERED</b> · DeclanCapital FX\n\n` +
          `<b>${config.name ?? symbol}</b> (${symbol})\n` +
          `<b>Strategy:</b> ATR Volume Pullback (CCHOAS21)\n` +
          `<b>Direction:</b> ${signal.direction.toUpperCase()}\n` +
          `<b>Qty:</b> ${config.qty}\n` +
          `<b>Entry:</b> ${signal.entryPrice.toFixed(2)}\n` +
          `<b>Stop:</b> ${signal.stopPrice.toFixed(2)}\n` +
          `<b>TP:</b> ${signal.tp1Price.toFixed(2)}\n` +
          `<b>ATR:</b> ${signal.atr.toFixed(2)}\n` +
          `<b>Session:</b> NY\n` +
          `<b>Mode:</b> ATR Pullback Rules\n` +
          `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      } catch (err) {
        logger.error({ err, symbol }, "Error processing ATR pullback signal");
      }
    }
  }

  private async processRangePhase(session: "london" | "ny"): Promise<void> {
    if (!this.client) return;
    const rangeStart = session === "london" ? "01:12" : "08:12";
    const rangeEnd = session === "london" ? "02:13" : "09:13";

    for (const [symbol, state] of this.instrumentStates) {
      if (!this.isInstrumentEnabled(symbol)) continue;
      if (!state.contractId) continue;
      // ATR pullback instruments don't use the DTR range phase
      if (this.getEffectiveConfig(symbol)?.strategyMode === "atr_pullback") continue;

      try {
        // Convert NY wall-clock session boundaries to UTC (DST-safe)
        const startUtc = todayAtNY(rangeStart);
        const endUtc = todayAtNY(rangeEnd);

        const bars = await this.client.getBars(state.contractId, startUtc, endUtc);
        const rangeData = computeRange(bars);

        if (rangeData) {
          state.rangeData = rangeData;
          logger.debug(
            { symbol, high: rangeData.high, low: rangeData.low, bias: rangeData.bias },
            "Range computed"
          );
        }

        // Update last price
        const lastPrice = await this.client.getLastPrice(state.contractId);
        if (lastPrice !== null) state.lastPrice = lastPrice;
      } catch (err) {
        logger.error({ err, symbol }, "Error computing range");
      }
    }
  }

  private async processEntryPhase(session: "london" | "ny"): Promise<void> {
    if (!this.client) return;

    for (const [symbol, state] of this.instrumentStates) {
      const config = this.getEffectiveConfig(symbol);
      if (!this.isInstrumentEnabled(symbol)) continue;
      if (!state.contractId) continue;
      // ATR pullback instruments are handled by processAtrPullbackSignals, not DTR entry phase
      if (config?.strategyMode === "atr_pullback") continue;
      if (!state.rangeData) continue;
      if (state.inPosition) continue;
      if (state.todayTrades >= this.effectiveMaxTrades(symbol)) continue;
      // Per-instrument session window from DB is the primary gate for NY entry
      if (session === "ny" && config) {
        if (!isInTimeWindow(config.sessionStart, config.sessionEnd)) continue;
      }

      // Build effective config — runtime overrides fully replace config values when set
      const effectiveConfig = {
        ...config,
        maxLossesPerDirection: this.effectiveMaxLossesPerDirection(symbol),
      };

      try {
        const lastPrice = await this.client.getLastPrice(state.contractId);
        if (!lastPrice) continue;
        state.lastPrice = lastPrice;

        const signal = checkEntrySignal(lastPrice, state.rangeData, state, effectiveConfig);
        if (!signal) continue;

        logger.info({ symbol, signal }, "Entry signal detected, placing order");

        // Place bracket order
        const orderResult = await this.client.placeBracketOrder({
          contractId: state.contractId,
          isBuy: signal.direction === "long",
          qty: config.qty,
          stopPrice: signal.stopPrice,
          tp1Price: signal.tp1Price,
          tp2Price: signal.tp2Price,
        });

        // Record trade in DB
        const [trade] = await db
          .insert(tradesTable)
          .values({
            instrument: symbol,
            direction: signal.direction,
            entryPrice: signal.entryPrice,
            exitPrice: null,
            qty: config.qty,
            pnl: null,
            session,
            status: "open",
            entryTime: new Date(),
            exitTime: null,
            stopPrice: signal.stopPrice,
            tp1Price: signal.tp1Price,
            tp2Price: signal.tp2Price,
            projectxOrderId: orderResult.orderId,
            strategy: "dtr",
          })
          .returning();

        // Update instrument state
        state.inPosition = true;
        state.positionDirection = signal.direction;
        state.positionQty = config.qty;
        state.positionEntryPrice = signal.entryPrice;
        state.positionOpenedAt = new Date().toISOString();
        state.openTradeId = trade.id;
        state.todayTrades++;

        this.tradeCount++;
        await this.updateDailySummary();

        this.sendTelegram(
          `📈 <b>TRADE ENTERED</b> · DeclanCapital FX\n\n` +
          `<b>${config.name ?? symbol}</b> (${symbol})\n` +
          `<b>Direction:</b> ${signal.direction.toUpperCase()}\n` +
          `<b>Qty:</b> ${config.qty}\n` +
          `<b>Entry:</b> ${signal.entryPrice.toFixed(2)}\n` +
          `<b>Stop:</b> ${signal.stopPrice.toFixed(2)}\n` +
          `<b>TP1:</b> ${signal.tp1Price.toFixed(2)}\n` +
          `<b>TP2:</b> ${signal.tp2Price != null ? signal.tp2Price.toFixed(2) : "—"}\n` +
          `<b>Session:</b> ${session.toUpperCase()}\n` +
          `<b>Mode:</b> DTR Rules\n` +
          `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
          `<i>${new Date().toUTCString()}</i>`
        ).catch(() => {});
      } catch (err) {
        logger.error({ err, symbol }, "Error processing entry signal");
      }
    }
  }

  private async processEodFlat(): Promise<void> {
    if (!this.client) return;
    await this.flattenAllPositions("ended");
  }

  private async flattenAllPositions(
    summaryStatus: "profit_target_hit" | "loss_limit_hit" | "ended"
  ): Promise<void> {
    if (!this.client) return;
    logger.info({ summaryStatus }, "Flattening all positions");

    for (const [symbol, state] of this.instrumentStates) {
      if (!state.contractId) continue;
      if (!state.inPosition) continue;

      try {
        await this.client.closePositionForContract(state.contractId);

        // Mark trade as closed
        if (state.openTradeId) {
          const lastPrice = state.lastPrice ?? state.positionEntryPrice ?? 0;
          const flatCfg = this.getEffectiveConfig(symbol);
          const pnl = state.positionDirection && state.positionEntryPrice
            ? calculatePnl(
                state.positionDirection,
                state.positionEntryPrice,
                lastPrice,
                state.positionQty,
                flatCfg?.pointValue ?? 10
              )
            : 0;

          await db
            .update(tradesTable)
            .set({
              status: "closed",
              exitPrice: lastPrice,
              exitTime: new Date(),
              pnl,
            })
            .where(eq(tradesTable.id, state.openTradeId));

          this.dailyPnl += pnl;

          const instName = flatCfg?.name ?? symbol;
          const closedDir = state.positionDirection;
          this.sendTelegram(
            `${pnl >= 0 ? "✅" : "❌"} <b>TRADE CLOSED (FORCED)</b> · DeclanCapital FX\n\n` +
            `<b>${instName}</b> (${symbol})\n` +
            `<b>Direction:</b> ${(closedDir ?? "").toUpperCase()}\n` +
            `<b>Exit:</b> ${lastPrice.toFixed(2)}\n` +
            `<b>P&amp;L:</b> <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>\n` +
            `<b>Reason:</b> ${summaryStatus.replace(/_/g, " ").toUpperCase()}\n` +
            `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
            `<i>${new Date().toUTCString()}</i>`
          ).catch(() => {});
        }

        state.inPosition = false;
        state.positionDirection = null;
        state.positionQty = 0;
        state.positionEntryPrice = null;
        state.positionOpenedAt = null;
        state.openTradeId = null;
      } catch (err) {
        logger.error({ err, symbol }, "Error flattening position");
      }
    }

    try {
      await this.client.cancelAllOrders();
    } catch (err) {
      logger.error({ err }, "Error cancelling orders");
    }

    await this.updateDailySummary(summaryStatus);
  }

  private async syncPositionStates(): Promise<void> {
    for (const [symbol, state] of this.instrumentStates) {
      if (!state.contractId) continue;
      const pos = this.openPositionsCache.find(
        (p) => p.contractId === state.contractId
      );

      if (pos && pos.size !== 0) {
        state.inPosition = true;
        state.positionDirection = pos.size > 0 ? "long" : "short";
        state.positionQty = Math.abs(pos.size);
        if (!state.positionEntryPrice) {
          state.positionEntryPrice = pos.averagePrice;
        }
      } else if (!pos || pos.size === 0) {
        // Position was closed externally (hit SL or TP)
        if (state.inPosition && state.openTradeId) {
          // Use ProjectX realizedPnl from previous position snapshot if available,
          // otherwise fall back to heuristic calculation from last price.
          const prevPos = this.previousPositionsCache.find(
            (p) => p.contractId === state.contractId
          );
          let pnl: number;
          let exitPrice: number;

          const effConfig = this.getEffectiveConfig(symbol);
          if (prevPos && prevPos.realizedPnl !== undefined && prevPos.realizedPnl !== 0) {
            // Use the broker's realized P&L directly
            pnl = prevPos.realizedPnl;
            exitPrice = state.lastPrice ?? state.positionEntryPrice ?? 0;
          } else if (state.lastPrice && state.positionDirection && state.positionEntryPrice && effConfig) {
            // Fallback: compute from price diff
            exitPrice = state.lastPrice;
            pnl = calculatePnl(
              state.positionDirection,
              state.positionEntryPrice,
              exitPrice,
              state.positionQty,
              effConfig.pointValue
            );
          } else {
            exitPrice = state.positionEntryPrice ?? 0;
            pnl = 0;
          }

          this.dailyPnl += pnl;

          if (pnl < 0) {
            if (state.positionDirection === "long") state.longLosses++;
            else state.shortLosses++;
          }

          await db
            .update(tradesTable)
            .set({
              status: "closed",
              exitPrice,
              exitTime: new Date(),
              pnl,
            })
            .where(
              and(
                eq(tradesTable.id, state.openTradeId),
                eq(tradesTable.status, "open")
              )
            );

          await this.updateDailySummary();

          logger.info({ symbol, pnl, exitPrice, direction: state.positionDirection }, "Trade closed");

          const closedDir = state.positionDirection;
          const instName = this.getEffectiveConfig(symbol)?.name ?? symbol;
          this.sendTelegram(
            `${pnl >= 0 ? "✅" : "❌"} <b>TRADE CLOSED</b> · DeclanCapital FX\n\n` +
            `<b>${instName}</b> (${symbol})\n` +
            `<b>Direction:</b> ${(closedDir ?? "").toUpperCase()}\n` +
            `<b>Exit:</b> ${exitPrice.toFixed(2)}\n` +
            `<b>P&amp;L:</b> <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b>\n` +
            `<b>Daily P&amp;L:</b> ${this.dailyPnl >= 0 ? "+" : ""}$${this.dailyPnl.toFixed(2)}\n` +
            `<i>${new Date().toUTCString()}</i>`
          ).catch(() => {});

          state.inPosition = false;
          state.positionDirection = null;
          state.positionQty = 0;
          state.positionEntryPrice = null;
          state.positionOpenedAt = null;
          state.openTradeId = null;
        }
      }
    }
  }

  private async updateDailySummary(
    status?: "active" | "profit_target_hit" | "loss_limit_hit" | "ended"
  ): Promise<void> {
    const today = this.currentDate;

    // Compute win/loss counts from trades table
    const result = await db
      .select({
        wins: sql<number>`count(*) filter (where pnl > 0)`,
        losses: sql<number>`count(*) filter (where pnl < 0)`,
        londonPnl: sql<number>`coalesce(sum(pnl) filter (where session = 'london'), 0)`,
        nyPnl: sql<number>`coalesce(sum(pnl) filter (where session = 'ny'), 0)`,
      })
      .from(tradesTable)
      .where(
        and(
          sql`date(entry_time) = ${today}`,
          eq(tradesTable.status, "closed")
        )
      );

    const stats = result[0] ?? { wins: 0, losses: 0, londonPnl: 0, nyPnl: 0 };

    await db
      .update(dailySummaryTable)
      .set({
        totalPnl: this.dailyPnl,
        tradeCount: this.tradeCount,
        winCount: Number(stats.wins),
        lossCount: Number(stats.losses),
        status: status ?? "active",
        londonPnl: Number(stats.londonPnl),
        nyPnl: Number(stats.nyPnl),
        updatedAt: new Date(),
      })
      .where(eq(dailySummaryTable.date, today));
  }
}

// Singleton instance
export const agentController = new AgentController();
