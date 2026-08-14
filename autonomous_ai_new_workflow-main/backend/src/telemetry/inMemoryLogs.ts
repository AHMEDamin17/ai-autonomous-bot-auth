import fs from 'fs';
import path from 'path';
import { getTraceId } from './correlation';

export interface TelemetryEvent {
  timestamp: string;
  executionId: string;
  parentExecutionId?: string;
  connectionId: number;
  surface?: "analytics-ai" | "dashboard-ai";
  step: string;
  stage?: string;
  status: 'success' | 'failure';
  latencyMs: number;
  authType: string;
  message?: string;
  circuitState?: string;
  traceId?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextWindowTokens?: number;
  contextUsagePercent?: number;
  usageReported?: boolean;
}

const MAX_LOGS = Number(process.env.MAX_TELEMETRY_LOGS) || 500;
let logs: TelemetryEvent[] = [];

const CACHE_FILE = path.join(process.cwd(), '.telemetry_cache.json');
const CACHE_TMP_FILE = `${CACHE_FILE}.tmp`;

// Load logs on startup
try {
  if (fs.existsSync(CACHE_FILE)) {
    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
    logs = JSON.parse(data);
    console.log(`[Telemetry] Loaded ${logs.length} cached live logs from file`);
  }
} catch (err) {
  console.warn('[Telemetry] Failed to load cached live logs', err);
}

let isSaving = false;
let saveScheduled = false;
let cacheIsDirty = false;

async function saveLogsToCacheAsync(): Promise<void> {
  cacheIsDirty = true;
  if (saveScheduled || isSaving) return;
  saveScheduled = true;

  // Debounce 5s
  await new Promise(r => setTimeout(r, 5000));
  saveScheduled = false;

  if (isSaving) return;
  isSaving = true;

  try {
    while (cacheIsDirty) {
      cacheIsDirty = false;
      const logsCopy = [...logs];
      await fs.promises.writeFile(CACHE_TMP_FILE, JSON.stringify(logsCopy, null, 2), 'utf-8');
      await fs.promises.rename(CACHE_TMP_FILE, CACHE_FILE);
    }
  } catch (err) {
    console.warn('[Telemetry] Failed to cache live logs', err);
  } finally {
    isSaving = false;
    if (cacheIsDirty) {
      saveLogsToCacheAsync().catch(() => {});
    }
  }
}

export const recordTelemetry = (event: Omit<TelemetryEvent, 'timestamp' | 'traceId'>) => {
  const fullEvent: TelemetryEvent = {
    ...event,
    timestamp: new Date().toISOString(),
    traceId: getTraceId()
  };

  logs.push(fullEvent);
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(logs.length - MAX_LOGS);
  }
  saveLogsToCacheAsync().catch(err => console.error('[Telemetry] Save cache failed', err));
}

export function getLiveLogs(limit = 50, offset = 0): { logs: TelemetryEvent[], total: number } {
  const reversed = [...logs].reverse();
  return {
    logs: reversed.slice(offset, offset + limit),
    total: logs.length
  };
}
