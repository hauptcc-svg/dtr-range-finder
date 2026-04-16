import { Router, type IRouter } from "express";
import { agentController } from "../lib/agent-controller";
import { GetPositionsResponse } from "@workspace/api-zod";
import { TRADING_CONFIG } from "../lib/trading-config";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAgentKeyOrSession } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/positions", async (req, res): Promise<void> => {
  const statuses = await agentController.getInstrumentStatusesWithFresh();

  const openStatuses = statuses.filter((s) => s.position !== null && s.positionSize > 0);

  // Fetch SL/TP for open positions from the trades table (status='open')
  const openTradesData =
    openStatuses.length > 0
      ? await db
          .select()
          .from(tradesTable)
          .where(eq(tradesTable.status, "open"))
      : [];

  // Build a map of instrument -> open trade for quick lookup
  const openTradeByInstrument = new Map(openTradesData.map((t) => [t.instrument, t]));

  const positions = openStatuses.map((s) => {
    const config = TRADING_CONFIG.instruments[s.symbol];
    const currentPrice = s.lastPrice ?? s.entryPrice ?? 0;
    const entryPrice = s.entryPrice ?? 0;
    const priceDiff =
      s.position === "long"
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;
    const unrealizedPnl = priceDiff * s.positionSize * (config?.pointValue ?? 10);

    const openTrade = openTradeByInstrument.get(s.symbol);

    return {
      instrument: s.symbol,
      direction: s.position as "long" | "short",
      size: s.positionSize,
      entryPrice,
      currentPrice,
      unrealizedPnl,
      openedAt: s.positionOpenedAt ?? new Date().toISOString(),
      stopPrice: openTrade?.stopPrice ?? null,
      tp1Price: openTrade?.tp1Price ?? null,
      tp2Price: openTrade?.tp2Price ?? null,
    };
  });

  req.log.debug({ count: positions.length }, "Returning open positions");
  res.json(GetPositionsResponse.parse(positions));
});

router.post("/positions/:symbol/close", requireAgentKeyOrSession, async (req, res): Promise<void> => {
  const symbol = (req.params["symbol"] as string).toUpperCase();
  const result = await agentController.closePositionForSymbol(symbol);
  res.json(result);
});

export default router;
