import crypto from "node:crypto";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { classifyQuery, extractMentionedTables } from "../../routes/semanticLayer/queryClassifier";
import { AiDatasetDefinition, GlobalAiKpi } from "../../routes/semanticLayer/semanticCatalog";
import { withLlmUsageContext } from "../../telemetry/llmUsage";
import { compileKpiQuery, compileSimpleSelectQuery } from "../../sql/compiler";
import {
  ClassifyResult,
  CompiledQuery,
  ConversationContext,
  FilterNode,
  JoinSpec,
  LiveAdapter,
  QueryResult,
  SqlFilter,
} from "../../types/types";
import { getErrorRecoveryGuidance, getFriendlyErrorMessage, getResilientErrorResponse, sanitizeDbError } from "../../utils/errorFormatter";
import { getLlmModel, QueryPlan } from "../planner";
import { planKpiQuery } from "../pipelines/kpi/kpiPlanner";
import {
  buildCatalogListResponse,
  buildColumnCatalogResponse,
  isCatalogListQuestion,
  isColumnCatalogQuestion,
} from "../pipelines/shared/catalogQuestions";
import { buildInsight } from "../pipelines/shared/insightBuilder";
import { analyzeLocalDateInputs, detectWriteIntent } from "../pipelines/shared/queryUnderstanding";
import {
  buildClarificationResponse,
  buildUnsupportedIntentResponse,
  TraceEntry,
} from "../pipelines/shared/responseBuilders";
import {
  buildDataQualityIssueResponse,
  evaluateGroupedResultQuality,
} from "../pipelines/shared/resultQuality";
import { planSimpleQuery } from "../pipelines/simple/simplePlanner";
import { isExplicitEntityListRequest } from "../pipelines/simple/entityProjection";
import { pruneCatalogColumns } from "../planner/pruneCatalogColumns";
import { getDynamicDataset, normalizeIdentifier, resolveColumnAcrossDatasets, resolveMetricAcrossDatasets } from "../utils/resolvers";
import { getJoinConditions, normalizeJoinConditions } from "../utils/joinSpecs";
import { MAX_QUERY_LIMIT, sanitizeAndCorrectPlan, validatePlan } from "../validator/validatePlan";

const createTool = tool as unknown as (fn: any, fields: any) => any;
const QUERY_PLAN_FILTER_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "between", "relative"]);

type AnalyticsProfile = "kpi" | "simple";
type RequestedMode = "simple" | "kpi" | "auto";
type QueryPlanFilter = NonNullable<QueryPlan["filters"]>[number];
type AnalyticsResponse = Record<string, any>;

export type AnalyticsToolTraceEntry = TraceEntry & {
  attempt: number;
  durationMs: number;
};

export interface AnalyticsOrchestratorInput {
  question: string;
  catalog: AiDatasetDefinition[];
  adapter: LiveAdapter;
  kpiMetrics?: GlobalAiKpi[];
  requestFilters?: SqlFilter[];
  conversationContext?: ConversationContext;
  requestedMode?: RequestedMode;
  connectionName?: string;
}

type DateNote = { value: string; message: string };

interface ToolOutcome {
  ok: boolean;
  status?: TraceEntry["status"];
  detail: string;
  next?: string;
  retryable?: boolean;
  terminal?: boolean;
  summary?: Record<string, unknown>;
}

interface AnalyticsRunState {
  executionId: string;
  question: string;
  catalog: AiDatasetDefinition[];
  adapter: LiveAdapter;
  kpiMetrics: GlobalAiKpi[];
  requestPlanFilters: QueryPlanFilter[];
  conversationContext?: ConversationContext;
  requestedMode: RequestedMode;
  connectionName: string;

  classification?: ClassifyResult;
  profile?: AnalyticsProfile;
  matchedKpi?: GlobalAiKpi;
  userFiltersAst?: FilterNode;
  guardPassed: boolean;
  dateNotes: DateNote[];

  plan?: QueryPlan;
  planVersion: number;
  validatedPlan?: QueryPlan;
  validatedPlanVersion?: number;
  compiledQuery?: CompiledQuery;
  compiledPlanVersion?: number;
  data?: { rowCount: number; rows: QueryResult["rows"] };
  qualityChecked: boolean;
  insight?: unknown;
  chart?: unknown;

  corrections: string[];
  trace: AnalyticsToolTraceEntry[];
  attempts: Record<string, number>;
  totalToolCalls: number;
  toolQueue: Promise<void>;
  haltedReason?: string;
  lastFeedback?: string;
  lastError?: string;
  terminalResponse?: AnalyticsResponse;
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function toQueryPlanFilters(filters: SqlFilter[]): QueryPlanFilter[] {
  const planFilters: QueryPlanFilter[] = [];
  for (const filter of filters) {
    if (!QUERY_PLAN_FILTER_OPS.has(filter.op)) continue;
    if (filter.op === "between") {
      const value = filter.value;
      if (!value || typeof value !== "object" || Array.isArray(value) || !("start" in value) || !("end" in value)) {
        continue;
      }
      planFilters.push({
        field: filter.field,
        op: filter.op,
        value: { start: String(value.start), end: String(value.end) },
      });
      continue;
    }
    if (filter.op === "in") {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      planFilters.push({ field: filter.field, op: filter.op, value: values.map(String) });
      continue;
    }
    planFilters.push({
      field: filter.field,
      op: filter.op as QueryPlanFilter["op"],
      value: String(filter.value),
    });
  }
  return planFilters;
}

function filterKey(filter: QueryPlanFilter): string {
  return JSON.stringify({ field: filter.field, op: filter.op, value: filter.value });
}

function dedupeFilters(filters: QueryPlanFilter[]): QueryPlanFilter[] {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = filterKey(filter);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function containsIsoDate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsIsoDate);
  if (value && typeof value === "object") return Object.values(value).some(containsIsoDate);
  return /\b(?:19|20)\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?\b/.test(String(value || ""));
}

function filterScalarValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(filterScalarValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(filterScalarValues);
  return [String(value || "")].filter(Boolean);
}

/** Keep only planner filters grounded in the user's wording or explicit filter intent. */
export function removeUngroundedPlannerFilters(
  currentPlan: QueryPlan,
  question: string,
): { plan: QueryPlan; removed: number } {
  const normalizedQuestion = question.toLowerCase();
  const hasTemporalIntent = /\b(?:today|yesterday|tomorrow|daily|weekly|monthly|quarterly|yearly|date|day|week|month|quarter|year|last|past|previous|this|next|since|until|before|after)\b|\b(?:19|20)\d{2}(?:-\d{1,2}(?:-\d{1,2})?)?\b/.test(normalizedQuestion);
  if (!currentPlan.filters?.length) return { plan: currentPlan, removed: 0 };
  const hasExplicitFilterIntent = /\b(?:where|whose|having|filter(?:ed)?|only|exclude|excluding|except|without|with|at)\b|\bfor\s+(?!each\b|every\b)/.test(normalizedQuestion);
  const hasGroupingIntent = /\b(?:by|per|grouped\s+by|split\s+by|breakdown\s+by|based\s+on)\b/.test(normalizedQuestion);
  const normalizedQuestionRef = `_${normalizeIdentifier(question)}_`;

  const retained = currentPlan.filters.filter((filter) => {
    if (containsIsoDate(filter.value)) return hasTemporalIntent;
    const normalizedValues = filterScalarValues(filter.value).map(normalizeIdentifier).filter(Boolean);
    const valueMistakenForGroupingDimension = hasGroupingIntent
      && normalizedValues.some((value) => dimensionLeafAliases(filter.field).includes(value));
    if (valueMistakenForGroupingDimension) return false;
    const valueAppearsInQuestion = normalizedValues.some((normalizedValue) => {
      return normalizedValue.length > 1 && normalizedQuestionRef.includes(`_${normalizedValue}_`);
    });
    return hasExplicitFilterIntent || valueAppearsInQuestion;
  });
  const removed = currentPlan.filters.length - retained.length;
  return removed > 0
    ? { plan: { ...currentPlan, filters: retained } as QueryPlan, removed }
    : { plan: currentPlan, removed: 0 };
}

function addCorrection(state: AnalyticsRunState, correction: string): void {
  if (correction && !state.corrections.includes(correction)) state.corrections.push(correction);
}

function normalizeDatasetRef(datasetRef: string, catalog: AiDatasetDefinition[]): string {
  return getDynamicDataset(datasetRef, catalog)?.name || datasetRef;
}

type KpiDimensionResolution =
  | { ok: true; plan: QueryPlan }
  | { ok: false; kind: "not_configured" | "ambiguous"; requestedRef: string; candidates: string[] };

function columnRefLeaf(columnRef: string): string {
  return String(columnRef || "").replace(/[`"\[\]]/g, "").split(".").filter(Boolean).pop() || "";
}

/** Exact column-name key; separators remain significant. */
function exactDimensionLeafKey(columnRef: string): string {
  return columnRefLeaf(columnRef).trim().toLowerCase();
}

function exactDimensionRefKey(columnRef: string): string {
  return String(columnRef || "").replace(/[`"\[\]]/g, "").trim().toLowerCase();
}

function dimensionLeafAliases(columnRef: string): string[] {
  const aliases = new Set<string>();
  let current = normalizeIdentifier(columnRefLeaf(columnRef));
  if (current) aliases.add(current);
  // Business users should be able to say "region" for technical custom-field
  // names such as "u_gsc_region". Strip only known implementation prefixes;
  // do not perform arbitrary suffix matching against unrelated columns.
  const prefixes = ["u_", "x_", "sys_", "gsc_"];
  let changed = true;
  while (changed && current) {
    changed = false;
    for (const prefix of prefixes) {
      if (current.startsWith(prefix) && current.length > prefix.length) {
        current = current.slice(prefix.length);
        aliases.add(current);
        changed = true;
        break;
      }
    }
  }
  return [...aliases];
}

function isQualifiedColumnRef(columnRef: string): boolean {
  return String(columnRef || "").replace(/[`"\[\]]/g, "").split(".").filter(Boolean).length > 1;
}

function requestedTrendGrain(question: string): QueryPlan["timeGrain"] | undefined {
  const normalized = String(question || "").toLowerCase().replace(/[_-]+/g, " ");
  if (/\b(?:daily|each day|by day|day over day)\b/.test(normalized)) return "day";
  if (/\b(?:weekly|each week|by week|week over week)\b/.test(normalized)) return "week";
  if (/\b(?:monthly|each month|by month|month over month)\b/.test(normalized)) return "month";
  if (/\b(?:yearly|annually|each year|by year|year over year)\b/.test(normalized)) return "year";
  if (/\b(?:trend|over time|time series)\b/.test(normalized)) return "month";
  return undefined;
}

function canonicalizeKpiDimensionRef(
  columnRef: string,
  involvedTables: string[],
  catalog: AiDatasetDefinition[],
): string {
  try {
    const resolved = resolveColumnAcrossDatasets(columnRef, involvedTables, catalog);
    return resolved ? `${resolved.datasetName}.${resolved.column.name}` : String(columnRef || "").trim();
  } catch {
    return String(columnRef || "").trim();
  }
}

export function resolveMatchedKpiPlanDimensions(
  currentPlan: QueryPlan,
  matchedKpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
  question: string,
): KpiDimensionResolution {
  const involvedTables = (matchedKpi.involvedTables || [])
    .filter(Boolean)
    .map((tableName) => normalizeDatasetRef(tableName, catalog));
  const configuredDimensions = (matchedKpi.dimensions?.length
    ? matchedKpi.dimensions
    : (matchedKpi.kpi_dimensions || []))
    .map((dimension) => canonicalizeKpiDimensionRef(dimension, involvedTables, catalog));
  const uniqueDimensions = Array.from(new Map(
    configuredDimensions.map((dimension) => [exactDimensionRefKey(dimension), dimension]),
  ).values());
  // The first involved table is the KPI's configured root and provides the
  // stable canonical reference for a same-named dimension set.
  const primaryTable = involvedTables[0] || "";

  const dimensionTable = (dimensionRef: string): string =>
    dimensionRef.slice(0, dimensionRef.length - columnRefLeaf(dimensionRef).length - 1);

  const leafMatchesFor = (ref: string): string[] => {
    const exactLeaf = exactDimensionLeafKey(ref);
    const exactMatches = uniqueDimensions.filter(
      (dimension) => exactDimensionLeafKey(dimension) === exactLeaf,
    );
    if (exactMatches.length > 0) return exactMatches;

    const semanticLeaf = normalizeIdentifier(columnRefLeaf(ref));
    return uniqueDimensions.filter(
      (dimension) => dimensionLeafAliases(dimension).includes(semanticLeaf),
    );
  };

  const chooseCanonicalDimension = (matches: string[]): string | undefined =>
    matches.find(
      (dimension) => normalizeIdentifier(dimensionTable(dimension)) === normalizeIdentifier(primaryTable),
    ) || matches[0];

  const resolveRequestedRef = (requestedRef: string): string | KpiDimensionResolution => {
    const cleanRef = String(requestedRef || "").trim();
    const leafMatches = leafMatchesFor(cleanRef);
    const matchedLeafSets = new Set(leafMatches.map(exactDimensionLeafKey));

    if (isQualifiedColumnRef(cleanRef)) {
      const canonicalRequested = canonicalizeKpiDimensionRef(cleanRef, involvedTables, catalog);
      const exactMatch = uniqueDimensions.find(
        (dimension) => exactDimensionRefKey(dimension) === exactDimensionRefKey(canonicalRequested),
      );
      if (!exactMatch) {
        return { ok: false, kind: "not_configured", requestedRef: cleanRef, candidates: uniqueDimensions };
      }
      // Qualification verifies that the planner selected a configured column.
      // Same-named configured columns still resolve to one primary-anchored
      // business set, regardless of which table the planner happened to name.
      const sameNamedMatches = uniqueDimensions.filter(
        (dimension) => exactDimensionLeafKey(dimension) === exactDimensionLeafKey(exactMatch),
      );
      return chooseCanonicalDimension(sameNamedMatches) || exactMatch;
    }

    if (matchedLeafSets.size === 1) return chooseCanonicalDimension(leafMatches)!;
    if (matchedLeafSets.size > 1) {
      return { ok: false, kind: "ambiguous", requestedRef: cleanRef, candidates: leafMatches };
    }
    return { ok: false, kind: "not_configured", requestedRef: cleanRef, candidates: uniqueDimensions };
  };

  const resolvedPlan = { ...currentPlan } as QueryPlan;
  const trendGrain = requestedTrendGrain(question);
  if (trendGrain) {
    // Providers occasionally omit both trend fields even for an explicit
    // "monthly trend" question. Because the KPI dimension allowlist is the
    // governed source of truth, deterministically select a configured date
    // dimension instead of silently degrading the request to a scorecard.
    const dateDimensions = uniqueDimensions.filter((dimension) => {
      try {
        return resolveColumnAcrossDatasets(dimension, involvedTables, catalog)?.column.type === "date";
      } catch {
        return false;
      }
    });
    const configuredDateDimension = dateDimensions.find(
      (dimension) => normalizeIdentifier(dimensionTable(dimension)) === normalizeIdentifier(primaryTable),
    ) || dateDimensions[0];
    if (configuredDateDimension) {
      resolvedPlan.timeGrain = trendGrain;
      resolvedPlan.timeGrainColumn = configuredDateDimension;
      resolvedPlan.sortDir = "asc";
    }
  }

  // Backstop explicit group-by wording that a planner may omit. This keeps
  // phrases such as "based on u_gsc_region" deterministic while still routing
  // duplicate short names through the ambiguity guard below.
  if (!resolvedPlan.groupBy && !resolvedPlan.timeGrainColumn) {
    const normalizedQuestion = question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const hasGroupingIntent = /\b(?:by|per|grouped\s+by|split\s+by|breakdown\s+by|based\s+on)\b/.test(normalizedQuestion);
    if (hasGroupingIntent) {
      const exactMentionedDimensions = uniqueDimensions.filter((dimension) => {
        const leaf = exactDimensionLeafKey(dimension);
        const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9_])${escapedLeaf}([^a-z0-9_]|$)`, "i").test(question);
      });
      const exactMentionedLeaves = Array.from(new Set(
        exactMentionedDimensions.map(exactDimensionLeafKey),
      ));

      if (exactMentionedLeaves.length > 0) {
        // Exact configured names win. This prevents a request for `region`
        // from also pulling in the differently named `u_gsc_region` set.
        resolvedPlan.groupBy = exactMentionedLeaves.length === 1
          ? exactMentionedLeaves[0]!
          : exactMentionedLeaves;
      } else {
        const normalizedQuestionRef = `_${normalizeIdentifier(question)}_`;
        const semanticMentions = uniqueDimensions.filter((dimension) =>
          dimensionLeafAliases(dimension).some(
            (alias) => alias && normalizedQuestionRef.includes(`_${alias}_`),
          ),
        );
        const semanticLeafSets = Array.from(new Set(semanticMentions.map(exactDimensionLeafKey)));
        if (semanticLeafSets.length === 1) {
          const businessAlias = dimensionLeafAliases(semanticMentions[0]!).find(
            (alias) => alias && normalizedQuestionRef.includes(`_${alias}_`),
          );
          if (businessAlias) resolvedPlan.groupBy = businessAlias;
        } else if (semanticLeafSets.length > 1) {
          // Let resolveRequestedRef return a clear ambiguity instead of
          // combining multiple differently named technical columns.
          const sharedAlias = dimensionLeafAliases(semanticMentions[0]!).find((alias) =>
            alias && normalizedQuestionRef.includes(`_${alias}_`)
            && semanticMentions.every((dimension) => dimensionLeafAliases(dimension).includes(alias)),
          );
          if (sharedAlias) resolvedPlan.groupBy = sharedAlias;
        }
      }
    }
  }
  if (resolvedPlan.groupBy) {
    const requestedGroups = Array.isArray(resolvedPlan.groupBy) ? resolvedPlan.groupBy : [resolvedPlan.groupBy];
    const resolvedGroups: string[] = [];
    for (const requestedGroup of requestedGroups) {
      const resolved = resolveRequestedRef(requestedGroup);
      if (typeof resolved !== "string") return resolved;
      resolvedGroups.push(resolved);
    }
    resolvedPlan.groupBy = Array.isArray(resolvedPlan.groupBy) ? resolvedGroups : resolvedGroups[0]!;
  }
  if (resolvedPlan.timeGrainColumn) {
    const resolved = resolveRequestedRef(resolvedPlan.timeGrainColumn);
    if (typeof resolved !== "string") return resolved;
    resolvedPlan.timeGrainColumn = resolved;
  }

  // A provider may mark a repeated short dimension as AMBIGUOUS before the
  // certified KPI resolver anchors it to the root table. Once this function
  // has resolved every requested grouping, that provider flag is stale.
  if (resolvedPlan.errorMode === "AMBIGUOUS" && (resolvedPlan.groupBy || resolvedPlan.timeGrainColumn)) {
    resolvedPlan.errorMode = undefined;
    resolvedPlan.conversationalAnswer = undefined;
    resolvedPlan.ambiguityDetails = undefined;
  }

  return { ok: true, plan: applyKpiCombinedDimensionGroups(resolvedPlan, matchedKpi, catalog) };
}

/**
 * Register row-expansion groups for requested same-named KPI dimensions.
 * Saved KPI joins remain the master joins; dimensions do not add equality
 * predicates to those joins.
 */
export function applyKpiCombinedDimensionGroups(
  currentPlan: QueryPlan,
  matchedKpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
): QueryPlan {
  const involvedTables = (matchedKpi.involvedTables || [])
    .filter(Boolean)
    .map((tableName) => normalizeDatasetRef(tableName, catalog));
  const primaryTable = involvedTables[0];
  if (!primaryTable) return currentPlan;

  const dimensionTable = (dimensionRef: string): string =>
    dimensionRef.slice(0, dimensionRef.length - columnRefLeaf(dimensionRef).length - 1);
  const configuredDimensions = (matchedKpi.dimensions?.length
    ? matchedKpi.dimensions
    : (matchedKpi.kpi_dimensions || []))
    .map((dimension) => canonicalizeKpiDimensionRef(dimension, involvedTables, catalog));
  const requestedDimensions = Array.isArray(currentPlan.groupBy)
    ? currentPlan.groupBy
    : (currentPlan.groupBy ? [currentPlan.groupBy] : []);
  if (requestedDimensions.length === 0) {
    return { ...currentPlan, combinedGroupBy: undefined } as QueryPlan;
  }

  const combinedGroupBy: NonNullable<QueryPlan["combinedGroupBy"]> = [];
  for (const requested of requestedDimensions) {
    const leaf = exactDimensionLeafKey(requested);
    const matches = configuredDimensions.filter(
      (dimension) => exactDimensionLeafKey(dimension) === leaf,
    );
    const canonicalDimension = matches.find(
      (dimension) => normalizeIdentifier(dimensionTable(dimension)) === normalizeIdentifier(primaryTable),
    ) || matches[0];
    if (!leaf || !canonicalDimension || matches.length < 2) continue;

    const columns = Array.from(new Map(
      matches.map((dimension) => [dimension.toLowerCase(), dimension]),
    ).values());
    if (!combinedGroupBy.some((entry) => exactDimensionLeafKey(entry.groupBy) === leaf)) {
      combinedGroupBy.push({ groupBy: canonicalDimension, columns });
    }
  }

  return {
    ...currentPlan,
    combinedGroupBy: combinedGroupBy.length > 0 ? combinedGroupBy : undefined,
  } as QueryPlan;
}

function normalizeMatchedKpiPlan(
  currentPlan: QueryPlan,
  matchedKpi: GlobalAiKpi | undefined,
  catalog: AiDatasetDefinition[],
): QueryPlan {
  if (!matchedKpi) return currentPlan;
  const normalized = { ...currentPlan } as QueryPlan;
  const involvedTables = (matchedKpi.involvedTables || [])
    .filter(Boolean)
    .map((tableName) => normalizeDatasetRef(tableName, catalog));
  normalized.metric = matchedKpi.name;
  if (involvedTables.length > 0) normalized.datasets = involvedTables;
  // Pin the complete join list too. Keeping even one Simple-planner join while
  // appending KPI tables is what produced the disconnected 3-dataset/1-join
  // plan in the original failure.
  normalized.joins = (matchedKpi.join_spec || []).map((join) => normalizeJoinConditions({
      ...join,
      leftTable: normalizeDatasetRef(join.leftTable, catalog),
      rightTable: normalizeDatasetRef(join.rightTable, catalog),
      conditions: getJoinConditions(join).map((condition) => ({
        ...condition,
        leftTable: normalizeDatasetRef(condition.leftTable || join.leftTable, catalog),
        rightTable: normalizeDatasetRef(condition.rightTable || join.rightTable, catalog),
      })),
    }));
  return normalized;
}

const KPI_NAME_GENERIC_TOKENS = new Set([
  "active", "average", "cases", "case", "count", "distinct", "matched",
  "metric", "number", "per", "rate", "resolved", "total", "unique", "volume",
]);

function normalizedTokens(value: string): string[] {
  return normalizeIdentifier(value).split("_").filter(Boolean);
}

export function resolveKpiQualifierFilter(
  currentPlan: QueryPlan,
  matchedKpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
  question: string,
): { plan: QueryPlan; correction?: string } {
  const qualifierMatch = question.trim().match(/\b(at|for)\s+(.+?)[?.!]*$/i);
  if (!qualifierMatch) return { plan: currentPlan };

  const qualifierWord = qualifierMatch[1]!.toLowerCase();
  const qualifierValue = qualifierMatch[2]!.trim();
  if (!qualifierValue
    || /^(?:each|every)\b/i.test(qualifierValue)
    || /\b(?:today|yesterday|tomorrow|last|past|previous|this|next|day|week|month|quarter|year|am|pm)\b/i.test(qualifierValue)
    || /\b20\d{2}\b/.test(qualifierValue)) {
    return { plan: currentPlan };
  }

  const involvedTables = (matchedKpi.involvedTables || []).map((table) => normalizeDatasetRef(table, catalog));
  const configuredDimensions = (matchedKpi.dimensions?.length ? matchedKpi.dimensions : (matchedKpi.kpi_dimensions || []))
    .map((dimension) => canonicalizeKpiDimensionRef(dimension, involvedTables, catalog));
  const semanticTokens = new Set(normalizedTokens(matchedKpi.name).filter((token) => !KPI_NAME_GENERIC_TOKENS.has(token)));
  if (semanticTokens.size === 0) return { plan: currentPlan };

  const mentionedTables = new Set(extractMentionedTables(question, catalog));
  const scoredDimensions = configuredDimensions.map((dimension, index) => {
    const splitAt = dimension.lastIndexOf(".");
    const table = splitAt > 0 ? dimension.slice(0, splitAt) : "";
    const column = splitAt > 0 ? dimension.slice(splitAt + 1) : dimension;
    const dataset = getDynamicDataset(table, catalog);
    const columnType = dataset?.columns.find((candidate) => normalizeIdentifier(candidate.name) === normalizeIdentifier(column))?.type;
    const dimensionTokens = new Set(normalizedTokens(dimension));
    const semanticOverlap = [...semanticTokens].filter((token) => dimensionTokens.has(token)).length;
    const explicitlyMentioned = mentionedTables.has(table) ? 1 : 0;
    return {
      dimension,
      index,
      score: (columnType === "date" ? -100 : 0) + semanticOverlap * 10 + explicitlyMentioned * 100,
    };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selectedDimension = scoredDimensions[0]?.dimension;
  if (!selectedDimension) return { plan: currentPlan };

  const normalizedValue = normalizeIdentifier(qualifierValue);
  const filters = [...(currentPlan.filters || [])];
  let targetIndex = filters.findIndex((filter) => {
    if (typeof filter.value !== "string") return false;
    const filterValue = normalizeIdentifier(filter.value);
    return filterValue === normalizedValue || filterValue.includes(normalizedValue) || normalizedValue.includes(filterValue);
  });
  if (targetIndex < 0 && filters.length === 1 && typeof filters[0]?.value === "string") targetIndex = 0;

  const intendedFilter = { field: selectedDimension, op: "eq" as const, value: qualifierValue };
  const previousField = targetIndex >= 0 ? filters[targetIndex]?.field : undefined;
  if (targetIndex >= 0) filters[targetIndex] = intendedFilter;
  else filters.push(intendedFilter);

  if (previousField && normalizeIdentifier(previousField) === normalizeIdentifier(selectedDimension)) {
    return { plan: { ...currentPlan, filters } as QueryPlan };
  }
  const action = previousField ? `corrected from ${previousField}` : "restored after planner omission";
  return {
    plan: { ...currentPlan, filters } as QueryPlan,
    correction: `Applied '${qualifierWord} ${qualifierValue}' to ${selectedDimension} (${action}).`,
  };
}

export function promoteCertifiedKpiPlan(
  currentPlan: QueryPlan,
  kpiMetrics: GlobalAiKpi[],
  catalog: AiDatasetDefinition[],
): { plan: QueryPlan; kpi: GlobalAiKpi } | null {
  const metricName = normalizeIdentifier(currentPlan.metric);
  if (!metricName) return null;
  const kpi = kpiMetrics.find((candidate) => normalizeIdentifier(candidate.name) === metricName);
  if (!kpi) return null;
  return { plan: normalizeMatchedKpiPlan(currentPlan, kpi, catalog), kpi };
}

function emptyData() {
  return { rowCount: 0, rows: [] };
}

export function buildGuidedQuerySuggestions(
  _question: string,
  _catalog: AiDatasetDefinition[],
  kpiMetrics: GlobalAiKpi[] = [],
): string[] {
  return [
    ...(kpiMetrics[0]?.name ? [`Show me ${kpiMetrics[0].name}`] : []),
    "Show the business values I asked for",
    "Show a KPI result",
  ].slice(0, 3);
}

function createAmbiguousResponse(state: AnalyticsRunState, plan: QueryPlan): AnalyticsResponse {
  void plan;
  const message = "I need a more specific business description before I can run this query. Please describe the value or KPI you want without database identifiers.";
  return {
    success: true,
    mode: "AMBIGUOUS",
    question: state.question,
    message,
    appliedCorrections: state.corrections,
    insight: { answer: message, drivers: ["The requested business meaning was ambiguous."], followUps: [] },
    chart: null,
    data: emptyData(),
    sql: { dialect: state.adapter.dialect, sql: "-- Ambiguous query; no SQL executed", params: [] },
  };
}

function createKpiDimensionNotConfiguredResponse(
  state: AnalyticsRunState,
  _requestedRef: string,
  _candidates: string[],
): AnalyticsResponse {
  const message = "That business breakdown is not configured for this KPI. Update the KPI definition or ask for a configured business dimension.";
  return {
    success: false,
    mode: "kpi-dimension-not-configured",
    errorCode: "KPI_DIMENSION_NOT_CONFIGURED",
    question: state.question,
    error: message,
    insight: {
      answer: message,
      drivers: ["Certified KPI dimensions are enforced as an allowlist."],
      followUps: ["Update this KPI in the KPI Metrics tab", "Show available KPIs"],
    },
    chart: null,
    data: emptyData(),
    sql: { dialect: state.adapter.dialect, sql: "-- KPI dimension is not configured; no SQL executed", params: [] },
  };
}

function applyKpiDimensionIssue(
  state: AnalyticsRunState,
  resolution: Extract<KpiDimensionResolution, { ok: false }>,
): ToolOutcome {
  if (resolution.kind === "ambiguous") {
    const column = columnRefLeaf(resolution.requestedRef) || resolution.requestedRef;
    const reason = "The requested business dimension needs more context before this KPI can be run.";
    state.terminalResponse = createAmbiguousResponse(state, {
      ambiguityDetails: { candidateTables: resolution.candidates, column, reason },
    } as QueryPlan);
    return { ok: true, status: "warning", detail: reason, terminal: true };
  }

  state.terminalResponse = createKpiDimensionNotConfiguredResponse(
    state,
    resolution.requestedRef,
    resolution.candidates,
  );
  return {
    ok: true,
    status: "warning",
    detail: `KPI dimension "${resolution.requestedRef}" is not configured.`,
    terminal: true,
  };
}

// The group-by allowlist (resolveMatchedKpiPlanDimensions) protects grouping,
// but a WHERE filter referencing a column shared by several of the KPI's
// involved tables has the same hazard: the planner is told to qualify shared
// columns, and when the user's phrasing was a bare ambiguous name it may guess
// a table. A qualified-but-guessed filter passes the compiler's bare-column
// ambiguity throw (the ref is already qualified) and silently filters the wrong
// table. This mirrors the group-by guard: only trust the planner's chosen table
// when the user's own question named it.
type KpiFilterAmbiguity = { column: string; candidates: string[] };

function collectFilterFields(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectFilterFields(child, out));
    return;
  }
  const record = node as Record<string, unknown>;
  // Mirror the compiler's own filter walk: a node with `children` is a group;
  // anything else carrying a string `field` is a condition. Plan filters are
  // frequently flat { field, op, value } objects with no explicit
  // type:"condition", so keying on the type tag alone would miss them.
  if (Array.isArray(record.children)) {
    record.children.forEach((child) => collectFilterFields(child, out));
    return;
  }
  if (typeof record.field === "string") {
    out.push(record.field);
  }
}

export function findAmbiguousKpiFilterField(
  plan: QueryPlan,
  matchedKpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
  question: string,
): KpiFilterAmbiguity | null {
  const involvedTables = (matchedKpi.involvedTables || [])
    .filter(Boolean)
    .map((tableName) => normalizeDatasetRef(tableName, catalog));
  // A shared column name cannot be cross-table ambiguous on a single-table KPI.
  if (involvedTables.length < 2) return null;

  const fields: string[] = [];
  // plan.filters carries the LLM/user WHERE conditions. The KPI's own
  // filter_logic is compiled separately and never appears here, so certified
  // KPI-defined filters are correctly out of scope for this guess check.
  collectFilterFields(plan.filters, fields);
  if (fields.length === 0) return null;

  const mentionedTables = new Set(extractMentionedTables(question, catalog));

  for (const field of fields) {
    // Bare ambiguous fields are already caught by resolveColumnAcrossDatasets'
    // AMBIGUOUS_MODE throw; only a qualified ref can silently pick a table.
    if (!isQualifiedColumnRef(field)) continue;

    const leaf = normalizeIdentifier(columnRefLeaf(field));
    const tablesWithLeaf = involvedTables.filter((tableName) =>
      getDynamicDataset(tableName, catalog)?.columns.some(
        (column) => normalizeIdentifier(column.name) === leaf,
      ),
    );
    if (tablesWithLeaf.length < 2) continue;

    let chosen: { datasetName: string } | null = null;
    try {
      chosen = resolveColumnAcrossDatasets(field, involvedTables, catalog);
    } catch {
      chosen = null;
    }
    if (!chosen) continue;

    const userNamedChosen = mentionedTables.has(chosen.datasetName);
    const userNamedOther = tablesWithLeaf.some(
      (tableName) => tableName !== chosen!.datasetName && mentionedTables.has(tableName),
    );
    if (!userNamedChosen || userNamedOther) {
      const leafName = columnRefLeaf(field);
      return {
        column: leafName,
        candidates: tablesWithLeaf.map((tableName) => `${tableName}.${leafName}`),
      };
    }
  }

  return null;
}

function applyKpiFilterAmbiguity(state: AnalyticsRunState, ambiguity: KpiFilterAmbiguity): ToolOutcome {
  const reason = "The requested business filter needs more context before this KPI can be run.";
  state.terminalResponse = createAmbiguousResponse(state, {
    ambiguityDetails: { candidateTables: ambiguity.candidates, column: ambiguity.column, reason },
  } as QueryPlan);
  return { ok: true, status: "warning", detail: reason, terminal: true };
}

function createAmbiguousToolOutcome(state: AnalyticsRunState, error: unknown): ToolOutcome | null {
  const message = String((error as Error)?.message || error);
  const marker = "AMBIGUOUS_MODE|";
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return null;

  const [tables = "", column = "column", ...reasonParts] = message.slice(markerIndex + marker.length).split("|");
  const candidateTables = tables.split(",").map((table) => table.trim()).filter(Boolean);
  const reason = reasonParts.join("|").trim()
    || `'${column}' exists in multiple requested tables. Please specify the table name.`;
  state.terminalResponse = createAmbiguousResponse(state, {
    ambiguityDetails: { candidateTables, column, reason },
  } as QueryPlan);
  return { ok: true, status: "warning", detail: reason, terminal: true };
}

function createUnrecognizedResponse(state: AnalyticsRunState, conversationalAnswer?: string | null): AnalyticsResponse {
  const suggestedQueries = buildGuidedQuerySuggestions(state.question, state.catalog, state.kpiMetrics);
  if (conversationalAnswer) {
    return {
      success: true,
      mode: "assistant",
      question: state.question,
      suggestedQueries,
      appliedCorrections: state.corrections,
      insight: {
        answer: conversationalAnswer,
        drivers: [state.profile === "kpi" ? "KPI catalog lookup" : "Catalog lookup"],
        followUps: suggestedQueries,
      },
      chart: null,
      data: emptyData(),
      sql: { dialect: state.adapter.dialect, sql: "-- Informational response; no SQL executed", params: [] },
    };
  }
  return {
    success: false,
    mode: "unrecognized",
    errorCode: "UNRECOGNIZED_QUERY",
    question: state.question,
    error: "Unrecognized Query Intent",
    suggestedQueries,
    insight: {
      answer: state.profile === "kpi"
        ? "I couldn't map that request to the matched certified KPI. Please rephrase with a KPI name, group-by, or filter from the catalog."
        : "I couldn't map that to any tables or metrics in the database. Please try rephrasing or ask me what's available.",
      drivers: ["Planner could not map the request"],
      followUps: suggestedQueries,
    },
    chart: null,
    data: emptyData(),
    sql: { dialect: state.adapter.dialect, sql: "-- Unrecognized query; no SQL executed", params: [] },
  };
}

function createNeedsKpiResponse(state: AnalyticsRunState, issue: string): AnalyticsResponse {
  const parts = issue.split("|");
  const aggregate = parts[1] || "SUM";
  const column = parts[2] || "value";
  const dataset = parts[3] || "";
  const formula = `${aggregate}(${column})`;
  const answer = `"${aggregate} of ${column}" isn't a certified KPI yet, so I can't run it as an ad-hoc calculation. Please create a KPI in the KPI Metrics tab${dataset ? ` (table: ${dataset})` : ""} with the formula \`${formula}\`, then ask again.`;
  return {
    success: false,
    mode: "needs_kpi",
    errorCode: "NEEDS_KPI",
    question: state.question,
    error: "No certified KPI for this metric",
    suggestedKpi: { formula, table: dataset || undefined },
    insight: {
      answer,
      drivers: ["No certified metric matched this aggregation"],
      followUps: ["Go to KPI Metrics and create a new KPI", "List available KPIs"],
    },
    chart: null,
    data: emptyData(),
    sql: { dialect: state.adapter.dialect, sql: "-- KPI required; no SQL executed", params: [] },
    appliedCorrections: state.corrections,
  };
}

function createClassificationTerminal(state: AnalyticsRunState, classification: ClassifyResult): AnalyticsResponse | undefined {
  if (classification.mode === "GREETING") {
    return {
      success: true,
      mode: "assistant",
      question: state.question,
      insight: {
        answer: "I am Analytics AI. I can answer questions about your connected catalog and run natural-language analytics.",
        drivers: ["Greeting detected by classifier tool"],
        followUps: ["List available tables", "Show available KPIs"],
      },
      chart: null,
      data: emptyData(),
      sql: { dialect: "none", sql: "-- Assistant response; no SQL executed", params: [] },
    };
  }
  if (classification.mode === "AMBIGUOUS") {
    const message = classification.reason || "The request is ambiguous. Please specify the table or column you mean.";
    return {
      success: false,
      mode: "ambiguous",
      question: state.question,
      column: classification.column,
      candidateTables: classification.candidateTables || [],
      message,
      insight: { answer: message, drivers: ["Classifier tool detected ambiguity"], followUps: [] },
      chart: null,
      data: emptyData(),
      sql: { dialect: state.adapter.dialect, sql: "-- Ambiguous query; no SQL executed", params: [] },
    };
  }
  if (classification.mode === "NEEDS_KPI") {
    return createNeedsKpiResponse(state, "NEEDS_KPI_MODE|SUM|value|");
  }
  if (classification.mode === "UNKNOWN") {
    return createUnrecognizedResponse(state);
  }
  return undefined;
}

export function classifyAnalyticsProfile(
  question: string,
  kpiMetrics: GlobalAiKpi[],
  catalog: AiDatasetDefinition[],
  conversationContext?: ConversationContext,
  requestedMode: RequestedMode = "auto",
): { classification: ClassifyResult; profile?: AnalyticsProfile; terminal: boolean } {
  const detected = classifyQuery(question, kpiMetrics, catalog, conversationContext);
  if (detected.mode === "GREETING") {
    return {
      classification: { ...detected, mode: "COMPLEX" },
      profile: "simple",
      terminal: false,
    };
  }
  if (requestedMode === "simple") {
    return {
      classification: { ...detected, mode: "COMPLEX", kpi: undefined, weakMatch: undefined },
      profile: "simple",
      terminal: false,
    };
  }
  if (detected.mode === "KPI" && detected.kpi) {
    return { classification: detected, profile: "kpi", terminal: false };
  }
  if (detected.mode === "SIMPLE" || detected.mode === "COMPLEX") {
    return { classification: detected, profile: "simple", terminal: false };
  }
  return { classification: detected, terminal: true };
}

function invalidateAfterPlanning(state: AnalyticsRunState): void {
  state.validatedPlan = undefined;
  state.validatedPlanVersion = undefined;
  state.compiledQuery = undefined;
  state.compiledPlanVersion = undefined;
  state.data = undefined;
  state.qualityChecked = false;
  state.insight = undefined;
  state.chart = undefined;
}

async function runRecordedTool(
  state: AnalyticsRunState,
  name: string,
  operation: (attempt: number) => Promise<ToolOutcome> | ToolOutcome,
): Promise<string> {
  // LangGraph's ToolNode may execute multiple tool calls from one model turn
  // concurrently. Every analytics tool closes over the same authoritative run
  // state, so parallel execution would let validator/compiler calls race ahead
  // of a slower LLM planner. Chain calls through a per-run queue to preserve the
  // exact order emitted by the model while retaining agent-controlled branching.
  const previous = state.toolQueue;
  let releaseQueue!: () => void;
  state.toolQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
  await previous;

  const startedAt = Date.now();
  const attempt = (state.attempts[name] || 0) + 1;
  state.attempts[name] = attempt;
  state.totalToolCalls += 1;

  let outcome: ToolOutcome;
  try {
    const maxCalls = positiveIntEnv("ANALYTICS_ORCHESTRATOR_MAX_TOOL_CALLS", 18);
    if (state.haltedReason) {
      outcome = { ok: false, status: "warning", detail: state.haltedReason, terminal: true };
    } else if (state.totalToolCalls > maxCalls) {
      state.haltedReason = `Tool-call limit of ${maxCalls} exceeded.`;
      state.lastError = state.haltedReason;
      outcome = { ok: false, status: "error", detail: state.haltedReason, terminal: true };
    } else {
      try {
        outcome = await operation(attempt);
      } catch (error) {
        const message = getFriendlyErrorMessage(error);
        state.lastError = message;
        outcome = { ok: false, status: "error", detail: message, retryable: false };
      }
    }

    state.trace.push({
      step: name,
      status: outcome.status || (outcome.ok ? "completed" : "error"),
      detail: outcome.detail,
      attempt,
      durationMs: Date.now() - startedAt,
    });
    return JSON.stringify({
      tool: name,
      attempt,
      ok: outcome.ok,
      detail: outcome.detail,
      next: outcome.next,
      retryable: outcome.retryable || false,
      terminal: outcome.terminal || false,
      summary: outcome.summary,
    });
  } finally {
    releaseQueue();
  }
}

function blockedByTerminal(state: AnalyticsRunState): ToolOutcome | null {
  if (state.terminalResponse) {
    return { ok: false, status: "warning", detail: "The run already has a terminal response. Stop calling tools.", terminal: true };
  }
  if (state.insight !== undefined && state.qualityChecked) {
    return { ok: false, status: "warning", detail: "The analytics result is complete. Stop calling tools.", terminal: true };
  }
  return null;
}

function applyPostLlmPreQueryGuard(state: AnalyticsRunState): ToolOutcome | null {
  if (detectWriteIntent(state.question)) {
    state.terminalResponse = buildUnsupportedIntentResponse(
      state.question,
      state.adapter.dialect,
      "Analytics AI is read-only. Modifying data (insert, update, delete, drop) is not supported.",
      [],
    );
    return { ok: true, status: "warning", detail: "Write intent was interpreted by the LLM and blocked before SQL planning.", terminal: true };
  }

  const dateGuard = analyzeLocalDateInputs(state.question);
  if (dateGuard.action === "clarify") {
    state.terminalResponse = buildClarificationResponse(state.question, state.adapter.dialect, dateGuard, []);
    return { ok: true, status: "warning", detail: dateGuard.message, terminal: true };
  }
  state.dateNotes = dateGuard.notes;
  state.guardPassed = true;
  return null;
}

function createAnalyticsTools(state: AnalyticsRunState): any[] {
  const classifierTool = createTool(
    async () => runRecordedTool(state, "query_classifier_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (state.classification) {
        return { ok: true, detail: `Already classified as ${state.profile || state.classification.mode}.`, next: "pre_query_guard_tool" };
      }
      const resolved = classifyAnalyticsProfile(
        state.question,
        state.kpiMetrics,
        state.catalog,
        state.conversationContext,
        state.requestedMode,
      );
      state.classification = resolved.classification;
      state.profile = resolved.profile;
      state.matchedKpi = resolved.classification.kpi;
      state.userFiltersAst = resolved.classification.userFilters;
      if (resolved.terminal) {
        state.terminalResponse = createClassificationTerminal(state, resolved.classification);
        return {
          ok: true,
          status: "warning",
          detail: `Classification produced terminal mode ${resolved.classification.mode}.`,
          terminal: true,
        };
      }
      return {
        ok: true,
        detail: `Selected ${state.profile} profile${state.matchedKpi ? ` for KPI ${state.matchedKpi.name}` : ""}.${resolved.classification.reason ? ` Reason: ${resolved.classification.reason}` : ""}`,
        next: "pre_query_guard_tool",
        summary: { profile: state.profile, matchedKpi: state.matchedKpi?.name },
      };
    }),
    {
      name: "query_classifier_tool",
      description: "Classify the analytics request and select the certified KPI or Simple execution profile. This must be the first tool called.",
      schema: z.object({}),
    },
  );

  const guardTool = createTool(
    async () => runRecordedTool(state, "pre_query_guard_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.classification || !state.profile) {
        return { ok: false, detail: "Classification is missing. Call query_classifier_tool first.", next: "query_classifier_tool", retryable: true };
      }
      if (detectWriteIntent(state.question)) {
        state.terminalResponse = buildUnsupportedIntentResponse(
          state.question,
          state.adapter.dialect,
          "Analytics AI is read-only. Modifying data (insert, update, delete, drop) is not supported.",
          [],
        );
        return { ok: true, status: "warning", detail: "Write intent detected and blocked.", terminal: true };
      }
      const dateGuard = analyzeLocalDateInputs(state.question);
      if (dateGuard.action === "clarify") {
        state.terminalResponse = buildClarificationResponse(state.question, state.adapter.dialect, dateGuard, []);
        return { ok: true, status: "warning", detail: dateGuard.message, terminal: true };
      }
      state.dateNotes = dateGuard.notes;
      state.guardPassed = true;
      return {
        ok: true,
        detail: dateGuard.notes.length > 0 ? dateGuard.notes.map((note) => note.message).join(" ") : "Read-only and date guards passed.",
        next: "planner_tool",
      };
    }),
    {
      name: "pre_query_guard_tool",
      description: "Block write operations and resolve or clarify local date formats before query planning.",
      schema: z.object({}),
    },
  );

  const plannerTool = createTool(
    async () => runRecordedTool(state, "planner_tool", async (attempt) => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.classification || !state.profile) {
        const resolved = classifyAnalyticsProfile(
          state.question,
          state.kpiMetrics,
          state.catalog,
          state.conversationContext,
          state.requestedMode,
        );
        state.classification = resolved.terminal
          ? { ...resolved.classification, mode: "COMPLEX", kpi: undefined }
          : resolved.classification;
        state.profile = resolved.profile || "simple";
        state.matchedKpi = resolved.terminal ? undefined : resolved.classification.kpi;
        state.userFiltersAst = resolved.classification.userFilters;
      }
      const maxAttempts = positiveIntEnv("ANALYTICS_PLANNER_MAX_ATTEMPTS", 3);
      if (attempt > maxAttempts) {
        return { ok: false, detail: `Planner attempt limit of ${maxAttempts} exceeded.`, terminal: true };
      }

      const plannerCatalog = pruneCatalogColumns(
        state.catalog,
        state.question,
        state.matchedKpi,
        { allKpis: state.kpiMetrics },
      );
      let nextPlan: QueryPlan;
      if (state.profile === "kpi") {
        const matchedKpi = state.matchedKpi;
        if (!matchedKpi) {
          return { ok: false, detail: "KPI profile selected without a matched certified KPI.", terminal: true };
        }
        if (!matchedKpi.involvedTables?.length) {
          return { ok: false, detail: `The "${matchedKpi.name}" KPI has no configured tables.`, terminal: true };
        }
        nextPlan = await planKpiQuery(
          state.question,
          plannerCatalog,
          state.kpiMetrics,
          matchedKpi,
          state.userFiltersAst,
          state.conversationContext,
          state.lastFeedback,
        );
        const guardOutcome = applyPostLlmPreQueryGuard(state);
        if (guardOutcome) return guardOutcome;
        nextPlan = normalizeMatchedKpiPlan(nextPlan, matchedKpi, state.catalog);
        const dimensionResolution = resolveMatchedKpiPlanDimensions(nextPlan, matchedKpi, state.catalog, state.question);
        if (!dimensionResolution.ok) {
          return applyKpiDimensionIssue(state, dimensionResolution);
        }
        nextPlan = dimensionResolution.plan;
        const qualifierResolution = resolveKpiQualifierFilter(nextPlan, matchedKpi, state.catalog, state.question);
        nextPlan = qualifierResolution.plan;
        if (qualifierResolution.correction) addCorrection(state, qualifierResolution.correction);
      } else {
        nextPlan = await planSimpleQuery(
          state.question,
          plannerCatalog,
          state.kpiMetrics,
          state.userFiltersAst,
          state.conversationContext,
          state.lastFeedback,
        );
        const guardOutcome = applyPostLlmPreQueryGuard(state);
        if (guardOutcome) return guardOutcome;
        if (isColumnCatalogQuestion(state.question)) {
          state.terminalResponse = buildColumnCatalogResponse(
            state.question,
            { connection_name: state.connectionName, db_type: state.adapter.dialect },
            state.catalog,
          );
          return { ok: true, detail: "After mandatory LLM interpretation, the request was routed to the column-catalog tool.", terminal: true };
        }
        if (isCatalogListQuestion(state.question)) {
          state.terminalResponse = buildCatalogListResponse(
            state.question,
            { connection_name: state.connectionName, db_type: state.adapter.dialect },
            state.catalog,
            state.kpiMetrics,
          );
          return { ok: true, detail: "After mandatory LLM interpretation, the request was routed to the catalog-list tool.", terminal: true };
        }
        const promoted = isExplicitEntityListRequest(state.question, state.catalog)
          ? null
          : promoteCertifiedKpiPlan(nextPlan, state.kpiMetrics, state.catalog);
        if (promoted) {
          state.profile = "kpi";
          state.matchedKpi = promoted.kpi;
          state.classification = { ...state.classification, mode: "KPI", kpi: promoted.kpi };
          nextPlan = promoted.plan;
          addCorrection(state, `Routed certified metric '${promoted.kpi.name}' through the KPI compiler with its configured datasets and joins.`);
          const dimensionResolution = resolveMatchedKpiPlanDimensions(nextPlan, promoted.kpi, state.catalog, state.question);
          if (!dimensionResolution.ok) {
            return applyKpiDimensionIssue(state, dimensionResolution);
          }
          nextPlan = dimensionResolution.plan;
          const qualifierResolution = resolveKpiQualifierFilter(nextPlan, promoted.kpi, state.catalog, state.question);
          nextPlan = qualifierResolution.plan;
          if (qualifierResolution.correction) addCorrection(state, qualifierResolution.correction);
        }
      }

      const filterGroundingGuard = removeUngroundedPlannerFilters(nextPlan, state.question);
      nextPlan = filterGroundingGuard.plan;
      if (filterGroundingGuard.removed > 0) {
        addCorrection(state, "Ignored unrequested constraints added by the language model.");
      }
      if (state.profile === "kpi" && state.matchedKpi) {
        const filterAmbiguity = findAmbiguousKpiFilterField(nextPlan, state.matchedKpi, state.catalog, state.question);
        if (filterAmbiguity) return applyKpiFilterAmbiguity(state, filterAmbiguity);
      }

      if (nextPlan.errorMode === "AMBIGUOUS") {
        state.terminalResponse = createAmbiguousResponse(state, nextPlan);
        return { ok: true, status: "warning", detail: "Planner requires column/table clarification.", terminal: true };
      }
      if (nextPlan.errorMode === "UNRECOGNIZED") {
        const hasCoherentPlan = Array.isArray(nextPlan.datasets) && nextPlan.datasets.length > 0
          && !!(
            nextPlan.metric
            || nextPlan.groupBy
            || (Array.isArray(nextPlan.groupBy) && nextPlan.groupBy.length > 0)
            || nextPlan.select_columns?.length
          );
        if (!hasCoherentPlan) {
          state.terminalResponse = createUnrecognizedResponse(state, nextPlan.conversationalAnswer);
          return { ok: true, status: "warning", detail: "Planner returned an informational or unrecognized response.", terminal: true };
        }
        nextPlan = { ...nextPlan, errorMode: undefined, conversationalAnswer: undefined } as QueryPlan;
      }

      state.plan = nextPlan;
      state.planVersion += 1;
      state.lastFeedback = undefined;
      invalidateAfterPlanning(state);
      return {
        ok: true,
        detail: `Created plan version ${state.planVersion} for ${nextPlan.datasets.join(", ")}.`,
        next: "validator_tool",
        summary: { planVersion: state.planVersion, datasets: nextPlan.datasets, metric: nextPlan.metric || null },
      };
    }),
    {
      name: "planner_tool",
      description: "Create or revise the semantic query plan for the selected KPI or Simple profile. Call again after validation, compilation, or execution feedback.",
      schema: z.object({}),
    },
  );

  const validatorTool = createTool(
    async () => runRecordedTool(state, "validator_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.plan || !state.profile) {
        return { ok: false, detail: "No planner-produced plan is available.", next: "planner_tool", retryable: true };
      }
      if (state.validatedPlanVersion === state.planVersion && state.validatedPlan) {
        return { ok: true, detail: `Plan version ${state.planVersion} is already validated.`, next: "sql_compiler_tool" };
      }

      if (state.profile === "kpi" && state.matchedKpi) {
        const dimensionResolution = resolveMatchedKpiPlanDimensions(state.plan, state.matchedKpi, state.catalog, state.question);
        if (!dimensionResolution.ok) {
          return applyKpiDimensionIssue(state, dimensionResolution);
        }
        state.plan = dimensionResolution.plan;
        const filterAmbiguity = findAmbiguousKpiFilterField(state.plan, state.matchedKpi, state.catalog, state.question);
        if (filterAmbiguity) return applyKpiFilterAmbiguity(state, filterAmbiguity);
      }

      let sanitized: ReturnType<typeof sanitizeAndCorrectPlan>;
      try {
        sanitized = sanitizeAndCorrectPlan(
          state.plan,
          state.catalog,
          state.profile === "simple"
            ? { allowDynamicMetrics: false, requireExplicitProjection: true }
            : undefined,
        );
      } catch (error) {
        const ambiguousOutcome = createAmbiguousToolOutcome(state, error);
        if (ambiguousOutcome) return ambiguousOutcome;
        throw error;
      }
      sanitized.corrections.forEach((correction) => addCorrection(state, correction));
      state.dateNotes.forEach((note) => addCorrection(state, note.message));

      if (sanitized.issues.length > 0) {
        const needsKpiIssue = sanitized.issues.find((issue) => issue.startsWith("NEEDS_KPI_MODE|"));
        if (needsKpiIssue && state.profile === "simple") {
          state.terminalResponse = createNeedsKpiResponse(state, needsKpiIssue);
          return { ok: true, status: "warning", detail: needsKpiIssue, terminal: true };
        }
        state.lastFeedback = `Validation failed: ${sanitized.issues.join("; ")}`;
        return { ok: false, detail: state.lastFeedback, next: "planner_tool", retryable: true };
      }

      let validated = {
        ...sanitized.plan,
        filters: dedupeFilters([...(sanitized.plan.filters || []), ...state.requestPlanFilters]),
      } as QueryPlan;
      if (state.profile === "kpi") {
        validated = normalizeMatchedKpiPlan(validated, state.matchedKpi, state.catalog);
        if (validated.filters?.length && validated.assumptions?.some((assumption) => assumption.includes("No explicit group-by, sort, or filter"))) {
          validated.assumptions = validated.assumptions.map((assumption) =>
            assumption.includes("No explicit group-by, sort, or filter")
              ? "Running the certified KPI as a scorecard with the applied filters below."
              : assumption,
          );
        }
        // Re-check the dimension allowlist AFTER sanitizeAndCorrectPlan, not
        // just before it. sanitizeAndCorrectPlan's timeGrain-vs-timeGrainColumn
        // step (validatePlan.ts step 10) auto-fills a missing timeGrainColumn
        // by searching every column on every involved table for anything
        // date-typed — with no awareness of the KPI's configured dimensions.
        // Since the earlier checks (in planner_tool and at the top of this
        // tool) only inspect timeGrainColumn when it's already set, that
        // auto-filled value would otherwise reach compileKpiQuery — and the
        // GROUP BY it produces — having never been checked against the
        // allowlist at all.
        if (state.matchedKpi) {
          const postSanitizeDimensionResolution = resolveMatchedKpiPlanDimensions(validated, state.matchedKpi, state.catalog, state.question);
          if (!postSanitizeDimensionResolution.ok) {
            return applyKpiDimensionIssue(state, postSanitizeDimensionResolution);
          }
          validated = postSanitizeDimensionResolution.plan;
          const filterAmbiguity = findAmbiguousKpiFilterField(validated, state.matchedKpi, state.catalog, state.question);
          if (filterAmbiguity) return applyKpiFilterAmbiguity(state, filterAmbiguity);
        }
      }

      let verification: ReturnType<typeof validatePlan>;
      try {
        verification = validatePlan(validated, state.catalog);
      } catch (error) {
        const ambiguousOutcome = createAmbiguousToolOutcome(state, error);
        if (ambiguousOutcome) return ambiguousOutcome;
        throw error;
      }
      if (!verification.passed) {
        state.lastFeedback = `Validation failed: ${verification.issues.join("; ")}`;
        return { ok: false, detail: state.lastFeedback, next: "planner_tool", retryable: true };
      }

      state.plan = validated;
      state.validatedPlan = validated;
      state.validatedPlanVersion = state.planVersion;
      state.lastFeedback = undefined;
      return {
        ok: true,
        status: sanitized.corrections.length > 0 ? "warning" : "completed",
        detail: sanitized.corrections.length > 0
          ? `Validated plan version ${state.planVersion} with ${sanitized.corrections.length} correction(s).`
          : `Validated plan version ${state.planVersion}.`,
        next: "sql_compiler_tool",
      };
    }),
    {
      name: "validator_tool",
      description: "Sanitize, correct, and strictly validate the current plan. SQL cannot be compiled until this tool succeeds.",
      schema: z.object({}),
    },
  );

  const compilerTool = createTool(
    async () => runRecordedTool(state, "sql_compiler_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.validatedPlan || state.validatedPlanVersion !== state.planVersion || !state.profile) {
        return { ok: false, detail: "The current plan has not been validated.", next: "validator_tool", retryable: true };
      }
      const plan = state.validatedPlan;
      try {
        if (state.profile === "kpi") {
          const matchedKpi = state.matchedKpi;
          if (!matchedKpi) throw new Error("Certified KPI context is missing.");
          const metricResult = plan.metric ? resolveMetricAcrossDatasets(plan.metric, plan.datasets, state.catalog) : null;
          const certifiedSql = matchedKpi.expressionSql ?? metricResult?.metric?.expressionSql;
          if (!certifiedSql) throw new Error(`Certified KPI expression not found for metric "${plan.metric}".`);
          state.compiledQuery = compileKpiQuery(
            plan,
            state.adapter.dialect,
            (columnRef) => {
              const resolved = resolveColumnAcrossDatasets(columnRef, plan.datasets, state.catalog);
              if (!resolved) return null;
              const dataset = state.catalog.find((item) => item.name === resolved.datasetName);
              return { table: dataset ? dataset.physicalTable : resolved.datasetName, column: resolved.column.name };
            },
            certifiedSql,
            {},
            { kpi: matchedKpi, userAst: state.userFiltersAst },
            state.catalog,
          );
        } else {
          state.compiledQuery = compileSimpleSelectQuery(
            plan,
            state.adapter.dialect,
            (columnRef) => {
              const resolved = resolveColumnAcrossDatasets(columnRef, plan.datasets, state.catalog);
              if (!resolved) return null;
              const dataset = state.catalog.find((item) => item.name === resolved.datasetName);
              return { table: dataset ? dataset.physicalTable : resolved.datasetName, column: resolved.column.name };
            },
            undefined,
            state.catalog,
          );
        }
      } catch (error) {
        const ambiguousOutcome = createAmbiguousToolOutcome(state, error);
        if (ambiguousOutcome) return ambiguousOutcome;
        state.lastFeedback = `SQL compilation failed: ${getFriendlyErrorMessage(error)}`;
        state.compiledQuery = undefined;
        state.compiledPlanVersion = undefined;
        return { ok: false, detail: state.lastFeedback, next: "planner_tool", retryable: true };
      }
      state.compiledPlanVersion = state.planVersion;
      state.data = undefined;
      state.qualityChecked = false;
      return {
        ok: true,
        detail: `Compiled validated plan version ${state.planVersion} for ${state.adapter.dialect}.`,
        next: "db_execute_tool",
        summary: { dialect: state.compiledQuery.dialect, parameterCount: state.compiledQuery.params.length },
      };
    }),
    {
      name: "sql_compiler_tool",
      description: "Compile the validated plan into parameterized SQL. The model never writes or edits SQL directly.",
      schema: z.object({}),
    },
  );

  const executeTool = createTool(
    async () => runRecordedTool(state, "db_execute_tool", async (attempt) => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.compiledQuery || state.compiledPlanVersion !== state.planVersion) {
        return { ok: false, detail: "No compiler-produced SQL exists for the current plan.", next: "sql_compiler_tool", retryable: true };
      }
      const maxAttempts = positiveIntEnv("ANALYTICS_DB_MAX_ATTEMPTS", 2);
      if (attempt > maxAttempts) {
        return { ok: false, detail: `Database execution attempt limit of ${maxAttempts} exceeded.`, terminal: true };
      }
      try {
        const result = await state.adapter.execute(state.compiledQuery);
        state.data = { rowCount: result.rowCount, rows: result.rows.slice(0, MAX_QUERY_LIMIT) };
        state.qualityChecked = false;
        state.lastFeedback = undefined;
        return {
          ok: true,
          detail: `Database returned ${state.data.rowCount} row(s).`,
          next: "result_quality_tool",
          summary: { rowCount: state.data.rowCount },
        };
      } catch (error) {
        const message = sanitizeDbError(error);
        state.lastFeedback = `Database execution failed: ${message}`;
        state.lastError = message;
        return { ok: false, status: "warning", detail: state.lastFeedback, next: "planner_tool", retryable: attempt < maxAttempts };
      }
    }),
    {
      name: "db_execute_tool",
      description: "Execute only the parameterized SQL produced by sql_compiler_tool against the live database.",
      schema: z.object({}),
    },
  );

  const qualityTool = createTool(
    async () => runRecordedTool(state, "result_quality_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.validatedPlan || !state.compiledQuery || !state.data) {
        return { ok: false, detail: "Validated plan, compiled SQL, and database data are required.", next: state.data ? "result_quality_tool" : "db_execute_tool", retryable: true };
      }
      const quality = evaluateGroupedResultQuality(state.validatedPlan, state.data.rows);
      state.qualityChecked = true;
      if (quality?.severity === "blocking") {
        state.terminalResponse = buildDataQualityIssueResponse(
          state.question,
          state.profile === "kpi" ? "certified-kpi" : "autonomous-ai",
          state.matchedKpi?.name,
          state.validatedPlan,
          state.compiledQuery,
          state.data,
          state.corrections,
          quality,
          [],
        );
        return { ok: true, status: "warning", detail: quality.message, terminal: true };
      }
      if (quality?.severity === "warning") {
        addCorrection(state, quality.message);
        return { ok: true, status: "warning", detail: quality.message, next: "insight_builder_tool" };
      }
      return { ok: true, detail: "Result quality checks passed.", next: "insight_builder_tool" };
    }),
    {
      name: "result_quality_tool",
      description: "Check grouped results for blank or misleading dimensions before charts and insights are generated.",
      schema: z.object({}),
    },
  );

  const insightTool = createTool(
    async () => runRecordedTool(state, "insight_builder_tool", async () => {
      const terminal = blockedByTerminal(state);
      if (terminal) return terminal;
      if (!state.qualityChecked || !state.validatedPlan || !state.compiledQuery || !state.data) {
        return { ok: false, detail: "Result quality must be checked before building insight.", next: "result_quality_tool", retryable: true };
      }
      const result: QueryResult = {
        dataset: state.validatedPlan.datasets[0],
        metric: state.validatedPlan.metric || "",
        sql: state.compiledQuery.sql,
        rowCount: state.data.rowCount,
        rows: state.data.rows,
      };
      const built = buildInsight(state.validatedPlan, result, state.catalog);
      const visibleCorrections = state.corrections.filter((correction) => correction.startsWith("Interpreted date "));
      if (visibleCorrections.length > 0 && built.insight && typeof built.insight === "object") {
        const insight = built.insight as { answer?: unknown };
        if (typeof insight.answer === "string") insight.answer = `${visibleCorrections.join(" ")}\n\n${insight.answer}`;
      }
      state.insight = built.insight;
      state.chart = built.chart;
      if (state.validatedPlan.limit && state.data.rowCount === state.validatedPlan.limit) {
        addCorrection(state, `The query returned exactly ${state.data.rowCount} rows, which matches the query limit of ${state.validatedPlan.limit}. Some data points may have been clipped/omitted.`);
      }
      return { ok: true, detail: "Insight and chart recommendation created.", terminal: true };
    }),
    {
      name: "insight_builder_tool",
      description: "Build the final business answer and chart recommendation from quality-checked data.",
      schema: z.object({}),
    },
  );

  return [classifierTool, guardTool, plannerTool, validatorTool, compilerTool, executeTool, qualityTool, insightTool];
}

type OrchestratorMode = "deterministic" | "agent";

// Which strategy advances the tool workflow:
//   "deterministic" (default) — the LLM planner is the mandatory semantic
//     entry, then backend code follows each tool's structured `next` pointer.
//     A clean request makes one LLM call. Reliable and quota-efficient.
//   "agent" — a LangGraph ReAct agent (an LLM) chooses which tool to call
//     next each turn (~1 LLM call per tool, ~8 per request). More autonomous
//     but slower and heavier on provider quota.
// Both share the same tools, guards, per-run queue, and deterministic response
// assembly — only WHO picks the next tool differs.
export function resolveOrchestratorMode(): OrchestratorMode {
  const configuredMode = String(
    process.env.ANALYTICS_ORCHESTRATOR_MODE || "deterministic",
  )
    .trim()
    .toLowerCase();

  if (configuredMode === "deterministic" || configuredMode === "agent") {
    return configuredMode;
  }

  throw new Error(
    `Invalid ANALYTICS_ORCHESTRATOR_MODE '${configuredMode}'. Expected 'deterministic' or 'agent'.`,
  );
}

// Deterministic orchestration: a plain backend loop that calls the first tool,
// then follows each tool's authoritative `next`/retryable/terminal result to
// the next tool. Mirrors the agent mode's tool order exactly (query_classifier_tool
// -> pre_query_guard_tool -> planner_tool -> ...); only WHO picks "next" differs
// (backend code here vs. an LLM in agent mode).
async function runDeterministicOrchestrator(tools: any[], state: AnalyticsRunState): Promise<void> {
  const toolsByName = new Map<string, any>(tools.map((analyticsTool) => [analyticsTool.name, analyticsTool]));
  // Start at query_classifier_tool (not planner_tool) so its trace entry and
  // pre_query_guard_tool's both always appear in the execution trace returned
  // to the client, instead of only being run inline as planner_tool fallbacks.
  let nextToolName: string | undefined = "query_classifier_tool";

  while (nextToolName && !state.terminalResponse && !(state.qualityChecked && state.insight !== undefined)) {
    const analyticsTool = toolsByName.get(nextToolName);
    if (!analyticsTool) {
      state.lastError = `The orchestrator requested an unknown tool: ${nextToolName}.`;
      break;
    }

    const rawOutcome = await analyticsTool.invoke({});
    const outcome = typeof rawOutcome === "string"
      ? JSON.parse(rawOutcome) as ToolOutcome
      : rawOutcome as ToolOutcome;

    if (outcome.terminal) break;
    if (!outcome.ok && !outcome.retryable) {
      state.lastError = outcome.detail;
      break;
    }
    if (!outcome.next) {
      state.lastError = `The ${nextToolName} tool did not identify the next analytics action.`;
      break;
    }
    nextToolName = outcome.next;
  }
}

function applyWeakKpiMatchNote(state: AnalyticsRunState): void {
  const weakMatch = state.classification?.weakMatch;
  if (!weakMatch || !state.insight || typeof state.insight !== "object") return;
  const note = `Matched the "${weakMatch}" KPI based on that single keyword in your question. If this isn't what you meant, rephrase or name the table/metric explicitly.`;
  addCorrection(state, note);
  const insight = state.insight as { answer?: unknown };
  if (typeof insight.answer === "string" && !insight.answer.includes(note)) {
    insight.answer = `_${note}_\n\n${insight.answer}`;
  }
}

function finalizeResponse(state: AnalyticsRunState): AnalyticsResponse {
  if (state.terminalResponse) {
    return { executionId: state.executionId, ...state.terminalResponse, trace: state.trace };
  }
  if (
    state.profile && state.validatedPlan && state.compiledQuery && state.data
    && state.qualityChecked && state.insight !== undefined
  ) {
    applyWeakKpiMatchNote(state);
    return {
      success: true,
      executionId: state.executionId,
      question: state.question,
      mode: state.profile === "kpi" ? "certified-kpi" : "autonomous-ai",
      ...(state.matchedKpi && { kpiUsed: state.matchedKpi.name }),
      appliedCorrections: state.corrections,
      plan: state.validatedPlan,
      semanticMatch: state.validatedPlan,
      sql: state.compiledQuery,
      data: state.data,
      insight: state.insight,
      chart: state.chart ?? null,
      trace: state.trace,
    };
  }

  const message = state.lastError || state.lastFeedback || "The orchestrator stopped before all required analytics tools completed.";
  if (state.profile === "kpi") {
    const recoveryGuidance = getErrorRecoveryGuidance(message);
    return {
      success: false,
      executionId: state.executionId,
      mode: "certified-kpi",
      question: state.question,
      friendlyError: message,
      error: message,
      appliedCorrections: state.corrections,
      insight: {
        answer: `Analytics AI was unable to complete your KPI query.\n\nReason: ${message}\n\n${recoveryGuidance}`,
        drivers: [],
        followUps: ["Show available KPIs"],
      },
      chart: null,
      data: emptyData(),
      sql: state.compiledQuery || { dialect: state.adapter.dialect, sql: "-- KPI query failed", params: [] },
      trace: state.trace.length ? state.trace : [{ step: "analytics_orchestrator", status: "error", detail: message }],
    };
  }
  return {
    executionId: state.executionId,
    ...getResilientErrorResponse("autonomous-ai", state.question, message, state.trace, state.corrections),
  };
}

export async function runAnalyticsOrchestrator(input: AnalyticsOrchestratorInput): Promise<AnalyticsResponse> {
  const state: AnalyticsRunState = {
    executionId: crypto.randomUUID(),
    question: input.question,
    catalog: JSON.parse(JSON.stringify(input.catalog)) as AiDatasetDefinition[],
    adapter: input.adapter,
    kpiMetrics: input.kpiMetrics || [],
    requestPlanFilters: toQueryPlanFilters(input.requestFilters || []),
    conversationContext: input.conversationContext,
    requestedMode: input.requestedMode || "auto",
    connectionName: input.connectionName || "the selected connection",
    guardPassed: false,
    dateNotes: [],
    planVersion: 0,
    qualityChecked: false,
    corrections: [],
    trace: [],
    attempts: {},
    totalToolCalls: 0,
    toolQueue: Promise.resolve(),
  };

  try {
    const tools = createAnalyticsTools(state);
    // Both modes share the same tools, prerequisite guards, per-run queue, and
    // deterministic response assembly — only WHO picks the next tool differs.
    // See resolveOrchestratorMode() for the trade-off. Default: "deterministic".
    if (resolveOrchestratorMode() === "agent") {
      // Agent-driven: a LangGraph ReAct agent (an LLM) decides which analytics
      // tool to call next, guided by each tool's structured result. The tools
      // still enforce prerequisites/ordering over shared backend-owned state,
      // so the agent can never run SQL out of order or fabricate results.
      const agent = createReactAgent({
        llm: getLlmModel(),
        tools,
        messageModifier: `You are the Analytics AI tool orchestrator. You control execution by calling tools; never write SQL or fabricate tool results.

Required initial actions:
0. Emit exactly ONE tool call per assistant turn. Never request multiple tools in the same response.
1. Call query_classifier_tool first.
2. If it is not terminal, call pre_query_guard_tool.
3. If the guard passes, call planner_tool, validator_tool, sql_compiler_tool, db_execute_tool, result_quality_tool, and insight_builder_tool as their prerequisites become available.

Recovery rules:
- Follow each tool's "next" recommendation.
- If validator_tool, sql_compiler_tool, or db_execute_tool returns retryable feedback, call planner_tool to create a revised plan, then validate and compile it again.
- Never call db_execute_tool before validator_tool and sql_compiler_tool succeed.
- If any tool returns terminal=true, stop calling tools and finish.
- Do not repeat a successful tool unless a later failure requires a new plan.
- Tool attempts and total calls are bounded by the backend. Do not loop.

Your final text is only a completion signal; the backend deterministically assembles the API response from authoritative tool state.`,
      });
      await withLlmUsageContext(
        { stage: "orchestrator_agent" },
        () => agent.invoke(
          { messages: [{ role: "user", content: input.question }] },
          { recursionLimit: positiveIntEnv("ANALYTICS_ORCHESTRATOR_RECURSION_LIMIT", 30) },
        ),
      );
    } else {
      // Deterministic (default): backend code follows each tool's `next`
      // pointer. Only the planner spends an LLM call — reliable + quota-efficient.
      await runDeterministicOrchestrator(tools, state);
    }
  } catch (error) {
    state.lastError = getFriendlyErrorMessage(error);
    if (!state.terminalResponse && state.insight === undefined) {
      state.trace.push({
        step: "analytics_orchestrator",
        status: "error",
        detail: state.lastError,
        attempt: 1,
        durationMs: 0,
      });
    }
  }

  return finalizeResponse(state);
}
