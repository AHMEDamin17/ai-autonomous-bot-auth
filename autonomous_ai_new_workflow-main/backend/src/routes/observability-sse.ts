import { Router, Request, Response } from "express";
import { getLiveLogs } from "../telemetry/inMemoryLogs";
import { filterTelemetryForDisplay } from "../telemetry/llmUsage";
import { getCircuitState } from "../mcp/resilience/circuitBreaker";

export const sseRouter = Router();

sseRouter.get("/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(() => {
    const { logs } = getLiveLogs(Number.MAX_SAFE_INTEGER, 0);
    const visibleLogs = filterTelemetryForDisplay(logs);
    send("logs", {
      logs: visibleLogs.slice(0, 20),
      total: visibleLogs.length,
    });
  }, 2000);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  req.on("close", () => { clearInterval(interval); clearInterval(heartbeat); });
});
