const QUERY_API_KEY_PATHS = new Set([
  "/api/observability/stream",
]);

const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "token",
]);

export function allowsApiKeyInQuery(
  method: string,
  baseUrl: string,
  requestPath: string,
): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const fullPath = `${baseUrl || ""}${requestPath || ""}`.replace(/\/+/g, "/");
  return QUERY_API_KEY_PATHS.has(fullPath);
}

export function redactSensitiveUrl(originalUrl: string): string {
  const queryIndex = originalUrl.indexOf("?");
  if (queryIndex < 0) return originalUrl;

  const pathname = originalUrl.slice(0, queryIndex);
  const params = new URLSearchParams(originalUrl.slice(queryIndex + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, "[REDACTED]");
      changed = true;
    }
  }
  return changed ? `${pathname}?${params.toString()}` : originalUrl;
}
