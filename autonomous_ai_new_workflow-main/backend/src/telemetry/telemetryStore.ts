import pool from '../db/connection';

const LATENCY_SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.LATENCY_SAMPLE_RATE ?? 0.05)));

export interface ExecutionLogEntry {
  executionId: string;
  connectionId: number;
  surface?: "analytics-ai" | "dashboard-ai";
  connector: string;
  status: 'success' | 'failure';
  latencyMs: number;
  authType: string;
  message?: string;
  traceId?: string;
}

export async function logExecution(entry: ExecutionLogEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO execution_logs (executionId, connectionId, surface, connector, status, latencyMs, authType, message, traceId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.executionId,
        entry.connectionId,
        entry.surface || "analytics-ai",
        entry.connector,
        entry.status,
        entry.latencyMs,
        entry.authType,
        entry.message || null,
        entry.traceId || null
      ]
    );
  } catch (error) {
    console.error('[TelemetryStore] Failed to log execution', error);
  }
}

export async function upsertMetrics(connectionId: number, connector: string, success: boolean, latencyMs: number): Promise<void> {
  try {
    const failureIncrement = success ? 0 : 1;
    
    // Provide a cross-db compatible UPSERT by trying UPDATE first, then INSERT
    const [updateResult]: any = await pool.query(
      `UPDATE connector_metrics 
       SET failures = failures + ?,
           totalLatencyMs = totalLatencyMs + ?,
           executions = executions + 1,
           avgLatencyMs = ROUND((totalLatencyMs + ?) / (executions + 1), 2)
       WHERE connectionId = ? AND connector = ?`,
      [failureIncrement, latencyMs, latencyMs, connectionId, connector]
    );

    if (updateResult.affectedRows === 0 || updateResult.rowCount === 0) {
      try {
        await pool.query(
          `INSERT INTO connector_metrics (connectionId, connector, executions, failures, totalLatencyMs, avgLatencyMs)
           VALUES (?, ?, 1, ?, ?, ?)`,
          [connectionId, connector, failureIncrement, latencyMs, latencyMs]
        );
      } catch (insertError: any) {
        if (insertError.code === 'ER_DUP_ENTRY' || insertError.code === '23505') {
          await pool.query(
            `UPDATE connector_metrics 
             SET failures = failures + ?,
                 totalLatencyMs = totalLatencyMs + ?,
                 executions = executions + 1,
                 avgLatencyMs = ROUND((totalLatencyMs + ?) / (executions + 1), 2)
             WHERE connectionId = ? AND connector = ?`,
            [failureIncrement, latencyMs, latencyMs, connectionId, connector]
          );
        } else {
          throw insertError;
        }
      }
    }

    if (Math.random() < LATENCY_SAMPLE_RATE) {
      await pool.query("INSERT INTO latency_samples (connectionId, connector, latencyMs) VALUES (?, ?, ?)", [connectionId, connector, latencyMs]);
    }
  } catch (error) {
    console.error('[TelemetryStore] Failed to upsert metrics', error);
  }
}

export async function getLogs(limit = 50, offset = 0): Promise<{ logs: any[], total: number }> {
  const [countRows] = await pool.query(
    `SELECT COUNT(*) as total FROM execution_logs`
  );
  const total = (countRows as any)[0]?.total ?? 0;

  const [rows] = await pool.query(
    `SELECT * FROM execution_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { logs: rows as any[], total };
}

export async function getMetrics(limit = 50, offset = 0) {
  const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM connector_metrics`);
  const total = (countRows as any)[0]?.total ?? 0;
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT connectionId, connector, executions, failures, totalLatencyMs,
            CASE WHEN executions > 0 THEN ROUND(totalLatencyMs / executions, 2) ELSE 0 END AS avgLatencyMs
     FROM connector_metrics ORDER BY executions DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return { metrics: rows, total };
}

export async function getPercentiles() {
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT
       connectionId, connector,
       totalLatencyMs,
       executions,
       -- approximate p50/p95/p99 from total + count is unreliable;
       -- capture real distribution in a separate latency_samples table if needed.
       failures
     FROM connector_metrics`
  );
  return rows;
}

const TELEMETRY_RETENTION_DAYS = 7;

export async function cleanupOldTelemetry(): Promise<void> {
  try {
    console.log('[TelemetryStore] Pruning logs older than', TELEMETRY_RETENTION_DAYS, 'days...');
    await pool.query(
      `DELETE FROM execution_logs WHERE timestamp < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [TELEMETRY_RETENTION_DAYS]
    );
    await pool.query(
      `DELETE FROM latency_samples WHERE capturedAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [TELEMETRY_RETENTION_DAYS]
    );
    console.log('[TelemetryStore] Telemetry pruning complete.');
  } catch (error) {
    console.error('[TelemetryStore] Failed to prune telemetry tables', error);
  }
}

