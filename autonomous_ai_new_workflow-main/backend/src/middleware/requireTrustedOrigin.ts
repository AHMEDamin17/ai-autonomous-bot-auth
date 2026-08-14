import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.CORS_ORIGIN || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin || allowedOrigins().has(origin)) {
    next();
    return;
  }
  res.status(403).json({
    error: "Untrusted request origin",
    code: "UNTRUSTED_ORIGIN",
  });
}

