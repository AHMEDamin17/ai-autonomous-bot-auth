const TYPE_ALIASES: Record<string, string> = {
  postgres: "postgresql",
  "sql server": "mssql",
};

/** Canonical database-type key used by per-connection semantic documents. */
export function normalizeSemanticDbType(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return TYPE_ALIASES[normalized] || normalized.replace(/[^a-z0-9]+/g, "_");
}
