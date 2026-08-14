import { AsyncLocalStorage } from "async_hooks";
import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";

export const traceStorage = new AsyncLocalStorage<string>();

export const correlationMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const traceId = (req.headers['x-trace-id'] as string) || crypto.randomUUID();
  res.setHeader('x-trace-id', traceId);
  traceStorage.run(traceId, () => next());
};

export const getTraceId = (): string => traceStorage.getStore() || "no-trace";
