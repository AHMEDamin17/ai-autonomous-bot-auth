// Must be the first import: tsx/esbuild hoist all imports ahead of module
// statements, so a bare `dotenv.config()` call here would only run AFTER the
// entire ./server import tree (secret crypto, auth middleware, DB pools) had
// already evaluated its module-level env checks against an unloaded env.
import "dotenv/config";

import app from "./server";
import pool from "./db/connection";
import { RowDataPacket } from "mysql2";
import { closeAllPools } from "./connections/poolManager";
import { closeAllAdapterPools } from "./analytics/executor/adapterPoolRegistry";
import { networkInterfaces } from "node:os";
import { cleanupExpiredSessions } from "./auth/session";
import { startVectorOutboxWorker, VectorOutboxWorker } from "./semanticModels/vectorOutboxWorker";
import { resetInterruptedGenerations } from "./semanticModels/store";
import type { Server } from "node:http";

const PORT: number = Number(process.env.PORT ?? 3005);
let vectorOutboxWorker: VectorOutboxWorker | undefined;
let httpServer: Server | undefined;

function findLanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}

async function validateDbConnection(
  retries = 5,
  initialDelayMs = 2000,
): Promise<void> {
  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await pool.getConnection();
      await conn.query("SELECT 1");
      conn.release();
      console.log("[DB] Database connection verified successfully");
      return;
    } catch (err) {
      console.warn(
        `[DB] Database connection attempt ${attempt}/${retries} failed: ${(err as Error).message}`,
      );
      if (attempt === retries) {
        throw new Error(
          `Failed to connect to database after ${retries} attempts.`,
        );
      }
      console.log(`[DB] Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2; // Exponential backoff
    }
  }
}

async function bootstrap(): Promise<void> {
  console.log("[DB] Verifying database connectivity...");
  try {
    await validateDbConnection();
  } catch (err) {
    console.error(
      "[DB] Database is unavailable at startup:",
      (err as Error).message,
    );
    console.error(
      "[DB] Backend will still start; /readyz and DB-backed routes will report failures until the database is reachable.",
    );
  }

  // Recover per-connection generation leases left by a previous process.
  await resetInterruptedGenerations();
  httpServer = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(PORT, "0.0.0.0");
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.error(`[Startup] Port ${PORT} is already in use by another process.`);
        console.error("[Startup] Stop the existing backend, or set a different PORT and matching frontend proxy target.");
      }
      reject(error);
    });
    server.once("listening", () => resolve(server));
  });

  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs`);
  const lanAddress = findLanAddress();
  if (lanAddress) {
    console.log(`LAN Swagger UI: http://${lanAddress}:${PORT}/docs`);
  }
  vectorOutboxWorker = startVectorOutboxWorker();
}

bootstrap().catch(async (err) => {
  if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
  console.error("[Bootstrap error]", err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});

import { cleanupOldTelemetry } from "./telemetry/telemetryStore";

async function shutdown(signal: string): Promise<void> {
  console.log(
    `[Shutdown] ${signal} received. Closing database connection pools...`,
  );
  await vectorOutboxWorker?.stop();
  await new Promise<void>((resolve) => {
    if (!httpServer?.listening) return resolve();
    httpServer.close(() => resolve());
  });
  await closeAllAdapterPools();
  await closeAllPools();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", async () => {
  await shutdown("SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdown("SIGTERM");
});

// Run telemetry cleanup every 24 hours, starting 5 minutes after startup to avoid boot locks
const telemetryCleanupTimer = setInterval(
  () => {
    cleanupOldTelemetry().catch((err) =>
      console.error("[Telemetry] Scheduled cleanup failed", err),
    );
  },
  24 * 60 * 60 * 1000,
);
setTimeout(
  () => {
    cleanupOldTelemetry().catch((err) =>
      console.error("[Telemetry] Initial cleanup failed", err),
    );
  },
  5 * 60 * 1000,
).unref?.();
telemetryCleanupTimer.unref?.(); // Don't keep Node process alive just for this

const sessionCleanupTimer = setInterval(
  () => {
    cleanupExpiredSessions().catch((err) =>
      console.error("[Auth] Session cleanup failed", err),
    );
  },
  24 * 60 * 60 * 1000,
);
setTimeout(
  () => {
    cleanupExpiredSessions().catch((err) =>
      console.error("[Auth] Initial session cleanup failed", err),
    );
  },
  60 * 1000,
).unref?.();
sessionCleanupTimer.unref?.();
