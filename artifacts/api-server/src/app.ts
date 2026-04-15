import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Build list of trusted origins from the Replit-managed REPLIT_DOMAINS env var.
// Only same-deployment origins are allowed to make cross-origin requests.
const replitDomains = (process.env.REPLIT_DOMAINS ?? "").split(",").filter(Boolean);
const trustedOrigins = new Set<string>(
  replitDomains.flatMap((d) => [`https://${d.trim()}`, `http://${d.trim()}`])
);

// In local dev (REPLIT_DOMAINS unset), allow localhost origins to avoid accidental lockout.
const isLocalDev = replitDomains.length === 0;

function corsOriginFn(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void
): void {
  // Allow same-origin / no-origin (server-to-server, curl from localhost)
  if (!origin) {
    cb(null, true);
    return;
  }
  // Local dev fallback: allow any localhost origin when REPLIT_DOMAINS is unset
  if (isLocalDev && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
    cb(null, true);
    return;
  }
  if (trustedOrigins.size > 0 && trustedOrigins.has(origin)) {
    cb(null, true);
    return;
  }
  // Reject unknown cross-origin requests
  cb(new Error(`CORS: Origin '${origin}' is not allowed`));
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: corsOriginFn, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
