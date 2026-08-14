// Use global AbortController

export interface TimeoutOptions {
  readonly timeoutMs: number;
  readonly onTimeout?: () => Promise<void>;   // dialect-specific cancel
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, opts: TimeoutOptions): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;

  // Races the driver call against the timer so a hung/slow query fails the
  // request at timeoutMs even when the underlying driver ignores the abort
  // signal (true today for sqlite/snowflake/bigquery/databricks).
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const cleanup = opts.onTimeout ? opts.onTimeout().catch(() => {}) : Promise.resolve();
      cleanup.finally(() => reject(new Error(`Query timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}
