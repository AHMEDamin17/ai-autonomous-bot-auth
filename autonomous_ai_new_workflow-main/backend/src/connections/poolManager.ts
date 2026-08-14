import mysql from "mysql2/promise";
import pg, { Pool as PgPool } from "pg";
import mssql from "mssql";
import { MongoClient } from "mongodb";

export const mysqlPools = new Map<string, mysql.Pool>();
export const pgPools = new Map<string, PgPool>();
export const mssqlPools = new Map<string, mssql.ConnectionPool>();
export const mssqlPoolPromises = new Map<string, Promise<mssql.ConnectionPool>>();
export const mongoClients = new Map<string, MongoClient>();
export const poolLastActive = new Map<string, number>();
const pendingCloses = new Map<string, Promise<void>>();

export function getMysqlPool(key: string, config: mysql.PoolOptions): mysql.Pool {
  poolLastActive.set(key, Date.now());
  if (!mysqlPools.has(key)) {
    mysqlPools.set(key, mysql.createPool(config));
  }
  return mysqlPools.get(key)!;
}

export function getPgPool(key: string, config: pg.PoolConfig): PgPool {
  poolLastActive.set(key, Date.now());
  if (!pgPools.has(key)) {
    pgPools.set(key, new pg.Pool(config));
  }
  return pgPools.get(key)!;
}

export async function getMssqlPool(key: string, config: mssql.config): Promise<mssql.ConnectionPool> {
  poolLastActive.set(key, Date.now());
  if (mssqlPools.has(key)) {
    const pool = mssqlPools.get(key)!;
    if (pool.connected) return pool;
  }
  if (mssqlPoolPromises.has(key)) {
    return mssqlPoolPromises.get(key)!;
  }

  const promise = (async () => {
    try {
      const pool = new mssql.ConnectionPool(config);
      await pool.connect();
      mssqlPools.set(key, pool);
      return pool;
    } catch (err) {
      mssqlPoolPromises.delete(key);
      throw err;
    }
  })();
  mssqlPoolPromises.set(key, promise);
  return promise;
}

export async function getMongoClient(key: string, url: string): Promise<MongoClient> {
  poolLastActive.set(key, Date.now());
  if (!mongoClients.has(key)) {
    const client = new MongoClient(url);
    await client.connect();
    mongoClients.set(key, client);
  }
  return mongoClients.get(key)!;
}

export async function closePool(key: string, type: 'mysql' | 'pg' | 'mssql' | 'mongo'): Promise<void> {
  const existingClose = pendingCloses.get(key);
  if (existingClose) return existingClose;

  const closePromise = closePoolNow(key, type).finally(() => {
    pendingCloses.delete(key);
  });
  pendingCloses.set(key, closePromise);
  return closePromise;
}

async function closePoolNow(key: string, type: 'mysql' | 'pg' | 'mssql' | 'mongo'): Promise<void> {
  try {
    if (type === 'mysql') {
      const poolInstance = mysqlPools.get(key);
      if (poolInstance) {
        mysqlPools.delete(key);
        await poolInstance.end();
      }
    } else if (type === 'pg') {
      const poolInstance = pgPools.get(key);
      if (poolInstance) {
        pgPools.delete(key);
        await poolInstance.end();
      }
    } else if (type === 'mssql') {
      mssqlPoolPromises.delete(key);
      const poolInstance = mssqlPools.get(key);
      if (poolInstance) {
        mssqlPools.delete(key);
        await poolInstance.close();
      }
    } else if (type === 'mongo') {
      const client = mongoClients.get(key);
      if (client) {
        mongoClients.delete(key);
        await client.close();
      }
    }
  } catch (err) {
    console.warn(`[Telemetry] Error closing pool for key ${key}:`, err);
  } finally {
    poolLastActive.delete(key);
  }
}

const POOL_TTL_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, lastActive] of poolLastActive.entries()) {
    if (now - lastActive > POOL_TTL_MS) {
      if (pendingCloses.has(key)) continue;
      if (mysqlPools.has(key)) void closePool(key, 'mysql');
      else if (pgPools.has(key)) void closePool(key, 'pg');
      else if (mssqlPools.has(key)) void closePool(key, 'mssql');
      else if (mongoClients.has(key)) void closePool(key, 'mongo');
    }
  }
}, 60 * 1000);
cleanupTimer.unref?.();

export async function closeAllPools(): Promise<void> {
  const closers: Promise<void>[] = [];
  for (const key of mysqlPools.keys()) closers.push(closePool(key, 'mysql'));
  for (const key of pgPools.keys()) closers.push(closePool(key, 'pg'));
  for (const key of mssqlPools.keys()) closers.push(closePool(key, 'mssql'));
  for (const key of mongoClients.keys()) closers.push(closePool(key, 'mongo'));
  await Promise.allSettled([...closers, ...pendingCloses.values()]);
}
