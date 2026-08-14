import { classifyQuery, parseRelativeTimeFilters } from "../routes/semanticLayer/queryClassifier";
import { AiDatasetDefinition, GlobalAiKpi } from "../routes/semanticLayer/semanticCatalog";
import { compileSimpleSelectQuery } from "../sql/compiler";
import { compileKpiQuery } from "../sql/compiler";
import { sanitizeAndCorrectPlan, validatePlan } from "../analytics/validator/validatePlan";
import { CreateKpiSchema } from "../routes/semanticLayer/kpiMetrics";
import { buildGuidedQuerySuggestions, classifyAnalyticsProfile, resolveKpiQualifierFilter, resolveMatchedKpiPlanDimensions, findAmbiguousKpiFilterField, promoteCertifiedKpiPlan, removeUngroundedPlannerFilters, resolveOrchestratorMode } from "../analytics/orchestrator/analyticsOrchestrator";
import { getConfiguredLlmSelection, invokeWithProviderRetry, wrapWithRateLimit } from "../analytics/planner";
import { getErrorRecoveryGuidance, getFriendlyErrorMessage, getPublicAnalyticsErrorMessage, getResilientErrorResponse } from "../utils/errorFormatter";
import { buildInsight } from "../analytics/pipelines/shared/insightBuilder";
import {
  isEntityListRequest,
  planSimpleQuery,
  selectRelevantDatasets,
} from "../analytics/pipelines/simple/simplePlanner";
import {
  isExplicitEntityListRequest,
  selectEntityDisplayColumns,
  selectEntityListFilters,
} from "../analytics/pipelines/simple/entityProjection";
import { classifyDatasetRole, describeDataset } from "../analytics/pipelines/simple/datasetRole";
import { planKpiQuery } from "../analytics/pipelines/kpi/kpiPlanner";
import { buildColumnCatalogResponse, isColumnCatalogQuestion } from "../analytics/pipelines/shared/catalogQuestions";
import {
  buildConversationContextFromConversation,
  Conversation,
} from "../routes/semanticLayer/conversationStore";
import { allowsApiKeyInQuery, redactSensitiveUrl } from "../utils/httpSecurity";
import express from "express";
import { buildDynamicOpenApiSpec } from "../routes/swagger";
import {
  resolveTargetConnection,
  rankConnections,
  semanticRoutingContext,
} from "../analytics/router/semanticModelConnectionRouter";
import { evaluateRoutingFixtures } from "../analytics/router/routingEval";
import { connectionRoutingFixtures } from "./fixtures/connectionRouting.fixtures";
import { pruneCatalogColumns } from "../analytics/planner/pruneCatalogColumns";
import { buildConnectionSelectionResponse } from "../analytics/pipelines/shared/responseBuilders";
import { addDashboardSchemaTrace } from "../analytics/executeResolvedAnalyticsQuery";
import {
  extractLlmTokenUsage,
  filterTelemetryForDisplay,
  resolveLlmContextWindowTokens,
  summarizeLlmUsageEvents,
} from "../telemetry/llmUsage";
import type { TelemetryEvent } from "../telemetry/inMemoryLogs";

const mockCatalog: AiDatasetDefinition[] = [
  {
    name: "orders",
    label: "Orders",
    physicalTable: "dbo.orders",
    certified: true,
    synonyms: [],
    columns: [
      { name: "amount", type: "number", allowedForGrouping: true, allowedForFiltering: true },
      { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "order_date", type: "date", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  }
];

const accountCatalog: AiDatasetDefinition[] = [
  {
    name: "account",
    label: "Accounts",
    physicalTable: "crm.account",
    certified: true,
    synonyms: [],
    columns: [
      { name: "id", type: "number", allowedForGrouping: true, allowedForFiltering: true },
      { name: "name", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "status", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  },
];

const mockKpis: GlobalAiKpi[] = [
  {
    name: "Total Revenue",
    expressionSql: "SUM(amount)",
    valueFormat: "currency",
    involvedTables: ["orders"],
    allowedGroupByTables: ["orders"],
    dimensions: ["region", "order_date"],
  }
];

const duplicateDimensionCatalog: AiDatasetDefinition[] = [
  {
    name: "cases",
    label: "Cases",
    physicalTable: "app.cases",
    certified: true,
    synonyms: [],
    columns: [
      { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
    ],
    metrics: [],
    relationships: [],
  },
  {
    name: "users",
    label: "Users",
    physicalTable: "app.users",
    certified: true,
    synonyms: [],
    columns: [
      { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "display_name", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  },
];

const duplicateDimensionKpi: GlobalAiKpi = {
  name: "Resolved Volume",
  expressionSql: "COUNT(cases.number)",
  valueFormat: "number",
  involvedTables: ["cases", "users"],
  allowedGroupByTables: ["cases", "users"],
  dimensions: ["cases.region", "users.region", "users.display_name"],
};

const measureConflictCatalog: AiDatasetDefinition[] = [
  {
    name: "inbound_report",
    label: "Inbound Report",
    physicalTable: "wms.inbound_report",
    certified: true,
    synonyms: [],
    columns: [
      // Mirrors the real warehouse DB: quantities are stored as TEXT, so the
      // semantic layer types them "string" — the conflict detector must still
      // recognize them as measures by name.
      { name: "receivedQty", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "rejectedQty", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  },
];

const inboundVolumeKpi: GlobalAiKpi = {
  name: "INBOUND Volume",
  expressionSql: "SUM(inbound_report.receivedQty)",
  valueFormat: "number",
  involvedTables: ["inbound_report"],
  allowedGroupByTables: ["inbound_report"],
  dimensions: ["inbound_report.region"],
};

const rejectedVolumeKpi: GlobalAiKpi = {
  name: "Rejected Quantity",
  expressionSql: "SUM(inbound_report.rejectedQty)",
  valueFormat: "number",
  involvedTables: ["inbound_report"],
  allowedGroupByTables: ["inbound_report"],
  dimensions: ["inbound_report.region"],
};

const volumeResolvedCatalog: AiDatasetDefinition[] = [
  {
    name: "case_table",
    label: "Cases",
    physicalTable: "app.case_table",
    certified: true,
    synonyms: [],
    columns: [
      { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "assigned_to", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "resolved_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
      { name: "state", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "subcategory", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      // These columns previously caused the false conflict: after generic
      // amt/qty tokens were removed, the shared dimension prefix `gsc` was
      // incorrectly treated as the requested competing measure.
      { name: "u_gsc_amt_qty_1", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "u_gsc_amt_qty_2", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "u_gsc_amt_qty_3", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [{
      name: "volume_resolved",
      label: "Volume Resolved",
      expressionSql: "COUNT(case_table.number)",
      format: "number",
      synonyms: [],
    }],
    relationships: [{
      targetDataset: "user_table",
      sourceColumn: "assigned_to",
      targetColumn: "name",
      type: "kpi_defined",
    }],
  },
  {
    name: "user_table",
    label: "Users",
    physicalTable: "app.user_table",
    certified: true,
    synonyms: [],
    columns: [
      { name: "name", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "u_gsc_region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "web_service_access_only", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  },
  {
    name: "unrelated_region_table",
    label: "Unrelated Regions",
    physicalTable: "app.unrelated_region_table",
    certified: true,
    synonyms: [],
    columns: [
      { name: "u_gsc_region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
      { name: "case_number", type: "string", allowedForGrouping: true, allowedForFiltering: true },
    ],
    metrics: [],
    relationships: [],
  },
];

const volumeResolvedKpi: GlobalAiKpi = {
  name: "volume_resolved",
  expressionSql: "COUNT(case_table.number)",
  valueFormat: "number",
  involvedTables: ["case_table", "user_table"],
  allowedGroupByTables: ["case_table", "user_table"],
  dimensions: ["case_table.resolved_at", "user_table.u_gsc_region"],
  kpi_dimensions: ["case_table.resolved_at", "user_table.u_gsc_region"],
  join_spec: [{
    type: "INNER",
    leftTable: "case_table",
    leftColumn: "assigned_to",
    rightTable: "user_table",
    rightColumn: "name",
  }],
  filter_logic: {
    type: "group",
    operator: "AND",
    children: [
      { type: "condition", field: "case_table.state", op: "in", value: ["Resolved", "Closed"] },
      { type: "condition", field: "user_table.web_service_access_only", op: "neq", value: "true" },
    ],
  },
};

export async function runRegressionTests() {
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  const expect = (actual: any) => ({
    toEqual: (expected: any) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toBe: (expected: any) => {
      if (actual !== expected) {
        throw new Error(`Expected ${expected} but got ${actual}`);
      }
    },
    toContain: (expected: string) => {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected ${actual} to contain ${expected}`);
      }
    }
  });

  const cases = [
    {
      name: "simple planner intent scoping: a vague 'cases' question selects the case tables, drops fillers, and ranks the backup below the live table",
      fn: async () => {
        const makeDataset = (name: string, label: string, columns: string[]) => ({
          name,
          label,
          physicalTable: `gsconnectdev.${label}`,
          certified: true,
          synonyms: [],
          columns: columns.map((c) => ({ name: c, type: "string" })),
          metrics: [],
          relationships: [],
        });
        const fillers = Array.from({ length: 25 }, (_, i) =>
          makeDataset(`gsconnectdev_filler_${i}`, `FILLER_${i}`, ["id", "value"]));
        const caseTables = [
          makeDataset("gsconnectdev_gs_sn_customerservice_case", "GS_SN_CUSTOMERSERVICE_CASE", ["number", "state"]),
          makeDataset("gsconnectdev_gs_sn_customerservice_case_report", "GS_SN_CUSTOMERSERVICE_CASE_REPORT", ["total"]),
          makeDataset("gsconnectdev_bkp_case", "BKP_CASE", ["number", "state"]),
        ];
        const catalog = [...fillers, ...caseTables] as unknown as AiDatasetDefinition[];
        const { datasets } = selectRelevantDatasets("what are the cases?", catalog);
        const names = datasets.map((d) => d.name);
        expect(names.includes("gsconnectdev_gs_sn_customerservice_case")).toBe(true);
        expect(names.includes("gsconnectdev_gs_sn_customerservice_case_report")).toBe(true);
        expect(names.some((n) => n.startsWith("gsconnectdev_filler_"))).toBe(false);
        const liveIdx = names.indexOf("gsconnectdev_gs_sn_customerservice_case");
        const bkpIdx = names.indexOf("gsconnectdev_bkp_case");
        expect(liveIdx >= 0 && (bkpIdx === -1 || liveIdx < bkpIdx)).toBe(true);
      },
    },
    {
      name: "simple entity listing: vague cases request gets a compact catalog-approved projection",
      fn: async () => {
        const caseDataset: AiDatasetDefinition = {
          name: "gsconnectdev_gs_sn_customerservice_case",
          label: "GS_SN_CUSTOMERSERVICE_CASE",
          physicalTable: "gsconnectdev.GS_SN_CUSTOMERSERVICE_CASE",
          certified: true,
          synonyms: [],
          columns: [
            { name: "sys_id", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
            { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "short_description", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "state", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "priority", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "assigned_to", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "opened_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
            { name: "resolved_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
            { name: "internal_notes", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          ],
          metrics: [],
          relationships: [],
        };
        expect(isEntityListRequest("what are the cases?", caseDataset)).toBe(true);
        expect(isEntityListRequest("how many cases?", caseDataset)).toBe(false);
        expect(isEntityListRequest("what columns are in cases?", caseDataset)).toBe(false);
        expect(selectEntityDisplayColumns(caseDataset)).toEqual([
          "number",
          "short_description",
          "state",
          "priority",
          "assigned_to",
        ]);

        let invocations = 0;
        const model = {
          withStructuredOutput: () => ({
            invoke: async () => {
              invocations += 1;
              return {
                datasets: [caseDataset.name],
                joins: [],
                metric: "",
                groupBy: null,
                filters: [],
                requiresApproval: false,
              };
            },
          }),
        };
        const plan = await planSimpleQuery(
          "what are the cases?",
          [caseDataset],
          [],
          undefined,
          undefined,
          undefined,
          model,
        );
        expect(invocations).toBe(1);
        expect(plan.select_columns).toEqual([
          `${caseDataset.name}.number`,
          `${caseDataset.name}.short_description`,
          `${caseDataset.name}.state`,
          `${caseDataset.name}.priority`,
          `${caseDataset.name}.assigned_to`,
        ]);

        const sanitized = sanitizeAndCorrectPlan(
          plan,
          [caseDataset],
          { allowDynamicMetrics: false, requireExplicitProjection: true },
        );
        expect(sanitized.issues).toEqual([]);
        const compiled = compileSimpleSelectQuery(
          sanitized.plan,
          "mysql",
          (ref) => {
            if (ref === `${caseDataset.name}.__table__`) {
              return { table: caseDataset.physicalTable, column: "__table__" };
            }
            const column = ref.slice(caseDataset.name.length + 1);
            return caseDataset.columns.some((candidate) => candidate.name === column)
              ? { table: caseDataset.physicalTable, column }
              : null;
          },
          undefined,
          [caseDataset],
        );
        expect(compiled.sql).toContain("`gsconnectdev`.`GS_SN_CUSTOMERSERVICE_CASE`.`number`");
        expect(compiled.sql).toContain("`gsconnectdev`.`GS_SN_CUSTOMERSERVICE_CASE`.`assigned_to`");
        expect(compiled.sql.includes("*")).toBe(false);

        const { insight, chart } = buildInsight(
          sanitized.plan,
          {
            rowCount: 2,
            rows: [
              { number: "CASE001", short_description: "Example", state: "Open" },
              { number: "CASE002", short_description: "Example 2", state: "Closed" },
            ],
          } as any,
          [caseDataset],
        );
        expect(insight.answer).toBe("Returned 2 cases.");
        expect(insight.drivers).toEqual([
          "Catalog-approved case fields listed without aggregation.",
        ]);
        expect(chart).toBe(null);
      },
    },
    {
      name: "entity-list shape guard: filtered case rows cannot be hijacked by a partial resolved-cases KPI match",
      fn: async () => {
        const caseDataset: AiDatasetDefinition = {
          name: "gsconnectdev_gs_sn_customerservice_case",
          label: "GS_SN_CUSTOMERSERVICE_CASE",
          physicalTable: "gsconnectdev.GS_SN_CUSTOMERSERVICE_CASE",
          certified: true,
          synonyms: [],
          columns: [
            { name: "sys_id", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
            { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "short_description", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "state", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "priority", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            { name: "opened_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
          ],
          metrics: [],
          relationships: [],
        };
        const centerDataset: AiDatasetDefinition = {
          name: "gsconnectdev_gsc_center",
          label: "GSC_CENTER",
          physicalTable: "gsconnectdev.GSC_CENTER",
          certified: true,
          synonyms: [],
          columns: [
            { name: "id", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
            { name: "name", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          ],
          metrics: [],
          relationships: [],
        };
        const centerMatchedKpi: GlobalAiKpi = {
          name: "center-matched_resolved_cases",
          expressionSql: `COUNT(${caseDataset.name}.number)`,
          valueFormat: "number",
          involvedTables: [caseDataset.name, centerDataset.name],
          allowedGroupByTables: [caseDataset.name, centerDataset.name],
          dimensions: [`${caseDataset.name}.resolved_at`, `${centerDataset.name}.name`],
          join_spec: [{
            type: "INNER",
            leftTable: caseDataset.name,
            leftColumn: "sys_id",
            rightTable: centerDataset.name,
            rightColumn: "id",
          }],
        };
        const catalog = [caseDataset, centerDataset];
        const question = "list the high priority cases that are resolved";

        expect(isExplicitEntityListRequest(question, catalog)).toBe(true);
        expect(selectEntityListFilters(question, caseDataset)).toEqual([
          { field: "priority", op: "eq", value: "High" },
          { field: "state", op: "eq", value: "Resolved" },
        ]);
        const classified = classifyQuery(question, [centerMatchedKpi], catalog);
        expect(classified.mode).toBe("COMPLEX");
        expect(classified.reason).toContain("record output rather than a KPI aggregate");
        const profile = classifyAnalyticsProfile(question, [centerMatchedKpi], catalog);
        expect(profile.profile).toBe("simple");
        expect(profile.classification.kpi).toBe(undefined);

        // Weak "show" wording can still call an explicitly named KPI, while
        // aggregate wording remains KPI-safe.
        expect(classifyQuery(
          "show center-matched resolved cases",
          [centerMatchedKpi],
          catalog,
        ).mode).toBe("KPI");
        expect(classifyQuery(
          "how many center-matched resolved cases are there?",
          [centerMatchedKpi],
          catalog,
        ).mode).toBe("KPI");

        const hostileModel = {
          withStructuredOutput: () => ({
            invoke: async () => ({
              datasets: [caseDataset.name],
              joins: [],
              metric: centerMatchedKpi.name,
              groupBy: null,
              filters: [],
              requiresApproval: false,
            }),
          }),
        };
        const plan = await planSimpleQuery(
          question,
          catalog,
          [centerMatchedKpi],
          undefined,
          undefined,
          undefined,
          hostileModel,
        );
        expect(plan.datasets).toEqual([caseDataset.name]);
        expect(plan.metric).toBe("");
        expect(plan.select_columns).toEqual([
          `${caseDataset.name}.number`,
          `${caseDataset.name}.short_description`,
          `${caseDataset.name}.state`,
          `${caseDataset.name}.priority`,
          `${caseDataset.name}.opened_at`,
        ]);
        expect(plan.filters).toEqual([
          { field: `${caseDataset.name}.priority`, op: "eq", value: "High" },
          { field: `${caseDataset.name}.state`, op: "eq", value: "Resolved" },
        ]);

        const sanitized = sanitizeAndCorrectPlan(
          plan,
          catalog,
          { allowDynamicMetrics: false, requireExplicitProjection: true },
        );
        expect(sanitized.issues).toEqual([]);
        const compiled = compileSimpleSelectQuery(
          sanitized.plan,
          "mysql",
          (ref) => {
            if (ref === `${caseDataset.name}.__table__`) {
              return { table: caseDataset.physicalTable, column: "__table__" };
            }
            const column = ref.slice(caseDataset.name.length + 1);
            return caseDataset.columns.some((candidate) => candidate.name === column)
              ? { table: caseDataset.physicalTable, column }
              : null;
          },
          undefined,
          catalog,
        );
        expect(compiled.sql.includes("COUNT(")).toBe(false);
        expect(compiled.sql).toContain("`priority` = ?");
        expect(compiled.sql).toContain("`state` = ?");
        expect(compiled.params).toEqual(["High", "Resolved"]);
      },
    },
    {
      name: "dataset role classification: backup/entity/report/log/lookup and backup-wins-over-report",
      fn: async () => {
        const mk = (name: string, label: string, cols: string[]) => ({
          name,
          label,
          physicalTable: `db.${label}`,
          certified: true,
          synonyms: [],
          columns: cols.map((c) => ({ name: c, type: "string" })),
          metrics: [],
          relationships: [],
        }) as unknown as AiDatasetDefinition;
        const role = (label: string, cols: string[] = ["id", "x"]) =>
          classifyDatasetRole(mk(`db_${label.toLowerCase()}`, label, cols));
        expect(role("GS_SN_CUSTOMERSERVICE_CASE")).toBe("entity");
        expect(role("BKP_CASE")).toBe("backup");
        expect(role("GS_SN_CUSTOMERSERVICE_CASE_REPORT")).toBe("report");
        expect(role("CASE_AUDIT_LOG")).toBe("log");
        expect(role("STATUS_TYPE", ["id", "name"])).toBe("lookup");
        // A wide table named like a lookup is not a lookup.
        expect(role("STATUS_TYPE", Array.from({ length: 20 }, (_, i) => `c${i}`))).toBe("entity");
        // Backup is decided before report: "bkp_case_report" is a backup.
        expect(role("BKP_CASE_REPORT")).toBe("backup");
        const desc = describeDataset(mk("db_bkp_case", "BKP_CASE", ["id"]));
        expect(desc.role).toBe("backup");
        expect(desc.note.includes("NOT the live source")).toBe(true);
      },
    },
    {
      name: "connection router: confident, ambiguous, and no-match outcomes use the score gap",
      fn: async () => {
        const eligible = [
          { connectionId: 11, label: "Sales", semanticContext: "Orders, revenue, and regional sales performance." },
          { connectionId: 22, label: "Support", semanticContext: "Customer cases, resolution volume, and service quality." },
        ];
        const modelFor = (result: unknown) => ({
          withStructuredOutput: () => ({
            invoke: async () => result,
          }),
        });
        const confident = await resolveTargetConnection(
          "Show revenue by region",
          eligible,
          undefined,
          {
            model: modelFor({
              noMatch: false,
              reason: "Revenue is a sales subject.",
              rankings: [
                { connectionId: 11, score: 0.91, reason: "Revenue and regions." },
                { connectionId: 22, score: 0.2, reason: "No sales subject." },
              ],
            }),
          },
        );
        expect(confident.outcome).toBe("confident");
        if (confident.outcome === "confident") {
          expect(confident.selected.connectionId).toBe(11);
        }

        const ambiguous = await resolveTargetConnection(
          "Show monthly volume",
          eligible,
          undefined,
          {
            model: modelFor({
              noMatch: false,
              reason: "Volume appears in both business areas.",
              rankings: [
                { connectionId: 11, score: 0.81, reason: "Order volume." },
                { connectionId: 22, score: 0.74, reason: "Case volume." },
              ],
            }),
          },
        );
        expect(ambiguous.outcome).toBe("ambiguous");

        const noMatch = await resolveTargetConnection(
          "What is the weather?",
          eligible,
          undefined,
          {
            model: modelFor({
              noMatch: true,
              reason: "No summary covers weather.",
              rankings: [],
            }),
          },
        );
        expect(noMatch.outcome).toBe("no_match");
      },
    },
    {
      name: "semantic-model router: builds safe business routing context from a valid document",
      fn: async () => {
        const context = semanticRoutingContext({
          version: "1.0",
          model_name: "Sales Model",
          domain: "Commerce",
          description: "Revenue and order analysis.",
          datasource: { connection_id: "mysql_sales", database_name: "sales" },
          entities: [{
            name: "Order",
            table_name: "internal_orders_table",
            description: "Customer orders.",
            primary_keys: ["id"],
            dimensions: [{ name: "Region", column_name: "region_code", datatype: "varchar", description: "Sales region." }],
            measures: [{ name: "Revenue", expression: "amount", aggregation: "sum", datatype: "decimal", format: "currency", description: "Order revenue." }],
          }],
          relationships: [],
        });
        expect(context?.includes("Sales Model")).toBe(true);
        expect(context?.includes("Revenue")).toBe(true);
        expect(context?.includes("internal_orders_table")).toBe(false);
        expect(context?.includes("region_code")).toBe(false);
      },
    },
    {
      name: "semantic-model router: rejects invalid stored documents",
      fn: async () => {
        expect(semanticRoutingContext({ version: "1.0", entities: [] })).toBe(null);
        expect(semanticRoutingContext("not-json")).toBe(null);
      },
    },
    {
      name: "semantic-model router: no ready candidates returns a deterministic no-match",
      fn: async () => {
        const ranked = await rankConnections("Show revenue", []);
        expect(ranked.noMatch).toBe(true);
        expect(ranked.reason).toContain("semantic models");
        expect(ranked.rankings).toEqual([]);
      },
    },
    {
      name: "semantic-model router: explicit selection cannot bypass readiness",
      fn: async () => {
        const resolution = await resolveTargetConnection(
          "Show revenue",
          [{ connectionId: 11, label: "Sales", semanticContext: "Revenue and orders." }],
          undefined,
          { selectedConnectionId: 22 },
        );
        expect(resolution.outcome).toBe("no_match");
        expect(resolution.reason).toContain("no ready semantic model");
      },
    },
    {
      name: "connection router: ranking allowlist drops invented connection IDs",
      fn: async () => {
        const rankings = await rankConnections(
          "Show revenue",
          [{ connectionId: 11, label: "Sales", semanticContext: "Revenue and orders." }],
          undefined,
          {
            withStructuredOutput: () => ({
              invoke: async () => ({
                noMatch: false,
                reason: "Revenue match.",
                rankings: [
                  { connectionId: 999, score: 1, reason: "Invented." },
                  { connectionId: 11, score: 0.9, reason: "Semantic-model match." },
                ],
              }),
            }),
          },
        );
        expect(rankings.rankings.length).toBe(1);
        expect(rankings.rankings[0]?.connectionId).toBe(11);
      },
    },
    {
      name: "connection selection response exposes only safe card fields",
      fn: async () => {
        const response = buildConnectionSelectionResponse(
          "Show volume",
          [{
            connectionId: 11,
            label: "Sales",
            semanticContext: "Orders and revenue.",
            host: "secret.internal",
          } as any],
        );
        expect(response.mode).toBe("connection_selection_required");
        expect(Object.keys(response.connectionChoices[0]!).sort()).toEqual(
          ["connectionId", "context", "label"],
        );
        expect(JSON.stringify(response)).toBe(
          JSON.stringify(response).replace("secret.internal", ""),
        );
      },
    },
    {
      name: "dashboard trace explains live schema decisions before orchestrator tools",
      fn: async () => {
        const response: any = {
          success: true,
          mode: "autonomous-ai",
          semanticMatch: {
            datasets: ["orders"],
            metric: "SUM(orders.amount)",
            groupBy: "orders.region",
            filters: [{ field: "orders.order_date", op: "relative", value: "last month" }],
          },
          trace: [{
            step: "query_classifier_tool",
            status: "completed",
            detail: "Simple profile selected.",
          }],
        };
        const decorated = addDashboardSchemaTrace(
          "dashboard-ai",
          response,
          {
            connectionLabel: "Semantic Test",
            databaseType: "mysql",
            catalog: mockCatalog,
            catalogAttempted: true,
            catalogDurationMs: 17,
            routing: {
              method: "semantic_model",
              reason: "The question concerns order analysis.",
            },
          },
        );
        expect(decorated.trace.map((entry: any) => entry.step)).toEqual([
          "intent_connection_router",
          "live_schema_introspection",
          "schema_decision",
          "query_classifier_tool",
        ]);
        expect(decorated.trace[0].detail).toContain(
          "supplied no table or column identifiers",
        );
        expect(decorated.trace[1].detail).toContain(
          "orders (3 columns)",
        );
        expect(decorated.trace[2].detail).toContain(
          "orders.region",
        );
        expect(decorated.trace[2].detail).toContain(
          "orders.order_date",
        );

        const kpiResponse: any = {
          success: true,
          mode: "certified-kpi",
          kpiUsed: "Total Revenue",
          semanticMatch: {
            datasets: ["orders"],
            metric: "Total Revenue",
            groupBy: null,
          },
          trace: [],
        };
        addDashboardSchemaTrace(
          "dashboard-ai",
          kpiResponse,
          {
            connectionLabel: "Semantic Test",
            databaseType: "mysql",
            catalog: mockCatalog,
            catalogAttempted: true,
            catalogDurationMs: 17,
            kpiMetrics: mockKpis,
          },
        );
        expect(kpiResponse.trace[2].detail).toContain(
          "certified column set: orders.amount, orders.region, orders.order_date",
        );

        const qualifiedFilterCatalog: AiDatasetDefinition[] = [
          {
            name: "cases",
            label: "Cases",
            physicalTable: "app.cases",
            certified: true,
            synonyms: [],
            columns: [
              { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
              { name: "state", type: "string", allowedForGrouping: true, allowedForFiltering: true },
              { name: "assigned_to", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            ],
            metrics: [],
            relationships: [],
          },
          {
            name: "users",
            label: "Users",
            physicalTable: "app.users",
            certified: true,
            synonyms: [],
            columns: [
              { name: "name", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
              { name: "state", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            ],
            metrics: [],
            relationships: [],
          },
        ];
        const qualifiedFilterKpi: GlobalAiKpi = {
          name: "Resolved Cases",
          expressionSql: "COUNT(cases.number)",
          valueFormat: "number",
          involvedTables: ["cases", "users"],
          allowedGroupByTables: ["cases", "users"],
          dimensions: [],
          join_spec: [{
            type: "INNER",
            leftTable: "cases",
            leftColumn: "assigned_to",
            rightTable: "users",
            rightColumn: "name",
          }],
          filter_logic: {
            type: "condition",
            field: "cases.state",
            op: "eq",
            value: "Resolved",
          },
        };
        const qualifiedFilterResponse: any = {
          success: true,
          mode: "certified-kpi",
          kpiUsed: qualifiedFilterKpi.name,
          semanticMatch: {
            datasets: ["cases", "users"],
            metric: qualifiedFilterKpi.name,
          },
          trace: [],
        };
        addDashboardSchemaTrace(
          "dashboard-ai",
          qualifiedFilterResponse,
          {
            connectionLabel: "Cases",
            databaseType: "mysql",
            catalog: qualifiedFilterCatalog,
            catalogAttempted: true,
            catalogDurationMs: 17,
            kpiMetrics: [qualifiedFilterKpi],
          },
        );
        expect(qualifiedFilterResponse.trace[2].detail).toContain("cases.state");
        expect(qualifiedFilterResponse.trace[2].detail.includes("users.state")).toBe(false);

        const adminResponse: any = {
          trace: [{ step: "query_classifier_tool", status: "completed" }],
        };
        addDashboardSchemaTrace(
          "analytics-ai",
          adminResponse,
          {
            connectionLabel: "Semantic Test",
            databaseType: "mysql",
            catalog: mockCatalog,
            catalogAttempted: true,
            catalogDurationMs: 17,
          },
        );
        expect(adminResponse.trace.map((entry: any) => entry.step)).toEqual([
          "query_classifier_tool",
        ]);
      },
    },
    {
      name: "llm usage: provider token metadata is normalized and summarized",
      fn: async () => {
        expect(extractLlmTokenUsage({
          usage_metadata: {
            input_tokens: 120,
            output_tokens: 30,
            total_tokens: 150,
          },
        })).toEqual({
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          usageReported: true,
        });
        expect(extractLlmTokenUsage({
          response_metadata: {
            tokenUsage: {
              promptTokens: 80,
              completionTokens: 20,
              totalTokens: 100,
            },
          },
        }).totalTokens).toBe(100);

        const originalContextWindow = process.env.LLM_CONTEXT_WINDOW_TOKENS;
        process.env.LLM_CONTEXT_WINDOW_TOKENS = "128000";
        expect(resolveLlmContextWindowTokens("groq", "test-model")).toBe(128000);
        if (originalContextWindow === undefined) {
          delete process.env.LLM_CONTEXT_WINDOW_TOKENS;
        } else {
          process.env.LLM_CONTEXT_WINDOW_TOKENS = originalContextWindow;
        }

        const events: TelemetryEvent[] = [
          {
            timestamp: "2026-07-27T00:00:02.000Z",
            executionId: "call-2",
            connectionId: 7,
            surface: "dashboard-ai",
            step: "llm_call",
            stage: "simple_planner",
            status: "success",
            latencyMs: 100,
            authType: "llm_provider",
            inputTokens: 300,
            outputTokens: 50,
            totalTokens: 350,
            contextUsagePercent: 0.2734,
            usageReported: true,
          },
          {
            timestamp: "2026-07-27T00:00:01.000Z",
            executionId: "call-1",
            connectionId: 0,
            surface: "dashboard-ai",
            step: "llm_call",
            stage: "connection_router",
            status: "success",
            latencyMs: 50,
            authType: "llm_provider",
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            contextUsagePercent: 0.0938,
            usageReported: true,
          },
          {
            timestamp: "2026-07-27T00:00:00.000Z",
            executionId: "query-1",
            connectionId: 7,
            step: "query",
            status: "success",
            latencyMs: 200,
            authType: "api_key",
          },
        ];
        const summary = summarizeLlmUsageEvents(events);
        expect(summary.summary.callCount).toBe(2);
        expect(summary.summary.inputTokens).toBe(400);
        expect(summary.summary.outputTokens).toBe(70);
        expect(summary.summary.totalTokens).toBe(470);
        expect(summary.byStage.map((entry) => entry.stage)).toEqual([
          "simple_planner",
          "connection_router",
        ]);

        const originalVisibility = process.env.SHOW_LLM_TOKEN_USAGE;
        process.env.SHOW_LLM_TOKEN_USAGE = "false";
        expect(filterTelemetryForDisplay(events).length).toBe(1);
        process.env.SHOW_LLM_TOKEN_USAGE = "true";
        expect(filterTelemetryForDisplay(events).length).toBe(3);
        if (originalVisibility === undefined) {
          delete process.env.SHOW_LLM_TOKEN_USAGE;
        } else {
          process.env.SHOW_LLM_TOKEN_USAGE = originalVisibility;
        }
      },
    },
    {
      name: "catalog pruning preserves KPI, key, join, and question columns",
      fn: async () => {
        const columns: AiDatasetDefinition["columns"] = Array.from(
          { length: 205 },
          (_, index) => ({
          name: `unused_${index}`,
          type: "string" as const,
          allowedForGrouping: true,
          allowedForFiltering: true,
          }),
        );
        columns.push({
          name: "order_id",
          type: "string",
          allowedForGrouping: true,
          allowedForFiltering: true,
          isPrimaryKey: true,
        } as any);
        columns.push({
          name: "net_revenue",
          type: "number",
          allowedForGrouping: true,
          allowedForFiltering: true,
        });
        columns.push({
          name: "customer_region",
          type: "string",
          allowedForGrouping: true,
          allowedForFiltering: true,
        });
        const wideCatalog: AiDatasetDefinition[] = [{
          name: "orders",
          label: "Orders",
          physicalTable: "dbo.orders",
          certified: true,
          synonyms: [],
          columns,
          metrics: [],
          relationships: [],
        }];
        const pruned = pruneCatalogColumns(
          wideCatalog,
          "Show revenue by customer region",
          {
            name: "Net Revenue",
            expressionSql: "SUM(orders.net_revenue)",
            valueFormat: "currency",
            involvedTables: ["orders"],
            allowedGroupByTables: ["orders"],
            dimensions: ["orders.customer_region"],
          },
          { widthThreshold: 200, maxColumns: 10 },
        );
        const kept = pruned[0]!.columns.map((column) => column.name);
        expect(kept.includes("order_id")).toBe(true);
        expect(kept.includes("net_revenue")).toBe(true);
        expect(kept.includes("customer_region")).toBe(true);
        expect(wideCatalog[0]!.columns.length).toBe(208);
      },
    },
    {
      name: "KPI catalog pruning preserves every required column across all configured tables",
      fn: async () => {
        const fillerColumns = (prefix: string): AiDatasetDefinition["columns"] =>
          Array.from({ length: 205 }, (_, index) => ({
            name: `${prefix}_unused_${index}`,
            type: "string" as const,
            allowedForGrouping: true,
            allowedForFiltering: true,
          }));
        const casesColumns: AiDatasetDefinition["columns"] = [
          ...fillerColumns("case"),
          { name: "sys_id", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
          { name: "number", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          { name: "short_description", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          { name: "assigned_to", type: "string", allowedForGrouping: true, allowedForFiltering: true },
        ];
        const usersColumns: AiDatasetDefinition["columns"] = [
          ...fillerColumns("user"),
          { name: "sys_id", type: "string", allowedForGrouping: true, allowedForFiltering: true, isPrimaryKey: true },
          { name: "name", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          { name: "web_service_access_only", type: "string", allowedForGrouping: true, allowedForFiltering: true },
        ];
        const wideKpiCatalog: AiDatasetDefinition[] = [
          {
            name: "cases",
            label: "Cases",
            physicalTable: "app.cases",
            certified: true,
            synonyms: [],
            columns: casesColumns,
            metrics: [],
            relationships: [{
              targetDataset: "users",
              sourceColumn: "assigned_to",
              targetColumn: "name",
              type: "kpi_defined",
            }],
          },
          {
            name: "users",
            label: "Users",
            physicalTable: "app.users",
            certified: true,
            synonyms: [],
            columns: usersColumns,
            metrics: [],
            relationships: [],
          },
        ];
        const wideKpi: GlobalAiKpi = {
          name: "Resolved Cases",
          expressionSql: "COUNT(cases.number)",
          valueFormat: "number",
          involvedTables: ["cases", "users"],
          allowedGroupByTables: ["cases", "users"],
          dimensions: ["users.region"],
          select_columns: ["cases.short_description"],
          join_spec: [{
            type: "INNER",
            leftTable: "cases",
            leftColumn: "assigned_to",
            rightTable: "users",
            rightColumn: "name",
          }],
          filter_logic: {
            type: "condition",
            field: "users.web_service_access_only",
            op: "eq",
            value: "false",
          },
        };
        const pruned = pruneCatalogColumns(
          wideKpiCatalog,
          "Show Resolved Cases by region",
          wideKpi,
          { widthThreshold: 200, maxColumns: 2 },
        );
        const keptByTable = Object.fromEntries(
          pruned.map((dataset) => [
            dataset.name,
            dataset.columns.map((column) => column.name),
          ]),
        );
        for (const column of ["sys_id", "number", "short_description", "assigned_to"]) {
          expect(keptByTable.cases.includes(column)).toBe(true);
        }
        for (const column of ["sys_id", "name", "region", "web_service_access_only"]) {
          expect(keptByTable.users.includes(column)).toBe(true);
        }
        expect(wideKpiCatalog[0]!.columns.length).toBe(209);
        expect(wideKpiCatalog[1]!.columns.length).toBe(209);

        let prompt = "";
        const model = {
          withStructuredOutput: () => ({
            invoke: async (messages: unknown) => {
              prompt = JSON.stringify(messages);
              return {
                datasets: ["cases", "users"],
                joins: wideKpi.join_spec,
                metric: wideKpi.name,
                groupBy: "users.region",
                filters: [],
                requiresApproval: false,
              };
            },
          }),
        };
        const plan = await planKpiQuery(
          "Show Resolved Cases by region",
          pruned,
          [wideKpi],
          wideKpi,
          undefined,
          undefined,
          undefined,
          model,
        );
        expect(plan.datasets).toEqual(["cases", "users"]);
        for (const reference of [
          "cases",
          "users",
          "number",
          "short_description",
          "assigned_to",
          "name",
          "region",
          "web_service_access_only",
        ]) {
          expect(prompt).toContain(reference);
        }
      },
    },
    {
      name: "routing eval harness reports connection accuracy and table overlap",
      fn: async () => {
        const metrics = await evaluateRoutingFixtures(
          connectionRoutingFixtures,
          async (fixture) => ({
            connectionId: fixture.expectedConnectionId,
            datasets: fixture.expectedDatasets,
          }),
        );
        expect(metrics.total).toBe(2);
        expect(metrics.routingAccuracy).toBe(1);
        expect(metrics.averageTableOverlap).toBe(1);
      },
    },
    {
      name: "OpenAPI: discovered contracts match KPI fields and route-specific authentication",
      fn: async () => {
        const app = express();
        const api = express.Router();
        api.post("/kpi-metrics", (_req, res) => res.sendStatus(201));
        api.post("/analytics/query", (_req, res) => res.sendStatus(200));
        api.post("/conversations", (_req, res) => res.sendStatus(201));
        api.delete("/conversations/:id", (_req, res) => res.sendStatus(200));
        api.delete("/conversations", (_req, res) => res.sendStatus(200));
        api.get("/observability/stream", (_req, res) => res.sendStatus(200));
        app.use("/api", api);
        app.get("/healthz", (_req, res) => res.sendStatus(200));

        const spec = buildDynamicOpenApiSpec(app);
        const kpiSchema = spec.paths["/api/kpi-metrics"].post.requestBody.content["application/json"].schema;
        expect(kpiSchema.required).toEqual([
          "connection_id",
          "metric_name",
          "department",
          "metric_type",
          "formula",
          "involved_tables",
        ]);
        expect(!!kpiSchema.properties.formula).toBe(true);
        expect(!!kpiSchema.properties.metric_sql).toBe(false);
        expect(spec.paths["/healthz"].get.security).toEqual([]);
        expect(spec.paths["/api/analytics/query"].post.security).toEqual([{ ApiKeyAuth: [] }]);
        expect(spec.paths["/api/observability/stream"].get.security).toEqual([
          { ApiKeyAuth: [] },
          { ApiKeyQueryParam: [] },
        ]);
        const deleteConversation = spec.paths["/api/conversations/{id}"].delete;
        expect(deleteConversation.security).toEqual([{ ApiKeyAuth: [] }]);
        expect(deleteConversation.parameters.find((param: any) => param.name === "id").schema)
          .toEqual({ type: "string", format: "uuid" });
        expect(deleteConversation.parameters.find((param: any) => param.name === "connectionId").required)
          .toBe(true);
        expect(spec.paths["/api/conversations"].delete.parameters[0].name).toBe("connectionId");
      },
    },
    {
      name: "HTTP auth: query API keys are limited to browser-only observability GET routes",
      fn: async () => {
        expect(allowsApiKeyInQuery("GET", "/api", "/observability/stream")).toBe(true);
        expect(allowsApiKeyInQuery("GET", "/api", "/observability/logs/live/export")).toBe(false);
        expect(allowsApiKeyInQuery("GET", "/api", "/connections")).toBe(false);
        expect(allowsApiKeyInQuery("POST", "/api", "/observability/stream")).toBe(false);
      },
    },
    {
      name: "HTTP logging: sensitive query credentials are redacted",
      fn: async () => {
        const redacted = redactSensitiveUrl("/api/observability/stream?api_key=secret-value&format=json");
        expect(redacted.includes("secret-value")).toBe(false);
        expect(redacted).toContain("api_key=%5BREDACTED%5D");
        expect(redacted).toContain("format=json");
      },
    },
    {
      name: "conversation context: uses the latest exchanges and de-duplicates hints",
      fn: async () => {
        const now = Date.now();
        const conversation: Conversation = {
          id: "conversation-1",
          connectionId: "1",
          createdAt: now - 1000,
          lastActivityAt: now,
          messages: [
            { role: "user", content: "Old question", tableHint: "ignored_old_table", timestamp: now - 800 },
            { role: "assistant", content: "Old answer", columnHints: ["ignored_old_column"], timestamp: now - 700 },
            { role: "user", content: "Revenue?", tableHint: "orders", columnHints: ["orders.amount"], timestamp: now - 600 },
            { role: "assistant", content: "Revenue answer", tableHint: "orders", columnHints: ["orders.amount"], timestamp: now - 500 },
            { role: "user", content: "By customer?", tableHint: "customers", columnHints: ["customers.name"], timestamp: now - 400 },
            { role: "assistant", content: "Customer answer", tableHint: "customers", columnHints: ["customers.name"], timestamp: now - 300 },
            { role: "user", content: "And now?", tableHint: "orders", columnHints: ["orders.amount"], timestamp: now - 200 },
            { role: "assistant", content: "Latest answer", timestamp: now - 100 },
          ],
        };

        const context = buildConversationContextFromConversation(conversation);
        expect(context.conversationId).toBe("conversation-1");
        expect(context.referencedTables).toEqual(["orders", "customers"]);
        expect(context.referencedColumns).toEqual(["orders.amount", "customers.name"]);
        expect(context.lastTopic).toBe("Latest answer");
        expect(context.messageCount).toBe(8);
      },
    },
    {
      name: "classify: known kpi exact match",
      fn: async () => {
        const res = classifyQuery("What is total revenue?", mockKpis, mockCatalog, undefined);
        expect(res.mode).toBe("KPI");
      }
    },
    {
      name: "classify: simple mode correctly fallback",
      fn: async () => {
        const res = classifyQuery("Show me regions from orders", mockKpis, mockCatalog, undefined);
        expect(res.mode).toBe("COMPLEX");
      }
    },
    {
      name: "LLM-first simple lookup: exact table and column wording still invokes the model",
      fn: async () => {
        let invocations = 0;
        const model = {
          withStructuredOutput: () => ({
            invoke: async () => {
              invocations += 1;
              return {
                datasets: ["account"],
                joins: [],
                metric: "",
                groupBy: "account.name",
                filters: [],
                requiresApproval: false,
              };
            },
          }),
        };
        const plan = await planSimpleQuery(
          "what is name from account table?",
          accountCatalog,
          [],
          undefined,
          undefined,
          undefined,
          model,
        );
        expect(invocations).toBe(1);
        expect(plan.datasets).toEqual(["account"]);
        expect(plan.metric).toBe("");
        expect(plan.groupBy).toBe("account.name");

        const sanitized = sanitizeAndCorrectPlan(plan, accountCatalog);
        expect(sanitized.issues).toEqual([]);
        expect(validatePlan(sanitized.plan, accountCatalog).passed).toBe(true);
        const compiled = compileSimpleSelectQuery(sanitized.plan, "mysql", (ref) => {
          if (ref === "account.__table__") return { table: "account", column: "" };
          if (ref === "account.name") return { table: "account", column: "name" };
          return null;
        }, undefined, accountCatalog);
        expect(compiled.sql).toContain("`account`.`name`");
        expect(compiled.sql).toContain("FROM `account`");
        expect(compiled.sql.includes("COUNT(")).toBe(false);
      }
    },
    {
      name: "LLM-first assistant intent: greeting is routed to the model-backed simple profile",
      fn: async () => {
        const result = classifyAnalyticsProfile("hello", [], accountCatalog);
        expect(result.profile).toBe("simple");
        expect(result.terminal).toBe(false);
      }
    },
    {
      name: "LLM-first simple lookup: row-value wording retries an incorrect metadata classification",
      fn: async () => {
        let invocations = 0;
        const model = {
          withStructuredOutput: () => ({
            invoke: async () => {
              invocations += 1;
              if (invocations === 1) {
                return {
                  datasets: [],
                  metric: "",
                  groupBy: null,
                  errorMode: "UNRECOGNIZED",
                  conversationalAnswer: "Technical metadata cannot be listed.",
                };
              }
              return {
                datasets: ["account"],
                joins: [],
                metric: "COUNT(account.name)",
                groupBy: "account.name",
                filters: [],
                requiresApproval: false,
              };
            },
          }),
        };
        const plan = await planSimpleQuery(
          "what are the name from the account table?",
          accountCatalog,
          [],
          undefined,
          undefined,
          undefined,
          model,
        );
        expect(invocations).toBe(2);
        expect(plan.errorMode).toBe(undefined);
        expect(plan.datasets).toEqual(["account"]);
        expect(plan.metric).toBe("");
        expect(plan.groupBy).toBe("account.name");
      },
    },
    {
      name: "query guidance: a mentioned table produces catalog-backed rewrites",
      fn: async () => {
        const suggestions = buildGuidedQuerySuggestions(
          "what is name from account table?",
          accountCatalog,
        );
        expect(suggestions).toEqual([
          "Show the business values I asked for",
          "Show a KPI result",
        ]);
      }
    },
    {
      name: "column catalog: metadata wording is recognized for the post-LLM catalog tool",
      fn: async () => {
        expect(isColumnCatalogQuestion(
          "What columns are available in account?",
        )).toBe(true);
        expect(isColumnCatalogQuestion(
          "List name from account",
        )).toBe(false);
      }
    },
    {
      name: "column catalog: exact table is blocked without exposing identifiers",
      fn: async () => {
        const response = buildColumnCatalogResponse(
          "What columns are available in account?",
          { connection_name: "Test CRM", db_type: "mysql" } as any,
          accountCatalog,
        );
        expect(response.mode).toBe("metadata_discovery_blocked");
        expect(response.success).toBe(true);
        expect(response.data.rowCount).toBe(0);
        expect(response.insight.answer.includes("account")).toBe(false);
        expect(response.insight.answer.includes("name")).toBe(false);
        expect(response.sql.sql).toContain("no SQL executed");
      }
    },
    {
      name: "column catalog: unknown table is blocked without a technical rewrite",
      fn: async () => {
        const response = buildColumnCatalogResponse(
          "What columns are available in acount?",
          { connection_name: "Test CRM", db_type: "mysql" } as any,
          accountCatalog,
        );
        expect(response.mode).toBe("metadata_discovery_blocked");
        expect(response.success).toBe(true);
        expect(response.insight.followUps.join(" ").includes("account")).toBe(false);
      }
    },
    {
      name: "classify: measure conflict does not silently answer with the wrong KPI",
      fn: async () => {
        // "rejected quantity" must NOT resolve to the received-quantity KPI.
        const res = classifyQuery(
          "what is the total rejected quantity in the inbound report?",
          [inboundVolumeKpi],
          measureConflictCatalog,
          undefined,
        );
        expect(res.mode).toBe("COMPLEX");
        expect(res.kpi).toBe(undefined);
      }
    },
    {
      name: "classify: matching measure still routes to its KPI",
      fn: async () => {
        // The received-quantity KPI is correct for an inbound-volume question.
        const res = classifyQuery("what is the total inbound volume?", [inboundVolumeKpi], measureConflictCatalog, undefined);
        expect(res.mode).toBe("KPI");
        expect(res.kpi?.name).toBe("INBOUND Volume");
      }
    },
    {
      name: "classify: a correct non-conflicting KPI wins over a conflicting one",
      fn: async () => {
        // Both KPIs are candidates; only the rejected-quantity KPI matches intent.
        const res = classifyQuery(
          "what is the total rejected quantity in the inbound report?",
          [inboundVolumeKpi, rejectedVolumeKpi],
          measureConflictCatalog,
          undefined,
        );
        expect(res.mode).toBe("KPI");
        expect(res.kpi?.name).toBe("Rejected Quantity");
      }
    },
    {
      name: "classify: volume_resolved by u_gsc_region is not rejected by shared gsc prefixes",
      fn: async () => {
        const res = classifyQuery(
          "what is volume resolved based on u_gsc_region?",
          [volumeResolvedKpi],
          volumeResolvedCatalog,
          undefined,
        );
        expect(res.mode).toBe("KPI");
        expect(res.kpi?.name).toBe("volume_resolved");
      }
    },
    {
      name: "classify: an explicitly named competing u_gsc quantity still rejects volume_resolved",
      fn: async () => {
        const res = classifyQuery(
          "what is volume resolved based on u_gsc_amt_qty_2?",
          [volumeResolvedKpi],
          volumeResolvedCatalog,
          undefined,
        );
        expect(res.mode).toBe("COMPLEX");
        expect(res.kpi).toBe(undefined);
      }
    },
    {
      name: "orchestrator classifier: certified KPI selects KPI profile",
      fn: async () => {
        const result = classifyAnalyticsProfile("What is total revenue?", mockKpis, mockCatalog);
        expect(result.profile).toBe("kpi");
        expect(result.classification.kpi?.name).toBe("Total Revenue");
        expect(result.terminal).toBe(false);
      }
    },
    {
      name: "orchestrator classifier: explicit simple mode forces Simple profile",
      fn: async () => {
        const result = classifyAnalyticsProfile("What is total revenue?", mockKpis, mockCatalog, undefined, "simple");
        expect(result.profile).toBe("simple");
        expect(result.classification.mode).toBe("COMPLEX");
        expect(result.classification.kpi).toBe(undefined);
      }
    },
    {
      name: "LLM-first KPI planning: plain and qualified KPI questions both invoke the model",
      fn: async () => {
        let invocations = 0;
        const model = {
          withStructuredOutput: () => ({
            invoke: async () => {
              invocations += 1;
              return {
                datasets: ["orders"],
                joins: [],
                metric: "Total Revenue",
                groupBy: null,
                filters: [],
                requiresApproval: false,
              };
            },
          }),
        };
        const plain = await planKpiQuery(
          "What is Total Revenue?",
          mockCatalog,
          mockKpis,
          mockKpis[0]!,
          undefined,
          undefined,
          undefined,
          model,
        );
        const qualified = await planKpiQuery(
          "What is Total Revenue by region?",
          mockCatalog,
          mockKpis,
          mockKpis[0]!,
          undefined,
          undefined,
          undefined,
          model,
        );
        expect(invocations).toBe(2);
        expect(plain.metric).toBe("Total Revenue");
        expect(qualified.metric).toBe("Total Revenue");
      }
    },
    {
      name: "orchestrator planning: concrete for qualifier cannot be assigned to an unrelated field",
      fn: async () => {
        const result = resolveKpiQualifierFilter(
          {
            datasets: ["case_table", "user_table"],
            metric: "Region-Matched Resolved Cases",
            filters: [{ field: "case_table.subcategory", op: "eq", value: "ASPA" }],
            requiresApproval: false,
          },
          {
            ...volumeResolvedKpi,
            name: "Region-Matched Resolved Cases",
            dimensions: ["case_table.resolved_at", "user_table.u_gsc_region"],
            kpi_dimensions: ["case_table.resolved_at", "user_table.u_gsc_region"],
          },
          volumeResolvedCatalog,
          "What is Region-Matched Resolved Cases for ASPA?",
        );
        expect(result.plan.filters?.[0]).toEqual({
          field: "user_table.u_gsc_region",
          op: "eq",
          value: "ASPA",
        });
        expect(result.correction || "").toContain("corrected from case_table.subcategory");
      }
    },
    {
      name: "orchestrator classifier: volume_resolved question selects KPI profile",
      fn: async () => {
        const result = classifyAnalyticsProfile(
          "what is volume resolved based on u_gsc_region?",
          [volumeResolvedKpi],
          volumeResolvedCatalog,
          undefined,
          "kpi",
        );
        expect(result.profile).toBe("kpi");
        expect(result.classification.kpi?.name).toBe("volume_resolved");

        const november = classifyQuery(
          "volume resolved for nov 2025 ?",
          [volumeResolvedKpi],
          volumeResolvedCatalog,
        );
        expect((november.userFilters as any)?.children?.[0]).toEqual({
          type: "condition",
          field: "case_table.resolved_at",
          op: "between",
          value: {
            start: "2025-11-01",
            end: "2025-11-30",
          },
        });
        expect(parseRelativeTimeFilters(
          "Accuracy KPI for December -2025",
          volumeResolvedCatalog,
          volumeResolvedKpi.involvedTables,
          volumeResolvedKpi.dimensions,
        )[0]).toEqual({
          type: "condition",
          field: "case_table.resolved_at",
          op: "between",
          value: {
            start: "2025-12-01",
            end: "2025-12-31",
          },
        });
      }
    },
    {
      name: "orchestrator promotion: certified metric pins KPI datasets and the complete join spec",
      fn: async () => {
        const promoted = promoteCertifiedKpiPlan(
          {
            datasets: ["unrelated_region_table", "case_table"],
            metric: "Volume Resolved",
            groupBy: "u_gsc_region",
            joins: [{
              type: "LEFT",
              leftTable: "unrelated_region_table",
              leftColumn: "case_number",
              rightTable: "case_table",
              rightColumn: "number",
            }],
            requiresApproval: false,
          },
          [volumeResolvedKpi],
          volumeResolvedCatalog,
        );
        expect(promoted !== null).toBe(true);
        if (promoted) {
          expect(promoted.plan.datasets).toEqual(["case_table", "user_table"]);
          expect(promoted.plan.metric).toBe("volume_resolved");
          expect({
            type: promoted.plan.joins?.[0]?.type,
            leftTable: promoted.plan.joins?.[0]?.leftTable,
            leftColumn: promoted.plan.joins?.[0]?.leftColumn,
            rightTable: promoted.plan.joins?.[0]?.rightTable,
            rightColumn: promoted.plan.joins?.[0]?.rightColumn,
          }).toEqual(volumeResolvedKpi.join_spec?.[0]);
          expect(promoted.plan.joins?.[0]?.conditions?.length).toBe(1);
        }
      }
    },
    {
      name: "kpi dimensions: based on u_gsc_region deterministically restores an omitted groupBy",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          {
            datasets: ["case_table", "user_table"],
            metric: "volume_resolved",
            groupBy: null,
            joins: volumeResolvedKpi.join_spec,
            requiresApproval: false,
          },
          volumeResolvedKpi,
          volumeResolvedCatalog,
          "what is volume resolved based on u_gsc_region?",
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.groupBy).toBe("user_table.u_gsc_region");
      }
    },
    {
      name: "kpi dimensions: business wording resolves a prefixed technical dimension",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          {
            datasets: ["case_table", "user_table"],
            metric: "volume_resolved",
            groupBy: null,
            joins: volumeResolvedKpi.join_spec,
            requiresApproval: false,
          },
          volumeResolvedKpi,
          volumeResolvedCatalog,
          "what is volume resolved based on region?",
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.groupBy).toBe("user_table.u_gsc_region");
      },
    },
    {
      name: "kpi dimensions: explicit monthly trend restores an omitted configured date grouping",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          {
            datasets: ["case_table", "user_table"],
            metric: "volume_resolved",
            groupBy: null,
            joins: volumeResolvedKpi.join_spec,
            requiresApproval: false,
          },
          volumeResolvedKpi,
          volumeResolvedCatalog,
          "Show me the monthly trend of volume resolved",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.timeGrain).toBe("month");
          expect(result.plan.timeGrainColumn).toBe("case_table.resolved_at");
          expect(result.plan.sortDir).toBe("asc");
        }
      },
    },
    {
      name: "kpi planner guard: unrequested model filters are removed",
      fn: async () => {
        const guarded = removeUngroundedPlannerFilters(
          {
            datasets: ["case_table", "user_table"],
            metric: "volume_resolved",
            groupBy: "user_table.u_gsc_region",
            filters: [
              { field: "case_table.resolved_at", op: "gte", value: "2025-01-01" },
              { field: "case_table.resolved_at", op: "lte", value: "2025-12-31" },
              { field: "case_table.state", op: "eq", value: "Closed" },
              { field: "user_table.u_gsc_region", op: "eq", value: "region" },
            ],
            requiresApproval: false,
          },
          "what is volume resolved based on region?",
        );
        expect(guarded.removed).toBe(4);
        expect(guarded.plan.filters).toEqual([]);
      },
    },
    {
      name: "kpi planner guard: an explicitly requested filter is retained",
      fn: async () => {
        const guarded = removeUngroundedPlannerFilters(
          {
            datasets: ["case_table"],
            metric: "volume_resolved",
            filters: [{ field: "case_table.state", op: "eq", value: "Closed" }],
            requiresApproval: false,
          },
          "what is volume resolved where state is Closed?",
        );
        expect(guarded.removed).toBe(0);
        expect(guarded.plan.filters?.length).toBe(1);
      },
    },
    {
      name: "runtime selection: provider model and orchestration mode are independently resolved",
      fn: async () => {
        const keys = [
          "LLM_PROVIDER",
          "LLM_MODEL",
          "GROQ_MODEL",
          "OPENROUTER_MODEL",
          "NVIDIA_MODEL",
          "OPENAI_MODEL",
          "ANALYTICS_ORCHESTRATOR_MODE",
        ] as const;
        const previous = Object.fromEntries(
          keys.map((key) => [key, process.env[key]]),
        );
        try {
          process.env.GROQ_MODEL = "groq-selected-model";
          process.env.OPENROUTER_MODEL = "openrouter-selected-model";
          process.env.NVIDIA_MODEL = "nvidia-selected-model";
          process.env.OPENAI_MODEL = "openai-selected-model";

          process.env.LLM_PROVIDER = "groq";
          expect(getConfiguredLlmSelection()).toEqual({
            provider: "groq",
            model: "groq-selected-model",
          });

          process.env.LLM_PROVIDER = "openrouter";
          expect(getConfiguredLlmSelection()).toEqual({
            provider: "openrouter",
            model: "openrouter-selected-model",
          });

          process.env.LLM_PROVIDER = "nvidia";
          expect(getConfiguredLlmSelection()).toEqual({
            provider: "nvidia",
            model: "nvidia-selected-model",
          });

          process.env.LLM_PROVIDER = "openai";
          expect(getConfiguredLlmSelection()).toEqual({
            provider: "openai",
            model: "openai-selected-model",
          });

          delete process.env.ANALYTICS_ORCHESTRATOR_MODE;
          expect(resolveOrchestratorMode()).toBe("deterministic");

          process.env.ANALYTICS_ORCHESTRATOR_MODE = "  DeTeRmInIsTiC  ";
          expect(resolveOrchestratorMode()).toBe("deterministic");

          process.env.ANALYTICS_ORCHESTRATOR_MODE = "  AgEnT  ";
          expect(resolveOrchestratorMode()).toBe("agent");

          process.env.ANALYTICS_ORCHESTRATOR_MODE = "tool-loop";
          let invalidModeMessage = "";
          try {
            resolveOrchestratorMode();
          } catch (error) {
            invalidModeMessage = String((error as Error).message || error);
          }
          expect(invalidModeMessage).toContain(
            "Invalid ANALYTICS_ORCHESTRATOR_MODE",
          );
        } finally {
          for (const key of keys) {
            const value = previous[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    },
    {
      name: "kpi dimensions: missing short name is rejected as not configured",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: "Resolved Volume", groupBy: "priority", requiresApproval: false },
          duplicateDimensionKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by priority",
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.kind).toBe("not_configured");
      }
    },
    {
      name: "kpi dimensions: one short-name match resolves to its qualified dimension",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: "Resolved Volume", groupBy: "display_name", requiresApproval: false },
          duplicateDimensionKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by display_name",
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.groupBy).toBe("users.display_name");
      }
    },
    {
      name: "kpi dimensions: same-named columns form one primary-anchored combined group",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: "Resolved Volume", groupBy: "region", requiresApproval: false },
          duplicateDimensionKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by region",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.groupBy).toBe("cases.region");
          expect(result.plan.joins).toBe(undefined);
          expect(result.plan.combinedGroupBy).toEqual([{
            groupBy: "cases.region",
            columns: ["cases.region", "users.region"],
          }]);
        }
      }
    },
    {
      name: "kpi dimensions: planner qualification is still anchored to the primary dataset",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: "Resolved Volume", groupBy: "users.region", requiresApproval: false },
          duplicateDimensionKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by region",
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.groupBy).toBe("cases.region");
      }
    },
    {
      name: "kpi dimensions: business wording combines one prefixed set without changing the master join",
      fn: async () => {
        const prefixedCatalog = duplicateDimensionCatalog.map((dataset) => ({
          ...dataset,
          columns: dataset.columns.map((column) => column.name === "region"
            ? { ...column, name: "u_gsc_region" }
            : column),
        }));
        const prefixedKpi: GlobalAiKpi = {
          ...duplicateDimensionKpi,
          dimensions: ["cases.u_gsc_region", "users.u_gsc_region"],
          join_spec: [{
            type: "INNER",
            leftTable: "cases",
            leftColumn: "number",
            rightTable: "users",
            rightColumn: "display_name",
          }],
        };
        const result = resolveMatchedKpiPlanDimensions(
          {
            datasets: ["cases", "users"],
            metric: "Resolved Volume",
            groupBy: null,
            joins: prefixedKpi.join_spec,
            errorMode: "AMBIGUOUS",
            requiresApproval: false,
          },
          prefixedKpi,
          prefixedCatalog,
          "what is resolved volume based on region?",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.groupBy).toBe("cases.u_gsc_region");
          expect(result.plan.errorMode).toBe(undefined);
          expect(result.plan.joins).toEqual(prefixedKpi.join_spec);
          expect(result.plan.combinedGroupBy).toEqual([{
            groupBy: "cases.u_gsc_region",
            columns: ["cases.u_gsc_region", "users.u_gsc_region"],
          }]);
        }
      },
    },
    {
      name: "kpi dimensions: differently named region columns remain separate",
      fn: async () => {
        const distinctNameCatalog = duplicateDimensionCatalog.map((dataset) => dataset.name === "users"
          ? {
              ...dataset,
              columns: dataset.columns.map((column) => column.name === "region"
                ? { ...column, name: "u_gsc_region" }
                : column),
            }
          : dataset);
        const distinctNameKpi: GlobalAiKpi = {
          ...duplicateDimensionKpi,
          dimensions: ["cases.region", "users.u_gsc_region"],
        };
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: distinctNameKpi.name, groupBy: null, requiresApproval: false },
          distinctNameKpi,
          distinctNameCatalog,
          "what is resolved volume based on region?",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.groupBy).toBe("cases.region");
          expect(result.plan.combinedGroupBy).toBe(undefined);
        }
      },
    },
    {
      name: "kpi dimensions: exact region set wins over prefixed region set",
      fn: async () => {
        const catalog: AiDatasetDefinition[] = duplicateDimensionCatalog.map((dataset) => ({
          ...dataset,
          columns: [
            ...dataset.columns,
            { name: "u_gsc_region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
          ],
        }));
        const kpi: GlobalAiKpi = {
          ...duplicateDimensionKpi,
          dimensions: [
            "cases.region",
            "users.region",
            "cases.u_gsc_region",
            "users.u_gsc_region",
          ],
        };
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: kpi.name, groupBy: null, requiresApproval: false },
          kpi,
          catalog,
          "what is resolved volume grouped by region?",
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.plan.groupBy).toBe("cases.region");
          expect(result.plan.combinedGroupBy).toEqual([{
            groupBy: "cases.region",
            columns: ["cases.region", "users.region"],
          }]);
        }
      },
    },
    {
      name: "kpi filters: qualified-but-guessed ambiguous filter column is flagged",
      fn: async () => {
        // User said bare "region"; planner guessed "cases.region". Same hazard
        // as the group-by guess, but on a WHERE filter.
        const plan: any = {
          datasets: ["cases", "users"],
          metric: "Resolved Volume",
          filters: [{ type: "condition", field: "cases.region", op: "eq", value: "North" }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, duplicateDimensionKpi, duplicateDimensionCatalog, "resolved volume where region is North");
        expect(res !== null).toBe(true);
        if (res) expect(res.candidates).toEqual(["cases.region", "users.region"]);
      }
    },
    {
      name: "kpi filters: flat {field,op,value} condition (no type tag) is still scanned",
      fn: async () => {
        // Real planner output often omits type:"condition" on conditions.
        const plan: any = {
          datasets: ["cases", "users"],
          metric: "Resolved Volume",
          filters: [{ field: "cases.region", op: "eq", value: "North" }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, duplicateDimensionKpi, duplicateDimensionCatalog, "resolved volume where region is North");
        expect(res !== null).toBe(true);
        if (res) expect(res.column).toBe("region");
      }
    },
    {
      name: "kpi filters: user-named table on an ambiguous filter column is accepted",
      fn: async () => {
        const plan: any = {
          datasets: ["cases", "users"],
          metric: "Resolved Volume",
          filters: [{ type: "condition", field: "users.region", op: "eq", value: "North" }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, duplicateDimensionKpi, duplicateDimensionCatalog, "resolved volume where users.region is North");
        expect(res).toBe(null);
      }
    },
    {
      name: "kpi filters: unambiguous filter column is accepted",
      fn: async () => {
        const plan: any = {
          datasets: ["cases", "users"],
          metric: "Resolved Volume",
          filters: [{ type: "condition", field: "users.display_name", op: "eq", value: "Alice" }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, duplicateDimensionKpi, duplicateDimensionCatalog, "resolved volume where display_name is Alice");
        expect(res).toBe(null);
      }
    },
    {
      name: "kpi filters: nested filter groups are scanned for ambiguity",
      fn: async () => {
        const plan: any = {
          datasets: ["cases", "users"],
          metric: "Resolved Volume",
          filters: [{
            type: "group", operator: "AND",
            children: [
              { type: "condition", field: "users.display_name", op: "eq", value: "Alice" },
              { type: "condition", field: "cases.region", op: "eq", value: "North" },
            ],
          }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, duplicateDimensionKpi, duplicateDimensionCatalog, "resolved volume for Alice where region is North");
        expect(res !== null).toBe(true);
        if (res) expect(res.column).toBe("region");
      }
    },
    {
      name: "kpi filters: single-table KPI never flags a filter as cross-table ambiguous",
      fn: async () => {
        const plan: any = {
          datasets: ["inbound_report"],
          metric: "INBOUND Volume",
          filters: [{ type: "condition", field: "inbound_report.region", op: "eq", value: "North" }],
          requiresApproval: false,
        };
        const res = findAmbiguousKpiFilterField(plan, inboundVolumeKpi, measureConflictCatalog, "inbound volume where region is North");
        expect(res).toBe(null);
      }
    },
    {
      name: "kpi dimensions: even a qualified shared dimension uses the KPI root",
      fn: async () => {
        const result = resolveMatchedKpiPlanDimensions(
          { datasets: ["cases", "users"], metric: "Resolved Volume", groupBy: "users.region", requiresApproval: false },
          duplicateDimensionKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by users.region",
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.plan.groupBy).toBe("cases.region");
      }
    },
    {
      name: "llm retry: empty-generation retry receives a separate limiter schedule",
      fn: async () => {
        let attempts = 0;
        let scheduled = 0;
        const target = {
          invoke: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new TypeError("Cannot read properties of undefined (reading 'message')");
            }
            return "ok";
          },
        };
        const limiter = {
          enabled: true,
          schedule: async (work: () => Promise<unknown>) => {
            scheduled += 1;
            return work();
          },
        };
        const wrapped = wrapWithRateLimit(target, limiter as any);
        expect(await wrapped.invoke()).toBe("ok");
        expect(attempts).toBe(2);
        expect(scheduled).toBe(2);
      }
    },
    {
      name: "llm retry: exhausted empty response is classified as an AI service error",
      fn: async () => {
        let attempts = 0;
        const target = {
          invoke: async () => {
            attempts += 1;
            throw new TypeError("Cannot read properties of undefined (reading 'message')");
          },
        };
        const limiter = {
          enabled: true,
          schedule: async (work: () => Promise<unknown>) => work(),
        };
        try {
          await wrapWithRateLimit(target, limiter as any).invoke();
          throw new Error("Expected the wrapped model invocation to fail");
        } catch (error) {
          expect(attempts).toBe(2);
          expect(getFriendlyErrorMessage(error)).toContain("AI Services error");
          expect(getFriendlyErrorMessage(error)).toContain("empty response after retrying");
        }
      }
    },
    {
      name: "llm retry: provider 429 honors Retry-After before succeeding",
      fn: async () => {
        let attempts = 0;
        const delays: number[] = [];
        const result = await invokeWithProviderRetry(
          async () => {
            attempts += 1;
            if (attempts === 1) {
              throw { status: 429, message: "rate limit", headers: { "retry-after": "2" } };
            }
            return "ok";
          },
          {
            maxRetries: 1,
            baseDelayMs: 10,
            maxDelayMs: 3000,
            sleep: async (delayMs) => { delays.push(delayMs); },
          },
        );
        expect(result).toBe("ok");
        expect(attempts).toBe(2);
        expect(delays.length).toBe(1);
        expect(delays[0]! >= 2000).toBe(true);
      }
    },
    {
      name: "llm retry: exhausted provider 429 remains an AI-service failure",
      fn: async () => {
        let attempts = 0;
        try {
          await invokeWithProviderRetry(
            async () => {
              attempts += 1;
              throw { status: 429, message: "rate limit exceeded" };
            },
            {
              maxRetries: 2,
              baseDelayMs: 1,
              maxDelayMs: 1,
              sleep: async () => undefined,
            },
          );
          throw new Error("Expected the provider retry wrapper to fail");
        } catch (error) {
          expect(attempts).toBe(3);
          expect(getFriendlyErrorMessage(error)).toContain("rate limit was exceeded");
        }
      }
    },
    {
      name: "error formatter: null errors degrade without throwing",
      fn: async () => {
        expect(getFriendlyErrorMessage(undefined)).toContain("No error details were provided");
        expect(getFriendlyErrorMessage(null)).toContain("No error details were provided");
      }
    },
    {
      name: "error formatter: pre-execution failures do not suggest a database connection problem",
      fn: async () => {
        const response = getResilientErrorResponse(
          "autonomous-ai",
          "volume resolved by region",
          "SQL compilation failed: Internal routing error",
        );
        expect(response.insight.answer).toContain("No database query was executed");
        expect(response.insight.answer.includes("Review your connection settings")).toBe(false);
      }
    },
    {
      name: "error formatter: public validation errors do not expose technical identifiers",
      fn: async () => {
        const publicMessage = getPublicAnalyticsErrorMessage(
          'Validation failed: Column "private_table.secret_column" was not found in schema internal_schema.',
        );
        expect(publicMessage.includes("private_table")).toBe(false);
        expect(publicMessage.includes("secret_column")).toBe(false);
        expect(publicMessage.includes("internal_schema")).toBe(false);
        expect(publicMessage).toContain("No database query was executed");
      },
    },
    {
      name: "error formatter: AI provider failures give provider guidance instead of database guidance",
      fn: async () => {
        const guidance = getErrorRecoveryGuidance(
          "AI Services error: The language model provider rate limit was exceeded.",
        );
        expect(guidance).toContain("No database query was executed");
        expect(guidance).toContain("LLM provider quota");
        expect(guidance.includes("connection settings")).toBe(false);
      }
    },
    {
      name: "error formatter: LLM parse/empty-plan failures are AI service errors, not database errors",
      fn: async () => {
        const parseErr = getFriendlyErrorMessage(new Error('Failed to parse. Text: "{ \\"datasets\\": [] }"'));
        expect(parseErr).toContain("AI Services error");
        expect(parseErr.includes("Database error")).toBe(false);
        const emptyPlan = getFriendlyErrorMessage(new Error("The language model returned an empty query plan. This is usually a transient provider issue — please try again."));
        expect(emptyPlan).toContain("AI Services error");
        expect(emptyPlan.includes("Database error")).toBe(false);
      }
    },
    {
      name: "error formatter: provider 402 quota errors are AI service errors, not database errors",
      fn: async () => {
        const message = getFriendlyErrorMessage({ message: "402 Provider returned error", status: 402 });
        expect(message).toContain("AI Services error");
        expect(message).toContain("quota");
        const upstream = getFriendlyErrorMessage(new Error("Provider returned error"));
        expect(upstream).toContain("AI Services error");
      }
    },
    {
      name: "error formatter: provider 403 forbidden is an AI service error, not a database error",
      fn: async () => {
        const byStatus = getFriendlyErrorMessage({ message: "403 status code (no body)", status: 403 });
        expect(byStatus).toContain("AI Services error");
        expect(byStatus.includes("Database error")).toBe(false);
        const byMessage = getFriendlyErrorMessage(new Error("403 status code (no body)"));
        expect(byMessage).toContain("AI Services error");
      }
    },
    {
      name: "error formatter: LLM 'Request timed out' is an AI error, but DB 'Query timed out' stays a database error",
      fn: async () => {
        const llm = getFriendlyErrorMessage(new Error("Request timed out."));
        expect(llm).toContain("AI Services error");
        expect(llm.includes("Database error")).toBe(false);
        const llmByName = getFriendlyErrorMessage({ name: "APITimeoutError", message: "Request timed out." });
        expect(llmByName).toContain("AI Services error");
        // The database withTimeout message must NOT be reclassified as an AI error.
        const db = getFriendlyErrorMessage(new Error("Query timed out after 30000ms"));
        expect(db.includes("AI Services error")).toBe(false);
      }
    },
    {
      name: "insight builder: plain listing with rows is not reported as no data",
      fn: async () => {
        const { insight, chart } = buildInsight(
          { datasets: ["asn_report"], metric: "", requiresApproval: false } as any,
          { rowCount: 5, rows: [{ record_id: 1 }, { record_id: 2 }, { record_id: 3 }, { record_id: 4 }, { record_id: 5 }] } as any,
        );
        expect(insight.answer).toContain("Returned 5 business records");
        expect(insight.answer.includes("No data found")).toBe(false);
        expect(chart).toBe(null);
      }
    },
    {
      name: "insight builder: grouped plain lookup is described as values, not a count",
      fn: async () => {
        const { insight, chart } = buildInsight(
          { datasets: ["account"], metric: "", groupBy: "account.name", requiresApproval: false } as any,
          { rowCount: 2, rows: [{ key: "ACME" }, { key: "SOLARIS" }] } as any,
          accountCatalog,
        );
        expect(insight.answer).toContain("Returned 2 business values");
        expect(insight.answer.includes("count")).toBe(false);
        expect(insight.answer.includes("account")).toBe(false);
        expect(insight.drivers).toEqual(["Business values listed without aggregation."]);
        expect(chart).toBe(null);
      },
    },
    {
      name: "insight builder: cross-table certified KPI uses global metric dimensions for concrete follow-ups",
      fn: async () => {
        const catalog = [
          {
            name: "cases",
            label: "Cases",
            physicalTable: "cases",
            certified: true,
            synonyms: [],
            columns: [
              { name: "resolved_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
              { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            ],
            metrics: [],
            relationships: [],
          },
          {
            name: "users",
            label: "Users",
            physicalTable: "users",
            certified: true,
            synonyms: [],
            columns: [],
            metrics: [],
            relationships: [],
          },
          {
            name: "global_kpis",
            label: "Global KPIs",
            physicalTable: "",
            certified: true,
            synonyms: [],
            columns: [],
            metrics: [{
              name: "volume_resolved",
              label: "Volume Resolved",
              expressionSql: "COUNT(cases.id)",
              format: "number",
              synonyms: [],
              involved_tables: ["cases", "users"],
              dimensions: ["cases.resolved_at", "cases.region"],
            }],
            relationships: [],
          },
        ] as any;
        const { insight } = buildInsight(
          {
            datasets: ["cases", "users"],
            metric: "volume_resolved",
            requiresApproval: false,
          } as any,
          { rowCount: 1, rows: [{ value: 2879 }] } as any,
          catalog,
        );
        expect(insight.answer).toContain("Based on the Volume Resolved KPI");
        expect(insight.followUps.includes("Show me the monthly trend of volume resolved")).toBe(true);
        expect(insight.followUps.includes("Break down volume resolved by region")).toBe(true);
        expect(insight.followUps.some((followUp: string) => followUp.includes("a business dimension"))).toBe(false);
      },
    },
    {
      name: "insight builder: monthly KPI trend uses time wording and does not suggest the same trend again",
      fn: async () => {
        const catalog = [
          {
            name: "cases",
            label: "Cases",
            physicalTable: "cases",
            certified: true,
            synonyms: [],
            columns: [
              { name: "resolved_at", type: "date", allowedForGrouping: true, allowedForFiltering: true },
              { name: "region", type: "string", allowedForGrouping: true, allowedForFiltering: true },
            ],
            metrics: [],
            relationships: [],
          },
          {
            name: "global_kpis",
            label: "Global KPIs",
            physicalTable: "",
            certified: true,
            synonyms: [],
            columns: [],
            metrics: [{
              name: "volume_resolved",
              label: "Volume Resolved",
              expressionSql: "COUNT(cases.id)",
              format: "number",
              synonyms: [],
              involved_tables: ["cases", "users"],
              dimensions: ["cases.resolved_at", "cases.region"],
            }],
            relationships: [],
          },
        ] as any;
        const { insight, chart } = buildInsight(
          {
            datasets: ["cases", "users"],
            metric: "volume_resolved",
            timeGrain: "month",
            timeGrainColumn: "cases.resolved_at",
            requiresApproval: false,
          } as any,
          {
            rowCount: 2,
            rows: [
              { key: "2025-11-01", value: 2879 },
              { key: "2025-12-01", value: 3095 },
            ],
          } as any,
          catalog,
        );
        expect(insight.answer).toContain("monthly trend of volume resolved");
        expect(insight.drivers.includes("Results are grouped by month.")).toBe(true);
        expect(insight.followUps.includes("Break down volume resolved by region")).toBe(true);
        expect(insight.followUps.some((followUp: string) => followUp.includes("monthly trend"))).toBe(false);
        expect(chart?.type).toBe("line");
      },
    },
    {
      name: "compile: valid simple select query (Sum amount by region)",
      fn: async () => {
        const plan = {
          datasets: ["orders"],
          groupBy: "orders.region",
          metric: "SUM(orders.amount)",
        };
        const sql = compileSimpleSelectQuery(plan, "mysql", (col) => {
          if (col === "orders.__table__") return { table: "orders", column: "" };
          if (col === "orders.region") return { table: "orders", column: "region" };
          if (col === "orders.amount") return { table: "orders", column: "amount" };
          return null;
        });
        expect(sql.sql).toContain("SUM(`orders`.`amount`)");
        expect(sql.sql).toContain("AS `metric_value`");
      }
    },
    {
      name: "compile: dataset-only raw plans are rejected instead of becoming SELECT star",
      fn: async () => {
        const sanitized = sanitizeAndCorrectPlan(
          { datasets: ["account"], metric: "", groupBy: null },
          accountCatalog,
          { allowDynamicMetrics: false, requireExplicitProjection: true },
        );
        expect(sanitized.issues.some((issue) =>
          issue.includes("must select explicit catalog columns"))).toBe(true);

        try {
          compileSimpleSelectQuery(
            { datasets: ["account"], metric: "", groupBy: null },
            "mysql",
            (ref) => ref === "account.__table__"
              ? { table: "crm.account", column: "__table__" }
              : null,
            undefined,
            accountCatalog,
          );
          throw new Error("Expected a dataset-only plan to be rejected");
        } catch (error) {
          expect((error as any).code).toBe("EMPTY_SELECT");
        }
      },
    },
    {
      name: "compile: date grouping (Show volume resolved by month)",
      fn: async () => {
        const plan = {
          datasets: ["orders"],
          timeGrain: "month" as const,
          timeGrainColumn: "orders.order_date",
          metric: "COUNT(1)",
        };
        const sql = compileSimpleSelectQuery(plan, "mysql", (col) => {
          if (col === "orders.__table__") return { table: "orders", column: "" };
          if (col === "orders.order_date") return { table: "orders", column: "order_date" };
          return null;
        });
        expect(sql.sql).toContain("AS `time_key`");
      }
    },
    {
      name: "compile: certified KPI time series is ordered chronologically",
      fn: async () => {
        const dimensionResult = resolveMatchedKpiPlanDimensions(
          {
            datasets: volumeResolvedKpi.involvedTables,
            metric: volumeResolvedKpi.name,
            groupBy: null,
            joins: volumeResolvedKpi.join_spec,
            requiresApproval: false,
          },
          volumeResolvedKpi,
          volumeResolvedCatalog,
          "Show me the monthly trend of volume resolved",
        );
        if (!dimensionResult.ok) throw new Error("Expected the KPI trend dimension to resolve");
        const sql = compileKpiQuery(
          dimensionResult.plan,
          "mysql",
          (ref) => {
            const [datasetName, column] = String(ref).split(".");
            const dataset = volumeResolvedCatalog.find((item) => item.name === datasetName);
            if (!dataset) return null;
            if (column === "__table__") return { table: dataset.physicalTable, column };
            if (!dataset.columns.some((item) => item.name === column)) return null;
            return { table: dataset.physicalTable, column };
          },
          volumeResolvedKpi.expressionSql,
          {},
          { kpi: volumeResolvedKpi },
          volumeResolvedCatalog,
        );
        expect(sql.sql).toContain("ORDER BY `time_key` ASC");
        expect(sql.sql.includes("ORDER BY `metric_value`")).toBe(false);
      },
    },
    {
      name: "compile: volume_resolved by u_gsc_region uses the KPI formula and configured join",
      fn: async () => {
        const dimensionResult = resolveMatchedKpiPlanDimensions(
          {
            datasets: volumeResolvedKpi.involvedTables,
            metric: volumeResolvedKpi.name,
            groupBy: null,
            joins: volumeResolvedKpi.join_spec,
            requiresApproval: false,
          },
          volumeResolvedKpi,
          volumeResolvedCatalog,
          "what is volume resolved based on u_gsc_region?",
        );
        if (!dimensionResult.ok) throw new Error("Expected the KPI dimension to resolve");
        const sql = compileKpiQuery(
          dimensionResult.plan,
          "mysql",
          (ref) => {
            const clean = String(ref);
            const [datasetName, column] = clean.split(".");
            const dataset = volumeResolvedCatalog.find((item) => item.name === datasetName);
            if (!dataset) return null;
            if (column === "__table__") return { table: dataset.physicalTable, column: "__table__" };
            if (!dataset.columns.some((item) => item.name === column)) return null;
            return { table: dataset.physicalTable, column };
          },
          volumeResolvedKpi.expressionSql,
          {},
          { kpi: volumeResolvedKpi },
          volumeResolvedCatalog,
        );
        expect(sql.sql).toContain("COUNT(`app`.`case_table`.`number`)");
        expect(sql.sql).toContain("INNER JOIN `app`.`user_table`");
        expect(sql.sql).toContain("`app`.`user_table`.`u_gsc_region`");
        expect(sql.sql).toContain("`app`.`case_table`.`state` IN");
      }
    },
    {
      name: "compile: Option A expands distinct same-named values without a dimension equality join",
      fn: async () => {
        const joinedKpi: GlobalAiKpi = {
          ...duplicateDimensionKpi,
          join_spec: [{
            type: "INNER",
            leftTable: "cases",
            leftColumn: "number",
            rightTable: "users",
            rightColumn: "display_name",
          }],
        };
        const dimensionResult = resolveMatchedKpiPlanDimensions(
          {
            datasets: ["cases", "users"],
            metric: joinedKpi.name,
            groupBy: "region",
            joins: joinedKpi.join_spec,
            requiresApproval: false,
          },
          joinedKpi,
          duplicateDimensionCatalog,
          "resolved volume grouped by region",
        );
        if (!dimensionResult.ok) throw new Error("Expected the shared KPI dimension to resolve");
        const sql = compileKpiQuery(
          dimensionResult.plan,
          "mysql",
          (ref) => {
            const [datasetName, column] = String(ref).split(".");
            const dataset = duplicateDimensionCatalog.find((item) => item.name === datasetName);
            if (!dataset) return null;
            if (column === "__table__") return { table: dataset.physicalTable, column };
            if (!dataset.columns.some((item) => item.name === column)) return null;
            return { table: dataset.physicalTable, column };
          },
          joinedKpi.expressionSql,
          {},
          { kpi: joinedKpi },
          duplicateDimensionCatalog,
        );
        expect(sql.sql).toContain("INNER JOIN `app`.`users` ON `app`.`cases`.`number` = `app`.`users`.`display_name`");
        expect(sql.sql).toContain("CROSS JOIN LATERAL");
        expect(sql.sql).toContain("SELECT `app`.`cases`.`region` AS `group_value` WHERE `app`.`cases`.`region` IS NOT NULL");
        expect(sql.sql).toContain("SELECT `app`.`users`.`region` AS `group_value` WHERE `app`.`users`.`region` IS NOT NULL");
        expect(sql.sql).toContain("SELECT NULL AS `group_value` WHERE `app`.`cases`.`region` IS NULL AND `app`.`users`.`region` IS NULL");
        expect(sql.sql).toContain("COUNT(DISTINCT CASE WHEN `app`.`cases`.`number` IS NOT NULL THEN `app`.`cases`.`number` END)");
        expect(sql.sql).toContain("GROUP BY `__combined_dimension_1`.`group_value`");
        expect(sql.sql.includes("UNION ALL")).toBe(false);
        expect(sql.sql.includes("`app`.`cases`.`region` = `app`.`users`.`region`")).toBe(false);
      },
    },
    {
      name: "compile: Simple compiler rejects certified metric names as an internal routing error",
      fn: async () => {
        try {
          compileSimpleSelectQuery(
            {
              datasets: ["case_table", "user_table"],
              metric: "volume_resolved",
              groupBy: "user_table.u_gsc_region",
              joins: volumeResolvedKpi.join_spec,
            },
            "mysql",
            (ref) => {
              if (ref === "case_table.__table__") return { table: "app.case_table", column: "__table__" };
              if (ref === "user_table.__table__") return { table: "app.user_table", column: "__table__" };
              if (ref === "user_table.u_gsc_region") return { table: "app.user_table", column: "u_gsc_region" };
              return null;
            },
            undefined,
            volumeResolvedCatalog,
          );
          throw new Error("Expected the Simple compiler to reject a certified metric name");
        } catch (error) {
          expect((error as any).code).toBe("CERTIFIED_METRIC_REQUIRES_KPI");
          const friendly = getFriendlyErrorMessage(error);
          expect(friendly).toContain("Analytics planning error");
          expect(friendly.includes("Database error")).toBe(false);
          expect(friendly).toContain("No database query was executed");
        }
      }
    },
    {
      name: "validate: correctly sanitizes and validates mock plan",
      fn: async () => {
        const plan = {
          datasets: ["orders"],
          groupBy: ["region"],
          metric: "amount",
        };
        const sanitized = sanitizeAndCorrectPlan(plan, mockCatalog);
        if (sanitized.issues.length > 0) {
          throw new Error("Validation issues: " + sanitized.issues.join(", "));
        }
        expect(sanitized.issues.length).toBe(0);
        
        const valid = validatePlan(sanitized.plan, mockCatalog);
        expect(valid.passed).toBe(true);
      }
    },
    {
      name: "pre_query: write intent is rejected (Delete orders)",
      fn: async () => {
        const { detectWriteIntent } = await import("../analytics/pipelines/shared/queryUnderstanding");
        const isWrite = detectWriteIntent("Delete orders");
        expect(isWrite).toBe(true);
      }
    },
    {
      name: "pre_query: ambiguous date asks clarification (Show volume resolved on 01-07-2025)",
      fn: async () => {
        const { analyzeLocalDateInputs } = await import("../analytics/pipelines/shared/queryUnderstanding");
        const res = analyzeLocalDateInputs("Show volume resolved on 01-07-2025");
        expect(res.action).toBe("clarify");
      }
    },
    {
      name: "pre_query: explicit iso date passes (Show volume resolved on 2025-07-01)",
      fn: async () => {
        const { analyzeLocalDateInputs } = await import("../analytics/pipelines/shared/queryUnderstanding");
        const res = analyzeLocalDateInputs("Show volume resolved on 2025-07-01");
        expect(res.action).toBe("ok");
      }
    },
    {
      name: "kpi schema: qualified table.column dimension is accepted",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Revenue",
          department: "Finance",
          metric_type: "Simple (Direct Measure)",
          formula: "SUM(orders.amount)",
          format: "currency",
          dimensions: ["orders.region"],
          involved_tables: ["orders"],
        });
        expect(result.success).toBe(true);
      }
    },
    {
      name: "kpi schema: unqualified dimension is rejected",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Revenue",
          department: "Finance",
          metric_type: "Simple (Direct Measure)",
          formula: "SUM(orders.amount)",
          format: "currency",
          dimensions: ["region"],
          involved_tables: ["orders"],
        });
        expect(result.success).toBe(false);
      }
    },
    {
      name: "kpi schema: qualified filter field is accepted",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Resolved Volume",
          department: "Customer Service",
          metric_type: "Simple (Direct Measure)",
          formula: "COUNT(cases.number)",
          format: "number",
          dimensions: ["cases.resolved_at"],
          involved_tables: ["cases", "users"],
          join_spec: [
            {
              type: "inner",
              leftTable: "cases",
              leftColumn: "assigned_to",
              rightTable: "users",
              rightColumn: "name",
            },
          ],
          filter_logic: {
            type: "group",
            operator: "AND",
            children: [
              { type: "condition", field: "cases.state", op: "in", value: "Resolved,Closed" },
              { type: "condition", field: "users.web_service_access_only", op: "neq", value: "true" },
            ],
          },
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.join_spec?.[0].type).toBe("INNER");
        }
      }
    },
    {
      name: "kpi schema: one table edge accepts multiple ON conditions",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Resolved Volume",
          department: "Customer Service",
          metric_type: "Simple (Direct Measure)",
          formula: "COUNT(cases.number)",
          format: "number",
          dimensions: ["cases.region", "users.region"],
          involved_tables: ["cases", "users"],
          join_spec: [{
            type: "INNER",
            leftTable: "cases",
            leftColumn: "assigned_to",
            rightTable: "users",
            rightColumn: "name",
            conditions: [
              { leftColumn: "assigned_to", rightColumn: "name" },
              { leftColumn: "region", rightColumn: "region" },
            ],
          }],
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.join_spec?.[0].conditions?.length).toBe(2);
      },
    },
    {
      name: "kpi schema: unqualified filter field is rejected",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Resolved Volume",
          department: "Customer Service",
          metric_type: "Simple (Direct Measure)",
          formula: "COUNT(cases.number)",
          format: "number",
          dimensions: ["cases.resolved_at"],
          involved_tables: ["cases", "users"],
          join_spec: [
            {
              type: "INNER",
              leftTable: "cases",
              leftColumn: "assigned_to",
              rightTable: "users",
              rightColumn: "name",
            },
          ],
          filter_logic: {
            type: "group",
            operator: "AND",
            children: [
              { type: "condition", field: "state", op: "in", value: "Resolved,Closed" },
            ],
          },
        });
        expect(result.success).toBe(false);
      }
    },
    {
      name: "kpi schema: cross-table KPI requires a join",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Resolved Volume",
          department: "Customer Service",
          metric_type: "Simple (Direct Measure)",
          formula: "COUNT(cases.number)",
          format: "number",
          dimensions: ["cases.resolved_at"],
          involved_tables: ["cases", "users"],
          join_spec: [],
        });
        expect(result.success).toBe(false);
      }
    },
    {
      name: "kpi schema: complete cascading join tree is accepted",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Order Revenue",
          department: "Finance",
          metric_type: "Simple (Direct Measure)",
          formula: "SUM(orders.amount)",
          format: "currency",
          dimensions: ["regions.name"],
          involved_tables: ["orders", "customers", "regions"],
          join_spec: [
            {
              type: "LEFT",
              leftTable: "orders",
              leftColumn: "customer_id",
              rightTable: "customers",
              rightColumn: "id",
            },
            {
              type: "INNER",
              leftTable: "customers",
              leftColumn: "region_id",
              rightTable: "regions",
              rightColumn: "id",
            },
          ],
        });
        expect(result.success).toBe(true);
      }
    },
    {
      name: "kpi schema: cyclic join tree is rejected",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Order Revenue",
          department: "Finance",
          metric_type: "Simple (Direct Measure)",
          formula: "SUM(orders.amount)",
          format: "currency",
          dimensions: ["customers.name"],
          involved_tables: ["orders", "customers", "regions"],
          join_spec: [
            {
              type: "LEFT",
              leftTable: "orders",
              leftColumn: "customer_id",
              rightTable: "customers",
              rightColumn: "id",
            },
            {
              type: "INNER",
              leftTable: "customers",
              leftColumn: "id",
              rightTable: "orders",
              rightColumn: "customer_id",
            },
          ],
        });
        expect(result.success).toBe(false);
      }
    },
    {
      name: "kpi schema: disconnected join order is rejected",
      fn: async () => {
        const result = CreateKpiSchema.safeParse({
          connection_id: 1,
          metric_name: "Order Revenue",
          department: "Finance",
          metric_type: "Simple (Direct Measure)",
          formula: "SUM(orders.amount)",
          format: "currency",
          dimensions: ["regions.name"],
          involved_tables: ["orders", "customers", "regions"],
          join_spec: [
            {
              type: "INNER",
              leftTable: "customers",
              leftColumn: "region_id",
              rightTable: "regions",
              rightColumn: "id",
            },
            {
              type: "INNER",
              leftTable: "orders",
              leftColumn: "customer_id",
              rightTable: "customers",
              rightColumn: "id",
            },
          ],
        });
        expect(result.success).toBe(false);
      }
    },
  ];

  for (const c of cases) {
    try {
      await c.fn();
      passed++;
    } catch (e: unknown) {
      failed++;
      failures.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  if (process.argv.includes("--selftest")) {
    runRegressionTests().then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.failed === 0 ? 0 : 1);
    });
  }
}
