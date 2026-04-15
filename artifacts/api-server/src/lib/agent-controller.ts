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
import { TRADING_CONFIG, isInTimeWindow, currentNYDate, todayAtNY } from "./trading-config";
import {
  computeRange,
  checkEntrySignal,
  createInstrumentState,
  calculatePnl,
  type InstrumentState,
} from "./dtr-strategy";
import { db, tradesTable, dailySummaryTable } from "@workspace/db";
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

  constructor() {
    // Initialize instrument states
    for (const symbol of Object.keys(TRADING_CONFIG.instruments)) {
      this.instrumentStates.set(symbol, createInstrumentState(symbol));
    }
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

    // Resolve contract IDs for all instruments
    await this.resolveContractIds();

    // Reconcile in-flight trades and positions from DB + broker on startup
    await this.reconcileOnStartup();

    this.running = true;
    this.errorMessage = null;

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

    return { success: true, message: "Agent stopped successfully" };
  }

  getStatus(): AgentStatusData {
    return {
      running: this.running,
      sessionPhase: this.sessionPhase,
      dailyPnl: this.dailyPnl,
      dailyLossLimit: TRADING_CONFIG.dailyLossLimit,
      dailyProfitTarget: TRADING_CONFIG.dailyProfitTarget,
      tradeCount: this.tradeCount,
      lastUpdated: this.lastUpdated,
      authenticatedWithProjectX: this.authenticatedWithProjectX,
      errorMessage: this.errorMessage,
    };
  }

  getInstrumentStatuses(): InstrumentStatusData[] {
    return Array.from(this.instrumentStates.values()).map((state) => {
      const config = TRADING_CONFIG.instruments[state.symbol];
      // Find matching open position from cache
      const openPos = this.openPositionsCache.find(
        (p) => state.contractId !== null && Number(p.contractId) === state.contractId
      );
      let unrealizedPnl: number | null = null;
      if (openPos && state.lastPrice && state.positionEntryPrice) {
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
        enabled: config?.enabled ?? false,
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

  private async resolveContractIds(): Promise<void> {
    if (!this.client) return;
    for (const symbol of Object.keys(TRADING_CONFIG.instruments)) {
      try {
        const contractId = await this.client.getContractId(symbol);
        const state = this.instrumentStates.get(symbol)!;
        state.contractId = contractId;
        if (contractId) {
          logger.info({ symbol, contractId }, "Resolved contract ID");
        } else {
          logger.warn({ symbol }, "Could not resolve contract ID");
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
          (p) => Number(p.contractId) === state.contractId
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

      // Reset instrument states
      for (const symbol of Object.keys(TRADING_CONFIG.instruments)) {
        this.instrumentStates.set(symbol, {
          ...createInstrumentState(symbol),
          contractId: this.instrumentStates.get(symbol)?.contractId ?? null,
        });
      }

      await this.loadDailySummary();
    }
  }

  private getCurrentPhase(): SessionPhase {
    // London range: 01:12–02:13
    if (isInTimeWindow("01:12", "02:13")) return "london_range";
    // London entry: 03:13–07:00
    if (isInTimeWindow("03:13", "07:00")) return "london_entry";
    // NY range: 08:12–09:13
    if (isInTimeWindow("08:12", "09:13")) return "ny_range";
    // NY entry: 09:13–14:00
    if (isInTimeWindow("09:13", "14:00")) return "ny_entry";
    // EOD flat: 14:00–20:00 (close out)
    if (isInTimeWindow("14:00", "20:00")) return "eod_flat";
    return "idle";
  }

  private async tick(): Promise<void> {
    if (!this.running || !this.client) return;

    await this.checkDayRollover();

    this.lastUpdated = new Date().toISOString();

    // Check daily limits
    if (this.dailyPnl <= -TRADING_CONFIG.dailyLossLimit) {
      if (this.sessionPhase !== "daily_limit_hit") {
        logger.warn({ dailyPnl: this.dailyPnl }, "Daily loss limit hit, stopping trading");
        this.sessionPhase = "daily_limit_hit";
        await this.flattenAllPositions("loss_limit_hit");
      }
      return;
    }

    if (this.dailyPnl >= TRADING_CONFIG.dailyProfitTarget) {
      if (this.sessionPhase !== "daily_limit_hit") {
        logger.info({ dailyPnl: this.dailyPnl }, "Daily profit target hit, stopping trading");
        this.sessionPhase = "daily_limit_hit";
        await this.flattenAllPositions("profit_target_hit");
      }
      return;
    }

    const phase = this.getCurrentPhase();
    this.sessionPhase = phase;

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
  }

  private async processRangePhase(session: "london" | "ny"): Promise<void> {
    if (!this.client) return;
    const rangeStart = session === "london" ? "01:12" : "08:12";
    const rangeEnd = session === "london" ? "02:13" : "09:13";

    for (const [symbol, state] of this.instrumentStates) {
      if (!TRADING_CONFIG.instruments[symbol]?.enabled) continue;
      if (!state.contractId) continue;

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
      const config = TRADING_CONFIG.instruments[symbol];
      if (!config?.enabled) continue;
      if (!state.contractId) continue;
      if (!state.rangeData) continue;
      if (state.inPosition) continue;

      try {
        const lastPrice = await this.client.getLastPrice(state.contractId);
        if (!lastPrice) continue;
        state.lastPrice = lastPrice;

        const signal = checkEntrySignal(lastPrice, state.rangeData, state, config);
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
          const pnl = state.positionDirection && state.positionEntryPrice
            ? calculatePnl(
                state.positionDirection,
                state.positionEntryPrice,
                lastPrice,
                state.positionQty,
                TRADING_CONFIG.instruments[symbol]?.pointValue ?? 10
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
        (p) => Number(p.contractId) === state.contractId
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
            (p) => Number(p.contractId) === state.contractId
          );
          const config = TRADING_CONFIG.instruments[symbol];
          let pnl: number;
          let exitPrice: number;

          if (prevPos && prevPos.realizedPnl !== undefined && prevPos.realizedPnl !== 0) {
            // Use the broker's realized P&L directly
            pnl = prevPos.realizedPnl;
            exitPrice = state.lastPrice ?? state.positionEntryPrice ?? 0;
          } else if (state.lastPrice && state.positionDirection && state.positionEntryPrice && config) {
            // Fallback: compute from price diff
            exitPrice = state.lastPrice;
            pnl = calculatePnl(
              state.positionDirection,
              state.positionEntryPrice,
              exitPrice,
              state.positionQty,
              config.pointValue
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
