import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import pool from "../db/connection";
import type { DatabaseConnection } from "../types/types";
import { fetchMetadata } from "../routes/semanticLayer/dataCatalog";
import {
  SemanticModelDocument,
  SemanticModelDocumentSchema,
  validateSemanticModelDocument,
} from "./schema";
import { buildDeterministicRelationships } from "./relationships";

export type SemanticModelStatus = "none" | "generating" | "ready" | "error";
export type SemanticVectorStatus = "not_indexed" | "pending" | "ready" | "error";

interface SemanticModelRow extends RowDataPacket {
  connection_id: number;
  semantic_key: string;
  model_json: string | SemanticModelDocument | null;
  status: SemanticModelStatus;
  generation_job_id: string | null;
  generation_started_at: Date | null;
  generation_error: string | null;
  last_generated_at: Date | null;
  revision: number | string;
  vector_status: SemanticVectorStatus;
  vector_error: string | null;
  vector_updated_at: Date | null;
  created_at: Date;
  created_by: number | null;
  updated_at: Date;
  updated_by: number | null;
}

export interface StoredSemanticModel {
  connectionId: number;
  semanticKey: string;
  model: SemanticModelDocument | null;
  status: SemanticModelStatus;
  generationJobId: string | null;
  generationStartedAt: Date | null;
  generationError: string | null;
  lastGeneratedAt: Date | null;
  revision: number;
  vectorStatus: SemanticVectorStatus;
  vectorError: string | null;
  vectorUpdatedAt: Date | null;
  createdAt: Date;
  createdBy: number | null;
  updatedAt: Date;
  updatedBy: number | null;
}

export class SemanticModelRevisionConflictError extends Error {
  readonly statusCode = 409;

  constructor(public readonly currentRevision: number) {
    super(`Semantic model revision conflict; current revision is ${currentRevision}`);
    this.name = "SemanticModelRevisionConflictError";
  }
}

export class SemanticModelBusyError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("A semantic-model generation job is already active for this connection");
    this.name = "SemanticModelBusyError";
  }
}

function generationLeaseMs(): number {
  const parsed = Number(process.env.SEMANTIC_GENERATION_LEASE_MS || 15 * 60 * 1000);
  return Number.isInteger(parsed) && parsed >= 60_000 ? parsed : 15 * 60 * 1000;
}

function parseModel(value: string | SemanticModelDocument | null): SemanticModelDocument | null {
  if (!value) return null;
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return SemanticModelDocumentSchema.parse(parsed);
}

function mapRow(row: SemanticModelRow): StoredSemanticModel {
  return {
    connectionId: Number(row.connection_id),
    semanticKey: String(row.semantic_key),
    model: parseModel(row.model_json),
    status: row.status,
    generationJobId: row.generation_job_id,
    generationStartedAt: row.generation_started_at,
    generationError: row.generation_error,
    lastGeneratedAt: row.last_generated_at,
    revision: Number(row.revision),
    vectorStatus: row.vector_status,
    vectorError: row.vector_error,
    vectorUpdatedAt: row.vector_updated_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

async function loadConnection(connectionId: number): Promise<DatabaseConnection> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM db_connections WHERE id = ?",
    [connectionId],
  );
  if (rows.length === 0) throw new Error(`Connection ${connectionId} was not found`);
  return rows[0] as DatabaseConnection;
}

export async function getModel(connectionId: number): Promise<StoredSemanticModel | null> {
  const [rows] = await pool.query<SemanticModelRow[]>(
    `SELECT sm.*, dc.semantic_key
       FROM semantic_models sm
       JOIN db_connections dc ON dc.id = sm.connection_id
      WHERE sm.connection_id = ?`,
    [connectionId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listModels(): Promise<StoredSemanticModel[]> {
  const [rows] = await pool.query<SemanticModelRow[]>(
    `SELECT sm.*, dc.semantic_key
       FROM semantic_models sm
       JOIN db_connections dc ON dc.id = sm.connection_id
      ORDER BY dc.created_at ASC, dc.id ASC`,
  );
  return rows.map(mapRow);
}

export async function enqueueVectorOperation(
  connection: PoolConnection,
  connectionId: number,
  operation: "upsert" | "delete",
  targetRevision: number,
): Promise<void> {
  await connection.query(
    `INSERT INTO semantic_vector_outbox
       (connection_id, operation, target_revision, attempt_count, next_attempt_at,
        locked_by, locked_until, last_error)
     VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP, NULL, NULL, NULL)
     ON DUPLICATE KEY UPDATE
       operation = VALUES(operation),
       target_revision = VALUES(target_revision),
       attempt_count = 0,
       next_attempt_at = CURRENT_TIMESTAMP,
       locked_by = NULL,
       locked_until = NULL,
       last_error = NULL`,
    [connectionId, operation, targetRevision],
  );
}

export async function enqueueVectorDeleteBeforeConnectionDeletion(
  connection: PoolConnection,
  connectionId: number,
): Promise<void> {
  await enqueueVectorOperation(connection, connectionId, "delete", 0);
}

async function saveModelInternal(args: {
  connectionId: number;
  value: unknown;
  expectedRevision: number;
  userId: number;
  mode: "manual" | "generation" | "conversion" | "operation";
  generationJobId?: string;
}): Promise<StoredSemanticModel> {
  const sourceConnection = await loadConnection(args.connectionId);
  const metadata = await fetchMetadata(sourceConnection);
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [connectionRows] = await db.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ? FOR UPDATE",
      [args.connectionId],
    );
    if (connectionRows.length === 0) throw new Error(`Connection ${args.connectionId} was not found`);
    const connection = connectionRows[0] as DatabaseConnection;

    const [modelRows] = await db.query<SemanticModelRow[]>(
      "SELECT * FROM semantic_models WHERE connection_id = ? FOR UPDATE",
      [args.connectionId],
    );
    const currentRevision = modelRows.length ? Number(modelRows[0].revision) : 0;
    if (currentRevision !== args.expectedRevision) {
      throw new SemanticModelRevisionConflictError(currentRevision);
    }
    if (modelRows.length && modelRows[0].status === "generating") {
      const ownsGeneration = args.mode === "generation"
        && Boolean(args.generationJobId)
        && modelRows[0].generation_job_id === args.generationJobId;
      if (!ownsGeneration) throw new SemanticModelBusyError();
    }
    const existing = modelRows.length ? parseModel(modelRows[0].model_json) : null;
    let model = validateSemanticModelDocument({
      value: args.value,
      connection,
      metadata,
      existing,
      mode: args.mode === "manual" ? "manual" : args.mode === "conversion" ? "conversion" : "generation",
    });
    model = {
      ...model,
      relationships: buildDeterministicRelationships(model.entities, metadata.relationships),
    };
    model = validateSemanticModelDocument({
      value: model,
      connection,
      metadata,
      existing,
      mode: args.mode === "conversion" ? "conversion" : "generation",
    });
    const nextRevision = currentRevision + 1;
    const generated = args.mode === "generation" || args.mode === "conversion";

    await db.query(
      `INSERT INTO semantic_models
         (connection_id, model_json, status, generation_job_id, generation_started_at,
          generation_error, last_generated_at, revision, vector_status, vector_error,
          vector_updated_at, created_by, updated_by)
       VALUES (?, ?, 'ready', NULL, NULL, NULL,
               CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
               ?, 'pending', NULL, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE
         model_json = VALUES(model_json),
         status = 'ready',
         generation_job_id = NULL,
         generation_started_at = NULL,
         generation_error = NULL,
         last_generated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_generated_at END,
         revision = VALUES(revision),
         vector_status = 'pending',
         vector_error = NULL,
         vector_updated_at = NULL,
         updated_by = VALUES(updated_by)`,
      [
        args.connectionId,
        JSON.stringify(model),
        generated,
        nextRevision,
        args.userId,
        args.userId,
        generated,
      ],
    );
    await enqueueVectorOperation(db, args.connectionId, "upsert", nextRevision);
    await db.commit();

    const stored = await getModel(args.connectionId);
    if (!stored) throw new Error("Semantic model disappeared after save");
    return stored;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

export function saveModel(
  connectionId: number,
  model: unknown,
  expectedRevision: number,
  userId: number,
): Promise<StoredSemanticModel> {
  return saveModelInternal({ connectionId, value: model, expectedRevision, userId, mode: "manual" });
}

export function saveGeneratedModel(args: {
  connectionId: number;
  model: unknown;
  expectedRevision: number;
  userId: number;
  generationJobId?: string;
  conversion?: boolean;
}): Promise<StoredSemanticModel> {
  return saveModelInternal({
    connectionId: args.connectionId,
    value: args.model,
    expectedRevision: args.expectedRevision,
    userId: args.userId,
    mode: args.conversion ? "conversion" : "generation",
    generationJobId: args.generationJobId,
  });
}

export function saveOperationModel(args: {
  connectionId: number;
  model: unknown;
  expectedRevision: number;
  userId: number;
}): Promise<StoredSemanticModel> {
  return saveModelInternal({
    connectionId: args.connectionId,
    value: args.model,
    expectedRevision: args.expectedRevision,
    userId: args.userId,
    mode: "operation",
  });
}

export async function markGenerationStarted(
  connectionId: number,
  generationJobId: string,
  userId: number,
): Promise<void> {
  await beginGeneration(connectionId, generationJobId, userId);
}

export async function beginGeneration(
  connectionId: number,
  generationJobId: string,
  userId: number,
): Promise<StoredSemanticModel> {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [connectionRows] = await db.query<RowDataPacket[]>(
      "SELECT id FROM db_connections WHERE id = ? FOR UPDATE",
      [connectionId],
    );
    if (connectionRows.length === 0) throw new Error(`Connection ${connectionId} was not found`);
    const [rows] = await db.query<SemanticModelRow[]>(
      "SELECT * FROM semantic_models WHERE connection_id = ? FOR UPDATE",
      [connectionId],
    );
    if (rows.length && rows[0].status === "generating") {
      const startedAt = rows[0].generation_started_at?.getTime() || Date.now();
      if (startedAt > Date.now() - generationLeaseMs()) throw new SemanticModelBusyError();
      await db.query(
        `UPDATE semantic_models
            SET status = 'error', generation_job_id = NULL, generation_started_at = NULL,
                generation_error = 'Previous generation was interrupted after its lease expired'
          WHERE connection_id = ?`,
        [connectionId],
      );
    }
    await db.query(
      `INSERT INTO semantic_models
         (connection_id, status, generation_job_id, generation_started_at, created_by, updated_by)
       VALUES (?, 'generating', ?, CURRENT_TIMESTAMP, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = 'generating', generation_job_id = VALUES(generation_job_id),
         generation_started_at = CURRENT_TIMESTAMP, generation_error = NULL,
         updated_by = VALUES(updated_by)`,
      [connectionId, generationJobId, userId, userId],
    );
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
  const stored = await getModel(connectionId);
  if (!stored) throw new Error("Generation state was not created");
  return stored;
}

export async function markGenerationFailed(
  connectionId: number,
  generationJobId: string,
  error: string,
  userId: number,
): Promise<void> {
  await pool.query(
    `UPDATE semantic_models
        SET status = 'error', generation_error = ?, generation_job_id = NULL,
            generation_started_at = NULL, updated_by = ?
      WHERE connection_id = ? AND generation_job_id = ?`,
    [error.slice(0, 4000), userId, connectionId, generationJobId],
  );
}

export async function resetInterruptedGenerations(): Promise<number> {
  const leaseSeconds = Math.ceil(generationLeaseMs() / 1000);
  const [result] = await pool.query<import("mysql2/promise").ResultSetHeader>(
    `UPDATE semantic_models
        SET status = 'error', generation_job_id = NULL, generation_started_at = NULL,
            generation_error = 'Generation was interrupted because the backend stopped or its lease expired'
      WHERE status = 'generating'
        AND (generation_started_at IS NULL
          OR generation_started_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ? SECOND))`,
    [leaseSeconds],
  );
  return result.affectedRows;
}

export async function deleteModel(connectionId: number): Promise<void> {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await enqueueVectorOperation(db, connectionId, "delete", 0);
    await db.query("DELETE FROM semantic_models WHERE connection_id = ?", [connectionId]);
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

export async function retryVectorSync(connectionId: number): Promise<void> {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query<SemanticModelRow[]>(
      "SELECT * FROM semantic_models WHERE connection_id = ? FOR UPDATE",
      [connectionId],
    );
    if (rows.length === 0 || !rows[0].model_json) {
      await enqueueVectorOperation(db, connectionId, "delete", 0);
    } else {
      const revision = Number(rows[0].revision);
      await db.query(
        "UPDATE semantic_models SET vector_status = 'pending', vector_error = NULL WHERE connection_id = ?",
        [connectionId],
      );
      await enqueueVectorOperation(db, connectionId, "upsert", revision);
    }
    await db.commit();
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}
