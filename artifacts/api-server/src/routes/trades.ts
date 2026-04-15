import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { desc, eq, and, sql, count } from "drizzle-orm";
import { GetTradesQueryParams, GetTradesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/trades", async (req, res): Promise<void> => {
  const parsed = GetTradesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { page, pageSize, instrument, date } = parsed.data;
  const offset = ((page ?? 1) - 1) * (pageSize ?? 20);
  const limit = pageSize ?? 20;

  const conditions = [];
  if (instrument) {
    conditions.push(eq(tradesTable.instrument, instrument));
  }
  if (date) {
    conditions.push(sql`date(entry_time) = ${date}`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [trades, totalResult] = await Promise.all([
    db
      .select()
      .from(tradesTable)
      .where(whereClause)
      .orderBy(desc(tradesTable.entryTime))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(tradesTable).where(whereClause),
  ]);

  const total = totalResult[0]?.total ?? 0;

  const serialized = trades.map((t) => ({
    id: t.id,
    instrument: t.instrument,
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice ?? null,
    qty: t.qty,
    pnl: t.pnl ?? null,
    session: t.session,
    status: t.status,
    entryTime: t.entryTime.toISOString(),
    exitTime: t.exitTime ? t.exitTime.toISOString() : null,
    stopPrice: t.stopPrice ?? null,
    tp1Price: t.tp1Price ?? null,
    tp2Price: t.tp2Price ?? null,
  }));

  res.json(
    GetTradesResponse.parse({
      trades: serialized,
      total,
      page: page ?? 1,
      pageSize: limit,
    })
  );
});

export default router;
