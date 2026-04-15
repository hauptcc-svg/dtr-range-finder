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
 *    matches one of the trusted REPLIT_DOMAINS (set by the platform). This
 *    covers the dashboard calling from a browser on the same Replit deployment.
 *
 * 2. External script/API access: requires the X-Agent-Key header to match
 *    the AGENT_CONTROL_SECRET env var.  If AGENT_CONTROL_SECRET is unset and
 *    the request is not same-origin, the server rejects it (fail-closed).
 *
 * The secret is NEVER sent to the browser; VITE_AGENT_CONTROL_SECRET is not used.
 */
function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers["origin"] as string | undefined;
  const referer = req.headers["referer"] as string | undefined;

  // Check if the request comes from a trusted Replit domain
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").filter(Boolean);
  const isSameOrigin =
    replitDomains.length > 0 &&
    (origin ?? referer ?? "")
      .split(/[/?#]/)[2]
      ?.split(".")
      .slice(-2)
      .join(".") === "replit.app" ||
    replitDomains.some(
      (d) =>
        (origin && origin.includes(d)) ||
        (referer && referer.includes(d))
    );

  if (isSameOrigin) {
    next();
    return;
  }

  // Fall back to secret-based auth for external access
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error(
      { path: req.path, origin, referer },
      "AGENT_CONTROL_SECRET is not set and request is not same-origin — rejecting"
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
