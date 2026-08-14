type CloseableAdapterPool = {
  end?: () => Promise<void>;
  close?: () => Promise<void>;
  destroy?: (callback?: () => void) => void;
};

const adapterPools = new Map<string, CloseableAdapterPool>();
const poolLastActive = new Map<string, number>();
const pendingCloses = new Map<string, Promise<void>>();
const ADAPTER_POOL_TTL_MS = 5 * 60 * 1000;

export function touchAdapterPool(key: string): void {
  poolLastActive.set(key, Date.now());
}

export function hasAdapterPool(key: string): boolean {
  return adapterPools.has(key);
}

export function getAdapterPool<T extends CloseableAdapterPool>(key: string): T {
  const pool = adapterPools.get(key);
  if (!pool) {
    throw new Error(`Adapter pool not found for key ${key}`);
  }
  touchAdapterPool(key);
  return pool as T;
}

export function setAdapterPool<T extends CloseableAdapterPool>(key: string, pool: T): T {
  adapterPools.set(key, pool);
  touchAdapterPool(key);
  return pool;
}

export async function closeAdapterPool(key: string, checkTtl = false): Promise<void> {
  const existingClose = pendingCloses.get(key);
  if (existingClose) return existingClose;

  if (checkTtl) {
    const lastActive = poolLastActive.get(key);
    if (lastActive && Date.now() - lastActive <= ADAPTER_POOL_TTL_MS) {
      return;
    }
  }

  const closePromise = closeAdapterPoolNow(key).finally(() => {
    pendingCloses.delete(key);
  });
  pendingCloses.set(key, closePromise);
  return closePromise;
}

async function closeAdapterPoolNow(key: string): Promise<void> {
  const poolInstance = adapterPools.get(key);
  if (!poolInstance) return;
  adapterPools.delete(key);
  poolLastActive.delete(key);

  try {
    if (typeof poolInstance.end === "function") {
      await poolInstance.end();
    } else if (typeof poolInstance.close === "function") {
      await poolInstance.close();
    } else if (typeof poolInstance.destroy === "function") {
      await new Promise<void>((resolve) => poolInstance.destroy?.(resolve));
    }
  } catch (err) {
    console.warn(`[Telemetry] Error closing adapter pool for key ${key}:`, err);
  }
}

export async function evictAdapterPoolsByConnection(connectionId: string): Promise<void> {
  const closers: Promise<void>[] = [];
  for (const key of adapterPools.keys()) {
    if (key === connectionId || key.startsWith(`${connectionId}-`)) {
      closers.push(closeAdapterPool(key));
    }
  }
  await Promise.allSettled(closers);
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, lastActive] of poolLastActive.entries()) {
    if (now - lastActive > ADAPTER_POOL_TTL_MS && !pendingCloses.has(key)) {
      void closeAdapterPool(key, true);
    }
  }
}, 60 * 1000);
cleanupTimer.unref?.();

export async function closeAllAdapterPools(): Promise<void> {
  const closers = Array.from(adapterPools.keys(), (key) => closeAdapterPool(key));
  await Promise.allSettled([...closers, ...pendingCloses.values()]);
}
