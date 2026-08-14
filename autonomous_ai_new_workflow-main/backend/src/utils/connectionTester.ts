import net from "net";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { MongoClient } from "mongodb";
import mssql from "mssql";
import { createClient as createRedisClient } from "redis";
import fs from "fs/promises";
import sqlite3 from "sqlite3";

// TCP liveness check — no auth, just confirms host:port is reachable
export const testConnection = (
  host: string,
  port: number,
  timeoutMs: number = 5000,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const cleanup = (): void => {
      socket.destroy();
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      cleanup();
      resolve();
    });
    socket.on("timeout", () => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms — unreachable: ${host}:${port}`,
        ),
      );
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(new Error(`Cannot reach ${host}:${port} — ${err.message}`));
    });
    socket.connect(port, host);
  });
};

// MySQL/MariaDB type check
const verifyMysql = async (hostname: string, port: number, user?: string, password?: string): Promise<void> => {
  let conn: mysql.Connection | null = null;
  const isTypeCheckOnly = !user;
  const u = user || "_type_check_";
  const p = password || "";

  try {
    conn = await mysql.createConnection({
      host: hostname,
      port,
      user: u,
      password: p,
      connectTimeout: 5000
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException & { code?: string }).code;
    if (isTypeCheckOnly) {
      if (
        code === "ER_ACCESS_DENIED_ERROR" ||
        code === "ER_NOT_SUPPORTED_AUTH_MODE" ||
        code === "ECONNRESET"
      )
        return;
    }
    throw new Error(
      `Connection failed (got: ${code ?? (err as Error).message})`,
    );
  } finally {
    try {
      await conn?.end();
    } catch {}
  }
};

// PostgreSQL/Redshift type check
const verifyPostgres = async (
  hostname: string,
  port: number,
  user?: string,
  password?: string,
  database?: string
): Promise<void> => {
  const isTypeCheckOnly = !user;
  const client = new PgClient({
    host: hostname,
    port,
    database: database || "postgres",
    user: user || "_type_check_",
    password: password || "",
    connectionTimeoutMillis: 5000
  });
  try {
    await client.connect();
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    if (isTypeCheckOnly) {
      if (
        msg.includes("password") ||
        msg.includes("authentication") ||
        msg.includes("pg_hba") ||
        msg.includes("role") ||
        msg.includes("sasl") ||
        msg.includes("does not exist")
      )
        return;
    }
    throw new Error(
      `Connection failed (got: ${(err as Error).message})`,
    );
  } finally {
    try {
      await client.end();
    } catch {}
  }
};

// MongoDB type check
const verifyMongoDB = async (hostname: string, port: number, user?: string, password?: string): Promise<void> => {
  const credentials = user && password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  const isTypeCheckOnly = !user;
  const client = new MongoClient(`mongodb://${credentials}${hostname}:${port}`, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    if (isTypeCheckOnly) {
      if (msg.includes("authentication") || msg.includes("unauthorized")) return;
    }
    throw new Error(
      `Connection failed (got: ${(err as Error).message})`,
    );
  } finally {
    try {
      await client.close();
    } catch {}
  }
};

// SQL Server type check
const verifyMssql = async (hostname: string, port: number, user?: string, password?: string): Promise<void> => {
  const isTypeCheckOnly = !user;
  const pool = new mssql.ConnectionPool({
    server: hostname,
    port: port,
    user: user || "_type_check_",
    password: password || "",
    options: { encrypt: false, connectTimeout: 5000 },
  });
  try {
    await pool.connect();
  } catch (err) {
    try {
      await pool.close();
    } catch {}
    const msg = (err as Error).message.toLowerCase();
    if (isTypeCheckOnly) {
      if (msg.includes("login failed") || msg.includes("authentication")) return;
    }
    throw new Error(`Connection failed (got: ${(err as Error).message})`);
  }

  try {
    await pool.close();
  } catch {}
};

// Redis type check
const verifyRedis = async (hostname: string, port: number, password?: string): Promise<void> => {
  const isTypeCheckOnly = !password;
  const client = createRedisClient({
    socket: { host: hostname, port, connectTimeout: 5000 },
    ...(password ? { password } : {}),
  });
  try {
    await client.connect();
    await client.quit();
  } catch (err) {
    const msg = (err as Error).message.toLowerCase();
    if (isTypeCheckOnly) {
      if (msg.includes("auth") || msg.includes("password")) return;
    }
    throw new Error(`Connection failed (got: ${(err as Error).message})`);
  }
};

// SQLite check (file system, no TCP)
const verifySqlite = async (filePath: string): Promise<void> => {
  try {
    await fs.access(filePath, fs.constants.R_OK);
  } catch {
    throw new Error(`SQLite database file not found or not readable at: ${filePath}`);
  }

  let timerId: NodeJS.Timeout | null = null;
  let db: sqlite3.Database | null = null;

  return new Promise<void>((resolve, reject) => {
    timerId = setTimeout(() => {
      if (db) {
        try {
          db.close();
        } catch {}
      }
      reject(new Error("Timeout accessing SQLite database file"));
    }, 5000);

    db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err: Error | null) => {
      if (err) {
        if (timerId) clearTimeout(timerId);
        reject(new Error(`Not a valid SQLite database: ${err.message}`));
      } else {
        db!.close((closeErr: Error | null) => {
          if (timerId) clearTimeout(timerId);
          if (closeErr) {
            reject(new Error(`Failed to close SQLite database: ${closeErr.message}`));
          } else {
            resolve();
          }
        });
      }
    });
  });
};

// TCP ping + driver-level handshake for known types
export const testDbTypeConnection = async (
  hostname: string,
  port: number,
  dbType: string,
  dbUser?: string,
  dbPassword?: string,
  dbSchema?: string
): Promise<void> => {
  const type = dbType.toLowerCase();

  // SQLite doesn't use TCP
  if (type === "sqlite") {
    await verifySqlite(hostname);
    return;
  }
  
  // BigQuery doesn't use TCP ping
  if (type === "bigquery") {
    return; // Cloud API, requires actual credentials to test properly
  }

  // Snowflake and Databricks use standard HTTPS ports, skip strict protocol check
  if (type === "snowflake" || type === "databricks") {
    await testConnection(hostname, port);
    return;
  }

  await testConnection(hostname, port);

  switch (type) {
    case "mysql":
    case "mariadb":
      await verifyMysql(hostname, port, dbUser, dbPassword);
      break;
    case "postgresql":
    case "redshift":
      await verifyPostgres(hostname, port, dbUser, dbPassword, dbSchema);
      break;
    case "mongodb":
      await verifyMongoDB(hostname, port, dbUser, dbPassword);
      break;
    case "sql server":
    case "mssql":
      await verifyMssql(hostname, port, dbUser, dbPassword);
      break;
    case "redis":
      await verifyRedis(hostname, port, dbPassword);
      break;
  }
};

// Parses "hostname:port" string, throws on invalid format
export const parseHostPort = (
  hostString: string,
  dbType?: string,
): { hostname: string; port: number } => {
  const type = (dbType || "").toLowerCase();

  // SQLite uses file paths, not hostname:port
  if (type === "sqlite") {
    return { hostname: hostString, port: 0 };
  }
  
  // BigQuery uses Project ID
  if (type === "bigquery") {
    return { hostname: hostString, port: 0 };
  }

  const lastColon = hostString.lastIndexOf(":");
  let hostname = hostString;
  let port: number | undefined;

  if (lastColon !== -1) {
    hostname = hostString.substring(0, lastColon);
    port = parseInt(hostString.substring(lastColon + 1), 10);
  } else if (type) {
    switch (type) {
      case "mysql":
      case "mariadb":
        port = 3306;
        break;
      case "postgresql":
      case "redshift":
        port = 5432;
        break;
      case "mongodb":
        port = 27017;
        break;
      case "sql server":
      case "mssql":
        port = 1433;
        break;
      case "redis":
        port = 6379;
        break;
      case "snowflake":
      case "databricks":
        port = 443;
        break;
    }
  }

  if (type !== "sqlite" && type !== "bigquery") {
    if (!hostname || port === undefined || isNaN(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid host format "${hostString}" — expected "hostname:port" or a known db_type for default port`,
      );
    }
  }
  
  return { hostname, port: port || 0 };
};
