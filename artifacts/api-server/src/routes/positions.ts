import { Router, type IRouter } from "express";
import { agentController } from "../lib/agent-controller";
import { GetPositionsResponse } from "@workspace/api-zod";
import { TRADING_CONFIG } from "../lib/trading-config";

const router: IRouter = Router();

router.get("/positions", async (req, res): Promise<void> => {
  // Force-refresh broker positions then merge with agent state for accurate display.
  // Falls back to cached in-memory state if the broker fetch fails or agent is not running.
  const statuses = await agentController.getInstrumentStatusesWithFresh();

  const positions = statuses
    .filter((s) => s.position !== null && s.positionSize > 0)
    .map((s) => {
      const config = TRADING_CONFIG.instruments[s.symbol];
      const currentPrice = s.lastPrice ?? s.entryPrice ?? 0;
      const entryPrice = s.entryPrice ?? 0;
      const priceDiff =
        s.position === "long"
          ? currentPrice - entryPrice
          : entryPrice - currentPrice;
      const unrealizedPnl = priceDiff * s.positionSize * (config?.pointValue ?? 10);

      return {
        instrument: s.symbol,
        direction: s.position as "long" | "short",
        size: s.positionSize,
        entryPrice,
        currentPrice,
        unrealizedPnl,
        openedAt: s.positionOpenedAt ?? new Date().toISOString(),
      };
    });

  req.log.debug({ count: positions.length }, "Returning open positions");
  res.json(GetPositionsResponse.parse(positions));
});

export default router;
