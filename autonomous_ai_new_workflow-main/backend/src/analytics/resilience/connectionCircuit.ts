import * as inMemoryBreaker from "../../mcp/resilience/circuitBreaker";
import { RedisCircuitBreaker } from "../../mcp/resilience/redisCircuitBreaker";

const redisBreaker = process.env.REDIS_URL ? new RedisCircuitBreaker() : null;

export async function canExecuteConnection(connectionId: number) {
  const key = `conn-${connectionId}`;
  return redisBreaker
    ? redisBreaker.canExecute(key).catch(() => inMemoryBreaker.canExecute(key))
    : inMemoryBreaker.canExecute(key);
}

export async function getConnectionCircuitState(connectionId: number) {
  const key = `conn-${connectionId}`;
  if (redisBreaker) {
    const redisState = await redisBreaker.getState(key).catch(() => null);
    if (redisState) return redisState;
  }
  return inMemoryBreaker.getCircuitState(key);
}

export async function isConnectionCircuitHealthy(connectionId: number): Promise<boolean> {
  const state = await getConnectionCircuitState(connectionId);
  return state.status === "closed";
}

export async function recordConnectionSuccess(connectionId: number): Promise<void> {
  const key = `conn-${connectionId}`;
  if (redisBreaker) {
    await redisBreaker.recordSuccess(key).catch(() => {
      inMemoryBreaker.recordSuccess(key);
    });
    return;
  }
  inMemoryBreaker.recordSuccess(key);
}

export async function recordConnectionFailure(connectionId: number): Promise<void> {
  const key = `conn-${connectionId}`;
  if (redisBreaker) {
    await redisBreaker.recordFailure(key).catch(() => {
      inMemoryBreaker.recordFailure(key);
    });
    return;
  }
  inMemoryBreaker.recordFailure(key);
}
