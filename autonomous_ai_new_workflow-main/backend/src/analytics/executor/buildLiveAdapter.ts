import mysql from "mysql2/promise";
import { Pool as PgPool } from "pg";
import mssql from "mssql";
import sqlite3 from "sqlite3";
import snowflake from "snowflake-sdk";
import { BigQuery } from "@google-cloud/bigquery";
import { DBSQLClient } from "@databricks/sql";
import fs from "node:fs";
import path from "node:path";
import { DatabaseConnection, LiveAdapter, DialectType, CompiledQuery, QueryResult } from "../../types/types";
import { parseHostPort } from "../../utils/connectionTester";
import { decryptConnectionSecrets } from "../../utils/secretCrypto";
import { withTimeout } from "./timeoutWrapper";
import {
  evictAdapterPoolsByConnection,
  getAdapterPool,
  hasAdapterPool,
  setAdapterPool,
  touchAdapterPool,
} from "./adapterPoolRegistry";

const DEFAULT_SQLITE_DATA_DIR = path.resolve(process.cwd(), "data");
const dbSslEnabled = () => process.env.DB_SSL === "true";
const sslRejectUnauthorized = () => process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false";

export async function evictAdapterPool(connectionId: string): Promise<void> {
  await evictAdapterPoolsByConnection(connectionId);
}

async function buildLiveAdapter(connection: DatabaseConnection): Promise<LiveAdapter> {
  const decryptedConnection = decryptConnectionSecrets(connection);
  const { hostname, port } = parseHostPort(decryptedConnection.host, decryptedConnection.db_type);
  const type = (decryptedConnection.db_type || "").toLowerCase();
  const poolKey = `${decryptedConnection.id}-${hostname}-${type}`;

  let creds: any = {};
  try {
    const credStr = decryptedConnection.credentials_json || decryptedConnection.db_password;
    if (credStr) creds = JSON.parse(credStr);
  } catch (e) {}



  let dialect: CompiledQuery["dialect"] = "mysql";
  if (type === "postgresql" || type === "redshift") dialect = "postgresql";
  else if (type === "sql server" || type === "mssql") dialect = "sqlserver";
  else if (type === "sqlite") dialect = "sqlite";
  else if (type === "snowflake") dialect = "snowflake";
  else if (type === "bigquery") dialect = "bigquery";
  else if (type === "databricks") dialect = "databricks";
  else if (type === "mysql" || type === "mariadb") dialect = "mysql";
  else throw new Error(`Unsupported database type for analytics queries: ${type}`);

  const mapRows = (query: CompiledQuery, rows: any[], rowCount: number): QueryResult => ({
    dataset: query.datasets?.[0] || query.dataset,
    metric: query.metric,
    groupBy: query.groupBy,
    sql: query.sql,
    rowCount: rowCount || rows.length,
    rows: rows.map((r: any) => {
      // If there is no metric, it's a raw list query, just return the raw row object.
      if (!query.metric) return r;

      let value = r.metric_value;
      if (value !== null && value !== undefined) {
        const numVal = Number(value);
        if (!isNaN(numVal)) {
          value = numVal;
        } else {
          console.warn(`[AnalyticsQuery] Non-numeric metric value encountered:`, value);
        }
      }

      const keyParts: string[] = [];
      const formatKeyPart = (value: unknown) =>
        value === null || value === undefined || value === "" ? "Unspecified" : String(value);

      if (r.time_key !== undefined) {
        keyParts.push(formatKeyPart(r.time_key));
      }
      if (r.group_key !== undefined) {
        keyParts.push(formatKeyPart(r.group_key));
      } else {
        const groupedAliases = Object.keys(r)
          .filter((key) => /^group_key_\d+$/.test(key))
          .sort((a, b) => Number(a.split("_").pop()) - Number(b.split("_").pop()));
        for (const alias of groupedAliases) {
          if (r[alias] !== undefined) {
            keyParts.push(formatKeyPart(r[alias]));
          }
        }
      }

      return {
        key: keyParts.length ? keyParts.join(" | ") : undefined,
        value,
      };
    }),
  });

  if (dialect === "postgresql") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      const pool = new PgPool({
        host: hostname, port, database: decryptedConnection.default_schema || "postgres",
        user: decryptedConnection.db_user, password: decryptedConnection.db_password,
        ssl: creds.ssl !== undefined ? creds.ssl : (dbSslEnabled() ? { rejectUnauthorized: sslRejectUnauthorized() } : undefined),
      });
      setAdapterPool(poolKey, pool);
    }
    const client = getAdapterPool<PgPool>(poolKey);
    return {
      dialect,
      execute: async (query: CompiledQuery, signal?: AbortSignal) => {
        let clientConn: any = null;
        let released = false;
        const releaseOnce = (err?: Error) => {
          if (released || !clientConn) return;
          released = true;
          clientConn.release(err);
        };
        return withTimeout(async () => {
          clientConn = await client.connect();
          const result = await clientConn.query({
            text: query.sql,
            values: query.params as any[]
          });
          return mapRows(query, result.rows, result.rowCount || result.rows.length);
        }, {
          timeoutMs: 30000,
          onTimeout: async () => releaseOnce(new Error("Timeout"))
        }).finally(() => releaseOnce());
      },
      close: async () => { }, // Pool handles lifecycle
    };
  }

  if (dialect === "sqlserver") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      const pool = new mssql.ConnectionPool({
        server: hostname, port, user: decryptedConnection.db_user, password: decryptedConnection.db_password, database: decryptedConnection.default_schema || "",
        options: { encrypt: creds.encrypt !== undefined ? creds.encrypt : true, ...creds.options }
      });
      await pool.connect();
      setAdapterPool(poolKey, pool);
    }
    const pool = getAdapterPool<mssql.ConnectionPool>(poolKey);
    return {
      dialect,
      execute: async (query: CompiledQuery) => withTimeout(async () => {
        const req = pool.request();
        query.params.forEach((p: any, i: number) => req.input(`p${i + 1}`, p));
        const result = await req.query(query.sql);
        return mapRows(query, result.recordset, result.recordset.length);
      }, { timeoutMs: 30000 }),
      close: async () => { }, // Pool handles lifecycle
    };
  }

  if (dialect === "sqlite") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      if (!hostname || (!hostname.endsWith(".sqlite") && !hostname.endsWith(".db"))) {
        throw new Error("Invalid SQLite connection string. Host must be an absolute path to a .sqlite or .db file.");
      }
      const resolvedPath = path.resolve(hostname);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`SQLite database file not found at ${resolvedPath}`);
      }
      const realPath = fs.realpathSync(resolvedPath);
      let allowedRoot = path.resolve(process.env.SQLITE_DATA_DIR || DEFAULT_SQLITE_DATA_DIR);
      if (fs.existsSync(allowedRoot)) {
        allowedRoot = fs.realpathSync(allowedRoot);
      }
      if (!realPath.startsWith(allowedRoot)) {
        throw new Error(`SQLite database file must be inside SQLITE_DATA_DIR (${allowedRoot}).`);
      }
      const db = new sqlite3.Database(resolvedPath, sqlite3.OPEN_READONLY);
      setAdapterPool(poolKey, db as any);
    }
    const db = getAdapterPool<any>(poolKey);
    return {
      dialect,
      // node-sqlite3 has no query-cancellation API, so a timed-out query keeps
      // running against the local file in the background; withTimeout still
      // bounds this call's latency to 30s from the caller's perspective.
      execute: async (query: CompiledQuery) => withTimeout(async () => {
        return new Promise<QueryResult>((resolve, reject) => {
          db.all(query.sql, query.params as any[], (err: any, rows: any) => {
            if (err) return reject(err);
            resolve(mapRows(query, rows, rows.length));
          });
        });
      }, { timeoutMs: 30000 }),
      close: async () => { },
    };
  }

  if (dialect === "snowflake") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      const conn = snowflake.createConnection({
        account: hostname, username: decryptedConnection.db_user || "", password: decryptedConnection.db_password || "", schema: decryptedConnection.default_schema,
        database: creds.database || undefined
      });
      await new Promise<void>((res, rej) => conn.connect((err) => err ? rej(err) : res()));
      setAdapterPool(poolKey, conn as any);
    }
    const conn = getAdapterPool<any>(poolKey);
    return {
      dialect,
      execute: async (query: CompiledQuery) => {
        let statement: any = null;
        return withTimeout(async () => {
          return new Promise<QueryResult>((resolve, reject) => {
            statement = conn.execute({
              sqlText: query.sql, binds: query.params as any[],
              complete: (err: any, stmt: any, rows: any) => {
                if (err) return reject(err);
                const lowerRows = (rows || []).map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
                resolve(mapRows(query, lowerRows, lowerRows.length));
              }
            });
          });
        }, {
          timeoutMs: 30000,
          onTimeout: async () => { statement?.cancel?.(() => {}); },
        });
      },
      close: async () => { },
    };
  }

  if (dialect === "bigquery") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      if (!creds || Object.keys(creds).length === 0) {
        throw new Error("Invalid BigQuery credentials. Ensure credentials_json or db_password contains a valid JSON service account key.");
      }
      const credentials = creds;
      const bq = new BigQuery({ projectId: hostname, credentials });
      setAdapterPool(poolKey, bq as any);
    }
    const bq = getAdapterPool<any>(poolKey);
    return {
      dialect,
      execute: async (query: CompiledQuery) => {
        let job: any = null;
        return withTimeout(async () => {
          [job] = await bq.createQueryJob({ query: query.sql, params: query.params });
          const [rows] = await job.getQueryResults();
          return mapRows(query, rows, rows.length);
        }, {
          timeoutMs: 30000,
          onTimeout: async () => { await job?.cancel?.().catch(() => {}); },
        });
      },
      close: async () => { },
    };
  }

  if (dialect === "databricks") {
    touchAdapterPool(poolKey);
    if (!hasAdapterPool(poolKey)) {
      const client = new DBSQLClient();
      await client.connect({ host: hostname, port, path: decryptedConnection.default_schema || "", token: decryptedConnection.db_password || "" });
      setAdapterPool(poolKey, client);
    }
    const client = getAdapterPool<DBSQLClient>(poolKey);
    let session: any = null;
    let sessionClosed = false;
    // Closing resets state so the NEXT execute() opens a fresh session,
    // rather than every subsequent call failing forever against a closed one
    // (this matters once onTimeout can close the session mid-flight below).
    const closeSession = async () => {
      if (sessionClosed || !session) return;
      sessionClosed = true;
      const toClose = session;
      session = null;
      await toClose.close().catch(() => {});
      sessionClosed = false;
    };
    return {
      dialect,
      execute: async (query: CompiledQuery) => withTimeout(async () => {
        if (!session) session = await client.openSession();
        let op: any;
        try {
          op = await session.executeStatement(query.sql, {
            runAsync: true,
            ordinalParameters: query.params as any[],
          });
          let rows = await op.fetchAll();
          const schema = await op.getSchema();
          const columnNames = schema?.columns?.map((c: any) => c.name.toLowerCase()) || [];
          if (Array.isArray(rows)) {
            rows = rows.map((r: any) => {
              if (Array.isArray(r)) {
                const mapped: Record<string, unknown> = {};
                columnNames.forEach((name: string, index: number) => {
                  mapped[name] = r[index];
                });
                if (mapped.metric_value === undefined && r.length > 0) {
                  mapped.metric_value = r[0];
                }
                return mapped;
              }
              return r;
            });
          }
          return mapRows(query, rows, rows.length);
        } catch (error) {
          await closeSession().catch(() => { });
          throw error;
        } finally {
          await op?.close?.().catch?.(() => { });
        }
      }, {
        timeoutMs: 30000,
        onTimeout: async () => { await closeSession().catch(() => {}); },
      }),
      close: closeSession, // Keep client connected
    };
  }

  // Default: MySQL / MariaDB
  touchAdapterPool(poolKey);
  if (!hasAdapterPool(poolKey)) {
    const mysqlPool = await mysql.createPool({
      host: hostname, port, database: decryptedConnection.default_schema || undefined,
      user: decryptedConnection.db_user,
      password: decryptedConnection.db_password,
      ssl: creds.ssl !== undefined ? creds.ssl : (dbSslEnabled() ? { rejectUnauthorized: sslRejectUnauthorized() } : undefined),
    });
    setAdapterPool(poolKey, mysqlPool);
  }
  const mysqlPool = getAdapterPool<mysql.Pool>(poolKey);

  return {
    dialect,
    execute: async (query: CompiledQuery, signal?: AbortSignal) => {
      let conn: any = null;
      let handled = false;
      return withTimeout(async () => {
        conn = await mysqlPool.getConnection();
        const [rows] = await conn.query(query.sql, query.params as any[]);
        const rowArr = rows as Record<string, unknown>[];
        return mapRows(query, rowArr, rowArr.length);
      }, {
        timeoutMs: 30000,
        onTimeout: async () => {
          if (!conn || handled) return;
          handled = true;
          conn.destroy();
        }
      }).finally(() => {
        if (!conn || handled) return;
        handled = true;
        conn.release();
      });
    },
    close: async () => { }, // Pool handles lifecycle
  };
}
export { buildLiveAdapter };
