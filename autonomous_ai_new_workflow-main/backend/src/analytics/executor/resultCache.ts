import crypto from "node:crypto";
import { Redis } from "ioredis";

interface Entry { result: any; cachedAt: number; }

const memory = new Map<string, Entry>();
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
const TTL_S = 60;
const MAX_MEMORY_ENTRIES = Number(process.env.RESULT_CACHE_MAX_ENTRIES) || 500;

function hashKey(parts: { sql: string; params: unknown[] }) {
  return crypto.createHash("sha256").update(`${parts.sql}::${JSON.stringify(parts.params)}`).digest("hex");
}

export async function get(connectionId: number, sql: string, params: unknown[]) {
  const key = `${connectionId}:${hashKey({ sql, params })}`;
  if (redis) {
    const raw = await redis.get(`rc:${key}`);
    if (raw) return JSON.parse(raw);
    return null;
  }
  const e = memory.get(key);
  if (e && Date.now() - e.cachedAt < TTL_S * 1000) {
    // strict LRU update
    memory.delete(key);
    memory.set(key, e);
    return e.result;
  }
  if (e) memory.delete(key);
  return null;
}

export async function set(connectionId: number, sql: string, params: unknown[], result: any) {
  const key = `${connectionId}:${hashKey({ sql, params })}`;
  if (redis) {
    await redis.set(`rc:${key}`, JSON.stringify(result), "EX", TTL_S);
  } else {
    for (const [existingKey, entry] of memory.entries()) {
      if (Date.now() - entry.cachedAt >= TTL_S * 1000) memory.delete(existingKey);
    }
    while (memory.size >= MAX_MEMORY_ENTRIES) {
      const oldestKey = memory.keys().next().value;
      if (!oldestKey) break;
      memory.delete(oldestKey);
    }
    memory.set(key, { result, cachedAt: Date.now() });
  }
}

export async function invalidateConnection(connectionId: number) {
  if (redis) {
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `rc:${connectionId}:*`, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  } else {
    for (const key of memory.keys()) {
      if (key.startsWith(`${connectionId}:`)) {
        memory.delete(key);
      }
    }
  }
}
