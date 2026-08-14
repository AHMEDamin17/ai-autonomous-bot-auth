import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../src/db/connection";
import { encryptSecret } from "../src/utils/secretCrypto";
import { fetchMetadata } from "../src/routes/semanticLayer/dataCatalog";
import { buildSemanticDatasource } from "../src/semanticModels/datasource";
import type { SemanticModelDocument } from "../src/semanticModels/schema";
import {
  enqueueVectorDeleteBeforeConnectionDeletion,
  beginGeneration,
  getModel,
  retryVectorSync,
  saveGeneratedModel,
  saveModel,
  markGenerationFailed,
  markGenerationStarted,
  SemanticModelRevisionConflictError,
  SemanticModelBusyError,
  resetInterruptedGenerations,
} from "../src/semanticModels/store";
import { processVectorOutboxOnce } from "../src/semanticModels/vectorOutboxWorker";
import { resetVectorConfigForTests } from "../src/vector/config";
import { resetQdrantClientForTests, retrieveSemanticModel } from "../src/vector/qdrant";

async function main(): Promise<void> {
  const suffix = randomUUID().slice(0, 8);
  const username = `model_store_selftest_${suffix}`;
  const semanticKey = `mysql_model_store_selftest_${suffix}`;
  let userId = 0;
  let connectionId = 0;
  const originalQdrantUrl = process.env.QDRANT_URL;

  try {
    const [userResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO users (username, role, is_active)
       VALUES (?, 'admin', 1)`,
      [username],
    );
    userId = userResult.insertId;
    await pool.query("UPDATE users SET created_by = ?, updated_by = ? WHERE id = ?", [userId, userId, userId]);

    const host = `${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || "3306"}`;
    const databaseName = process.env.DB_NAME || "autonomous_db";
    const [connectionResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO db_connections
         (connection_name, semantic_key, db_type, host, default_schema, db_user,
          db_password, created_by, updated_by)
       VALUES (?, ?, 'mysql', ?, ?, ?, ?, ?, ?)`,
      [
        `Model Store Selftest ${suffix}`,
        semanticKey,
        host,
        databaseName,
        process.env.DB_USER || "root",
        encryptSecret(process.env.DB_PASSWORD || "root"),
        userId,
        userId,
      ],
    );
    connectionId = connectionResult.insertId;

    const [connectionRows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections WHERE id = ?", [connectionId]);
    const connection = connectionRows[0] as any;
    const metadata = await fetchMetadata(connection);
    const table = metadata.tables.find((candidate) => candidate.table_name.toLowerCase() === "schema_migrations")
      || metadata.tables[0];
    if (!table) throw new Error("Self-test metadata has no table");
    const columns = metadata.columns.filter((column) => column.table_name.toLowerCase() === table.table_name.toLowerCase());
    if (columns.length === 0) throw new Error("Self-test table has no columns");

    const model: SemanticModelDocument = {
      version: "1.0",
      model_name: "Model Store Selftest",
      domain: "Internal",
      description: "Temporary model for authoritative store validation.",
      datasource: buildSemanticDatasource(connection),
      entities: [{
        name: "Migration",
        table_name: table.table_name,
        description: "Applied database migration.",
        primary_keys: columns.filter((column) => column.is_primary_key).map((column) => column.column_name),
        dimensions: columns.map((column) => ({
          name: column.column_name,
          column_name: column.column_name,
          datatype: column.data_type,
          description: `Source column ${column.column_name}.`,
        })),
        measures: [],
      }],
      relationships: [],
    };

    const initialJobId = randomUUID();
    await beginGeneration(connectionId, initialJobId, userId);
    const first = await saveGeneratedModel({
      connectionId,
      model,
      expectedRevision: 0,
      userId,
      generationJobId: initialJobId,
    });
    if (first.revision !== 1 || first.vectorStatus !== "pending"
      || first.createdBy !== userId || first.updatedBy !== userId) {
      throw new Error("Initial model save did not produce revision 1/pending with audit stamps");
    }

    let conflictSeen = false;
    try {
      await saveModel(connectionId, model, 0, userId);
    } catch (error) {
      conflictSeen = error instanceof SemanticModelRevisionConflictError;
    }
    if (!conflictSeen) throw new Error("Stale revision was not rejected");

    const invalidModel = structuredClone(model);
    invalidModel.entities[0].table_name = "table_that_does_not_exist";
    let invalidSeen = false;
    try {
      await saveModel(connectionId, invalidModel, 1, userId);
    } catch {
      invalidSeen = true;
    }
    if (!invalidSeen || (await getModel(connectionId))?.revision !== 1) {
      throw new Error("Invalid model reached the authoritative store");
    }

    process.env.QDRANT_URL = "http://127.0.0.1:6332";
    resetVectorConfigForTests();
    resetQdrantClientForTests();
    const editedModel = structuredClone(model);
    editedModel.description = "Manual description edit saved while Qdrant is unavailable.";
    const second = await saveModel(connectionId, editedModel, 1, userId);
    if (second.revision !== 2 || second.updatedBy !== userId) {
      throw new Error("Offline MySQL save did not reach revision 2 with its editor audit stamp");
    }
    await processVectorOutboxOnce();
    const afterFailure = await getModel(connectionId);
    if (afterFailure?.revision !== 2 || afterFailure.vectorStatus !== "error") {
      throw new Error("Vector outage did not preserve the authoritative revision with diagnostics");
    }

    if (originalQdrantUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = originalQdrantUrl;
    resetVectorConfigForTests();
    resetQdrantClientForTests();
    await retryVectorSync(connectionId);
    await processVectorOutboxOnce();
    const repaired = await getModel(connectionId);
    const indexed = await retrieveSemanticModel(connectionId);
    if (repaired?.vectorStatus !== "ready" || indexed?.model_revision !== 2) {
      throw new Error("Vector retry did not repair the derived Qdrant point");
    }

    const failedJobId = randomUUID();
    await markGenerationStarted(connectionId, failedJobId, userId);
    let busySeen = false;
    try {
      await beginGeneration(connectionId, randomUUID(), userId);
    } catch (error) {
      busySeen = error instanceof SemanticModelBusyError;
    }
    if (!busySeen) throw new Error("Overlapping generation lease was not rejected");
    await markGenerationFailed(connectionId, failedJobId, "intentional self-test failure", userId);
    const afterGenerationFailure = await getModel(connectionId);
    if (afterGenerationFailure?.revision !== 2
      || afterGenerationFailure.status !== "error"
      || afterGenerationFailure.model?.description !== editedModel.description) {
      throw new Error("Failed generation did not preserve the previous valid model/revision");
    }

    const interruptedJobId = randomUUID();
    await beginGeneration(connectionId, interruptedJobId, userId);
    await pool.query(
      "UPDATE semantic_models SET generation_started_at = DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 1 HOUR) WHERE connection_id = ?",
      [connectionId],
    );
    const oldLease = process.env.SEMANTIC_GENERATION_LEASE_MS;
    process.env.SEMANTIC_GENERATION_LEASE_MS = "60000";
    const resetCount = await resetInterruptedGenerations();
    if (oldLease === undefined) delete process.env.SEMANTIC_GENERATION_LEASE_MS;
    else process.env.SEMANTIC_GENERATION_LEASE_MS = oldLease;
    if (resetCount < 1 || (await getModel(connectionId))?.status !== "error") {
      throw new Error("Expired generation lease was not recovered as an error");
    }

    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      await enqueueVectorDeleteBeforeConnectionDeletion(db, connectionId);
      await db.query("DELETE FROM db_connections WHERE id = ?", [connectionId]);
      await db.commit();
      connectionId = 0;
    } catch (error) {
      await db.rollback();
      throw error;
    } finally {
      db.release();
    }
    await processVectorOutboxOnce();
    if (await retrieveSemanticModel(connectionResult.insertId)) {
      throw new Error("Connection deletion did not remove the derived Qdrant point");
    }

    console.log("[Model store self-test] PASS: validation, revisions, offline save/repair, and durable delete");
  } finally {
    if (originalQdrantUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = originalQdrantUrl;
    resetVectorConfigForTests();
    resetQdrantClientForTests();
    if (connectionId) {
      await pool.query("DELETE FROM db_connections WHERE id = ?", [connectionId]).catch(() => undefined);
    }
    if (userId) {
      await pool.query("DELETE FROM users WHERE id = ?", [userId]).catch(() => undefined);
    }
    await pool.end();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[Model store self-test] FAIL: ${(error as Error).message}`);
    process.exit(1);
  },
);
