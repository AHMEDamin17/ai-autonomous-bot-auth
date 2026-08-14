import { Router, Request, Response, NextFunction } from "express";
import pool from "../../db/connection";
import {
  testDbTypeConnection,
  parseHostPort,
} from "../../utils/connectionTester";
import {
  DatabaseConnection,
  CreateConnectionPayload,
  ApiResponse,
  ApiError,
} from "../../types/types";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import { decryptConnectionSecrets, encryptSecret } from "../../utils/secretCrypto";
import { semanticKeyBase, semanticKeyCandidate } from "../../connections/semanticKey";
import { requireRole } from "../../middleware/requireRole";

async function allocateSemanticKey(dbType: string, connectionName: string): Promise<string> {
  const base = semanticKeyBase(dbType, connectionName);
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const candidate = attempt === 0 ? base : semanticKeyCandidate(base);
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM db_connections WHERE semantic_key = ? LIMIT 1",
      [candidate],
    );
    if (!rows.length) return candidate;
  }
  throw new Error("Unable to allocate a unique semantic connection key.");
}

// Get all saved connections
const getAll = async (
  _req: Request,
  res: Response<ApiResponse<DatabaseConnection[]>>,
  next: NextFunction,
): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, connection_name, semantic_key, db_type, host, default_schema, db_user,
              created_at, updated_at, created_by, updated_by
       FROM db_connections ORDER BY created_at DESC`,
    );
    res.json({ data: rows as DatabaseConnection[] });
  } catch (err) {
    next(err);
  }
};

// Verify DB type via driver handshake, then save if valid
const create = async (
  req: Request<object, object, CreateConnectionPayload>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const { connection_name, db_type, host, default_schema, db_user, db_password, credentials_json } = req.body;

  const SUPPORTED_DB_TYPES = [
    "mysql", "mariadb", "postgresql", "redshift", "mongodb",
    "sql server", "mssql", "redis", "sqlite", "snowflake",
    "bigquery", "databricks"
  ];

  if (!connection_name || !db_type || !host) {
    const error: ApiError = {
      error: "Missing required fields",
      detail: "connection_name, db_type, and host are required",
    };
    res.status(400).json(error);
    return;
  }

  if (!SUPPORTED_DB_TYPES.includes(db_type.toLowerCase())) {
    const error: ApiError = {
      error: "Invalid database type",
      detail: `Supported database types are: ${SUPPORTED_DB_TYPES.join(", ")}`,
    };
    res.status(400).json(error);
    return;
  }

  let hostname: string;
  let port: number;
  try {
    ({ hostname, port } = parseHostPort(host, db_type));
  } catch (parseErr) {
    const error: ApiError = {
      error: "Invalid host format",
      detail: (parseErr as Error).message,
    };
    res.status(400).json(error);
    return;
  }

  try {
    await testDbTypeConnection(hostname, port, db_type, db_user, credentials_json || db_password, default_schema);
  } catch (connErr) {
    const error: ApiError = {
      error: "Connection failed",
      detail: (connErr as Error).message,
    };
    res.status(400).json(error);
    return;
  }

  try {
    const semanticKey = await allocateSemanticKey(db_type, connection_name);
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO db_connections
         (connection_name, semantic_key, db_type, host, default_schema, db_user,
          db_password, credentials_json, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        connection_name,
        semanticKey,
        db_type,
        host,
        default_schema || null,
        db_user || null,
        encryptSecret(db_password),
        encryptSecret(credentials_json),
        req.user!.id,
        req.user!.id,
      ],
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, connection_name, semantic_key, db_type, host, default_schema, db_user,
              created_at, updated_at, created_by, updated_by
       FROM db_connections WHERE id = ?`,
      [result.insertId],
    );
    const saved = rows[0] as DatabaseConnection;
    if (!saved) {
      res.status(404).json({
        error: "Connection not saved",
        detail: "The connection was created but could not be retrieved from the database."
      } as ApiError);
      return;
    }
    // NOTE: semantic-model generation is NOT triggered here. It only starts when
    // the user clicks Generate in the Semantic Model tab.

    const response: ApiResponse<DatabaseConnection> = {
      data: saved,
      message: "Connection verified and saved successfully",
    };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
};

const update = async (
  req: Request<{ id: string }, object, { connection_name?: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const id = Number(req.params.id);
  const connectionName = String(req.body?.connection_name || "").trim();
  if (!Number.isInteger(id) || id <= 0 || !connectionName || connectionName.length > 255) {
    res.status(400).json({
      error: "Invalid connection update",
      detail: "A valid connection id and connection_name (1-255 characters) are required.",
    });
    return;
  }
  try {
    const [result] = await pool.query<ResultSetHeader>(
      "UPDATE db_connections SET connection_name = ?, updated_by = ? WHERE id = ?",
      [connectionName, req.user!.id, id],
    );
    if (!result.affectedRows) {
      res.status(404).json({ error: `Connection with id ${id} not found` });
      return;
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, connection_name, semantic_key, db_type, host, default_schema, db_user,
              created_at, updated_at, created_by, updated_by
         FROM db_connections WHERE id = ?`,
      [id],
    );
    res.json({ data: rows[0], message: "Connection updated successfully" });
  } catch (error) {
    next(error);
  }
};

import { evictCatalogPool, clearMetadataCache } from "./dataCatalog";
import { evictAdapterPool, buildLiveAdapter } from "../../analytics/executor/buildLiveAdapter";
import * as resultCache from "../../analytics/executor/resultCache";
import { enqueueVectorDeleteBeforeConnectionDeletion } from "../../semanticModels/store";

// Delete a connection by id
const remove = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const { id } = req.params;
  const numericId = Number(id);
  if (isNaN(numericId) || numericId <= 0) {
    res.status(400).json({
      error: "Invalid connection ID",
      detail: "Connection ID must be a valid positive number"
    } as ApiError);
    return;
  }

  try {
    // Fetch details to evict pools
    const [connRows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ?",
      [numericId],
    );
    if (connRows.length > 0) {
      try {
        const conn = decryptConnectionSecrets(connRows[0] as DatabaseConnection);
        await evictAdapterPool(id).catch((err: Error) => console.warn(`Failed to evict adapter pool: ${err.message}`));
        await evictCatalogPool(conn).catch((err: Error) => console.warn(`Failed to evict catalog pool: ${err.message}`));
      } catch (decErr: any) {
        console.warn(`Skipping pool eviction due to decryption failure: ${decErr.message}`);
      }
      clearMetadataCache(numericId);
      await resultCache.invalidateConnection(numericId).catch(() => {});
    }

    const db = await pool.getConnection();
    let result: ResultSetHeader;
    try {
      await db.beginTransaction();
      await db.query("DELETE FROM kpi_metrics WHERE connection_id = ?", [numericId]);
      await enqueueVectorDeleteBeforeConnectionDeletion(db, numericId);
      [result] = await db.query<ResultSetHeader>(
        "DELETE FROM db_connections WHERE id = ?",
        [numericId],
      );
      await db.commit();
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
    if (result.affectedRows === 0) {
      res.status(404).json({ error: `Connection with id ${id} not found` });
      return;
    }
    res.json({ data: null, message: `Connection ${id} removed successfully` });
  } catch (err) {
    next(err);
  }
};

// Check health of an existing connection
const healthCheck = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const numericId = Number(req.params.id);
  if (!Number.isInteger(numericId) || numericId <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections WHERE id = ?", [numericId]);
    if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }
    const conn = decryptConnectionSecrets(rows[0] as DatabaseConnection);
    const start = Date.now();
    try {
      const adapter = await buildLiveAdapter(conn);
      await adapter.execute({ dialect: "mysql", sql: "SELECT 1", params: [], dataset: "health", metric: "" } as any);
      await adapter.close().catch(() => {});
      res.json({ connection_id: numericId, healthy: true, latencyMs: Date.now() - start });
    } catch (err: any) {
      res.status(503).json({ connection_id: numericId, healthy: false, latencyMs: Date.now() - start, error: err.message });
    }
  } catch (err) { next(err); }
};

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();
  router.get("/", getAll);
  router.post("/", requireRole("admin"), create);
  router.patch("/:id", requireRole("admin"), update);
  router.delete("/:id", requireRole("admin"), remove);
  router.get("/:id/health", healthCheck);
  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};
