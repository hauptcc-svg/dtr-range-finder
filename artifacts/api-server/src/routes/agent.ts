import { randomBytes } from "crypto";
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
import { eq, and, sql } from "drizzle-orm";
import { currentNYDate } from "../lib/trading-config";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Session store — maps session tokens to an authenticated flag.
// Sessions are issued by POST /api/agent/session and are stored in memory.
// They are ephemeral: they expire on process restart.
// ---------------------------------------------------------------------------
const SESSION_COOKIE = "agent_sid";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface SessionRecord {
  createdAt: number;
}

const sessions = new Map<string, SessionRecord>();

function issueSession(res: Response): void {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    // secure: true in production (Replit proxy terminates TLS)
    secure: process.env.NODE_ENV === "production",
  });
}

function isValidSession(req: Request): boolean {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token) return false;
  const record = sessions.get(token);
  if (!record) return false;
  if (Date.now() - record.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Prune expired sessions periodically (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, record] of sessions) {
    if (now - record.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// requireAgentKeyOrSession
//
// Mutating endpoints (start/stop) require one of:
//   1. X-Agent-Key header matching AGENT_CONTROL_SECRET  (external scripts)
//   2. A valid agent_sid HttpOnly session cookie          (dashboard browser)
//
// The session cookie is issued by POST /api/agent/session, which itself
// requires a correct X-Agent-Key. The cookie is HttpOnly (JS cannot read it),
// SameSite=Strict (not sent cross-site), and is stored only in server memory.
// ---------------------------------------------------------------------------
function requireAgentKeyOrSession(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error({ path: req.path }, "AGENT_CONTROL_SECRET is not configured — rejecting");
    res.status(503).json({ error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set." });
    return;
  }

  // Path 1: valid agent key header (external callers / scripts)
  const providedKey = req.headers["x-agent-key"] as string | undefined;
  if (providedKey && providedKey === secret) {
    next();
    return;
  }

  // Path 2: valid server-issued session cookie (authenticated dashboard browser)
  if (isValidSession(req)) {
    next();
    return;
  }

  logger.warn({ ip: req.ip, path: req.path }, "Unauthorized agent control attempt");
  res.status(401).json({
    error:
      "Unauthorized: supply X-Agent-Key header (external scripts) " +
      "or authenticate via POST /api/agent/session (dashboard).",
  });
}

// ---------------------------------------------------------------------------
// POST /api/agent/session
// Validates the agent key and issues an HttpOnly session cookie.
// Called by the dashboard "Connect" flow — user enters the key once per session.
// ---------------------------------------------------------------------------
router.post("/agent/session", (req: Request, res: Response): void => {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set." });
    return;
  }
  const providedKey = req.headers["x-agent-key"] ?? (req.body as Record<string, unknown>)?.key;
  if (!providedKey || providedKey !== secret) {
    logger.warn({ ip: req.ip }, "Failed agent session authentication");
    res.status(401).json({ error: "Invalid agent key." });
    return;
  }
  issueSession(res);
  logger.info({ ip: req.ip }, "Agent session issued");
  res.json({ authenticated: true });
});

// ---------------------------------------------------------------------------
// DELETE /api/agent/session — logout (clears the session cookie)
// ---------------------------------------------------------------------------
router.delete("/agent/session", (req: Request, res: Response): void => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.json({ authenticated: false });
});

// ---------------------------------------------------------------------------
// GET /api/agent/session — returns whether the current browser session is valid
// ---------------------------------------------------------------------------
router.get("/agent/session", (req: Request, res: Response): void => {
  res.json({ authenticated: isValidSession(req) });
});

// ---------------------------------------------------------------------------
// Read-only endpoints — no auth required
// ---------------------------------------------------------------------------

router.get("/agent/status", async (_req, res): Promise<void> => {
  const status = agentController.getStatus();
  res.json(GetAgentStatusResponse.parse(status));
});

router.get("/agent/instruments", async (req, res): Promise<void> => {
  const today = currentNYDate();
  const statuses = agentController.getInstrumentStatuses();

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

// ---------------------------------------------------------------------------
// Mutating control endpoints — require agent key or authenticated session
// ---------------------------------------------------------------------------

router.post("/agent/start", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Agent start requested");
  const result = await agentController.start();
  res.json(StartAgentResponse.parse(result));
});

router.post("/agent/stop", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Agent stop requested");
  const result = await agentController.stop();
  res.json(StopAgentResponse.parse(result));
});

// ---------------------------------------------------------------------------
// POST /api/agent/instruments/:symbol/toggle
// Enables or disables a specific instrument at runtime.
// Body: { enabled: boolean }
// ---------------------------------------------------------------------------
router.post("/agent/instruments/:symbol/toggle", requireAgentKeyOrSession, (req: Request, res: Response): void => {
  const symbol = (req.params as { symbol: string }).symbol.toUpperCase();
  const body = req.body as Record<string, unknown>;
  const enabled = body.enabled;

  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: 'Body must include { "enabled": true | false }' });
    return;
  }

  const result = agentController.toggleInstrument(symbol, enabled);
  if (!result.success) {
    res.status(404).json(result);
    return;
  }

  logger.info({ symbol, enabled }, "Instrument toggled via API");
  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/agent/claude-trade
// Asks Claude to analyse the current DTR state and place trades immediately.
// ---------------------------------------------------------------------------
router.post("/agent/claude-trade", requireAgentKeyOrSession, async (_req, res): Promise<void> => {
  logger.info("Claude Trade Now requested");
  const result = await agentController.claudeTradeNow();
  res.json(result);
});

export default router;
