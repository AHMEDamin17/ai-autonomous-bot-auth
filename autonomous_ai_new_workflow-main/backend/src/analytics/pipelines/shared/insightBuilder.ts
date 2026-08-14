import { AiDatasetDefinition, AiDatasetMetric } from "../../../routes/semanticLayer/semanticCatalog";
import { QueryPlan } from "../../planner";
import { QueryResult } from "../../../types/types";

// Resolves a qualified "dataset.column" dimension ref (as stored on a KPI's
// `dimensions` allowlist) to its catalog column definition, so callers can
// check the column's real type instead of guessing from its name.
function resolveDimensionColumn(
  dimRef: string,
  catalog: AiDatasetDefinition[],
): { column: string; type: string } | null {
  const lastDot = dimRef.lastIndexOf(".");
  if (lastDot < 0) return null;
  const datasetName = dimRef.slice(0, lastDot);
  const columnName = dimRef.slice(lastDot + 1);
  const dataset = catalog.find((d) => d.name === datasetName);
  const column = dataset?.columns.find((c) => c.name === columnName);
  return column ? { column: columnName, type: column.type } : null;
}

// "u_gsc_region" -> "region", "u_gsc_service_line" -> "service line". Strips
// the ServiceNow custom-field namespace prefix so suggested follow-ups read
// like a business term instead of a raw column identifier.
function humanizeDimensionName(columnName: string): string {
  return columnName.replace(/^u_gsc_/i, "").replace(/^u_/i, "").replace(/_/g, " ");
}

function identifierKey(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function columnLeaf(value: string | null | undefined): string {
  const normalized = String(value || "");
  return (normalized.includes(".") ? normalized.split(".").pop()! : normalized).toLowerCase();
}

function resolveMetricDefinition(
  plan: QueryPlan,
  catalog: AiDatasetDefinition[],
): AiDatasetMetric | undefined {
  const metricKey = identifierKey(plan.metric);
  if (!metricKey) return undefined;

  // Single-table KPI metrics live on their physical dataset, while multi-table
  // KPI metrics live on the virtual global_kpis dataset. A validated KPI plan
  // lists the involved physical datasets, so searching only datasets[0] misses
  // every cross-table certified KPI.
  const preferredDatasets = [
    ...(plan.datasets || []).map((name) => catalog.find((dataset) => dataset.name === name)),
    catalog.find((dataset) => dataset.name === "global_kpis"),
    ...catalog,
  ].filter((dataset): dataset is AiDatasetDefinition => Boolean(dataset));
  const seen = new Set<string>();
  for (const dataset of preferredDatasets) {
    if (seen.has(dataset.name)) continue;
    seen.add(dataset.name);
    const metric = (dataset.metrics || []).find(
      (candidate) => (
        identifierKey(candidate.name) === metricKey
        || identifierKey(candidate.label) === metricKey
      ),
    );
    if (metric) return metric;
  }
  return undefined;
}

function timeGrainAdjective(timeGrain: unknown): string {
  const value = String(timeGrain || "").toLowerCase();
  const adjectives: Record<string, string> = {
    day: "daily",
    week: "weekly",
    month: "monthly",
    quarter: "quarterly",
    year: "yearly",
  };
  return adjectives[value] || "time-based";
}

function entityListLabel(plan: QueryPlan, catalog?: AiDatasetDefinition[]): string | null {
  if (!plan.select_columns?.length || !catalog?.length) return null;
  const dataset = catalog.find((candidate) => plan.datasets.includes(candidate.name));
  if (!dataset) return null;
  const tokens = String(dataset.label || dataset.name)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const subject = tokens[tokens.length - 1];
  if (!subject) return null;
  if (subject.endsWith("s")) return subject;
  if (subject.endsWith("y") && !/[aeiou]y$/.test(subject)) return `${subject.slice(0, -1)}ies`;
  return `${subject}s`;
}

function singularEntityLabel(label: string): string {
  if (label.endsWith("ies")) return `${label.slice(0, -3)}y`;
  return label.replace(/s$/, "");
}

function buildInsight(plan: QueryPlan, result: QueryResult, catalog?: AiDatasetDefinition[]) {
  const topRow = result.rows?.[0];
  const rowsCount = result.rowCount || 0;
  let rawGroup = Array.isArray(plan.groupBy) ? plan.groupBy.join(" and ") : (plan.groupBy || "");
  let groupStr = rawGroup.split(" and ").map(g => g.includes(".") ? g.split(".").pop()! : g).join(" and ");
  if (plan.timeGrainColumn) {
    const timeCol = plan.timeGrainColumn.includes(".") ? plan.timeGrainColumn.split(".").pop()! : plan.timeGrainColumn;
    const timeLabel = plan.timeGrain ? `${timeCol} by ${plan.timeGrain}` : timeCol;
    groupStr = groupStr ? `${groupStr} and ${timeLabel}` : timeLabel;
  }

  const hasValue = (v: unknown): v is number | string => v !== null && v !== undefined;
  const formatValue = (v: unknown): string => (hasValue(v) ? Number(v).toLocaleString() : "No data");

  const values = result.rows.map(r => Number(r.value));
  const allSame =
    values.length > 1 &&
    values.every(v => v === values[0]);

  // plan.metric === "" means this is a plain list/lookup, not a real
  // aggregate. A chart of those raw values carries no information; the same
  // is true for an aggregate whose values are all identical.
  const isPlainListQuery = !plan.metric;
  const entityLabel = entityListLabel(plan, catalog);
  const isEntityListing = Boolean(entityLabel);
  const groupStrLower = groupStr.toLowerCase();
  const chart =
    isPlainListQuery || (allSame && !!groupStr)
      ? null
      : groupStrLower.includes("date") || groupStrLower.includes("time") || !!plan.timeGrainColumn
        ? { type: "line" as const, x: "key", y: "value" }
        : groupStr
          ? { type: "bar" as const, x: "key", y: "value" }
          : { type: "scorecard" as const, y: "value" };

  let answer = "";

  let kpiContext = "";
  let metricDef: AiDatasetMetric | undefined;
  if (catalog && catalog.length > 0) {
    metricDef = resolveMetricDefinition(plan, catalog);

    if (metricDef) {
      // It's a KPI metric. Provide context for the summary.
      kpiContext = `Based on the ${metricDef.label || String(plan.metric).replace(/_/g, " ")} KPI. `;
    }
  }

  // plan.metric is "" for a plain list/lookup query (no aggregate requested)
  // — falling back to a generic phrase avoids interpolating an empty string
  // into the answer text (e.g. "Here is the  grouped by name.").
  const metricPhrase = plan.metric ? String(plan.metric).replace(/_/g, " ") : "value";
  const hasTimeGrouping = Boolean(plan.timeGrainColumn);
  const groupedAnswerLead = hasTimeGrouping
    ? `Here is the ${timeGrainAdjective(plan.timeGrain)} trend of ${metricPhrase}`
    : `Here is the ${metricPhrase} by the requested business dimension`;

  // Plain listings (no aggregate) return raw records without a synthetic
  // `value` column, so the missing-value check below would misreport a
  // populated result as "No data found".
  const isPlainListing = isPlainListQuery;
  if (rowsCount === 0 || (!groupStr && !isPlainListing && !hasValue(topRow?.value))) {
    answer = `${kpiContext}No data found for ${metricPhrase} for this request.`;
  } else if (isPlainListing) {
    if (entityLabel) {
      const displayLabel = rowsCount === 1
        ? singularEntityLabel(entityLabel)
        : entityLabel;
      answer = `${kpiContext}Returned ${rowsCount} ${displayLabel}.`;
    } else {
      const itemLabel = groupStr ? "business value" : "business record";
      answer = `${kpiContext}Returned ${rowsCount} ${itemLabel}${rowsCount === 1 ? "" : "s"}.`;
    }
  } else if (!groupStr) {
    answer = `${kpiContext}The ${metricPhrase} is ${formatValue(topRow?.value)}.`;
  } else if (allSame) {
    answer = `${kpiContext}${groupedAnswerLead}. The values are evenly distributed across all groups, with ${formatValue(values[0])} recorded for each group.`;
  } else if (topRow?.key) {
    if (result.rows.length <= 10 && result.rows.length > 1) {
      const details = result.rows.map(r => `- **${r.key ?? "Unspecified"}**: ${formatValue(r.value)}`).join("\n");
      answer = `${kpiContext}${groupedAnswerLead}:\n${details}`;
    } else {
      const extStr = plan.sortDir === "asc" ? "lowest" : "highest";
      answer = `${kpiContext}${groupedAnswerLead}. The ${extStr} value is "${topRow.key ?? "Unspecified"}" at ${formatValue(topRow.value)}.`;
    }
  } else {
    answer = `${kpiContext}${groupedAnswerLead}.`;
  }

  const drivers =
    rowsCount === 0
      ? ["No matching data for this request."]
      : isPlainListing
        ? [
            isEntityListing
              ? `Catalog-approved ${singularEntityLabel(entityLabel!)} fields listed without aggregation.`
              : "Business values listed without aggregation.",
            ...(plan.assumptions || []),
          ]
        : groupStr
          ? [
              hasTimeGrouping
                ? `Results are grouped by ${String(plan.timeGrain || "time period").toLowerCase()}.`
                : "Results are grouped by the requested business dimension.",
            ]
          : ["Single metric scorecard result.", ...(plan.assumptions || [])];

  const followUps: string[] = [];
  const metricLabel = plan.metric ? String(plan.metric).replace(/_/g, " ").toLowerCase() : "value";

  const groupByList = Array.isArray(plan.groupBy) ? plan.groupBy : plan.groupBy ? [plan.groupBy] : [];
  const usedGroupByColumns = new Set(
    groupByList.map((g) => (g.includes(".") ? g.split(".").pop()! : g).toLowerCase()),
  );

  if (isPlainListing) {
    followUps.push("Show a KPI result");
  } else if (metricDef) {
    // Certified KPI: `metricDef.dimensions` is the same enforced group-by
    // allowlist resolveMatchedKpiPlanDimensions() validates against — the only
    // things this KPI can actually be broken down by. Only ever suggest a
    // real, unused, configured dimension by name; never a vague placeholder
    // the planner has no way to resolve (a bare column list on the raw
    // physical table is not the same thing and produced false suggestions).
    const configuredDims = metricDef.dimensions || [];
    const unusedDims = catalog
      ? configuredDims
          .map((dimRef) => resolveDimensionColumn(dimRef, catalog))
          .filter((resolved): resolved is { column: string; type: string } =>
            !!resolved && !usedGroupByColumns.has(resolved.column.toLowerCase()),
          )
      : [];

    const dateDim = unusedDims.find((dim) => dim.type === "date");
    if (dateDim && columnLeaf(plan.timeGrainColumn) !== dateDim.column.toLowerCase()) {
      followUps.push(`Show me the monthly trend of ${metricLabel}`);
    }

    const otherDim = unusedDims.find((dim) => dim.type !== "date");
    if (otherDim) {
      followUps.push(`Break down ${metricLabel} by ${humanizeDimensionName(otherDim.column)}`);
    }
    // No fallback here on purpose: if this KPI has no configured dimension
    // left unused, there is nothing valid to suggest breaking down by.
  } else if (catalog && catalog.length > 0) {
    // Simple/non-KPI query: there is no configured dimension allowlist, so
    // fall back to the broader catalog-column heuristic.
    const matchedDataset = catalog.find(d => d.name === plan.datasets[0]) || catalog[0];
    if (matchedDataset) {
      const hasDateCol = matchedDataset.columns.some(c => c.name.toLowerCase().includes("date") || c.name.toLowerCase().includes("time") || c.type === "date");
      if (hasDateCol) {
        followUps.push(`Show me the monthly trend of ${metricLabel}`);
      }
      const hasAnotherBusinessDimension = matchedDataset.columns.some(
        c => c.allowedForGrouping && (!plan.groupBy || !plan.groupBy.includes(c.name)),
      );
      if (hasAnotherBusinessDimension) followUps.push(`Break down ${metricLabel} by a business dimension`);
    }
  }

  if (followUps.length === 0 && !metricDef) {
    followUps.push(`Break down ${metricLabel} by a business dimension`);
  }

  return { insight: { answer, drivers, followUps }, chart };
}
export { buildInsight };
