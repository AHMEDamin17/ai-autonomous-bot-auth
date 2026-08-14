import path from "node:path";
import { DatabaseConnection } from "../types/types";
import { normalizeSemanticDbType } from "./dbType";

export interface SemanticDatasource {
  connection_id: string;
  database_name: string;
  catalog?: string;
  schema?: string;
  project?: string;
  dataset?: string;
}

function required(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Connection requires ${label} before semantic-model generation`);
  return normalized;
}

function splitScope(value: string): { catalog?: string; schema?: string } {
  const separator = value.indexOf(".");
  if (separator > 0 && separator < value.length - 1) {
    return { catalog: value.slice(0, separator), schema: value.slice(separator + 1) };
  }
  return { schema: value };
}

export function buildSemanticDatasource(connection: DatabaseConnection): SemanticDatasource {
  const semanticKey = required(connection.semantic_key, "a semantic key");
  const dbType = normalizeSemanticDbType(connection.db_type);
  const storedScope = String(connection.default_schema ?? "").trim();

  if (dbType === "sqlite") {
    const filename = path.basename(required(connection.host, "a SQLite database path"));
    return { connection_id: semanticKey, database_name: filename };
  }
  if (dbType === "databricks") {
    const scope = splitScope(required(storedScope, "a Databricks schema"));
    return {
      connection_id: semanticKey,
      database_name: required(scope.schema, "a Databricks schema"),
      ...scope,
    };
  }
  if (dbType === "snowflake") {
    const scope = splitScope(required(storedScope, "a Snowflake schema"));
    return {
      connection_id: semanticKey,
      database_name: required(scope.schema, "a Snowflake schema"),
      ...scope,
    };
  }
  if (dbType === "bigquery") {
    const project = required(connection.host, "a BigQuery project");
    const dataset = required(storedScope, "a BigQuery dataset");
    return { connection_id: semanticKey, database_name: dataset, project, dataset };
  }

  return {
    connection_id: semanticKey,
    database_name: storedScope || required(connection.connection_name, "a logical database name"),
  };
}
