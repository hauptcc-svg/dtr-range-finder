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
import { eq, desc, and, sql } from "drizzle-orm";
import { currentNYDate } from "../lib/trading-config";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// CSRF token — generated once per process start, stored only in memory.
// Returned to trusted-origin browser clients via GET /api/agent/csrf.
// Mutating endpoints verify it under X-CSRF-Token header.
// This allows the dashboard to call start/stop without shipping a shared
// secret to the browser, while still blocking non-browser script abuse.
// ---------------------------------------------------------------------------
const CSRF_TOKEN = randomBytes(32).toString("hex");

/**
 * Build the set of trusted origins from REPLIT_DOMAINS.
 * Returns an empty set when the env var is absent (local dev without proxy).
 */
function trustedOriginSet(): Set<string> {
  const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").filter(Boolean);
  return new Set<string>(
    replitDomains.flatMap((d) => [`https://${d.trim()}`, `http://${d.trim()}`])
  );
}

/**
 * Middleware: require a valid X-Agent-Key header (for external scripts).
 * This path does NOT accept CSRF tokens — it is exclusively for non-browser callers.
 */
function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error({ path: req.path }, "AGENT_CONTROL_SECRET is not configured — rejecting");
    res.status(503).json({
      error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set.",
    });
    return;
  }
  const provided = req.headers["x-agent-key"];
  if (!provided || provided !== secret) {
    logger.warn({ ip: req.ip, path: req.path }, "Unauthorized: missing or invalid X-Agent-Key");
    res.status(401).json({ error: "Unauthorized: missing or invalid X-Agent-Key header" });
    return;
  }
  next();
}

/**
 * Middleware: require a valid X-CSRF-Token header (for same-origin browser clients).
 * The token is an in-process secret that is served only to trusted-origin browsers
 * via GET /api/agent/csrf (which is CORS-restricted).
 */
function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers["x-csrf-token"];
  if (!provided || provided !== CSRF_TOKEN) {
    logger.warn({ ip: req.ip, path: req.path }, "Unauthorized: missing or invalid X-CSRF-Token");
    res.status(403).json({ error: "Forbidden: missing or invalid X-CSRF-Token header" });
    return;
  }
  next();
}

/**
 * Middleware: accept either a valid agent key OR a valid CSRF token.
 * - External scripts  → X-Agent-Key
 * - Dashboard browser → X-CSRF-Token (obtained from /api/agent/csrf via CORS-restricted GET)
 */
function requireAgentKeyOrCsrf(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_CONTROL_SECRET;
  const providedKey = req.headers["x-agent-key"] as string | undefined;
  const providedCsrf = req.headers["x-csrf-token"] as string | undefined;

  // Path 1: valid agent key (external callers)
  if (secret && providedKey && providedKey === secret) {
    next();
    return;
  }

  // Path 2: valid CSRF token (same-origin dashboard)
  if (providedCsrf && providedCsrf === CSRF_TOKEN) {
    next();
    return;
  }

  // Neither matched
  if (!secret) {
    logger.error({ path: req.path }, "AGENT_CONTROL_SECRET is not configured — rejecting");
    res.status(503).json({ error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set." });
    return;
  }
  logger.warn({ ip: req.ip, path: req.path }, "Unauthorized agent control attempt");
  res.status(401).json({
    error: "Unauthorized: supply X-Agent-Key (external) or X-CSRF-Token (dashboard)",
  });
}

// ---------------------------------------------------------------------------
// GET /api/agent/csrf
// Returns the in-process CSRF token to the browser dashboard.
// Access is limited by CORS (app.ts restricts cross-origin GET to trusted origins).
// Non-browser clients that reach this endpoint still cannot obtain the token
// and then forge a "browser" session because the mutating endpoints separately
// require the CSRF token via a custom header — which browsers will only send
// after they got the token from this endpoint (same-origin).
// ---------------------------------------------------------------------------
router.get("/agent/csrf", (_req, res): void => {
  res.json({ csrfToken: CSRF_TOKEN });
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
// Mutating endpoints — require agent key (external) or CSRF token (dashboard)
// ---------------------------------------------------------------------------

router.post("/agent/start", requireAgentKeyOrCsrf, async (_req, res): Promise<void> => {
  logger.info("Agent start requested");
  const result = await agentController.start();
  res.json(StartAgentResponse.parse(result));
});

router.post("/agent/stop", requireAgentKeyOrCsrf, async (_req, res): Promise<void> => {
  logger.info("Agent stop requested");
  const result = await agentController.stop();
  res.json(StopAgentResponse.parse(result));
});

export default router;
