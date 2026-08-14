import { Request, Response, NextFunction } from "express";
import { Redis } from "ioredis";

// In-memory fallback
const memoryStore = new Map<string, { count: number, resetAt: number }>();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of memoryStore.entries()) {
    if (now > record.resetAt) {
      memoryStore.delete(key);
    }
  }
}, 60 * 1000);
cleanupTimer.unref?.();

export const rateLimiter = (options: { maxPoints: number, windowMs: number }) => {
  const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true }) : null;
  
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `ratelimit:${req.ip || "unknown"}`;
    const now = Date.now();

    if (redis) {
      try {
        const luaScript = `
          local current = redis.call('incr', KEYS[1])
          if current == 1 then
            redis.call('pexpire', KEYS[1], ARGV[1])
          end
          return current
        `;
        const current = await redis.eval(luaScript, 1, key, options.windowMs) as number;
        if (current > options.maxPoints) {
          res.status(429).json({ error: "Too many requests" });
          return;
        }
        return next();
      } catch (e) {
        console.error("Redis rate limiter error, falling back to memory:", e);
        // Fallthrough to memory store if Redis fails
      }
    }
    
    // In-memory
    let record = memoryStore.get(key);
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + options.windowMs };
    }
    record.count++;
    memoryStore.set(key, record);

    if (record.count > options.maxPoints) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
};
