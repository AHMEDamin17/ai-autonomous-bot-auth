import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { allowsApiKeyInQuery } from "../../utils/httpSecurity";

// Read per-request rather than at module load: this module can be imported
// before dotenv has populated process.env (import order decides), and a
// captured constant would silently freeze the fallback dev key as the only
// accepted credential.
function getValidKey(): string {
  return process.env.API_KEY || "default-dev-key";
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const headerApiKey = req.headers["x-api-key"];
  const queryApiKey = allowsApiKeyInQuery(req.method, req.baseUrl, req.path)
    ? req.query.api_key
    : undefined;
  const apiKey = typeof headerApiKey === "string"
    ? headerApiKey
    : typeof queryApiKey === "string"
      ? queryApiKey
      : undefined;
  const validKey = getValidKey();

  if (!apiKey || typeof apiKey !== "string" || apiKey.length !== validKey.length || !crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey))) {
    res.status(401).json({ error: "Unauthorized: Invalid or missing API Key" });
    return;
  }
  next();
}

if (!process.env.API_KEY) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("CRITICAL: API_KEY is missing in production. Refusing to start with default key.");
  } else {
    console.warn("WARNING: API_KEY is missing. Using 'default-dev-key' for local development.");
  }
}
