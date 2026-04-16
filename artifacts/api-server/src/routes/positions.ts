import { Router, type IRouter, type Request, type Response } from "express";
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

// ---------------------------------------------------------------------------
// POST /api/positions/:symbol/bracket
// Cancel existing bracket orders and place new ones at provided prices.
// Body: { stopPrice: number, tp1Price: number, tp2Price?: number | null }
// ---------------------------------------------------------------------------
router.post("/positions/:symbol/bracket", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const symbol = (req.params["symbol"] as string).toUpperCase();
  const body = req.body as Record<string, unknown>;

  const stopPrice = Number(body.stopPrice);
  const tp1Price = Number(body.tp1Price);
  const tp2Price = body.tp2Price != null ? Number(body.tp2Price) : null;

  if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
    res.status(400).json({ success: false, message: "stopPrice must be a positive number" });
    return;
  }
  if (!Number.isFinite(tp1Price) || tp1Price <= 0) {
    res.status(400).json({ success: false, message: "tp1Price must be a positive number" });
    return;
  }
  if (tp2Price !== null && (!Number.isFinite(tp2Price) || tp2Price <= 0)) {
    res.status(400).json({ success: false, message: "tp2Price must be a positive number or null" });
    return;
  }

  const result = await agentController.updatePositionBracket(symbol, { stopPrice, tp1Price, tp2Price });
  res.status(result.success ? 200 : 400).json(result);
});

export default router;
