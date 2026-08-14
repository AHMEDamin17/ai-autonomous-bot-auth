import { QueryResult } from "../../../types/types";
import { QueryPlan } from "../../planner";
import { TraceEntry } from "./responseBuilders";

export type GroupedResultQuality =
  | { severity: "blocking"; errorCode: "GROUP_BY_VALUE_UNAVAILABLE"; groupLabel: string; message: string }
  | { severity: "warning"; groupLabel: string; message: string };

export function formatGroupLabel(plan: QueryPlan): string {
  if (plan.timeGrainColumn) {
    const column = plan.timeGrainColumn.split(".").pop() || plan.timeGrainColumn;
    return plan.timeGrain ? `${column} (${plan.timeGrain})` : column;
  }
  const groupBy = Array.isArray(plan.groupBy) ? plan.groupBy.join(", ") : plan.groupBy;
  if (!groupBy) return "requested field";
  return groupBy
    .split(",")
    .map((part) => part.trim().split(".").pop() || part.trim())
    .join(", ");
}

export function getGroupedRowKey(row: QueryResult["rows"][number]): unknown {
  const record = row as unknown as Record<string, unknown>;
  if ("key" in record) return record.key;
  if ("time_key" in record) return record.time_key;
  if ("group_key" in record) return record.group_key;
  const keyField = Object.keys(record).find((key) => key === "time_key" || key.startsWith("group_key"));
  return keyField ? record[keyField] : undefined;
}

export function isMissingGroupValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "" || normalized === "unspecified" || normalized === "undefined" || normalized === "null" || normalized === "-" || normalized === "—";
}

export function evaluateGroupedResultQuality(plan: QueryPlan, rows: QueryResult["rows"]): GroupedResultQuality | null {
  const hasGrouping = !!plan.groupBy || !!plan.timeGrainColumn;
  if (!hasGrouping || rows.length === 0) return null;

  const groupLabel = formatGroupLabel(plan);
  const missingRows = rows.filter((row) => isMissingGroupValue(getGroupedRowKey(row))).length;
  if (missingRows === 0) return null;

  if (missingRows === rows.length) {
    return {
      severity: "blocking",
      errorCode: "GROUP_BY_VALUE_UNAVAILABLE",
      groupLabel,
      message: `I could not break this down by ${groupLabel} because every returned group value is blank or null. No chart was generated because that would present missing source data as a real category.`,
    };
  }

  return {
    severity: "warning",
    groupLabel,
    message: `${missingRows} of ${rows.length} returned ${groupLabel} group(s) are blank or null and are shown as Unspecified.`,
  };
}

export function buildDataQualityIssueResponse(
  question: string,
  mode: string,
  kpiUsed: string | undefined,
  plan: QueryPlan,
  compiledQuery: any,
  data: { rowCount: number; rows: QueryResult["rows"] },
  corrections: string[],
  quality: Extract<GroupedResultQuality, { severity: "blocking" }>,
  trace: TraceEntry[],
) {
  return {
    success: false,
    mode: "data_quality_issue",
    errorCode: quality.errorCode,
    question,
    kpiUsed,
    appliedCorrections: corrections,
    plan,
    semanticMatch: plan,
    sql: compiledQuery,
    data,
    quality: {
      groupBy: quality.groupLabel,
      message: quality.message,
    },
    insight: {
      answer: quality.message,
      drivers: [`Requested group-by field: ${quality.groupLabel}.`, "All matching rows have no usable value for that group-by field."],
      followUps: kpiUsed ? [
        `Show monthly trend of ${kpiUsed}`,
        `Calculate ${kpiUsed}`,
      ] : [],
    },
    chart: null,
    trace,
  };
}
