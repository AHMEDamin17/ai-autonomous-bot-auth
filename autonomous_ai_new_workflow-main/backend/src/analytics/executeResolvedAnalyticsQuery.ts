import crypto from "node:crypto";
import { RowDataPacket } from "mysql2";
import pool from "../db/connection";
import { buildAuthContext, type AuthContext } from "../mcp/security/authProvider";
import { recordTelemetry } from "../telemetry/inMemoryLogs";
import { getTraceId } from "../telemetry/correlation";
import { logExecution, upsertMetrics } from "../telemetry/telemetryStore";
import { withLlmUsageContext } from "../telemetry/llmUsage";
import {
  AiDatasetDefinition,
  ConversationContext,
  DatabaseConnection,
  GlobalAiKpi,
  LiveAdapter,
  SqlFilter,
} from "../types/types";
import {
  getErrorRecoveryGuidance,
  getFriendlyErrorMessage,
  getPublicAnalyticsErrorMessage,
} from "../utils/errorFormatter";
import { decryptConnectionSecrets } from "../utils/secretCrypto";
import { buildAiCatalog } from "../routes/semanticLayer/semanticCatalog";
import { buildLiveAdapter } from "./executor/buildLiveAdapter";
import { runAnalyticsOrchestrator } from "./orchestrator/analyticsOrchestrator";
import {
  canExecuteConnection,
  getConnectionCircuitState,
  recordConnectionFailure,
  recordConnectionSuccess,
} from "./resilience/connectionCircuit";

export type AnalyticsSurface = "analytics-ai" | "dashboard-ai";

export type AnalyticsResponsePayload = {
  [key: string]: any;
  mode?: string;
  success?: boolean;
  executionId?: string;
  question?: string;
  semanticMatch?: {
    datasets?: string[];
    groupBy?: string | string[] | null;
  };
  insight?: {
    answer?: string;
    [key: string]: unknown;
  };
  conversationId?: string;
  sourceConnection?: {
    connectionId: number;
    label: string;
  };
};

export interface ExecuteResolvedAnalyticsQueryInput {
  connectionId: number;
  question: string;
  requestFilters?: SqlFilter[];
  mode?: "simple" | "kpi" | "auto";
  forcedTableContext?: string;
  conversationContext?: ConversationContext;
  conversationId?: string;
  surface: AnalyticsSurface;
  dashboardRouting?: {
    method: "semantic_model" | "sticky_conversation" | "user_selection";
    reason?: string;
  };
  onSuccessfulResponse?: (response: AnalyticsResponsePayload) => Promise<void>;
}

export interface ExecuteResolvedAnalyticsQueryResult {
  statusCode: number;
  payload: AnalyticsResponsePayload;
  connectionUnavailable: boolean;
  connectionId: number;
  connectionLabel?: string;
}

function emptyDataResponse() {
  return { rowCount: 0, rows: [] };
}

export function hasExecutableDatasets(
  catalog: Array<{ name: string; physicalTable?: string; columns?: unknown[] }>,
): boolean {
  return catalog.some(
    (dataset) => dataset.name !== "global_kpis"
      && !!dataset.physicalTable
      && (dataset.columns?.length || 0) > 0,
  );
}

type DashboardSchemaTraceInput = {
  connectionLabel: string;
  databaseType: string;
  catalog: AiDatasetDefinition[];
  catalogAttempted: boolean;
  catalogDurationMs: number;
  kpiMetrics?: GlobalAiKpi[];
  routing?: ExecuteResolvedAnalyticsQueryInput["dashboardRouting"];
};

function compactList(values: unknown[], limit = 8): string {
  const normalized = values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (normalized.length <= limit) return normalized.join(", ");
  return `${normalized.slice(0, limit).join(", ")} (+${normalized.length - limit} more)`;
}

function collectPlanColumnReferences(plan: Record<string, any>): string[] {
  const refs = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) refs.add(value.trim());
  };
  const addMany = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  };

  addMany(plan.groupBy);
  addMany(plan.select_columns);
  add(plan.timeGrainColumn);
  for (const filter of Array.isArray(plan.filters) ? plan.filters : []) {
    add(filter?.field);
  }
  for (const join of Array.isArray(plan.joins) ? plan.joins : []) {
    add(join?.leftColumn);
    add(join?.rightColumn);
    for (const condition of Array.isArray(join?.conditions) ? join.conditions : []) {
      add(condition?.leftColumn);
      add(condition?.rightColumn);
    }
  }
  for (const group of Array.isArray(plan.combinedGroupBy) ? plan.combinedGroupBy : []) {
    add(group?.groupBy);
    addMany(group?.columns);
  }
  return [...refs];
}

function normalizeCatalogRef(value: unknown): string {
  return String(value || "")
    .replace(/[`"\[\]]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function collectKpiColumnReferences(
  kpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
): string[] {
  const involvedRefs = new Set((kpi.involvedTables || []).map(normalizeCatalogRef));
  const involvedDatasets = catalog.filter((dataset) => {
    const refs = [
      dataset.name,
      dataset.label,
      dataset.physicalTable,
      String(dataset.physicalTable || "").split(".").pop(),
    ].map(normalizeCatalogRef);
    return refs.some((ref) => involvedRefs.has(ref));
  });
  const result = new Set<string>();
  const addFromText = (value: unknown) => {
    let remaining = String(value || "").replace(/[`"\[\]]/g, "");
    const qualifiedRefs = remaining.match(
      /[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)+/g,
    ) || [];
    for (const reference of qualifiedRefs) {
      const parts = reference.split(".");
      const columnName = parts.pop()!.toLowerCase();
      const qualifier = normalizeCatalogRef(parts.join("."));
      for (const dataset of involvedDatasets) {
        const datasetRefs = [
          dataset.name,
          dataset.label,
          dataset.physicalTable,
          String(dataset.physicalTable || "").split(".").pop(),
        ].map(normalizeCatalogRef);
        if (!datasetRefs.includes(qualifier)) continue;
        const column = dataset.columns.find(
          (candidate) => candidate.name.toLowerCase() === columnName,
        );
        if (column) result.add(`${dataset.name}.${column.name}`);
      }
      remaining = remaining.replace(reference, " ");
    }

    const tokens = remaining.match(/[A-Za-z_][A-Za-z0-9_$]*/g) || [];
    for (const token of tokens) {
      const normalizedToken = token.toLowerCase();
      for (const dataset of involvedDatasets) {
        const column = dataset.columns.find(
          (candidate) => candidate.name.toLowerCase() === normalizedToken,
        );
        if (column) result.add(`${dataset.name}.${column.name}`);
      }
    }
  };
  const addFilter = (node: any) => {
    if (!node || typeof node !== "object") return;
    addFromText(node.field);
    if (Array.isArray(node.children)) node.children.forEach(addFilter);
  };

  addFromText(kpi.expressionSql);
  kpi.dimensions?.forEach(addFromText);
  kpi.kpi_dimensions?.forEach(addFromText);
  kpi.select_columns?.forEach(addFromText);
  kpi.join_spec?.forEach((join) => {
    addFromText(join.leftColumn);
    addFromText(join.rightColumn);
    join.conditions?.forEach((condition) => {
      addFromText(condition.leftColumn);
      addFromText(condition.rightColumn);
    });
  });
  addFilter(kpi.filter_logic);
  for (const dataset of involvedDatasets) {
    dataset.columns
      .filter((column) => column.isPrimaryKey)
      .forEach((column) => result.add(`${dataset.name}.${column.name}`));
  }
  return [...result];
}

export function addDashboardSchemaTrace(
  surface: AnalyticsSurface,
  payload: AnalyticsResponsePayload,
  input: DashboardSchemaTraceInput,
): AnalyticsResponsePayload {
  if (surface !== "dashboard-ai") return payload;

  const routeMethod = input.routing?.method || "semantic_model";
  const routeLead = routeMethod === "sticky_conversation"
    ? `The pinned Dashboard conversation reused "${input.connectionLabel}".`
    : routeMethod === "user_selection"
      ? `The user selected "${input.connectionLabel}" from the safe connection choices.`
      : `Validated semantic-model routing selected "${input.connectionLabel}".`;
  const routeReason = String(input.routing?.reason || "").trim();
  const routeDetail = `${routeLead} The routing stage supplied no table or column identifiers.${routeReason ? ` Reason: ${routeReason}` : ""}`;

  const executableCatalog = input.catalog.filter(
    (dataset) => dataset.name !== "global_kpis" && !!dataset.physicalTable,
  );
  const columnCount = executableCatalog.reduce(
    (total, dataset) => total + (dataset.columns?.length || 0),
    0,
  );
  const datasetSummary = compactList(
    executableCatalog.map(
      (dataset) => `${dataset.name} (${dataset.columns?.length || 0} columns)`,
    ),
  );
  const catalogLoaded = input.catalogAttempted && executableCatalog.length > 0;
  const catalogDetail = catalogLoaded
    ? `Loaded ${executableCatalog.length} executable dataset(s) and ${columnCount} column(s) from live ${input.databaseType} metadata introspection in ${input.catalogDurationMs} ms${datasetSummary ? `: ${datasetSummary}` : ""}.`
    : "Live metadata introspection did not produce an executable schema catalog.";

  const plan = payload.semanticMatch && typeof payload.semanticMatch === "object"
    ? payload.semanticMatch as Record<string, any>
    : null;
  let decisionStatus: "completed" | "warning" = "warning";
  let decisionDetail = `No validated schema plan was produced for response mode "${payload.mode || "unknown"}". The routing semantic model was not used as executable schema context.`;
  if (plan) {
    decisionStatus = "completed";
    const datasets = compactList(Array.isArray(plan.datasets) ? plan.datasets : []);
    const metric = String(plan.metric || "").trim();
    const matchedKpi = payload.kpiUsed
      ? input.kpiMetrics?.find(
          (candidate) => normalizeCatalogRef(candidate.name) === normalizeCatalogRef(payload.kpiUsed),
        )
      : undefined;
    const columnRefs = compactList(
      matchedKpi
        ? collectKpiColumnReferences(matchedKpi, input.catalog)
        : collectPlanColumnReferences(plan),
      matchedKpi ? 12 : 8,
    );
    const validationSummary = [
      datasets ? `datasets: ${datasets}` : "",
      metric ? `metric: ${metric}` : "",
      columnRefs
        ? `${matchedKpi ? "certified column set" : "column references"}: ${columnRefs}`
        : "",
    ].filter(Boolean).join("; ");
    decisionDetail = payload.kpiUsed
      ? `Certified KPI "${payload.kpiUsed}" pinned its configured tables, joins, and formula; the live catalog validated the resulting plan${validationSummary ? ` (${validationSummary})` : ""}.`
      : `The planner selected only from the live catalog, and the validator accepted the schema decision${validationSummary ? ` (${validationSummary})` : ""}.`;
  }

  const existingTrace = Array.isArray(payload.trace) ? payload.trace : [];
  payload.trace = [
    {
      step: "intent_connection_router",
      status: "completed",
      detail: routeDetail,
    },
    {
      step: "live_schema_introspection",
      status: catalogLoaded ? "completed" : "error",
      detail: catalogDetail,
      durationMs: input.catalogDurationMs,
    },
    {
      step: "schema_decision",
      status: decisionStatus,
      detail: decisionDetail,
    },
    ...existingTrace,
  ];
  return payload;
}

export async function executeResolvedAnalyticsQuery(
  input: ExecuteResolvedAnalyticsQueryInput,
): Promise<ExecuteResolvedAnalyticsQueryResult> {
  const {
    connectionId,
    question,
    requestFilters = [],
    mode = "auto",
    forcedTableContext,
    conversationContext,
    conversationId,
    surface,
    dashboardRouting,
    onSuccessfulResponse,
  } = input;

  let adapter: LiveAdapter | null = null;
  let startedAt = 0;
  let executionId = "";
  let authContext: AuthContext | undefined;
  let connectionType = "unknown";
  let connectionLabel: string | undefined;
  let orchestratorStarted = false;
  let dashboardCatalog: AiDatasetDefinition[] = [];
  let dashboardKpiMetrics: GlobalAiKpi[] = [];
  let catalogAttempted = false;
  let catalogDurationMs = 0;

  const decorateDashboardTrace = (
    payload: AnalyticsResponsePayload,
  ): AnalyticsResponsePayload => {
    if (!connectionLabel) return payload;
    return addDashboardSchemaTrace(surface, payload, {
      connectionLabel,
      databaseType: connectionType,
      catalog: dashboardCatalog,
      catalogAttempted,
      catalogDurationMs,
      kpiMetrics: dashboardKpiMetrics,
      routing: dashboardRouting,
    });
  };

  try {
    const [connectionRows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ?",
      [connectionId],
    );
    if (!connectionRows.length) {
      return {
        statusCode: 404,
        payload: { error: `Connection ${connectionId} not found` },
        connectionUnavailable: true,
        connectionId,
      };
    }

    const connection = decryptConnectionSecrets(
      connectionRows[0] as DatabaseConnection,
    );
    connectionType = connection.db_type || "unknown";
    connectionLabel = connection.connection_name;
    authContext = buildAuthContext(connection);
    executionId = crypto.randomUUID();
    startedAt = Date.now();

    const [kpiRows] = await pool.query<RowDataPacket[]>(
      `SELECT k.*, c.connection_name, c.host
         FROM kpi_metrics k
         JOIN db_connections c ON k.connection_id = c.id
        WHERE k.connection_id = ?
        ORDER BY k.created_at DESC`,
      [connectionId],
    );
    catalogAttempted = true;
    const catalogStartedAt = Date.now();
    const catalogContext = await buildAiCatalog([connection], kpiRows);
    catalogDurationMs = Date.now() - catalogStartedAt;
    const fullCatalog = catalogContext.datasets;
    dashboardCatalog = fullCatalog;
    const kpiMetrics = catalogContext.kpiMetrics;
    dashboardKpiMetrics = kpiMetrics;

    const databaseType = connection.db_type?.toLowerCase();
    if (databaseType === "mongodb" || databaseType === "redis") {
      return {
        statusCode: 200,
        connectionUnavailable: false,
        connectionId,
        connectionLabel,
        payload: decorateDashboardTrace({
          success: false,
          mode: "unsupported_database",
          errorCode: "UNSUPPORTED_DATABASE",
          question,
          error: "Unsupported Database Type",
          insight: {
            answer: "The Analytics AI engine compiles and executes SQL. It cannot run data queries against NoSQL databases like MongoDB or Redis.",
            drivers: ["SQL execution is required"],
            followUps: [],
          },
          chart: null,
          data: emptyDataResponse(),
          sql: {
            dialect: connection.db_type || "unknown",
            sql: "-- Unsupported database type",
            params: [],
          },
          trace: [{
            step: "connection_check",
            status: "warning",
            detail: "Unsupported DB type",
          }],
        }),
      };
    }

    if (!hasExecutableDatasets(fullCatalog)) {
      return {
        statusCode: 200,
        connectionUnavailable: true,
        connectionId,
        connectionLabel,
        payload: decorateDashboardTrace({
          success: false,
          mode: "catalog-unavailable",
          errorCode: "CATALOG_UNAVAILABLE",
          question,
          error: "Executable catalog unavailable",
          insight: {
            answer: `I could not load executable table metadata for ${connection.connection_name}. Refresh the connection catalog or check database reachability before running data or KPI queries.`,
            drivers: ["No executable tables available", "SQL was not planned"],
            followUps: ["List the tables", "Check database connection settings"],
          },
          chart: null,
          data: emptyDataResponse(),
          sql: {
            dialect: connection.db_type || "mysql",
            sql: "-- Catalog unavailable",
            params: [],
          },
          trace: [{
            step: "catalog_builder",
            status: "error",
            detail: "No executable datasets",
          }],
        }),
      };
    }

    const breakerCheck = await canExecuteConnection(connectionId);
    if (!breakerCheck.allowed) {
      return {
        statusCode: 503,
        connectionUnavailable: true,
        connectionId,
        connectionLabel,
        payload: decorateDashboardTrace({
          success: false,
          mode: "database_unavailable",
          errorCode: "CIRCUIT_BREAKER_OPEN",
          question,
          error: "Database temporarily unavailable. Circuit breaker is open.",
          retryAfterMs: breakerCheck.retryAfterMs,
          circuitState: breakerCheck.status,
          data: emptyDataResponse(),
          trace: [{
            step: "circuit_breaker",
            status: "warning",
            detail: "Circuit breaker open",
          }],
        }),
      };
    }

    let catalog = fullCatalog;
    if (forcedTableContext) {
      const index = catalog.findIndex(
        (dataset) => dataset.name === forcedTableContext,
      );
      if (index > 0) {
        catalog = [
          catalog[index]!,
          ...catalog.slice(0, index),
          ...catalog.slice(index + 1),
        ];
      }
    }

    adapter = await buildLiveAdapter(connection);
    orchestratorStarted = true;
    const responsePayload = await withLlmUsageContext(
      {
        executionId,
        connectionId,
        surface,
      },
      () => runAnalyticsOrchestrator({
        question,
        catalog,
        adapter: adapter!,
        kpiMetrics,
        requestFilters,
        conversationContext,
        requestedMode: mode,
        connectionName: connection.connection_name,
      }),
    ) as unknown as AnalyticsResponsePayload | null;
    if (!responsePayload) {
      throw new Error("Analytics query routing did not produce a response.");
    }
    decorateDashboardTrace(responsePayload);

    if (responsePayload.success && onSuccessfulResponse) {
      await onSuccessfulResponse(responsePayload);
    }

    const latencyMs = Date.now() - startedAt;
    if (adapter) {
      await recordConnectionSuccess(connectionId);
    }
    const circuitState = await getConnectionCircuitState(connectionId);
    await logExecution({
      executionId,
      connectionId,
      surface,
      connector: connectionType,
      status: responsePayload.success === false ? "failure" : "success",
      latencyMs,
      authType: authContext.authType,
      traceId: getTraceId(),
    }).catch(console.error);
    await upsertMetrics(
      connectionId,
      connectionType,
      responsePayload.success !== false,
      latencyMs,
    ).catch(console.error);
    recordTelemetry({
      executionId,
      connectionId,
      surface,
      step: "query",
      status: responsePayload.success === false ? "failure" : "success",
      latencyMs,
      authType: authContext.authType,
      circuitState: circuitState.status,
    });

    responsePayload.executionId = executionId;
    responsePayload.question = question;
    if (conversationId) {
      responsePayload.conversationId = conversationId;
    }
    if (surface === "dashboard-ai") {
      responsePayload.sourceConnection = {
        connectionId,
        label: connection.connection_name,
      };
    }
    return {
      statusCode: 200,
      payload: responsePayload,
      connectionUnavailable: false,
      connectionId,
      connectionLabel,
    };
  } catch (error: any) {
    const friendlyMessage = getFriendlyErrorMessage(error);
    const publicMessage = getPublicAnalyticsErrorMessage(friendlyMessage);
    const recoveryGuidance = getErrorRecoveryGuidance(friendlyMessage);
    console.error("[AnalyticsQuery Error]:", friendlyMessage);

    if (startedAt > 0) {
      const latencyMs = Date.now() - startedAt;
      await recordConnectionFailure(connectionId);
      const circuitState = await getConnectionCircuitState(connectionId);
      await logExecution({
        executionId,
        connectionId,
        surface,
        connector: connectionType,
        status: "failure",
        latencyMs,
        authType: authContext?.authType ?? "none",
        message: friendlyMessage,
        traceId: getTraceId(),
      }).catch(console.error);
      await upsertMetrics(
        connectionId,
        connectionType,
        false,
        latencyMs,
      ).catch(console.error);
      recordTelemetry({
        executionId,
        connectionId,
        surface,
        step: "query",
        status: "failure",
        latencyMs,
        authType: authContext?.authType ?? "none",
        message: friendlyMessage,
        circuitState: circuitState.status,
      });
    }

    const errorPayload: AnalyticsResponsePayload = {
      success: false,
      mode: "error",
      question,
      error: publicMessage,
      friendlyError: publicMessage,
      appliedCorrections: [],
      insight: {
        answer: `Analytics AI was unable to complete your query.\n\nReason: ${publicMessage}\n\n${recoveryGuidance}`,
        drivers: [],
        followUps: [],
      },
      chart: null,
      data: emptyDataResponse(),
      sql: {
        dialect: "mysql",
        sql: "-- Query setup failed.",
        params: [],
      },
      trace: [{ step: "query_setup", status: "error" }],
    };
    if (surface === "dashboard-ai" && connectionLabel) {
      errorPayload.sourceConnection = {
        connectionId,
        label: connectionLabel,
      };
    }
    return {
      statusCode: 200,
      connectionUnavailable: !orchestratorStarted,
      connectionId,
      connectionLabel,
      payload: decorateDashboardTrace(errorPayload),
    };
  } finally {
    if (adapter?.close) {
      await Promise.race([
        adapter.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  }
}
