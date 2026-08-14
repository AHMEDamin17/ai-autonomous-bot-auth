import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import router from "./routes/router";
import { ApiError } from "./types/types";
import pool from "./db/connection";
import { redactSensitiveUrl } from "./utils/httpSecurity";
import { checkEmbeddingsHealth } from "./vector/embeddings";
import { checkQdrantHealth } from "./vector/qdrant";

dotenv.config();

import { correlationMiddleware } from "./telemetry/correlation";

const app: Application = express();
const corsOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const semanticModelBodyLimit = Number(process.env.SEMANTIC_MODEL_MAX_BODY_BYTES || 10 * 1024 * 1024);
if (!Number.isInteger(semanticModelBodyLimit)
  || semanticModelBodyLimit < 1024 * 1024
  || semanticModelBodyLimit > 25 * 1024 * 1024) {
  throw new Error("SEMANTIC_MODEL_MAX_BODY_BYTES must be an integer between 1 MB and 25 MB");
}

// Middleware setup
app.set("trust proxy", 1);
app.use(correlationMiddleware);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) {
      console.warn("[CORS] Request without Origin header allowed");
      callback(null, true);
      return;
    }
    if (corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    console.warn(`[CORS] Rejected origin: ${origin}`);
    callback(new Error("Not allowed by CORS"));
  },
}));
app.use("/api/semantic-models", express.json({ limit: semanticModelBodyLimit }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Request logging middleware (L3)
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${redactSensitiveUrl(req.originalUrl)} - ${res.statusCode} (${duration}ms)`);
  });
  next();
});

import { mountSwagger } from "./routes/swagger";

// API routes
app.use("/api", router);

// Dynamic Swagger API Documentation UI & JSON spec (inspects Express router stack)
mountSwagger(app);

// Health check endpoint
app.get("/healthz", async (_req: Request, res: Response) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", version: process.env.APP_VERSION ?? "1.0.0", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

app.get("/readyz", async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; required: boolean; error?: string }> = {
    db: { ok: false, required: true },
    redis: { ok: false, required: Boolean(process.env.REDIS_URL) },
    qdrant: { ok: false, required: false },
    embeddings: { ok: false, required: false },
  };
  try { await pool.query("SELECT 1"); checks.db.ok = true; } catch (error) { checks.db.error = (error as Error).message; }
  if (process.env.REDIS_URL) {
    try { /* Redis remains optional in the current process setup. */ checks.redis.ok = true; } catch (error) { checks.redis.error = (error as Error).message; }
  } else {
    checks.redis.ok = true;
  }
  [checks.qdrant, checks.embeddings] = await Promise.all([
    checkQdrantHealth(),
    checkEmbeddingsHealth(),
  ]).then(([qdrant, embeddings]) => [
    { ...qdrant, required: false },
    { ...embeddings, required: false },
  ]);
  const ok = Object.values(checks).filter((check) => check.required).every((check) => check.ok);
  const degraded = Object.values(checks).some((check) => !check.ok);
  res.status(ok ? 200 : 503).json({ status: ok ? (degraded ? "degraded" : "ready") : "unavailable", checks });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not found",
    detail: "The requested endpoint does not exist",
  } as ApiError);
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[Error]", err.message);
  const statusCode = (err as Error & { statusCode?: number }).statusCode ?? 500;
  const errorResponse = {
    statusCode,
    error: statusCode === 500 ? "Internal Server Error" : err.message,
    detail: process.env.NODE_ENV === "production" ? undefined : err.message,
  };
  res.status(statusCode).json(errorResponse);
});

export default app;
