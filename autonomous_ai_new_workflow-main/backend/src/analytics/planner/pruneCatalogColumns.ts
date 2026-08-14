import type {
  AiDatasetDefinition,
  GlobalAiKpi,
} from "../../types/types";
import { isEntityDisplayCandidateColumn } from "../pipelines/simple/entityProjection";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Safe defaults so a fresh deployment prunes wide tables out of the box; tune
// via ANALYTICS_CATALOG_PRUNE_THRESHOLD / ANALYTICS_CATALOG_PRUNE_MAX_COLUMNS.
const DEFAULT_WIDTH_THRESHOLD = positiveIntegerEnv(
  "ANALYTICS_CATALOG_PRUNE_THRESHOLD",
  60,
);
const DEFAULT_MAX_COLUMNS = positiveIntegerEnv(
  "ANALYTICS_CATALOG_PRUNE_MAX_COLUMNS",
  40,
);
const TOKEN_PATTERN = /[A-Za-z_][A-Za-z0-9_$]*/g;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "show",
  "the",
  "to",
  "what",
  "which",
  "with",
]);

function normalizedTokens(value: unknown): Set<string> {
  const tokens = String(value || "").match(TOKEN_PATTERN) || [];
  return new Set(
    tokens
      .map((token) => token.toLowerCase())
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function addReferenceTokens(target: Set<string>, value: unknown): void {
  for (const token of normalizedTokens(value)) {
    target.add(token);
  }
}

function addFilterReferences(target: Set<string>, node: any): void {
  if (!node || typeof node !== "object") return;
  if (typeof node.field === "string") addReferenceTokens(target, node.field);
  if (Array.isArray(node.children)) {
    node.children.forEach((child: unknown) => addFilterReferences(target, child));
  }
}

function addKpiReferences(
  target: Set<string>,
  kpi: GlobalAiKpi | undefined,
): void {
  if (!kpi) return;
  addReferenceTokens(target, kpi.expressionSql);
  kpi.dimensions?.forEach((value) => addReferenceTokens(target, value));
  kpi.kpi_dimensions?.forEach((value) => addReferenceTokens(target, value));
  kpi.select_columns?.forEach((value) => addReferenceTokens(target, value));
  kpi.join_spec?.forEach((join) => {
    addReferenceTokens(target, join.leftColumn);
    addReferenceTokens(target, join.rightColumn);
    join.conditions?.forEach((condition) => {
      addReferenceTokens(target, condition.leftColumn);
      addReferenceTokens(target, condition.rightColumn);
    });
  });
  addFilterReferences(target, kpi.filter_logic);
}

function columnOverlapsQuestion(
  columnName: string,
  questionTokens: Set<string>,
): boolean {
  const columnTokens = normalizedTokens(columnName);
  for (const token of columnTokens) {
    if (questionTokens.has(token)) return true;
    for (const questionToken of questionTokens) {
      if (
        token.length >= 4
        && questionToken.length >= 4
        && (token.includes(questionToken) || questionToken.includes(token))
      ) {
        return true;
      }
    }
  }
  return false;
}

export interface PruneCatalogOptions {
  widthThreshold?: number;
  maxColumns?: number;
  allKpis?: GlobalAiKpi[];
}

export function pruneCatalogColumns(
  catalog: AiDatasetDefinition[],
  question: string,
  matchedKpi?: GlobalAiKpi,
  options: PruneCatalogOptions = {},
): AiDatasetDefinition[] {
  const widthThreshold = options.widthThreshold ?? DEFAULT_WIDTH_THRESHOLD;
  const maxColumns = options.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const questionTokens = normalizedTokens(question);
  const protectedReferences = new Set<string>();
  addKpiReferences(protectedReferences, matchedKpi);
  options.allKpis?.forEach((kpi) => addKpiReferences(protectedReferences, kpi));

  for (const dataset of catalog) {
    dataset.metrics?.forEach((metric) => {
      addReferenceTokens(protectedReferences, metric.expressionSql);
      metric.dimensions?.forEach((value) =>
        addReferenceTokens(protectedReferences, value));
      metric.select_columns?.forEach((value) =>
        addReferenceTokens(protectedReferences, value));
      addFilterReferences(protectedReferences, metric.filter_logic);
      metric.join_spec?.forEach((join) => {
        addReferenceTokens(protectedReferences, join.leftColumn);
        addReferenceTokens(protectedReferences, join.rightColumn);
      });
    });
    dataset.relationships?.forEach((relationship) => {
      addReferenceTokens(protectedReferences, relationship.sourceColumn);
      addReferenceTokens(protectedReferences, relationship.targetColumn);
    });
  }

  return catalog.map((dataset) => {
    if (dataset.columns.length < widthThreshold) return dataset;

    const required = dataset.columns.filter((column) => (
      column.isPrimaryKey
      || isEntityDisplayCandidateColumn(column)
      || protectedReferences.has(column.name.toLowerCase())
      || columnOverlapsQuestion(column.name, questionTokens)
    ));
    const requiredNames = new Set(required.map((column) => column.name));
    const remainingSlots = Math.max(0, maxColumns - required.length);
    const deterministicFallback = dataset.columns
      .filter((column) => !requiredNames.has(column.name))
      .slice(0, remainingSlots);
    const keptNames = new Set(
      [...required, ...deterministicFallback].map((column) => column.name),
    );

    return {
      ...dataset,
      columns: dataset.columns.filter((column) => keptNames.has(column.name)),
    };
  });
}
