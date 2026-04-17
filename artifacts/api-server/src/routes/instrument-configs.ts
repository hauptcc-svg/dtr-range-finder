import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { instrumentConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAgentKeyOrSession } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { agentController } from "../lib/agent-controller";

const router: IRouter = Router();

router.get("/instrument-configs", async (_req, res): Promise<void> => {
  const rows = await db.select().from(instrumentConfigsTable).orderBy(instrumentConfigsTable.symbol);
  res.json(rows);
});

router.post("/instrument-configs", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const { symbol, name, enabled, qty, pointValue, minTick, maxTradesPerDay, strategyMode, sess2EntryEnd, sessionStart, sessionEnd } = body;

  if (!symbol || !name) {
    res.status(400).json({ error: "symbol and name are required" });
    return;
  }

  try {
    const [row] = await db
      .insert(instrumentConfigsTable)
      .values({
        symbol: String(symbol).toUpperCase(),
        name: String(name),
        enabled: typeof enabled === "boolean" ? enabled : true,
        qty: typeof qty === "number" ? qty : 1,
        pointValue: typeof pointValue === "number" ? pointValue : 1.0,
        minTick: typeof minTick === "number" ? minTick : 0.25,
        maxTradesPerDay: typeof maxTradesPerDay === "number" ? maxTradesPerDay : 4,
        strategyMode: typeof strategyMode === "string" ? strategyMode : "dtr",
        sess2EntryEnd: typeof sess2EntryEnd === "string" ? sess2EntryEnd : "04:00",
        sessionStart: typeof sessionStart === "string" ? sessionStart : "09:13",
        sessionEnd: typeof sessionEnd === "string" ? sessionEnd : "14:00",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: instrumentConfigsTable.symbol,
        set: {
          name: String(name),
          enabled: typeof enabled === "boolean" ? enabled : true,
          qty: typeof qty === "number" ? qty : 1,
          pointValue: typeof pointValue === "number" ? pointValue : 1.0,
          minTick: typeof minTick === "number" ? minTick : 0.25,
          maxTradesPerDay: typeof maxTradesPerDay === "number" ? maxTradesPerDay : 4,
          strategyMode: typeof strategyMode === "string" ? strategyMode : "dtr",
          sess2EntryEnd: typeof sess2EntryEnd === "string" ? sess2EntryEnd : "04:00",
          sessionStart: typeof sessionStart === "string" ? sessionStart : "09:13",
          sessionEnd: typeof sessionEnd === "string" ? sessionEnd : "14:00",
          updatedAt: new Date(),
        },
      })
      .returning();

    await agentController.refreshInstrumentConfigs();
    logger.info({ symbol: row.symbol }, "Instrument config created/updated");
    res.status(201).json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Failed to create instrument config");
    res.status(500).json({ error: msg });
  }
});

router.patch("/instrument-configs/:symbol", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const body = req.body as Record<string, unknown>;

  const existing = await db.select().from(instrumentConfigsTable).where(eq(instrumentConfigsTable.symbol, symbol)).limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: `Instrument ${symbol} not found` });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.name === "string") updates.name = body.name;
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  if (typeof body.qty === "number") updates.qty = body.qty;
  if (typeof body.pointValue === "number") updates.pointValue = body.pointValue;
  if (typeof body.minTick === "number") updates.minTick = body.minTick;
  if (typeof body.maxTradesPerDay === "number") updates.maxTradesPerDay = body.maxTradesPerDay;
  if (typeof body.strategyMode === "string") updates.strategyMode = body.strategyMode;
  if (typeof body.sess2EntryEnd === "string") updates.sess2EntryEnd = body.sess2EntryEnd;
  if (typeof body.sessionStart === "string") updates.sessionStart = body.sessionStart;
  if (typeof body.sessionEnd === "string") updates.sessionEnd = body.sessionEnd;

  try {
    const [row] = await db
      .update(instrumentConfigsTable)
      .set(updates)
      .where(eq(instrumentConfigsTable.symbol, symbol))
      .returning();

    await agentController.refreshInstrumentConfigs();
    logger.info({ symbol }, "Instrument config updated");
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, symbol }, "Failed to update instrument config");
    res.status(500).json({ error: msg });
  }
});

router.delete("/instrument-configs/:symbol", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();

  const existing = await db.select().from(instrumentConfigsTable).where(eq(instrumentConfigsTable.symbol, symbol)).limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: `Instrument ${symbol} not found` });
    return;
  }

  try {
    await db.delete(instrumentConfigsTable).where(eq(instrumentConfigsTable.symbol, symbol));
    await agentController.refreshInstrumentConfigs();
    logger.info({ symbol }, "Instrument config deleted");
    res.json({ success: true, message: `${symbol} removed from live trading` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, symbol }, "Failed to delete instrument config");
    res.status(500).json({ error: msg });
  }
});

export default router;
