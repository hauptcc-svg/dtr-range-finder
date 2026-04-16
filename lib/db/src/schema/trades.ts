import { pgTable, serial, text, real, integer, timestamp, date, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  instrument: text("instrument").notNull(),
  direction: text("direction").notNull(), // 'long' | 'short'
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  qty: integer("qty").notNull(),
  pnl: real("pnl"),
  session: text("session").notNull(), // 'london' | 'ny'
  status: text("status").notNull().default("open"), // 'open' | 'closed' | 'cancelled'
  entryTime: timestamp("entry_time").notNull().defaultNow(),
  exitTime: timestamp("exit_time"),
  stopPrice: real("stop_price"),
  tp1Price: real("tp1_price"),
  tp2Price: real("tp2_price"),
  projectxOrderId: text("projectx_order_id"),
  notes: text("notes"),
  strategy: text("strategy").default("dtr"),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;

export const dailySummaryTable = pgTable("daily_summary", {
  id: serial("id").primaryKey(),
  date: date("date").notNull().unique(),
  totalPnl: real("total_pnl").notNull().default(0),
  tradeCount: integer("trade_count").notNull().default(0),
  winCount: integer("win_count").notNull().default(0),
  lossCount: integer("loss_count").notNull().default(0),
  status: text("status").notNull().default("active"), // 'active' | 'profit_target_hit' | 'loss_limit_hit' | 'ended'
  londonPnl: real("london_pnl").notNull().default(0),
  nyPnl: real("ny_pnl").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertDailySummarySchema = createInsertSchema(dailySummaryTable).omit({ id: true });
export type InsertDailySummary = z.infer<typeof insertDailySummarySchema>;
export type DailySummary = typeof dailySummaryTable.$inferSelect;

export const instrumentConfigsTable = pgTable("instrument_configs", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  qty: integer("qty").notNull().default(1),
  pointValue: real("point_value").notNull().default(1.0),
  minTick: real("min_tick").notNull().default(0.25),
  maxTradesPerDay: integer("max_trades_per_day").notNull().default(4),
  strategyMode: text("strategy_mode").notNull().default("dtr"), // 'dtr' | 'atr_pullback'
  sessionStart: text("session_start").notNull().default("09:13"), // HH:MM NY
  sessionEnd: text("session_end").notNull().default("14:00"), // HH:MM NY
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertInstrumentConfigSchema = createInsertSchema(instrumentConfigsTable);
export type InsertInstrumentConfig = z.infer<typeof insertInstrumentConfigSchema>;
export type InstrumentConfig = typeof instrumentConfigsTable.$inferSelect;
