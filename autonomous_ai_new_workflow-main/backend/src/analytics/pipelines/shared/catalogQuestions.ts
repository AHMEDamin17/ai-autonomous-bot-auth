import { AiDatasetDefinition, DatabaseConnection } from "../../../types/types";

function normalize(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isColumnCatalogQuestion(question: string): boolean {
  const normalized = normalize(question);
  return /\b(columns?|fields?|schema)\b/.test(normalized)
    && /\b(list|show|display|available|what|which|all|tell|describe|does|have)\b/.test(normalized);
}

export function isCatalogListQuestion(question: string): boolean {
  const normalized = normalize(question);
  return /\b(tables|datasets|catalog|kpis|metrics)\b/.test(normalized)
    && /\b(list|show|display|available|what|which|all|tell|describe)\b/.test(normalized);
}

export function buildMetadataBlockedResponse(question: string, dialect = "mysql") {
  const message = "I can answer business-data questions, but I can't list database structures or technical metadata. Ask for the business values or KPI result you need instead.";
  return {
    success: true,
    blocked: true,
    mode: "metadata_discovery_blocked",
    errorCode: "METADATA_DISCOVERY_BLOCKED",
    question,
    insight: {
      answer: message,
      drivers: ["Technical metadata is hidden from analytics responses."],
      followUps: ["Show the business values I asked for", "Show a KPI result"],
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: { dialect, sql: "-- Metadata discovery blocked; no SQL executed", params: [] },
  };
}

export function buildCatalogListResponse(
  question: string,
  connection: Pick<DatabaseConnection, "connection_name" | "db_type">,
  _catalog: AiDatasetDefinition[],
  kpiMetrics: Array<{ label?: string; name: string; involvedTables?: string[] }>,
) {
  const normalizedQuestion = normalize(question);
  const isBusinessKpiList = /\b(kpis|metrics)\b/.test(normalizedQuestion)
    && !/\b(tables|datasets|catalog|schema|columns|fields)\b/.test(normalizedQuestion);
  if (!isBusinessKpiList) {
    return buildMetadataBlockedResponse(question, connection.db_type || "mysql");
  }

  const names = kpiMetrics.map((metric) => metric.label || metric.name).filter(Boolean);
  const answer = names.length > 0
    ? `Available business KPIs: ${names.slice(0, 20).join(", ")}${names.length > 20 ? ", ..." : ""}.`
    : "No business KPIs are currently available for this connection.";
  return {
    success: true,
    mode: "kpi_catalog",
    question,
    insight: {
      answer,
      drivers: ["Business KPI catalog"],
      followUps: names.slice(0, 3).map((name) => `Show me ${name}`),
    },
    chart: null,
    data: { rowCount: names.length, rows: names.map((name) => ({ kpi: name })) },
    sql: { dialect: connection.db_type || "mysql", sql: "-- KPI catalog response; no SQL executed", params: [] },
  };
}

export function buildColumnCatalogResponse(
  question: string,
  connection: Pick<DatabaseConnection, "connection_name" | "db_type">,
  _catalog: AiDatasetDefinition[],
) {
  return buildMetadataBlockedResponse(question, connection.db_type || "mysql");
}
