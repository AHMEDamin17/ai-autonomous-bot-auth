import { Router } from 'express';
import { getLogs, getMetrics } from '../telemetry/telemetryStore';
import { getLiveLogs } from '../telemetry/inMemoryLogs';
import {
  filterTelemetryForDisplay,
  isLlmTokenUsageVisible,
  summarizeLlmUsageEvents,
} from '../telemetry/llmUsage';
import { getCircuitState } from '../mcp/resilience/circuitBreaker';

function getVisibleLiveLogs(limit: number, offset: number) {
  const { logs } = getLiveLogs(Number.MAX_SAFE_INTEGER, 0);
  const visibleLogs = filterTelemetryForDisplay(logs);
  return {
    logs: visibleLogs.slice(offset, offset + limit),
    total: visibleLogs.length,
  };
}

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();

  router.get('/logs', async (req, res, next) => {
    try {
      const pageVal = Number(req.query.page ?? 1);
      const page = Math.max(1, isNaN(pageVal) ? 1 : pageVal);
      const limitVal = Number(req.query.limit ?? 50);
      const limit = Math.max(1, Math.min(100, isNaN(limitVal) ? 50 : limitVal));
      const offset = (page - 1) * limit;

      const { logs, total } = await getLogs(limit, offset);
      res.json({
        data: logs,
        meta: {
          type: 'execution_logs',
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/logs/live', (req, res) => {
    try {
      const pageVal = Number(req.query.page ?? 1);
      const page = Math.max(1, isNaN(pageVal) ? 1 : pageVal);
      const limitVal = Number(req.query.limit ?? 50);
      const limit = Math.max(1, Math.min(100, isNaN(limitVal) ? 50 : limitVal));
      const offset = (page - 1) * limit;

      const { logs, total } = getVisibleLiveLogs(limit, offset);
      res.json({
        data: logs,
        meta: {
          type: 'live_logs',
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch live logs', detail: (error as Error).message });
    }
  });

  router.get('/logs/live/export', (req, res) => {
    try {
      const format = req.query.format === 'csv' ? 'csv' : 'json';
      const { logs } = getVisibleLiveLogs(1000, 0);

      if (format === 'csv') {
        const headers = [
          'timestamp',
          'executionId',
          'parentExecutionId',
          'connectionId',
          'surface',
          'step',
          'stage',
          'status',
          'latencyMs',
          'authType',
          'circuitState',
          'message',
          ...(isLlmTokenUsageVisible()
            ? [
                'provider',
                'model',
                'inputTokens',
                'outputTokens',
                'totalTokens',
                'contextWindowTokens',
                'contextUsagePercent',
                'usageReported',
              ]
            : []),
        ];
        const rows = logs.map(log => 
          headers.map(h => JSON.stringify((log as any)[h] ?? '')).join(',')
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=live_logs.csv');
        res.send([headers.join(','), ...rows].join('\n'));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=live_logs.json');
        res.json(logs);
      }
    } catch (error) {
      res.status(500).json({ error: 'Failed to export logs', detail: (error as Error).message });
    }
  });

  router.get('/metrics', async (req, res, next) => {
    try {
      const pageVal = Number(req.query.page ?? 1);
      const page = Math.max(1, isNaN(pageVal) ? 1 : pageVal);
      const limitVal = Number(req.query.limit ?? 50);
      const limit = Math.max(1, Math.min(100, isNaN(limitVal) ? 50 : limitVal));
      const offset = (page - 1) * limit;

      const { metrics, total } = await getMetrics(limit, offset);
      res.json({
        data: metrics,
        meta: {
          type: 'connector_metrics',
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/token-usage', (req, res) => {
    if (!isLlmTokenUsageVisible()) {
      res.json({
        data: { enabled: false },
        meta: { type: 'llm_token_usage' },
      });
      return;
    }
    const limitVal = Number(req.query.limit ?? 20);
    const limit = Math.max(
      1,
      Math.min(100, Number.isFinite(limitVal) ? limitVal : 20),
    );
    const { logs } = getLiveLogs(Number.MAX_SAFE_INTEGER, 0);
    res.json({
      data: summarizeLlmUsageEvents(logs, limit),
      meta: { type: 'llm_token_usage' },
    });
  });

  router.get('/circuit/:id', (req, res) => {
    const connectionId = req.params.id;
    const state = getCircuitState(`conn-${connectionId}`);
    res.json({ data: state, meta: { type: 'circuit_state' } });
  });

  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};
