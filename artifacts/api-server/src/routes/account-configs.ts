import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { accountConfigsTable } from "@workspace/db";
import { eq, ne } from "drizzle-orm";
import { requireAgentKeyOrSession } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { agentController } from "../lib/agent-controller";

const router: IRouter = Router();

router.get("/account-configs", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  const rows = await db.select().from(accountConfigsTable).orderBy(accountConfigsTable.id);
  res.json(rows);
});

router.post("/account-configs", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const { accountId, accountNumber, label } = body;

  if (!accountId || !accountNumber) {
    res.status(400).json({ error: "accountId and accountNumber are required" });
    return;
  }

  const id = Number(accountId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "accountId must be a positive integer" });
    return;
  }

  try {
    const existing = await db.select().from(accountConfigsTable).where(eq(accountConfigsTable.accountId, id)).limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: `Account ${id} is already registered` });
      return;
    }

    const [row] = await db
      .insert(accountConfigsTable)
      .values({
        accountId: id,
        accountNumber: String(accountNumber),
        label: typeof label === "string" ? label : null,
        isActive: false,
      })
      .returning();

    logger.info({ accountId: id }, "Account config registered");
    res.status(201).json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Failed to create account config");
    res.status(500).json({ error: msg });
  }
});

router.patch("/account-configs/:id", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const rowId = parseInt((req.params as { id: string }).id, 10);
  if (isNaN(rowId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const existing = await db.select().from(accountConfigsTable).where(eq(accountConfigsTable.id, rowId)).limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: `Account config ${rowId} not found` });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.accountNumber === "string") updates.accountNumber = body.accountNumber;
  if (typeof body.label === "string" || body.label === null) updates.label = body.label;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  try {
    const [row] = await db
      .update(accountConfigsTable)
      .set(updates)
      .where(eq(accountConfigsTable.id, rowId))
      .returning();
    logger.info({ rowId }, "Account config updated");
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.delete("/account-configs/:id", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const rowId = parseInt((req.params as { id: string }).id, 10);
  if (isNaN(rowId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.select().from(accountConfigsTable).where(eq(accountConfigsTable.id, rowId)).limit(1);
  if (existing.length === 0) {
    res.status(404).json({ error: `Account config ${rowId} not found` });
    return;
  }
  if (existing[0].isActive) {
    res.status(400).json({ error: "Cannot delete the active account. Switch to another account first." });
    return;
  }

  try {
    await db.delete(accountConfigsTable).where(eq(accountConfigsTable.id, rowId));
    logger.info({ rowId }, "Account config deleted");
    res.json({ success: true, message: "Account removed" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/account-configs/:id/activate", requireAgentKeyOrSession, async (req: Request, res: Response): Promise<void> => {
  const rowId = parseInt((req.params as { id: string }).id, 10);
  if (isNaN(rowId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const target = await db.select().from(accountConfigsTable).where(eq(accountConfigsTable.id, rowId)).limit(1);
  if (target.length === 0) {
    res.status(404).json({ error: `Account config ${rowId} not found` });
    return;
  }

  if (target[0].isActive) {
    res.status(400).json({ error: "That account is already active." });
    return;
  }

  const newAccountId = target[0].accountId;

  // Ask agent controller to switch the live trading account
  const result = await agentController.switchAccount(newAccountId);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  // Persist the new active account in the database (transactional to avoid intermediate no-active state)
  try {
    await db.transaction(async (tx) => {
      await tx.update(accountConfigsTable).set({ isActive: false }).where(ne(accountConfigsTable.id, rowId));
      await tx.update(accountConfigsTable).set({ isActive: true }).where(eq(accountConfigsTable.id, rowId));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Failed to update isActive flags in DB after account switch");
    res.status(500).json({ error: msg });
    return;
  }

  logger.info({ rowId, newAccountId }, "Account activated successfully");
  const updated = await db.select().from(accountConfigsTable).orderBy(accountConfigsTable.id);
  res.json({ success: true, message: result.message, accounts: updated });
});

export default router;
