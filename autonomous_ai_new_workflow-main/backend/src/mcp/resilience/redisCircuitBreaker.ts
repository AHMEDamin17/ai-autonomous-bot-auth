import { Redis } from "ioredis";
import type { CircuitState, CanExecuteResult, BreakerDefaults } from "./circuitBreaker";

const DEPLOYMENT_SCOPE = (process.env.DEPLOYMENT_ID || process.env.NODE_ENV || "local")
  .replace(/[^A-Za-z0-9_.-]/g, "_");
const CB_KEY = (k: string) => `cb:${DEPLOYMENT_SCOPE}:${k}`;
const DEFAULT_DEFAULTS: BreakerDefaults = {
  failureThreshold: Number(process.env.CIRCUIT_FAILURE_THRESHOLD) || 2,
  successThreshold: Number(process.env.CIRCUIT_SUCCESS_THRESHOLD) || 3,
  cooldownMs: Number(process.env.CIRCUIT_COOLDOWN_MS) || 15_000,
  failureDecayMs: Number(process.env.CIRCUIT_DECAY_MS) || 60_000,
};

// Lua scripts: atomic, no race.
const CAN_EXECUTE_LUA = `
local cur = redis.call('HGETALL', KEYS[1])
local failures = tonumber(cur[2]) or 0
local successes = tonumber(cur[4]) or 0
local status = cur[6] or 'closed'
local openedAt = tonumber(cur[8]) or 0
local halfOpenInFlight = cur[10] or '0'
local now = tonumber(ARGV[1])
local failureThreshold = tonumber(ARGV[2])
local cooldownMs = tonumber(ARGV[3])
if status == 'closed' then return {'closed', 1} end
if status == 'open' then
  if now - openedAt > cooldownMs then
    redis.call('HSET', KEYS[1], 'status', 'half-open', 'halfOpenInFlight', '1', 'lastHalfOpenAt', now)
    return {'half-open', 1}
  end
  return {'open', cooldownMs - (now - openedAt)}
end
-- half-open
local lastHalfOpenAt = tonumber(redis.call('HGET', KEYS[1], 'lastHalfOpenAt')) or 0
if halfOpenInFlight == '0' or (now - lastHalfOpenAt > 30000) then
  redis.call('HSET', KEYS[1], 'halfOpenInFlight', '1', 'lastHalfOpenAt', now)
  return {'half-open', 1}
end
return {'half-open', 0}
`;

const RECORD_SUCCESS_LUA = `
local cur = redis.call('HGETALL', KEYS[1])
local status = cur[6] or 'closed'
local successes = tonumber(cur[4]) or 0
local successThreshold = tonumber(ARGV[1])
redis.call('HSET', KEYS[1], 'halfOpenInFlight', '0')
if status == 'half-open' then
  successes = successes + 1
  if successes >= successThreshold then
    redis.call('HMSET', KEYS[1], 'status', 'closed', 'failures', 0, 'successes', 0, 'openedAt', 0, 'halfOpenInFlight', '0')
    return 'closed'
  end
  redis.call('HSET', KEYS[1], 'successes', successes)
  return 'half-open'
end
if status == 'closed' then redis.call('HSET', KEYS[1], 'failures', 0) end
return status
`;

const RECORD_FAILURE_LUA = `
local cur = redis.call('HGETALL', KEYS[1])
local status = cur[6] or 'closed'
local failures = tonumber(cur[2]) or 0
local failureThreshold = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'halfOpenInFlight', '0', 'lastFailureAt', now)
if status == 'half-open' then
  redis.call('HMSET', KEYS[1], 'status', 'open', 'openedAt', now, 'failures', failureThreshold)
  return 'open'
end
failures = failures + 1
if failures >= failureThreshold then
  redis.call('HMSET', KEYS[1], 'status', 'open', 'openedAt', now, 'failures', failures)
  return 'open'
end
redis.call('HSET', KEYS[1], 'failures', failures)
return status
`;

export class RedisCircuitBreaker {
  private redis?: Redis;

  constructor(redisUrl?: string) {
    if (redisUrl || process.env.REDIS_URL) {
      this.redis = new Redis(redisUrl ?? process.env.REDIS_URL!, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    }
  }

  async canExecute(key: string, d: BreakerDefaults = {}): Promise<CanExecuteResult> {
    if (!this.redis) throw new Error("NO_REDIS");
    const now = Date.now();
    const def = { ...DEFAULT_DEFAULTS, ...d };
    const res = await this.redis.eval(CAN_EXECUTE_LUA, 1, CB_KEY(key),
      now, def.failureThreshold!, def.cooldownMs!) as any[];
      
    const status = res[0] as "closed" | "open" | "half-open";
    if (status === "open") {
       return { allowed: false, status, retryAfterMs: res[1] as number };
    }
    return { allowed: res[1] === 1, status };
  }

  recordSuccess(key: string, d: BreakerDefaults = {}) {
    if (!this.redis) throw new Error("NO_REDIS");
    const def = { ...DEFAULT_DEFAULTS, ...d };
    return this.redis.eval(RECORD_SUCCESS_LUA, 1, CB_KEY(key), def.successThreshold!);
  }

  recordFailure(key: string, d: BreakerDefaults = {}) {
    if (!this.redis) throw new Error("NO_REDIS");
    const def = { ...DEFAULT_DEFAULTS, ...d };
    return this.redis.eval(RECORD_FAILURE_LUA, 1, CB_KEY(key), def.failureThreshold!, Date.now());
  }

  async getState(key: string): Promise<CircuitState | null> {
    if (!this.redis) return null;
    const h = await this.redis.hgetall(CB_KEY(key));
    if (!h || !Object.keys(h).length) return null;
    return {
      failures: Number(h.failures ?? 0),
      successes: Number(h.successes ?? 0),
      status: (h.status ?? "closed") as any,
      openedAt: Number(h.openedAt ?? 0) || null,
      lastFailureAt: Number(h.lastFailureAt ?? 0) || null,
      lastHalfOpenAt: Number(h.lastHalfOpenAt ?? 0) || null,
      halfOpenInFlight: h.halfOpenInFlight === "1",
      failureThreshold: DEFAULT_DEFAULTS.failureThreshold!,
      successThreshold: DEFAULT_DEFAULTS.successThreshold!,
      cooldownMs: DEFAULT_DEFAULTS.cooldownMs!,
      failureDecayMs: DEFAULT_DEFAULTS.failureDecayMs!,
    };
  }
}
