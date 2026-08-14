import { Router, Request, Response, NextFunction } from "express";
import pool from "../../db/connection";
import { parseHostPort } from "../../utils/connectionTester";
import {
  DatabaseConnection,
  CatalogEntry,
  CatalogTable,
  CatalogColumn,
  CatalogFunction,
  CatalogRelationship,
  ApiResponse,
  ApiError,
} from "../../types/types";
import { RowDataPacket } from "mysql2";
import mssql from "mssql";
import sqlite3 from "sqlite3";
import snowflake from "snowflake-sdk";
import { BigQuery } from "@google-cloud/bigquery";
import { DBSQLClient } from "@databricks/sql";
import dotenv from "dotenv";
import { decryptConnectionSecrets, decryptSecret } from "../../utils/secretCrypto";
import { closePool, getMongoClient, getMssqlPool, getMysqlPool, getPgPool } from "../../connections/poolManager";
dotenv.config();

const dbSslEnabled = () => process.env.DB_SSL === "true";
const sslRejectUnauthorized = () => process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false";

export async function evictCatalogPool(connection: DatabaseConnection): Promise<void> {
  const { hostname, port } = parseHostPort(connection.host, connection.db_type);
  const user = connection.db_user;
  const password = decryptSecret(connection.db_password);
  const defaultSchema = connection.default_schema;
  const key = `${hostname}:${port}:${user || ''}:${password || ''}:${defaultSchema || ''}`;

  await closePool(key, 'mysql');
  await closePool(key, 'pg');
  await closePool(key, 'mssql');
  await closePool(key, 'mongo');
}


// 1. MySQL / MariaDB
const fetchMysqlMetadata = async (hostname: string, port: number, defaultSchema?: string, user?: string, password?: string) => {
  const poolKey = `${hostname}:${port}:${user || ''}:${password || ''}:${defaultSchema || ''}`;
  const mysqlPool = getMysqlPool(poolKey, {
    host: hostname,
    port,
    user,
    password,
    database: defaultSchema,
    ssl: dbSslEnabled() ? { rejectUnauthorized: sslRejectUnauthorized() } : undefined,
    connectionLimit: 5
  });
  const conn = await mysqlPool.getConnection();
  try {
    const queryParams: string[] = defaultSchema ? [defaultSchema] : [];
    const schemaFilter = defaultSchema ? `AND TABLE_SCHEMA = ?` : `AND TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')`;
    const [tables] = await conn.query<RowDataPacket[]>(`SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ${schemaFilter}`, queryParams);
    const [views] = await conn.query<RowDataPacket[]>(`SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema FROM information_schema.TABLES WHERE TABLE_TYPE = 'VIEW' ${schemaFilter}`, queryParams);
    const [columns] = await conn.query<RowDataPacket[]>(`SELECT TABLE_NAME as table_name, COLUMN_NAME as column_name, DATA_TYPE as data_type, TABLE_SCHEMA as table_schema, (COLUMN_KEY = 'PRI') as is_primary_key, (EXTRA LIKE '%auto_increment%') as is_auto_increment FROM information_schema.COLUMNS WHERE 1=1 ${schemaFilter} ORDER BY TABLE_NAME, ORDINAL_POSITION`, queryParams);

    // Foreign Key extraction
    const [fkRows] = await conn.query<RowDataPacket[]>(
      `SELECT
         kcu.TABLE_NAME AS source_table,
         kcu.COLUMN_NAME AS source_column,
         kcu.REFERENCED_TABLE_NAME AS target_table,
         kcu.REFERENCED_COLUMN_NAME AS target_column,
         kcu.CONSTRAINT_NAME AS constraint_name
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.TABLE_CONSTRAINTS tc
         ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
         AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ${schemaFilter.replace(/TABLE_SCHEMA/g, 'kcu.TABLE_SCHEMA')}`,
      queryParams
    );
    const relationships: CatalogRelationship[] = (fkRows as any[]).map(r => ({
      sourceTable: r.source_table,
      sourceColumn: r.source_column,
      targetTable: r.target_table,
      targetColumn: r.target_column,
      constraintName: r.constraint_name,
    }));

    return { tables: tables as CatalogTable[], views: views as CatalogTable[], columns: columns as CatalogColumn[], functions: [], relationships };
  } finally {
    conn.release();
  }
};

// 2. PostgreSQL / Redshift
const fetchPostgresMetadata = async (hostname: string, port: number, defaultSchema?: string, user?: string, password?: string) => {
  const schemaName = defaultSchema ?? "public";
  const poolKey = `${hostname}:${port}:${user || ''}:${password || ''}:${defaultSchema || ''}`;
  const pgPool = getPgPool(poolKey, {
    host: hostname,
    port,
    database: defaultSchema || "postgres",
    user,
    password,
    ssl: dbSslEnabled() ? { rejectUnauthorized: sslRejectUnauthorized() } : undefined,
    max: 5
  });
  const client = await pgPool.connect();
  try {
    const tablesRes = await client.query(`SELECT table_name, table_schema FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]);
    const viewsRes = await client.query(`SELECT table_name, table_schema FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'VIEW'`, [schemaName]);
    const columnsRes = await client.query(`SELECT c.table_name, c.column_name, c.data_type, c.table_schema,
      EXISTS (
        SELECT 1 FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
      ) AS is_primary_key,
      (c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%') AS is_auto_increment
      FROM information_schema.columns c WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`, [schemaName]);

    // Foreign Key extraction
    const fkRes = await client.query(
      `SELECT
         kcu.table_name AS source_table,
         kcu.column_name AS source_column,
         ccu.table_name AS target_table,
         ccu.column_name AS target_column,
         tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON tc.constraint_name = ccu.constraint_name
         AND tc.table_schema = ccu.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1`,
      [schemaName]
    );
    const relationships: CatalogRelationship[] = fkRes.rows.map((r: any) => ({
      sourceTable: r.source_table,
      sourceColumn: r.source_column,
      targetTable: r.target_table,
      targetColumn: r.target_column,
      constraintName: r.constraint_name,
    }));

    return { tables: tablesRes.rows, views: viewsRes.rows, columns: columnsRes.rows, functions: [], relationships };
  } finally {
    client.release();
  }
};

// 3. SQL Server (MSSQL)
const fetchMssqlMetadata = async (hostname: string, port: number, defaultSchema?: string, user?: string, password?: string) => {
  const schemaName = defaultSchema ?? "dbo";
  const poolKey = `${hostname}:${port}:${user || ''}:${password || ''}:${defaultSchema || ''}`;
  const pool = await getMssqlPool(poolKey, {
    server: hostname,
    port,
    user,
    password,
    database: defaultSchema || "master",
    options: { encrypt: false },
  });
  const req = pool.request();
  req.input("schema", mssql.NVarChar, schemaName);
  const tables = await req.query(`SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_TYPE = 'BASE TABLE'`);
  const views = await req.query(`SELECT TABLE_NAME as table_name, TABLE_SCHEMA as table_schema FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @schema AND TABLE_TYPE = 'VIEW'`);
  const columns = await req.query(`SELECT c.TABLE_NAME as table_name, c.COLUMN_NAME as column_name, c.DATA_TYPE as data_type, c.TABLE_SCHEMA as table_schema,
    CASE WHEN EXISTS (
      SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA AND tc.TABLE_NAME = c.TABLE_NAME AND kcu.COLUMN_NAME = c.COLUMN_NAME
    ) THEN 1 ELSE 0 END as is_primary_key,
    COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') as is_auto_increment
    FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = @schema ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`);

  // Foreign Key extraction
  const fkResult = await req.query(
    `SELECT
       tp.name AS source_table,
       cp.name AS source_column,
       tr.name AS target_table,
       cr.name AS target_column,
       fk.name AS constraint_name
     FROM sys.foreign_keys fk
     INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
     INNER JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
     INNER JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
     INNER JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
     INNER JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
     INNER JOIN sys.schemas s ON tp.schema_id = s.schema_id
     WHERE s.name = @schema`
  );
  const relationships: CatalogRelationship[] = (fkResult.recordset || []).map((r: any) => ({
    sourceTable: r.source_table,
    sourceColumn: r.source_column,
    targetTable: r.target_table,
    targetColumn: r.target_column,
    constraintName: r.constraint_name,
  }));

  return { tables: tables.recordset, views: views.recordset, columns: columns.recordset, functions: [], relationships };
};

// 4. SQLite
const fetchSqliteMetadata = async (filePath: string) => {
  return new Promise<any>((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) return reject(err);
    });

    db.all(`SELECT name as table_name, 'main' as table_schema FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, (err, tables: any[]) => {
      if (err) {
        db.close();
        return reject(err);
      }

      const columns: any[] = [];
      const relationships: CatalogRelationship[] = [];
      let pending = tables.length;
      if (pending === 0) {
        db.close();
        return resolve({ tables: [], views: [], columns: [], functions: [], relationships: [] });
      }

      // Cap FK extraction at 100 tables to avoid latency
      const extractFKs = tables.length <= 100;
      if (!extractFKs) {
        console.warn(`[DataCatalog] SQLite has ${tables.length} tables — skipping FK extraction (cap: 100).`);
      }

      let colsPending = tables.length;
      let fksPending = extractFKs ? tables.length : 0;
      const totalPending = () => colsPending + fksPending;

      const tryFinish = () => {
        if (totalPending() === 0) {
          db.close();
          resolve({ tables, views: [], columns, functions: [], relationships });
        }
      };

      tables.forEach((t) => {
        db.all(`PRAGMA table_info("${t.table_name.replace(/"/g, '""')}")`, (err2, cols: any[]) => {
          if (!err2 && cols) {
            cols.forEach(c => {
              columns.push({
                table_name: t.table_name,
                column_name: c.name,
                data_type: c.type,
                table_schema: 'main',
                is_primary_key: Number(c.pk || 0) > 0,
                is_auto_increment: false,
              });
            });
          }
          colsPending--;
          tryFinish();
        });

        if (extractFKs) {
          db.all(`PRAGMA foreign_key_list("${t.table_name.replace(/"/g, '""')}")`, (err3, fks: any[]) => {
            if (!err3 && fks) {
              fks.forEach((fk: any) => {
                relationships.push({
                  sourceTable: t.table_name,
                  sourceColumn: fk.from,
                  targetTable: fk.table,
                  targetColumn: fk.to,
                });
              });
            }
            fksPending--;
            tryFinish();
          });
        }
      });
    });
  });
};

// 5. Snowflake
const fetchSnowflakeMetadata = async (account: string, defaultSchema?: string, user?: string, password?: string) => {
  return new Promise<any>((resolve, reject) => {
    const conn = snowflake.createConnection({ account, username: user || "", password: password || "", schema: defaultSchema });
    conn.connect((err, conn) => {
      if (err) return reject(err);

      const execute = (sql: string, binds?: any[]) => new Promise<any[]>((res, rej) => {
        conn.execute({ sqlText: sql, binds, complete: (err, stmt, rows) => err ? rej(err) : res(rows || []) });
      });

      const schemaName = defaultSchema || 'PUBLIC';
      Promise.all([
        execute(`SELECT TABLE_NAME as "table_name", TABLE_SCHEMA as "table_schema" FROM information_schema.tables WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA = ?`, [schemaName]),
        execute(`SELECT TABLE_NAME as "table_name", COLUMN_NAME as "column_name", DATA_TYPE as "data_type", TABLE_SCHEMA as "table_schema" FROM information_schema.columns WHERE TABLE_SCHEMA = ?`, [schemaName]),
        // FK extraction — often empty in Snowflake but query anyway
        execute(
          `SELECT
             kcu.TABLE_NAME AS "source_table",
             kcu.COLUMN_NAME AS "source_column",
             rc.UNIQUE_CONSTRAINT_NAME AS "target_constraint",
             pk_col.TABLE_NAME AS "target_table",
             pk_col.COLUMN_NAME AS "target_column",
             tc.CONSTRAINT_NAME AS "constraint_name"
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
           JOIN information_schema.referential_constraints rc
             ON tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
             AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
           JOIN information_schema.key_column_usage pk_col
             ON rc.UNIQUE_CONSTRAINT_NAME = pk_col.CONSTRAINT_NAME
             AND rc.UNIQUE_CONSTRAINT_SCHEMA = pk_col.TABLE_SCHEMA
             AND kcu.ORDINAL_POSITION = pk_col.ORDINAL_POSITION
           WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
             AND tc.TABLE_SCHEMA = ?`,
          [schemaName]
        ).catch(() => [] as any[])
      ]).then(([tables, columns, fkRows]) => {
        const mapKeys = (arr: any[]) => arr.map(obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])));
        const relationships: CatalogRelationship[] = mapKeys(fkRows || []).map((r: any) => ({
          sourceTable: r.source_table,
          sourceColumn: r.source_column,
          targetTable: r.target_table,
          targetColumn: r.target_column,
          constraintName: r.constraint_name,
        }));
        resolve({ tables: mapKeys(tables), views: [], columns: mapKeys(columns), functions: [], relationships });
      }).catch(reject).finally(() => {
        conn.destroy((_, __) => { });
      });
    });
  });
};

// 6. BigQuery
const fetchBigQueryMetadata = async (projectId: string, defaultSchema?: string, credentialsJson?: string) => {
  if (!defaultSchema) {
    return { tables: [], views: [], columns: [], functions: [] };
  }
  let credentials;
  if (credentialsJson) {
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (parseErr) {
      throw new Error(`Invalid BigQuery credentials format: ${(parseErr as Error).message}`);
    }
  }
  const bq = new BigQuery({ projectId, credentials });
  const dataset = bq.dataset(defaultSchema);

  const [bqTables] = await dataset.getTables();
  const tables: any[] = [];
  const columns: any[] = [];

  for (const t of bqTables) {
    if (!t.id) continue;
    const tableId = t.id.split(/[.:]/).pop() || t.id;
    tables.push({ table_name: tableId, table_schema: defaultSchema });
    const [metadata] = await t.getMetadata();
    const fields = metadata.schema?.fields || [];
    fields.forEach((f: any) => {
      columns.push({ table_name: tableId, column_name: f.name, data_type: f.type, table_schema: defaultSchema });
    });
  }

  return { tables, views: [], columns, functions: [], relationships: [] };
};

// 7. Databricks
const fetchDatabricksMetadata = async (hostname: string, port: number, defaultSchema?: string, token?: string) => {
  const client = new DBSQLClient();
  const connectOptions = { token: token || "", host: hostname, path: defaultSchema || "", port };
  await client.connect(connectOptions);
  const session = await client.openSession();
  try {
    const schema = defaultSchema || "default";

    const tablesOp = await session.executeStatement(
      `SELECT table_name, table_schema FROM system.information_schema.tables WHERE table_schema = ?`,
      { ordinalParameters: [schema] } as any
    );
    let tables = await tablesOp.fetchAll();
    const tablesSchema = await tablesOp.getSchema();
    const tablesCols = tablesSchema?.columns?.map((c: any) => c.name.toLowerCase()) || [];
    const tableNameIdx = tablesCols.indexOf("table_name");
    const tableSchemaIdx = tablesCols.indexOf("table_schema");
    if (Array.isArray(tables)) {
      tables = tables.map((r: any) => Array.isArray(r) ? {
        table_name: tableNameIdx !== -1 ? r[tableNameIdx] : r[0],
        table_schema: tableSchemaIdx !== -1 ? r[tableSchemaIdx] : r[1]
      } : r);
    }

    const colsOp = await session.executeStatement(
      `SELECT table_name, column_name, data_type, table_schema FROM system.information_schema.columns WHERE table_schema = ?`,
      { ordinalParameters: [schema] } as any
    );
    let columns = await colsOp.fetchAll();
    const colsSchema = await colsOp.getSchema();
    const colsCols = colsSchema?.columns?.map((c: any) => c.name.toLowerCase()) || [];
    const colTableIdx = colsCols.indexOf("table_name");
    const colNameIdx = colsCols.indexOf("column_name");
    const colTypeIdx = colsCols.indexOf("data_type");
    const colSchemaIdx = colsCols.indexOf("table_schema");
    if (Array.isArray(columns)) {
      columns = columns.map((r: any) => Array.isArray(r) ? {
        table_name: colTableIdx !== -1 ? r[colTableIdx] : r[0],
        column_name: colNameIdx !== -1 ? r[colNameIdx] : r[1],
        data_type: colTypeIdx !== -1 ? r[colTypeIdx] : r[2],
        table_schema: colSchemaIdx !== -1 ? r[colSchemaIdx] : r[3]
      } : r);
    }

    return { tables, views: [], columns, functions: [], relationships: [] };
  } finally {
    await session.close();
    await client.close();
  }
};

// 8. MongoDB
const fetchMongoMetadata = async (hostname: string, port: number, defaultSchema?: string, user?: string, password?: string) => {
  const poolKey = `${hostname}:${port}:${user || ''}:${password || ''}:${defaultSchema || ''}`;
  const credentials = user && password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  const client = await getMongoClient(poolKey, `mongodb://${credentials}${hostname}:${port}`);
  const targetDb = defaultSchema ?? "admin";
  const collections = await client.db(targetDb).listCollections().toArray();
  const tables = collections.map((col) => ({ table_name: col.name, table_schema: targetDb }));
  return { tables, views: [], columns: [], functions: [], relationships: [] };
};

// Master Router
export const fetchMetadata = async (connection: DatabaseConnection): Promise<{
  tables: CatalogTable[];
  views: CatalogTable[];
  columns: CatalogColumn[];
  functions: CatalogFunction[];
  relationships: CatalogRelationship[];
}> => {
  const decryptedConnection = decryptConnectionSecrets(connection);
  const { hostname, port } = parseHostPort(decryptedConnection.host, decryptedConnection.db_type);
  const schema = decryptedConnection.default_schema;
  const user = decryptedConnection.db_user;
  const password = decryptedConnection.db_password;
  const type = (decryptedConnection.db_type || "").toLowerCase();

  switch (type) {
    case "mysql":
    case "mariadb":
      return fetchMysqlMetadata(hostname, port, schema, user, password);
    case "postgresql":
    case "redshift":
      return fetchPostgresMetadata(hostname, port, schema, user, password);
    case "sql server":
    case "mssql":
      return fetchMssqlMetadata(hostname, port, schema, user, password);
    case "sqlite":
      return fetchSqliteMetadata(hostname) as any;
    case "snowflake":
      return fetchSnowflakeMetadata(hostname, schema, user, password) as any;
    case "bigquery":
      return fetchBigQueryMetadata(hostname, schema, decryptedConnection.credentials_json || password) as any;
    case "databricks":
      return fetchDatabricksMetadata(hostname, port, schema, password) as any;
    case "mongodb":
      return fetchMongoMetadata(hostname, port, schema, user, password) as any;
    case "redis":
      return {
        tables: [{ table_name: "keys", table_schema: "redis" }],
        views: [],
        columns: [
          { table_name: "keys", column_name: "key", data_type: "string", table_schema: "redis" },
          { table_name: "keys", column_name: "value", data_type: "string", table_schema: "redis" },
          { table_name: "keys", column_name: "type", data_type: "string", table_schema: "redis" }
        ],
        functions: [],
        relationships: []
      };
    default:
      return { tables: [], views: [], columns: [], functions: [], relationships: [] };
  }
};

// Metadata cache definitions
interface CacheEntry {
  data: {
    tables: CatalogTable[];
    views: CatalogTable[];
    columns: CatalogColumn[];
    functions: CatalogFunction[];
    relationships: CatalogRelationship[];
  };
  fetchedAt: number;
}
const metadataCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60000;

export function clearMetadataCache(id: number): void {
  const prefix = `${id}-`;
  for (const key of metadataCache.keys()) {
    if (key.startsWith(prefix)) {
      metadataCache.delete(key);
    }
  }
}

const getMetadataForConnection = async (conn: DatabaseConnection, forceRefresh = false) => {
  const cacheKey = `${conn.id}-${conn.host}-${conn.db_type}`;
  const cached = metadataCache.get(cacheKey);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetchMetadata(conn);
  metadataCache.set(cacheKey, { data, fetchedAt: now });
  return data;
};

const getAll = async (req: Request, res: Response<ApiResponse<CatalogEntry[]>>, next: NextFunction) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections ORDER BY created_at DESC");
    const entries: CatalogEntry[] = await Promise.all(
      (rows as DatabaseConnection[]).map(async (conn) => {
        try {
          const { tables, views, columns, functions } = await getMetadataForConnection(conn, forceRefresh);
          return { connection_id: conn.id, connection_name: conn.connection_name, tables, views, columns, functions };
        } catch (err) {
          return {
            connection_id: conn.id,
            connection_name: conn.connection_name,
            tables: [],
            views: [],
            columns: [],
            functions: [],
            error: (err as Error).message
          };
        }
      }),
    );
    res.json({ data: entries });
  } catch (err) {
    next(err);
  }
};

const getByConnection = async (req: Request<{ connectionId: string }>, res: Response, next: NextFunction) => {
  try {
    const forceRefresh = req.query.refresh === "true";
    const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections WHERE id = ?", [req.params.connectionId]);
    if (rows.length === 0) return res.status(404).json({ error: "Connection not found" } as unknown as void);
    const conn = rows[0] as DatabaseConnection;
    const { tables, views, columns, functions } = await getMetadataForConnection(conn, forceRefresh);
    res.json({ data: { connection_id: conn.id, connection_name: conn.connection_name, tables, views, columns, functions } });
  } catch (err) {
    next(err);
  }
};

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();
  router.get("/", getAll);
  router.get("/:connectionId", getByConnection);
  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};
