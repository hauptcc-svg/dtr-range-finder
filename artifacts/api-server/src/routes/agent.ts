import { Router, type IRouter } from "express";
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

router.post("/agent/start", async (_req, res): Promise<void> => {
  logger.info("Agent start requested");
  const result = await agentController.start();
  res.json(StartAgentResponse.parse(result));
});

router.post("/agent/stop", async (_req, res): Promise<void> => {
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
