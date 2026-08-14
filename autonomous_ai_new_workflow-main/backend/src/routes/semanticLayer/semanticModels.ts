// Per-connection semantic-model document API.
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../../db/connection";
import { requireRole } from "../../middleware/requireRole";
import {
  getModel,
  retryVectorSync,
  saveModel,
  SemanticModelBusyError,
  SemanticModelRevisionConflictError,
  type StoredSemanticModel,
} from "../../semanticModels/store";
import { SemanticModelFieldError } from "../../semanticModels/schema";
import { UnknownSemanticTableError } from "../../semanticModels/generator";
import {
  removeModelTable,
  startFullOrAppendGeneration,
  startTableRegeneration,
} from "../../semanticModels/jobs";

const ConnectionParams = z.object({ connectionId: z.coerce.number().int().positive() });
const GenerateBody = z.object({
  tables: z.union([z.literal("all"), z.array(z.string().trim().min(1).max(512)).min(1).max(100)]),
  mode: z.enum(["full", "append"]),
}).strict();
const TableRevisionBody = z.object({
  table: z.string().trim().min(1).max(512),
  revision: z.number().int().nonnegative(),
}).strict();
const SaveBody = z.object({
  model: z.unknown(),
  revision: z.number().int().nonnegative(),
}).strict();

interface ConnectionRow extends RowDataPacket {
  id: number;
  connection_name: string;
  semantic_key: string;
}

function errorResponse(res: Response, status: number, code: string, detail: string): void {
  res.status(status).json({ error: code, code, detail });
}

function handleKnownError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof SemanticModelBusyError) {
    errorResponse(res, 409, "MODEL_BUSY", error.message);
    return;
  }
  if (error instanceof SemanticModelRevisionConflictError) {
    res.status(409).json({
      error: "STALE_MODEL_REVISION",
      code: "STALE_MODEL_REVISION",
      detail: error.message,
      current_revision: error.currentRevision,
    });
    return;
  }
  if (error instanceof UnknownSemanticTableError) {
    errorResponse(res, 400, "UNKNOWN_TABLE", error.message);
    return;
  }
  if (error instanceof SemanticModelFieldError || error instanceof z.ZodError) {
    errorResponse(res, 400, "INVALID_SEMANTIC_MODEL", error.message);
    return;
  }
  if ((error as Error & { statusCode?: number }).statusCode === 404) {
    errorResponse(res, 404, "CONNECTION_NOT_FOUND", "The selected connection does not exist.");
    return;
  }
  next(error);
}

async function loadConnection(connectionId: number): Promise<ConnectionRow | null> {
  const [rows] = await pool.query<ConnectionRow[]>(
    "SELECT id, connection_name, semantic_key FROM db_connections WHERE id = ?",
    [connectionId],
  );
  return rows[0] || null;
}

async function auditDisplay(model: StoredSemanticModel | null) {
  const ids = [...new Set([model?.createdBy, model?.updatedBy].filter((id): id is number => Number.isInteger(id)))];
  if (ids.length === 0) return { created_by: null, updated_by: null };
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const byId = new Map(rows.map((row) => [Number(row.id), { id: Number(row.id), username: String(row.username) }]));
  return {
    created_by: model?.createdBy ? byId.get(model.createdBy) || null : null,
    updated_by: model?.updatedBy ? byId.get(model.updatedBy) || null : null,
  };
}

async function responseData(connection: ConnectionRow, model: StoredSemanticModel | null) {
  const audit = await auditDisplay(model);
  return {
    connection: {
      id: Number(connection.id),
      name: connection.connection_name,
      semantic_key: connection.semantic_key,
    },
    model: model?.model || null,
    revision: model?.revision || 0,
    status: model?.status || "none",
    generation_job_id: model?.generationJobId || null,
    generation_started_at: model?.generationStartedAt || null,
    generation_error: model?.generationError || null,
    last_generated_at: model?.lastGeneratedAt || null,
    vector_status: model?.vectorStatus || "not_indexed",
    vector_error: model?.vectorError || null,
    vector_updated_at: model?.vectorUpdatedAt || null,
    created_at: model?.createdAt || null,
    updated_at: model?.updatedAt || null,
    audit,
    generation_by: model?.status === "generating" ? audit.updated_by : null,
  };
}

async function getOne(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = ConnectionParams.safeParse(req.params);
  if (!parsed.success) {
    errorResponse(res, 400, "INVALID_CONNECTION_ID", "connectionId must be a positive integer.");
    return;
  }
  try {
    const connection = await loadConnection(parsed.data.connectionId);
    if (!connection) {
      errorResponse(res, 404, "CONNECTION_NOT_FOUND", "The selected connection does not exist.");
      return;
    }
    res.json({ data: await responseData(connection, await getModel(connection.id)) });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

async function generate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const params = ConnectionParams.safeParse(req.params);
  const body = GenerateBody.safeParse(req.body);
  if (!params.success || !body.success) {
    const detail = !params.success ? params.error.message : !body.success ? body.error.message : "Invalid request";
    errorResponse(res, 400, "INVALID_SEMANTIC_MODEL", detail);
    return;
  }
  try {
    const accepted = await startFullOrAppendGeneration({
      connectionId: params.data.connectionId,
      userId: req.user!.id,
      tables: body.data.tables,
      mode: body.data.mode,
    });
    res.status(202).json({ data: { job_id: accepted.jobId, connection_id: accepted.connectionId } });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

async function regenerate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const params = ConnectionParams.safeParse(req.params);
  const body = TableRevisionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    const detail = !params.success ? params.error.message : !body.success ? body.error.message : "Invalid request";
    errorResponse(res, 400, "INVALID_SEMANTIC_MODEL", detail);
    return;
  }
  try {
    const accepted = await startTableRegeneration({
      connectionId: params.data.connectionId,
      userId: req.user!.id,
      table: body.data.table,
      expectedRevision: body.data.revision,
    });
    res.status(202).json({ data: { job_id: accepted.jobId, connection_id: accepted.connectionId } });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

async function removeTable(req: Request, res: Response, next: NextFunction): Promise<void> {
  const params = ConnectionParams.safeParse(req.params);
  const body = TableRevisionBody.safeParse(req.body);
  if (!params.success || !body.success) {
    const detail = !params.success ? params.error.message : !body.success ? body.error.message : "Invalid request";
    errorResponse(res, 400, "INVALID_SEMANTIC_MODEL", detail);
    return;
  }
  try {
    const stored = await removeModelTable({
      connectionId: params.data.connectionId,
      userId: req.user!.id,
      table: body.data.table,
      expectedRevision: body.data.revision,
    });
    const connection = await loadConnection(params.data.connectionId);
    if (!connection) throw Object.assign(new Error("Connection not found"), { statusCode: 404 });
    res.json({ data: await responseData(connection, stored), message: "Table removed from semantic model" });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

async function save(req: Request, res: Response, next: NextFunction): Promise<void> {
  const params = ConnectionParams.safeParse(req.params);
  const body = SaveBody.safeParse(req.body);
  if (!params.success || !body.success) {
    const detail = !params.success ? params.error.message : !body.success ? body.error.message : "Invalid request";
    errorResponse(res, 400, "INVALID_SEMANTIC_MODEL", detail);
    return;
  }
  try {
    const stored = await saveModel(
      params.data.connectionId,
      body.data.model,
      body.data.revision,
      req.user!.id,
    );
    const connection = await loadConnection(params.data.connectionId);
    if (!connection) throw Object.assign(new Error("Connection not found"), { statusCode: 404 });
    res.json({ data: await responseData(connection, stored), message: "Semantic model saved" });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

async function retryVector(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = ConnectionParams.safeParse(req.params);
  if (!parsed.success) {
    errorResponse(res, 400, "INVALID_CONNECTION_ID", parsed.error.message);
    return;
  }
  try {
    const connection = await loadConnection(parsed.data.connectionId);
    if (!connection) {
      errorResponse(res, 404, "CONNECTION_NOT_FOUND", "The selected connection does not exist.");
      return;
    }
    await retryVectorSync(connection.id);
    res.status(202).json({ data: { connection_id: connection.id, vector_status: "pending" } });
  } catch (error) {
    handleKnownError(error, res, next);
  }
}

let routerInstance: Router | null = null;

export function getRouter(): Router {
  const cacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (cacheable && routerInstance) return routerInstance;
  const router = Router();
  router.get("/:connectionId", getOne);
  router.post("/:connectionId/generate", requireRole("admin"), generate);
  router.post("/:connectionId/regenerate-table", requireRole("admin"), regenerate);
  router.delete("/:connectionId/tables", requireRole("admin"), removeTable);
  router.put("/:connectionId", requireRole("admin"), save);
  router.post("/:connectionId/retry-vector-sync", requireRole("admin"), retryVector);
  if (cacheable) routerInstance = router;
  return router;
}
