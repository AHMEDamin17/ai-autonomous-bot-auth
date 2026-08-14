import type { RowDataPacket } from "mysql2/promise";

export const CURRENT_SCHEMA_TABLES = [
  "connector_metrics",
  "conversation_messages",
  "conversations",
  "db_connections",
  "execution_logs",
  "kpi_metrics",
  "latency_samples",
  "schema_migrations",
  "semantic_models",
  "semantic_vector_outbox",
  "user_conversation_messages",
  "user_conversations",
  "user_sessions",
  "users",
] as const;

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  users: ["id", "username", "entra_oid", "role", "is_active", "created_by", "updated_by"],
  user_sessions: ["token_hash", "user_id", "expires_at", "revoked_at"],
  db_connections: ["id", "connection_name", "semantic_key", "db_type", "host", "created_by", "updated_by"],
  kpi_metrics: ["id", "connection_id", "metric_name", "formula", "involved_tables", "join_spec", "filter_logic", "select_columns"],
  conversations: ["id", "connection_id", "user_id", "last_activity_at"],
  conversation_messages: ["id", "conversation_id", "role", "content", "query_result"],
  user_conversations: ["id", "connection_id", "user_id", "last_activity_at"],
  user_conversation_messages: ["id", "conversation_id", "role", "content", "query_result"],
  execution_logs: ["id", "executionId", "connectionId", "surface", "status", "latencyMs"],
  connector_metrics: ["id", "connectionId", "connector", "executions", "failures", "avgLatencyMs"],
  latency_samples: ["id", "connectionId", "connector", "latencyMs", "capturedAt"],
  semantic_models: ["connection_id", "model_json", "status", "revision", "vector_status"],
  semantic_vector_outbox: ["connection_id", "operation", "target_revision", "next_attempt_at"],
  schema_migrations: ["version", "applied_at"],
};

const FORBIDDEN_TABLES = new Set([
  "autonomous_copy_audit",
  "semantic_model_doc",
  "semantic_model_part_bindings",
]);

const FORBIDDEN_COLUMNS = new Set([
  "db_connections.semantic_summary",
  "db_connections.summary_status",
  "db_connections.summary_updated_at",
  "kpi_metrics.inclusions",
  "kpi_metrics.exclusions",
  "users.password_hash",
]);

type Queryable = {
  query<T extends RowDataPacket[][] | RowDataPacket[]>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
};

export interface CurrentSchemaInspection {
  tables: string[];
  missingTables: string[];
  unexpectedTables: string[];
  missingColumns: string[];
  forbiddenColumns: string[];
  migrations: string[];
}

export async function inspectCurrentSchema(db: Queryable): Promise<CurrentSchemaInspection> {
  const [tableRows] = await db.query<RowDataPacket[]>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const tables = tableRows.map((row) => String(row.table_name ?? row.TABLE_NAME));
  const expected = new Set<string>(CURRENT_SCHEMA_TABLES);
  const actual = new Set(tables);

  const [columnRows] = await db.query<RowDataPacket[]>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = DATABASE()`,
  );
  const columns = new Set(
    columnRows.map((row) => `${String(row.table_name ?? row.TABLE_NAME)}.${String(row.column_name ?? row.COLUMN_NAME)}`),
  );

  const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(([table, names]) =>
    names
      .filter((name) => !columns.has(`${table}.${name}`))
      .map((name) => `${table}.${name}`),
  );
  const forbiddenColumns = [...FORBIDDEN_COLUMNS].filter((column) => columns.has(column));
  const [migrationRows] = await db.query<RowDataPacket[]>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );

  return {
    tables,
    missingTables: [...expected].filter((table) => !actual.has(table)),
    unexpectedTables: tables.filter((table) => !expected.has(table) || FORBIDDEN_TABLES.has(table)),
    missingColumns,
    forbiddenColumns,
    migrations: migrationRows.map((row) => String(row.version)),
  };
}

export function assertCurrentSchema(inspection: CurrentSchemaInspection): void {
  const errors: string[] = [];
  if (inspection.missingTables.length) errors.push(`missing tables: ${inspection.missingTables.join(", ")}`);
  if (inspection.unexpectedTables.length) errors.push(`unexpected tables: ${inspection.unexpectedTables.join(", ")}`);
  if (inspection.missingColumns.length) errors.push(`missing columns: ${inspection.missingColumns.join(", ")}`);
  if (inspection.forbiddenColumns.length) errors.push(`obsolete columns: ${inspection.forbiddenColumns.join(", ")}`);
  if (inspection.migrations.length !== 1 || inspection.migrations[0] !== "001_init.sql") {
    errors.push(`migration ledger must contain only 001_init.sql, found: ${inspection.migrations.join(", ") || "none"}`);
  }
  if (errors.length) throw new Error(`Current schema verification failed (${errors.join("; ")})`);
}
