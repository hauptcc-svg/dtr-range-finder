import { randomBytes } from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger";

const SESSION_COOKIE = "agent_sid";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

interface SessionRecord {
  createdAt: number;
}

export const sessions = new Map<string, SessionRecord>();

export function issueSession(res: Response): void {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    secure: process.env.NODE_ENV === "production",
  });
}

export function isValidSession(req: Request): boolean {
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

export function clearSession(req: Request, res: Response): void {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
}

export function requireAgentKeyOrSession(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AGENT_CONTROL_SECRET;
  if (!secret) {
    logger.error({ path: req.path }, "AGENT_CONTROL_SECRET is not configured — rejecting");
    res.status(503).json({ error: "Server misconfiguration: AGENT_CONTROL_SECRET is not set." });
    return;
  }

  const providedKey = req.headers["x-agent-key"] as string | undefined;
  if (providedKey && providedKey === secret) {
    next();
    return;
  }

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
