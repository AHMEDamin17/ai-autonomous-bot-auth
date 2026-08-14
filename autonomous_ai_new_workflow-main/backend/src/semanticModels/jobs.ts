import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../db/connection";
import type { DatabaseConnection } from "../types/types";
import {
  appendTables,
  generateFull,
  loadGenerationContext,
  regenerateTable,
  removeTable,
  UnknownSemanticTableError,
} from "./generator";
import {
  beginGeneration,
  getModel,
  markGenerationFailed,
  saveGeneratedModel,
  saveOperationModel,
  SemanticModelBusyError,
  SemanticModelRevisionConflictError,
} from "./store";

export interface GenerationJobAccepted {
  jobId: string;
  connectionId: number;
}

async function loadConnection(connectionId: number): Promise<DatabaseConnection> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM db_connections WHERE id = ?",
    [connectionId],
  );
  if (rows.length === 0) {
    const error = new Error(`Connection ${connectionId} was not found`);
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  return rows[0] as DatabaseConnection;
}

function safeGenerationError(error: unknown): string {
  if (error instanceof UnknownSemanticTableError) return error.message;
  if (error instanceof SemanticModelRevisionConflictError) {
    return "The semantic model changed while generation was running; reload and retry.";
  }
  if (error instanceof SemanticModelBusyError) {
    return "Another semantic-model operation is already active.";
  }
  const message = String((error as Error)?.message || "").toLowerCase();
  if (message.includes("rate") || message.includes("quota")) {
    return "The model provider is temporarily rate limited; retry later.";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "Semantic generation timed out; reduce the table selection or retry.";
  }
  return "Semantic generation failed. Check the configured provider and retry.";
}

async function runGeneration(args: {
  connectionId: number;
  userId: number;
  jobId: string;
  revision: number;
  operation:
    | { kind: "full"; tables: string[] | "all" }
    | { kind: "append"; tables: string[] }
    | { kind: "regenerate"; table: string };
}): Promise<void> {
  try {
    const connection = await loadConnection(args.connectionId);
    const stored = await getModel(args.connectionId);
    let model;
    if (args.operation.kind === "full") {
      model = await generateFull(connection, args.operation.tables);
    } else if (args.operation.kind === "append") {
      if (!stored?.model) throw new Error("Append requires an existing semantic model");
      model = await appendTables(connection, args.operation.tables, stored.model);
    } else {
      if (!stored?.model) throw new Error("Table regeneration requires an existing semantic model");
      model = await regenerateTable(connection, args.operation.table, stored.model);
    }
    await saveGeneratedModel({
      connectionId: args.connectionId,
      model,
      expectedRevision: args.revision,
      userId: args.userId,
      generationJobId: args.jobId,
    });
  } catch (error) {
    console.error(`[Semantic generation] Job ${args.jobId} failed: ${(error as Error).name}`);
    await markGenerationFailed(
      args.connectionId,
      args.jobId,
      safeGenerationError(error),
      args.userId,
    ).catch((markError) => {
      console.error(`[Semantic generation] Failed to record job state: ${(markError as Error).message}`);
    });
  }
}

export async function startFullOrAppendGeneration(args: {
  connectionId: number;
  userId: number;
  tables: string[] | "all";
  mode: "full" | "append";
}): Promise<GenerationJobAccepted> {
  if (args.mode === "append" && args.tables === "all") {
    throw new Error("Append requires an explicit table selection");
  }
  const connection = await loadConnection(args.connectionId);
  await loadGenerationContext(connection, args.tables);
  if (args.mode === "append" && !(await getModel(args.connectionId))?.model) {
    throw new Error("Append requires an existing semantic model");
  }
  const jobId = randomUUID();
  const state = await beginGeneration(args.connectionId, jobId, args.userId);
  void runGeneration({
    connectionId: args.connectionId,
    userId: args.userId,
    jobId,
    revision: state.revision,
    operation: args.mode === "full"
      ? { kind: "full", tables: args.tables }
      : { kind: "append", tables: args.tables as string[] },
  });
  return { jobId, connectionId: args.connectionId };
}

export async function startTableRegeneration(args: {
  connectionId: number;
  userId: number;
  table: string;
  expectedRevision: number;
}): Promise<GenerationJobAccepted> {
  const current = await getModel(args.connectionId);
  if (!current?.model) throw new Error("No semantic model exists for this connection");
  if (current.revision !== args.expectedRevision) {
    throw new SemanticModelRevisionConflictError(current.revision);
  }
  const connection = await loadConnection(args.connectionId);
  await loadGenerationContext(connection, [args.table]);
  if (!current.model.entities.some((entity) => entity.table_name.toLowerCase() === args.table.toLowerCase())) {
    throw new UnknownSemanticTableError(args.table);
  }
  const jobId = randomUUID();
  const state = await beginGeneration(args.connectionId, jobId, args.userId);
  if (state.revision !== args.expectedRevision) {
    await markGenerationFailed(args.connectionId, jobId, "The model changed before regeneration started.", args.userId);
    throw new SemanticModelRevisionConflictError(state.revision);
  }
  void runGeneration({
    connectionId: args.connectionId,
    userId: args.userId,
    jobId,
    revision: state.revision,
    operation: { kind: "regenerate", table: args.table },
  });
  return { jobId, connectionId: args.connectionId };
}

export async function removeModelTable(args: {
  connectionId: number;
  userId: number;
  table: string;
  expectedRevision: number;
}) {
  const connection = await loadConnection(args.connectionId);
  const current = await getModel(args.connectionId);
  if (!current?.model) throw new Error("No semantic model exists for this connection");
  if (current.status === "generating") throw new SemanticModelBusyError();
  if (current.revision !== args.expectedRevision) {
    throw new SemanticModelRevisionConflictError(current.revision);
  }
  const model = await removeTable(connection, args.table, current.model);
  return saveOperationModel({
    connectionId: args.connectionId,
    model,
    expectedRevision: args.expectedRevision,
    userId: args.userId,
  });
}
