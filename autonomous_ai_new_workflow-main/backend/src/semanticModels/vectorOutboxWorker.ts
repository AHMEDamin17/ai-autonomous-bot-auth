import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../db/connection";
import { SemanticModelDocumentSchema } from "./schema";
import { deleteSemanticModel, ensureCollection, upsertSemanticModel } from "../vector/qdrant";

interface OutboxRow extends RowDataPacket {
  connection_id: number;
  operation: "upsert" | "delete";
  target_revision: number | string;
  attempt_count: number;
}

interface ModelRow extends RowDataPacket {
  model_json: string | unknown;
  revision: number | string;
  semantic_key: string;
  updated_at: Date;
}

const LEASE_SECONDS = 90;
const POLL_INTERVAL_MS = 2_000;
const MAX_JOBS_PER_TICK = 5;

async function claimJob(workerId: string): Promise<OutboxRow | null> {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.query<OutboxRow[]>(
      `SELECT connection_id, operation, target_revision, attempt_count
         FROM semantic_vector_outbox
        WHERE next_attempt_at <= CURRENT_TIMESTAMP
          AND (locked_until IS NULL OR locked_until < CURRENT_TIMESTAMP)
        ORDER BY next_attempt_at ASC, connection_id ASC
        LIMIT 1
        FOR UPDATE`,
    );
    if (rows.length === 0) {
      await db.commit();
      return null;
    }
    const job = rows[0];
    await db.query(
      `UPDATE semantic_vector_outbox
          SET locked_by = ?, locked_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND)
        WHERE connection_id = ?`,
      [workerId, LEASE_SECONDS, job.connection_id],
    );
    await db.commit();
    return job;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    db.release();
  }
}

async function completeJob(workerId: string, job: OutboxRow): Promise<void> {
  await pool.query(
    `DELETE FROM semantic_vector_outbox
      WHERE connection_id = ? AND operation = ? AND target_revision = ? AND locked_by = ?`,
    [job.connection_id, job.operation, Number(job.target_revision), workerId],
  );
}

async function failJob(workerId: string, job: OutboxRow, error: Error): Promise<void> {
  const nextAttempt = Number(job.attempt_count) + 1;
  const delaySeconds = Math.min(3_600, 5 * (2 ** Math.min(nextAttempt - 1, 9)));
  const message = error.message.slice(0, 4_000);
  await pool.query(
    `UPDATE semantic_vector_outbox
        SET attempt_count = ?,
            next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND),
            locked_by = NULL,
            locked_until = NULL,
            last_error = ?
      WHERE connection_id = ? AND operation = ? AND target_revision = ? AND locked_by = ?`,
    [
      nextAttempt,
      delaySeconds,
      message,
      job.connection_id,
      job.operation,
      Number(job.target_revision),
      workerId,
    ],
  );
  if (job.operation === "upsert") {
    await pool.query(
      `UPDATE semantic_models
          SET vector_status = 'error', vector_error = ?
        WHERE connection_id = ? AND revision = ?`,
      [message, job.connection_id, Number(job.target_revision)],
    );
  }
}

async function processJob(workerId: string, job: OutboxRow): Promise<void> {
  try {
    if (job.operation === "delete") {
      await ensureCollection();
      await deleteSemanticModel(job.connection_id);
      await completeJob(workerId, job);
      return;
    }

    const [rows] = await pool.query<ModelRow[]>(
      `SELECT sm.model_json, sm.revision, sm.updated_at, dc.semantic_key
         FROM semantic_models sm
         JOIN db_connections dc ON dc.id = sm.connection_id
        WHERE sm.connection_id = ?`,
      [job.connection_id],
    );
    if (rows.length === 0 || Number(rows[0].revision) !== Number(job.target_revision)) {
      await completeJob(workerId, job);
      return;
    }
    const row = rows[0];
    const rawModel = typeof row.model_json === "string" ? JSON.parse(row.model_json) : row.model_json;
    const model = SemanticModelDocumentSchema.parse(rawModel);
    await upsertSemanticModel({
      connectionId: job.connection_id,
      semanticKey: row.semantic_key,
      modelRevision: Number(row.revision),
      model,
      modelUpdatedAt: new Date(row.updated_at).toISOString(),
    });
    await pool.query(
      `UPDATE semantic_models
          SET vector_status = 'ready', vector_error = NULL, vector_updated_at = CURRENT_TIMESTAMP
        WHERE connection_id = ? AND revision = ?`,
      [job.connection_id, Number(row.revision)],
    );
    await completeJob(workerId, job);
  } catch (error) {
    await failJob(workerId, job, error as Error);
  }
}

export async function processVectorOutboxOnce(workerId = randomUUID()): Promise<number> {
  let processed = 0;
  for (; processed < MAX_JOBS_PER_TICK; processed += 1) {
    const job = await claimJob(workerId);
    if (!job) break;
    await processJob(workerId, job);
  }
  return processed;
}

export interface VectorOutboxWorker {
  stop(): Promise<void>;
}

export function startVectorOutboxWorker(): VectorOutboxWorker {
  const workerId = randomUUID();
  let stopped = false;
  let active: Promise<void> = Promise.resolve();

  const run = (): void => {
    if (stopped) return;
    active = active.then(async () => {
      if (stopped) return;
      try {
        await processVectorOutboxOnce(workerId);
      } catch (error) {
        console.error(`[Vector outbox] Worker pass failed: ${(error as Error).message}`);
      }
    });
  };

  run();
  const timer = setInterval(run, POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await active;
    },
  };
}
