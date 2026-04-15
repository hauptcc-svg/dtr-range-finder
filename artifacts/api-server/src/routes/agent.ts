import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
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
import { eq, desc, and, sql, count } from "drizzle-orm";
import { currentNYDate } from "../lib/trading-config";

const router: IRouter = Router();

/**
 * Middleware that protects agent control endpoints (start/stop).
 *
 * ALL callers must supply the X-Agent-Key header matching AGENT_CONTROL_SECRET.
 * This includes the dashboard (which fetches the key from /api/agent/key at load).
 * The /api/agent/key endpoint itself is protected by CORS (browser-enforced) and
 * only serves the key to same-deployment origins.
 *
 * Origin headers are NOT used as authorization on their own because they are
 * spoofable by non-browser HTTP clients.
 */
function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error({ path: req.path }, "AGENT_CONTROL_SECRET is not configured — rejecting");
    res.status(503).json({
      error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set.",
    });
    return;
  }
  const provided = req.headers["x-agent-key"];
  if (!provided || provided !== secret) {
    logger.warn({ ip: req.ip, path: req.path }, "Unauthorized agent control attempt");
    res.status(401).json({ error: "Unauthorized: missing or invalid X-Agent-Key header" });
    return;
  }
  next();
}

/**
 * Returns the agent control key to the dashboard.
 * Protected by CORS (see app.ts) — only reachable from trusted Replit origins.
 * Non-browser clients cannot use this to bypass requireAgentKey because they
 * must still present the key in X-Agent-Key on the mutating endpoints.
 */
router.get("/agent/key", (_req, res): void => {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    res.status(503).json({ error: "AGENT_CONTROL_SECRET is not configured" });
    return;
  }
  res.json({ key: secret });
});

router.get("/agent/status", async (_req, res): Promise<void> => {
  const status = agentController.getStatus();
  res.json(GetAgentStatusResponse.parse(status));
});

router.get("/agent/instruments", async (req, res): Promise<void> => {
  const today = currentNYDate();
  const statuses = agentController.getInstrumentStatuses();

  // Enrich with today's P&L from DB
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

router.post("/agent/start", requireAgentKey, async (_req, res): Promise<void> => {
  logger.info("Agent start requested");
  const result = await agentController.start();
  res.json(StartAgentResponse.parse(result));
});

router.post("/agent/stop", requireAgentKey, async (_req, res): Promise<void> => {
  logger.info("Agent stop requested");
  const result = await agentController.stop();
  res.json(StopAgentResponse.parse(result));
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

export default router;
