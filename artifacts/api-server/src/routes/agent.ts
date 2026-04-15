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
 * Middleware that protects agent control endpoints (start/stop) via two paths:
 *
 * 1. Same-origin / Replit-proxied requests: allowed when the Origin header
 *    exactly matches one of the trusted REPLIT_DOMAINS origins.
 *    This covers the dashboard calling from the same Replit deployment.
 *    No browser-side secret is used or exposed.
 *
 * 2. External script/API access: requires X-Agent-Key header to match
 *    AGENT_CONTROL_SECRET (set as a Replit Secret, not in .replit).
 *    If the secret is unset and the request is not same-origin, it is
 *    rejected (fail-closed).
 */
function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers["origin"] as string | undefined;

  // Build trusted-origin set from REPLIT_DOMAINS (exact match only, no substrings)
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").filter(Boolean);
  const trustedOrigins = new Set<string>(
    replitDomains.flatMap((d) => [`https://${d.trim()}`, `http://${d.trim()}`])
  );

  // Allow requests from the same Replit deployment (exact origin match)
  if (origin && trustedOrigins.size > 0 && trustedOrigins.has(origin)) {
    next();
    return;
  }

  // Fall back to secret-based auth for external / no-origin requests
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error(
      { path: req.path, origin },
      "AGENT_CONTROL_SECRET is not set and request is not trusted-origin — rejecting"
    );
    res.status(503).json({
      error:
        "Server misconfiguration: AGENT_CONTROL_SECRET is not configured for external access.",
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
