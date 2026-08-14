import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import app from "../src/server";
import pool from "../src/db/connection";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session";
import { encryptSecret } from "../src/utils/secretCrypto";
import { fetchMetadata } from "../src/routes/semanticLayer/dataCatalog";
import { buildSemanticDatasource } from "../src/semanticModels/datasource";
import type { DatabaseConnection } from "../src/types/types";
import type { SemanticModelDocument } from "../src/semanticModels/schema";
import { beginGeneration, saveGeneratedModel } from "../src/semanticModels/store";

interface Identity {
  id: number;
  username: string;
  role: "admin" | "user";
}

async function createIdentity(role: "admin" | "user"): Promise<Identity> {
  const username = `semantic_api_${role}_${randomUUID().slice(0, 8)}`;
  const [result] = await pool.query<ResultSetHeader>(
    "INSERT INTO users (username, role, is_active) VALUES (?, ?, 1)",
    [username, role],
  );
  await pool.query("UPDATE users SET created_by = id, updated_by = id WHERE id = ?", [result.insertId]);
  return { id: result.insertId, username, role };
}

async function request(baseUrl: string, path: string, init: RequestInit = {}, cookie?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-api-key", process.env.API_KEY || "default-dev-key");
  if (init.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function login(_baseUrl: string, identity: Identity): Promise<string> {
  const session = await createSession(identity.id);
  return `${SESSION_COOKIE_NAME}=${session.token}`;
}

async function expect(response: Response, status: number, label: string, code?: string): Promise<Record<string, any>> {
  const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (response.status !== status) throw new Error(`${label}: expected ${status}, received ${response.status}`);
  if (code && payload?.code !== code) throw new Error(`${label}: expected code ${code}, received ${String(payload?.code)}`);
  return payload;
}

async function main(): Promise<void> {
  const identities: Identity[] = [];
  let connectionId = 0;
  let server: Server | undefined;
  try {
    identities.push(await createIdentity("admin"), await createIdentity("user"));
    const admin = identities[0];
    const suffix = randomUUID().slice(0, 8);
    const [connectionResult] = await pool.query<ResultSetHeader>(
      `INSERT INTO db_connections
         (connection_name, semantic_key, db_type, host, default_schema, db_user,
          db_password, created_by, updated_by)
       VALUES (?, ?, 'mysql', ?, ?, ?, ?, ?, ?)`,
      [
        `Semantic API Selftest ${suffix}`,
        `mysql_semantic_api_selftest_${suffix}`,
        `${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || "3306"}`,
        process.env.DB_NAME || "autonomous_db",
        process.env.DB_USER || "root",
        encryptSecret(process.env.DB_PASSWORD || "root"),
        admin.id,
        admin.id,
      ],
    );
    connectionId = connectionResult.insertId;
    const [connectionRows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections WHERE id = ?", [connectionId]);
    const connection = connectionRows[0] as DatabaseConnection;
    const metadata = await fetchMetadata(connection);
    const table = metadata.tables.find((candidate) => candidate.table_name.toLowerCase() === "schema_migrations") || metadata.tables[0];
    if (!table) throw new Error("No table available for semantic API self-test");
    const columns = metadata.columns.filter((column) => column.table_name.toLowerCase() === table.table_name.toLowerCase());
    const model: SemanticModelDocument = {
      version: "1.0",
      model_name: "SemanticApiSelftest",
      domain: "Platform",
      description: "Temporary endpoint contract model.",
      datasource: buildSemanticDatasource(connection),
      entities: [{
        name: "Migration",
        table_name: table.table_name,
        description: "Migration history.",
        primary_keys: columns.filter((column) => column.is_primary_key).map((column) => column.column_name),
        dimensions: columns.map((column) => ({
          name: column.column_name,
          column_name: column.column_name,
          datatype: column.data_type,
          description: `Column ${column.column_name}.`,
        })),
        measures: [],
      }],
      relationships: [],
    };
    const jobId = randomUUID();
    await beginGeneration(connectionId, jobId, admin.id);
    await saveGeneratedModel({ connectionId, model, expectedRevision: 0, userId: admin.id, generationJobId: jobId });

    server = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const adminCookie = await login(baseUrl, admin);
    const userCookie = await login(baseUrl, identities[1]);
    const root = `/api/semantic-models/${connectionId}`;

    const initial = await expect(await request(baseUrl, root, {}, userCookie), 200, "User model read");
    if (initial.data.revision !== 1 || initial.data.model?.entities?.length !== 1) {
      throw new Error("GET semantic model returned the wrong revision/model");
    }
    await expect(await request(baseUrl, `${root}/generate`, {
      method: "POST",
      body: JSON.stringify({ tables: [table.table_name], mode: "append" }),
    }, userCookie), 403, "User generation guard");
    await expect(await request(baseUrl, `${root}/generate`, {
      method: "POST",
      body: JSON.stringify({ tables: [], mode: "full" }),
    }, adminCookie), 400, "Invalid generation request", "INVALID_SEMANTIC_MODEL");
    await expect(await request(baseUrl, `${root}/generate`, {
      method: "POST",
      body: JSON.stringify({ tables: [table.table_name], mode: "append" }),
    }, adminCookie), 202, "Append generation accepted");

    let revision = 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await expect(await request(baseUrl, root, {}, adminCookie), 200, "Generation poll");
      if (current.data.status !== "generating") {
        revision = current.data.revision;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (revision !== 2) throw new Error("Append generation did not finish at revision 2");

    await expect(await request(baseUrl, `${root}/regenerate-table`, {
      method: "POST",
      body: JSON.stringify({ table: "unknown_table", revision }),
    }, adminCookie), 400, "Unknown table regeneration", "UNKNOWN_TABLE");
    await expect(await request(baseUrl, root, {
      method: "PUT",
      body: JSON.stringify({ model, revision: 1 }),
    }, adminCookie), 409, "Stale save", "STALE_MODEL_REVISION");
    const invalid = structuredClone(model);
    invalid.entities[0].table_name = "unknown_table";
    await expect(await request(baseUrl, root, {
      method: "PUT",
      body: JSON.stringify({ model: invalid, revision }),
    }, adminCookie), 400, "Invalid save", "INVALID_SEMANTIC_MODEL");

    const edited = structuredClone(model);
    edited.description = "Valid manual endpoint edit.";
    const saved = await expect(await request(baseUrl, root, {
      method: "PUT",
      body: JSON.stringify({ model: edited, revision }),
    }, adminCookie), 200, "Valid save");
    revision = saved.data.revision;
    await expect(await request(baseUrl, `${root}/retry-vector-sync`, { method: "POST" }, adminCookie), 202, "Vector retry");
    const removed = await expect(await request(baseUrl, `${root}/tables`, {
      method: "DELETE",
      body: JSON.stringify({ table: table.table_name, revision }),
    }, adminCookie), 200, "Table removal");
    if (removed.data.model.entities.length !== 0) throw new Error("DELETE table did not remove the selected entity");
    await expect(await request(baseUrl, `/api/semantic-models/2147483000`, {}, adminCookie), 404, "Missing model connection", "CONNECTION_NOT_FOUND");

    console.log("[Semantic API self-test] PASS: catalog separation, role guards, 202 jobs, stable errors, optimistic save, retry, and delete");
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (connectionId) {
      await pool.query("DELETE FROM semantic_vector_outbox WHERE connection_id = ?", [connectionId]).catch(() => undefined);
      await pool.query("DELETE FROM db_connections WHERE id = ?", [connectionId]).catch(() => undefined);
    }
    for (const identity of identities) {
      await pool.query("UPDATE users SET created_by = NULL, updated_by = NULL WHERE id = ?", [identity.id]).catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id = ?", [identity.id]).catch(() => undefined);
    }
    await pool.end().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[Semantic API self-test] FAIL: ${(error as Error).message}`);
    process.exit(1);
  },
);
