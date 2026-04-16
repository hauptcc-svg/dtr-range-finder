import { Router, type IRouter, type Request, type Response } from "express";
import { agentController } from "../lib/agent-controller";
import { logger } from "../lib/logger";
import {
  GetAgentStatusResponse,
  GetInstrumentsResponse,
  StartAgentResponse,
  StopAgentResponse,
  GetDailySummaryResponse,
} from "@workspace/api-zod";
import { db, tradesTable, dailySummaryTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { currentNYDate } from "../lib/trading-config";
import { requireAgentKeyOrSession, issueSession, isValidSession, clearSession } from "../middlewares/auth";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/agent/session
// Validates the agent key and issues an HttpOnly session cookie.
// Called by the dashboard "Connect" flow — user enters the key once per session.
// ---------------------------------------------------------------------------
router.post("/agent/session", (req: Request, res: Response): void => {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set." });
    return;
  }
  const providedKey = req.headers["x-agent-key"] ?? (req.body as Record<string, unknown>)?.key;
  if (!providedKey || providedKey !== secret) {
    logger.warn({ ip: req.ip }, "Failed agent session authentication");
    res.status(401).json({ error: "Invalid agent key." });
    return;
  }
  issueSession(res);
  logger.info({ ip: req.ip }, "Agent session issued");
  res.json({ authenticated: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/agent/session — logout (clears the session cookie)
// ---------------------------------------------------------------------------
router.delete("/agent/session", (req: Request, res: Response): void => {
  clearSession(req, res);
  res.json({ authenticated: false });
});

// ---------------------------------------------------------------------------
// GET /api/agent/session — returns whether the current browser session is valid
// ---------------------------------------------------------------------------
router.get("/agent/session", (req: Request, res: Response): void => {
  res.json({ authenticated: isValidSession(req) });
});

// ---------------------------------------------------------------------------
// Read-only endpoints — no auth required
// ---------------------------------------------------------------------------

router.get("/agent/status", async (_req, res): Promise<void> => {
  const status = agentController.getStatus();
  res.json(GetAgentStatusResponse.parse(status));
});

router.get("/agent/instruments", async (req, res): Promise<void> => {
  const today = currentNYDate();
  const statuses = agentController.getInstrumentStatuses();

  const pnlRows = await db
    .select({
      instrument: tradesTable.instrument,
      todayPnl: sql<number>`coalesce(sum(pnl), 0)`,
    })
    .from(tradesTable)
    .where(
      and(
        sql`date(entry_time) = ${today}`,
        eq(tradesTable.status, "closed")
      )
    )
    .groupBy(tradesTable.instrument);

  const pnlMap = new Map(pnlRows.map((r) => [r.instrument, Number(r.todayPnl)]));

  const enriched = statuses.map((s) => ({
    ...s,
    todayPnl: pnlMap.get(s.symbol) ?? 0,
  }));

  req.log.debug({ count: enriched.length }, "Returning instrument statuses");
  res.json(GetInstrumentsResponse.parse(enriched));
});

router.get("/agent/daily-summary", async (_req, res): Promise<void> => {
  const today = currentNYDate();

  const rows = await db
    .select()
    .from(dailySummaryTable)
    .where(eq(dailySummaryTable.date, today))
    .limit(1);

  if (rows.length === 0) {
    res.json(
      GetDailySummaryResponse.parse({
        date: today,
        totalPnl: 0,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        status: "active",
        londonPnl: 0,
        nyPnl: 0,
      })
    );
    return;
  }

  const row = rows[0];
  res.json(
    GetDailySummaryResponse.parse({
      date: row.date,
      totalPnl: row.totalPnl,
      tradeCount: row.tradeCount,
      winCount: row.winCount,
      lossCount: row.lossCount,
      status: row.status,
      londonPnl: row.londonPnl,
      nyPnl: row.nyPnl,
    })
  );
});

// ---------------------------------------------------------------------------
// Mutating control endpoints — require agent key or authenticated session
// ---------------------------------------------------------------------------

router.post("/agent/start", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Agent start requested");
  const result = await agentController.start();
  res.json(StartAgentResponse.parse(result));
});

router.post("/agent/stop", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Agent stop requested");
  const result = await agentController.stop();
  res.json(StopAgentResponse.parse(result));
});

// ---------------------------------------------------------------------------
// POST /api/agent/instruments/:symbol/toggle
// Enables or disables a specific instrument at runtime.
// Body: { enabled: boolean }
// ---------------------------------------------------------------------------
router.post("/agent/instruments/:symbol/toggle", requireAgentKeyOrSession, (req: Request, res: Response): void => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const body = req.body as Record<string, unknown>;
  const enabled = body.enabled;

  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: 'Body must include { "enabled": true | false }' });
    return;
  }

  const result = agentController.toggleInstrument(symbol, enabled);
  if (!result.success) {
    res.status(404).json(result);
    return;
  }

  logger.info({ symbol, enabled }, "Instrument toggled via API");
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/agent/claude-trade
// Asks Claude to analyse the current DTR state and place trades immediately.
// ---------------------------------------------------------------------------
router.post("/agent/claude-trade", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Claude Trade Now requested");
  const result = await agentController.claudeTradeNow();
  res.json(result);
});

// ---------------------------------------------------------------------------
// GET  /api/agent/mode       — returns current trading mode
// POST /api/agent/mode       — sets trading mode
//   Body: { claudeAutonomous: boolean }
// ---------------------------------------------------------------------------
router.get("/agent/mode", (_req, res): void => {
  res.json({
    claudeAutonomousMode: agentController.getAutonomousMode(),
  });
});

router.post("/agent/mode", requireAgentKeyOrSession, (req: Request, res: Response): void => {
  const body = req.body as Record<string, unknown>;
  const claudeAutonomous = body.claudeAutonomous;
  if (typeof claudeAutonomous !== "boolean") {
    res.status(400).json({ error: 'Body must include { "claudeAutonomous": true | false }' });
    return;
  }
  const result = agentController.setAutonomousMode(claudeAutonomous);
  logger.info({ claudeAutonomous }, "Trading mode set via API");
  res.json({ ...result, claudeAutonomousMode: agentController.getAutonomousMode() });
});

// ---------------------------------------------------------------------------
// GET /api/account — live TopStep account info (balance, name, canTrade)
// No auth required — balance is not sensitive enough to lock behind auth
// ---------------------------------------------------------------------------
router.get("/account", async (_req, res): Promise<void> => {
  const info = await agentController.getAccountInfo();
  if (!info) {
    res.status(503).json({ error: "Account info unavailable — agent may not be authenticated yet" });
    return;
  }
  res.json(info);
});

// ---------------------------------------------------------------------------
// GET  /api/agent/settings  — returns current effective risk settings
// POST /api/agent/settings  — applies partial runtime overrides
//   Body: { dailyLossLimit?: number, dailyProfitTarget?: number, maxTradesPerDay?: number | null }
// ---------------------------------------------------------------------------
router.get("/agent/settings", requireAgentKeyOrSession, (_req, res): void => {
  res.json(agentController.getSettings());
});

router.post("/agent/settings", requireAgentKeyOrSession, (req: Request, res: Response): void => {
  const body = req.body as Record<string, unknown>;
  const partial: {
    dailyLossLimit?: number;
    dailyProfitTarget?: number;
    maxTradesPerDay?: number | null;
    maxLossesPerDirection?: number | null;
  } = {};

  if (body.dailyLossLimit !== undefined) {
    const v = Number(body.dailyLossLimit);
    if (!Number.isFinite(v) || v <= 0) { res.status(400).json({ error: "dailyLossLimit must be a positive number" }); return; }
    partial.dailyLossLimit = v;
  }
  if (body.dailyProfitTarget !== undefined) {
    const v = Number(body.dailyProfitTarget);
    if (!Number.isFinite(v) || v <= 0) { res.status(400).json({ error: "dailyProfitTarget must be a positive number" }); return; }
    partial.dailyProfitTarget = v;
  }
  if ("maxTradesPerDay" in body) {
    if (body.maxTradesPerDay === null) {
      partial.maxTradesPerDay = null;
    } else {
      const v = Number(body.maxTradesPerDay);
      if (!Number.isInteger(v) || v <= 0) { res.status(400).json({ error: "maxTradesPerDay must be a positive integer or null" }); return; }
      partial.maxTradesPerDay = v;
    }
  }
  if ("maxLossesPerDirection" in body) {
    if (body.maxLossesPerDirection === null) {
      partial.maxLossesPerDirection = null;
    } else {
      const v = Number(body.maxLossesPerDirection);
      if (!Number.isInteger(v) || v <= 0) { res.status(400).json({ error: "maxLossesPerDirection must be a positive integer or null" }); return; }
      partial.maxLossesPerDirection = v;
    }
  }

  const result = agentController.updateSettings(partial);
  if (!result.success) { res.status(400).json(result); return; }
  logger.info({ partial }, "Risk settings updated via API");
  res.json({ ...result, settings: agentController.getSettings() });
});

// ---------------------------------------------------------------------------
// POST /api/agent/liquidate — immediately close all open positions
// ---------------------------------------------------------------------------
router.post("/agent/liquidate", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.warn("Liquidate all requested via API");
  const result = await agentController.liquidateAll();
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/agent/lock — lock trading for the rest of the session
// ---------------------------------------------------------------------------
router.post("/agent/lock", requireAgentKeyOrSession, (_req, res): void => {
  logger.warn("Lock trading requested via API");
  const result = agentController.lockTrading();
  res.json(result);
});

export default router;
