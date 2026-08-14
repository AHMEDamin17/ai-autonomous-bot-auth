export const MAX_QUERY_LIMIT = Number(process.env.MAX_QUERY_LIMIT) || 100;
import { AiDatasetDefinition } from "../../routes/semanticLayer/semanticCatalog";
import { QueryPlan } from "../planner";
import { resolveColumnAcrossDatasets, resolveMetricAcrossDatasets, getDynamicDataset } from "../utils/resolvers";
import { validateSqlExpression } from "../../utils/sqlValidator";
import { JoinSpec } from "../../types/types";
import { getJoinConditions, normalizeJoinConditions } from "../utils/joinSpecs";

type MutableQueryPlan = Partial<QueryPlan> & {
  datasets: string[];
  joins: JoinSpec[];
  metric: string;
};

type RawPlanRecord = Record<string, unknown>;

function asRecord(value: unknown): RawPlanRecord {
  return value && typeof value === "object" ? value as RawPlanRecord : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeFilterValue(value: unknown): string | string[] | { start: string; end: string } {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  const obj = asRecord(value);
  if (typeof obj.start === "string" && typeof obj.end === "string") {
    return { start: obj.start, end: obj.end };
  }
  return "";
}

function isDateLikeColumnType(type: unknown): boolean {
  const normalized = String(type || "").toLowerCase();
  return normalized.includes("date") || normalized.includes("time") || normalized.includes("timestamp");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function getDateInputOrder(): "MDY" | "DMY" {
  return String(process.env.DATE_INPUT_ORDER || "MDY").trim().toUpperCase() === "DMY" ? "DMY" : "MDY";
}

function dateOrderFormat(order = getDateInputOrder()): string {
  return order === "DMY" ? "DD-MM-YYYY" : "MM-DD-YYYY";
}

function isLocalDateInput(value: unknown): value is string {
  return typeof value === "string" && /^\s*\d{1,2}[-/]\d{1,2}[-/]\d{4}\s*$/.test(value);
}

function getLocalDateAmbiguity(value: string): { mdyIso: string; dmyIso: string } | null {
  const localMatch = value.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!localMatch) return null;
  const first = Number(localMatch[1]);
  const second = Number(localMatch[2]);
  const year = Number(localMatch[3]);
  if (first === second) return null;
  if (!isValidDateParts(year, first, second) || !isValidDateParts(year, second, first)) return null;
  return {
    mdyIso: `${year}-${pad2(first)}-${pad2(second)}`,
    dmyIso: `${year}-${pad2(second)}-${pad2(first)}`,
  };
}

function localDateInputIssue(value: string): string {
  const ambiguity = getLocalDateAmbiguity(value);
  if (ambiguity) {
    return `Ambiguous date '${value}'. It can mean ${ambiguity.mdyIso} in MDY order or ${ambiguity.dmyIso} in DMY order. Please use ISO YYYY-MM-DD or clarify the intended date.`;
  }
  return `Invalid date '${value}' for ${getDateInputOrder()} order. Please write dates in ${dateOrderFormat()} order, or use ISO YYYY-MM-DD.`;
}

function parseDateOnlyInput(value: unknown): { iso: string; start: string; end: string; sourceFormat: "ISO" | "LOCAL" } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (!isValidDateParts(year, month, day)) return null;
    const iso = `${year}-${pad2(month)}-${pad2(day)}`;
    return { iso, start: `${iso} 00:00:00`, end: `${iso} 23:59:59`, sourceFormat: "ISO" };
  }

  const localMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!localMatch) return null;
  if (getLocalDateAmbiguity(trimmed)) return null;

  const first = Number(localMatch[1]);
  const second = Number(localMatch[2]);
  const year = Number(localMatch[3]);
  let day: number;
  let month: number;

  const order = getDateInputOrder();
  if (order === "MDY") {
    month = first;
    day = second;
  } else {
    day = first;
    month = second;
  }

  if (!isValidDateParts(year, month, day)) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  return { iso, start: `${iso} 00:00:00`, end: `${iso} 23:59:59`, sourceFormat: "LOCAL" };
}

function normalizeDateEqualityFilter(
  field: string,
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "between" | "relative",
  value: string | string[] | { start: string; end: string },
  datasets: string[],
  catalog: AiDatasetDefinition[],
): { filter: { field: string; op: "between"; value: { start: string; end: string } }; correction: string } | { issue: string } | null {
  if (op !== "eq" || typeof value !== "string" || !field) return null;

  let resolved;
  try {
    resolved = resolveColumnAcrossDatasets(field, datasets, catalog);
  } catch {
    return null;
  }
  if (!resolved || !isDateLikeColumnType(resolved.column.type)) return null;

  const range = parseDateOnlyInput(value);
  if (!range) {
    if (isLocalDateInput(value)) {
      return {
        issue: localDateInputIssue(value),
      };
    }
    return null;
  }

  return {
    filter: { field, op: "between", value: { start: range.start, end: range.end } },
    correction: range.sourceFormat === "LOCAL"
      ? `Interpreted date '${value}' as ${range.iso} using ${getDateInputOrder()} (${dateOrderFormat()}). Please write dates in ${dateOrderFormat()} order, or use ISO YYYY-MM-DD to avoid ambiguity. Converted '${field}' to full-day range '${range.start}' through '${range.end}'.`
      : `Converted date equality filter '${field} = ${value}' to full-day range '${range.start}' through '${range.end}'.`,
  };
}

function validatePlan(plan: QueryPlan, catalog: AiDatasetDefinition[]) {
  const issues: string[] = [];
  const dsNames = plan.datasets;

  // 1. Validate ALL datasets exist
  for (const dsName of dsNames) {
    const dataset = getDynamicDataset(dsName, catalog);
    if (!dataset) issues.push(`Dataset "${dsName}" is not in the semantic catalog.`);
  }

  // If plan has joins from KPI (kpi_defined), trust them - don't re-validate
  // The KPI join_spec was already validated at creation time
  // We only verify that the tables in joins are subset of plan.datasets
  if (plan.joins && plan.joins.length > 0) {
    for (const join of plan.joins) {
      if (!plan.datasets.includes(join.leftTable) || !plan.datasets.includes(join.rightTable)) {
        issues.push(`Join references table not in plan datasets: ${join.leftTable} / ${join.rightTable}`);
      }
    }
  }

  // V1: Multi-dataset plans MUST have joins
  if (plan.datasets.length > 1) {
    if (!plan.joins || plan.joins.length === 0) {
      issues.push(
        `Query references ${plan.datasets.length} datasets (${plan.datasets.join(", ")}) ` +
        `but provides no JOINs. Multi-dataset queries require explicit join specifications ` +
        `to connect the tables.`
      );
    }
    // Also check join count is sufficient (n datasets need at least n-1 joins)
    if (plan.joins && plan.joins.length < plan.datasets.length - 1) {
      issues.push(
        `Query has ${plan.datasets.length} datasets but only ${plan.joins.length} join(s). ` +
        `At least ${plan.datasets.length - 1} join(s) are needed to connect all datasets.`
      );
    }
  }

  // V2: Verify all datasets are connected via join chain
  if (plan.datasets.length > 1 && plan.joins && plan.joins.length > 0) {
    const dsSet = new Set(plan.datasets);
    const adjacency: Record<string, Set<string>> = {};
    for (const ds of plan.datasets) adjacency[ds] = new Set();

    for (const join of plan.joins) {
      const left = join.leftTable;
      const right = join.rightTable;
      if (left && right && dsSet.has(left) && dsSet.has(right)) {
        adjacency[left].add(right);
        adjacency[right].add(left);
      }
    }

    // BFS from first dataset
    const visited = new Set<string>();
    const queue = [plan.datasets[0]];
    visited.add(plan.datasets[0]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of (adjacency[current] || [])) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    const unreachable = plan.datasets.filter(d => !visited.has(d));
    if (unreachable.length > 0) {
      const describeRelationships = (cat: AiDatasetDefinition[], names: string[]) => {
        const parts: string[] = [];
        for (const name of names) {
          const ds = cat.find(d => d.name === name);
          if (ds?.relationships?.length) {
            for (const rel of ds.relationships) {
              if (names.includes(rel.targetDataset)) {
                parts.push(`${name}.${rel.sourceColumn} -> ${rel.targetDataset}.${rel.targetColumn}`);
              }
            }
          }
        }
        return parts.length > 0 ? parts.join("; ") : "none found in catalog";
      };
      issues.push(
        `Datasets [${unreachable.join(", ")}] are not reachable via the provided JOINs. ` +
        `All datasets must form a connected join chain. ` +
        `Available relationships: ${describeRelationships(catalog, plan.datasets)}`
      );
    }
  }

  // 2. Validate joins reference existing columns
  if (plan.joins) {
    for (const join of plan.joins) {
      for (const condition of getJoinConditions(join)) {
        const leftTable = condition.leftTable || join.leftTable;
        const rightTable = condition.rightTable || join.rightTable;
        const leftCol = resolveColumnAcrossDatasets(
          `${leftTable}.${condition.leftColumn}`, dsNames, catalog
        );
        if (!leftCol) issues.push(`A configured join condition is invalid.`);

        const rightCol = resolveColumnAcrossDatasets(
          `${rightTable}.${condition.rightColumn}`, dsNames, catalog
        );
        if (!rightCol) issues.push(`A configured join condition is invalid.`);
      }
    }
  }

  // 3. Validate metric exists in any of the datasets
  if (plan.metric) {
    const metricResult = resolveMetricAcrossDatasets(plan.metric, dsNames, catalog);
    if (!metricResult) {
      issues.push(`Metric "${plan.metric}" is not certified for any of the datasets: [${dsNames.join(", ")}].`);
    } else {
      const validation = validateSqlExpression(metricResult.metric.expressionSql);
      if (!validation.valid) {
        issues.push(`Metric formula contains potentially dangerous SQL: ${validation.error}`);
      }
    }
  }

  // V3: Helper to suggest columns
  const allDatasetColumns = new Map<string, string[]>();
  for (const dsName of plan.datasets) {
    const ds = catalog.find(d => d.name === dsName);
    if (ds) {
      allDatasetColumns.set(dsName, [
        ...(ds.columns || []).map(c => c.name.toLowerCase()),
        ...(ds.metrics || []).map(m => m.name.toLowerCase()),
      ]);
    }
  }

  const checkColumn = (col: string, context: string) => {
    const colLower = col.toLowerCase();
    const colNameOnly = colLower.includes('.') ? colLower.split('.').pop()! : colLower;
    const foundIn = plan.datasets.filter(ds =>
      allDatasetColumns.get(ds)?.includes(colNameOnly)
    );
    if (foundIn.length === 0) {
      const allCols = catalog.flatMap(d =>
        (d.columns || []).map(c => `${d.name}.${c.name}`)
      );
      const suggestions = allCols
        .filter(c => c.split('.')[1]?.toLowerCase().includes(colLower))
        .slice(0, 3);
      issues.push(
        `Column "${col}" used in ${context} was not found in any of the planned datasets ` +
        `[${plan.datasets.join(", ")}]. Did you mean: ${suggestions.join(", ") || "check available columns"}`
      );
    }
  };

  // 4. Validate groupBy columns (search across all datasets)
  if (plan.groupBy) {
    const groups = Array.isArray(plan.groupBy) ? plan.groupBy : [plan.groupBy];
    for (const group of groups) {
      checkColumn(group, "GROUP BY");
      const resolved = resolveColumnAcrossDatasets(group, dsNames, catalog);
      if (resolved && !resolved.column.allowedForGrouping) issues.push(`Column "${group}" is not allowed for grouping.`);
    }
  }

  // 4b. Validate raw projection columns.
  for (const column of plan.select_columns || []) {
    checkColumn(column, "SELECT");
  }

  // 5. Validate timeGrainColumn
  if (plan.timeGrainColumn) {
    checkColumn(plan.timeGrainColumn, "time grain");
    const resolved = resolveColumnAcrossDatasets(plan.timeGrainColumn, dsNames, catalog);
    if (resolved && !resolved.column.allowedForGrouping) issues.push(`Column "${plan.timeGrainColumn}" is not allowed for grouping.`);
  }

  // 6. Validate filter columns (search across all datasets)
  for (const f of plan.filters || []) {
    checkColumn(f.field, "filter");
    const resolved = resolveColumnAcrossDatasets(f.field, dsNames, catalog);
    if (resolved && !resolved.column.allowedForFiltering) {
      issues.push(`Column "${f.field}" is not allowed for filtering.`);
    }
  }

  return { passed: issues.length === 0, issues };
}

function sanitizeAndCorrectPlan(
  rawInput: unknown,
  catalog: AiDatasetDefinition[],
  options?: { allowDynamicMetrics?: boolean; requireExplicitProjection?: boolean }
): { plan: QueryPlan; corrections: string[]; issues: string[] } {
  const allowDynamicMetrics = options?.allowDynamicMetrics !== false;
  const corrections: string[] = [];
  const issues: string[] = [];
  const rawPlan = asRecord(rawInput);

  // Normalize nulls from LLM structured output
  const rawTimeGrain = rawPlan.timeGrain === null ? undefined : rawPlan.timeGrain;
  const rawTimeGrainColumn = rawPlan.timeGrainColumn === null ? undefined : rawPlan.timeGrainColumn;

  //  1. Normalize datasets (handle both old single "dataset" and new "datasets") 
  let datasets: string[] = [];
  if (Array.isArray(rawPlan.datasets) && rawPlan.datasets.length > 0) {
    datasets = stringArray(rawPlan.datasets);
  } else if (typeof rawPlan.dataset === "string" && rawPlan.dataset) {
    // Backward compat: LLM returned old single-dataset format
    datasets = [rawPlan.dataset];
  } else if (typeof rawPlan.datasets === "string") {
    datasets = [rawPlan.datasets];
  }

  if (datasets.length === 0 && catalog.length > 0) {
    datasets = [catalog[0].name];
    corrections.push(`No valid datasets in plan. Defaulting to '${datasets[0]}'.`);
  }

  //  2. Normalize joins 
  let joins: JoinSpec[] = [];
  if (Array.isArray(rawPlan.joins)) {
    joins = rawPlan.joins
      .map(asRecord)
      .filter((j) => typeof j.leftTable === "string" && typeof j.rightTable === "string")
      .map((j) => normalizeJoinConditions({
        type: typeof j.type === "string" && ["INNER", "LEFT", "RIGHT", "FULL"].includes(j.type) ? j.type as JoinSpec["type"] : "LEFT",
        leftTable: String(j.leftTable),
        leftColumn: String(j.leftColumn || ""),
        rightTable: String(j.rightTable),
        rightColumn: String(j.rightColumn || ""),
        conditions: Array.isArray(j.conditions)
          ? j.conditions.map(asRecord).map((condition) => ({
            leftTable: typeof condition.leftTable === "string" ? condition.leftTable : undefined,
            leftColumn: String(condition.leftColumn || ""),
            rightTable: typeof condition.rightTable === "string" ? condition.rightTable : undefined,
            rightColumn: String(condition.rightColumn || ""),
            joinCondition: typeof condition.joinCondition === "string"
              ? condition.joinCondition as JoinSpec["joinCondition"]
              : undefined,
          }))
          : undefined,
        joinCondition: typeof j.joinCondition === "string"
          ? j.joinCondition as JoinSpec["joinCondition"]
          : undefined,
      }));
  }

  const plan: MutableQueryPlan = {
    datasets,
    joins,
    metric: typeof rawPlan.metric === "string" ? rawPlan.metric : "",
  };

  //  3. Validate / correct each dataset name 
  const correctedDatasets: string[] = [];
  for (const dsName of datasets) {
    const normDsName = dsName.toLowerCase().replace(/[_\-\s]+/g, "");
    let ds = catalog.find(
      (d) => d.name.toLowerCase().replace(/[_\-\s]+/g, "") === normDsName || 
             d.label.toLowerCase().replace(/[_\-\s]+/g, "") === normDsName
    );
    if (ds) {
      if (ds.name !== dsName) {
        corrections.push(`Dataset corrected from '${dsName}' to certified dataset '${ds.name}'.`);
      }
      correctedDatasets.push(ds.name);
    } else {
      corrections.push(`Dataset '${dsName}' not found in catalog. Skipping it.`);
    }
  }
  if (correctedDatasets.length === 0 && catalog.length > 0) {
    correctedDatasets.push(catalog[0].name);
    corrections.push(`No valid datasets remained after correction. Defaulting to '${catalog[0].name}'.`);
  }
  plan.datasets = correctedDatasets;

  //  4. Correct joins to use corrected dataset names 
  // (The join table names must match the physical table names from the catalog)
  if (plan.joins.length > 0) {
    const validJoins: JoinSpec[] = [];
    for (const join of plan.joins) {
      const leftDs = catalog.find(d => d.name === join.leftTable || d.physicalTable === join.leftTable);
      const rightDs = catalog.find(d => d.name === join.rightTable || d.physicalTable === join.rightTable);
      if (!leftDs || !rightDs) {
        corrections.push(`Removed invalid join: ${join.leftTable} ↔ ${join.rightTable} (table not in catalog).`);
        continue;
      }
      // Use the catalog name (logical name) for join references
      join.leftTable = leftDs.name;
      join.rightTable = rightDs.name;
      join.conditions = getJoinConditions(join).map((condition) => ({
        ...condition,
        leftTable: catalog.find(d => d.name === condition.leftTable || d.physicalTable === condition.leftTable)?.name || condition.leftTable,
        rightTable: catalog.find(d => d.name === condition.rightTable || d.physicalTable === condition.rightTable)?.name || condition.rightTable,
      }));
      validJoins.push(join);
    }
    plan.joins = validJoins;
  }

  //  4b. Auto-heal missing joins 
  if ((!plan.joins || plan.joins.length === 0) && plan.datasets.length > 1) {
    const inferredJoins: JoinSpec[] = [];
    const dsSet = new Set(plan.datasets);
    for (let i = 0; i < plan.datasets.length - 1; i++) {
      const leftDsName = plan.datasets[i];
      const rightDsName = plan.datasets[i + 1];
      const leftDs = catalog.find(d => d.name === leftDsName);
      const rightDs = catalog.find(d => d.name === rightDsName);

      if (leftDs && rightDs) {
        // Find relationship
        const rel = leftDs.relationships?.find(r => r.targetDataset === rightDs.name) ||
          rightDs.relationships?.find(r => r.targetDataset === leftDs.name);

        if (rel) {
          const isLeftSource = leftDs.relationships?.includes(rel);
          inferredJoins.push({
            type: "LEFT",
            leftTable: isLeftSource ? leftDs.name : rightDs.name,
            leftColumn: rel.sourceColumn,
            rightTable: isLeftSource ? rightDs.name : leftDs.name,
            rightColumn: rel.targetColumn
          });
        } else {
          // Fallback: Check for common matching columns
          const leftCols = leftDs.columns?.map(c => c.name.toLowerCase()) || [];
          const rightCols = rightDs.columns?.map(c => c.name.toLowerCase()) || [];

          let commonCol = leftCols.find(c => rightCols.includes(c) && c.endsWith('_id'));
          if (!commonCol) {
            commonCol = leftCols.find(c => rightCols.includes(c) && c !== 'id' && c !== 'created_at' && c !== 'updated_at');
          }
          if (commonCol) {
            inferredJoins.push({
              type: "LEFT",
              leftTable: leftDs.name,
              leftColumn: commonCol,
              rightTable: rightDs.name,
              rightColumn: commonCol
            });
          }
        }
      }
    }
    if (inferredJoins.length > 0) {
      plan.joins = inferredJoins;
      corrections.push(`Auto-healed missing joins using catalog relationships: ${inferredJoins.map(j => `${j.leftTable}.${j.leftColumn}=${j.rightTable}.${j.rightColumn}`).join(", ")}`);
    }
  }

  //  5. Validate / correct metric (search across all datasets) 
  // V5: Auto-heal list queries where the LLM mistakenly sets a dimension column as the metric
  if (plan.metric) {
    const isColumn = resolveColumnAcrossDatasets(plan.metric, plan.datasets, catalog);
    const isMetric = resolveMetricAcrossDatasets(plan.metric, plan.datasets, catalog);
    if (isColumn && !isMetric) {
      corrections.push(`Auto-healed: '${plan.metric}' is a column, not a metric. Moving it to groupBy.`);
      const currentGroupBy = Array.isArray(plan.groupBy) ? plan.groupBy : (plan.groupBy ? [plan.groupBy] : []);
      if (!currentGroupBy.includes(plan.metric)) {
        currentGroupBy.push(plan.metric);
      }
      plan.groupBy = currentGroupBy;
      plan.metric = "";
    }
  }

  // Auto-inject row count for list queries (if metric is empty)
  // Removed forced row_count injection to support raw list queries

  let metricResult = resolveMetricAcrossDatasets(plan.metric, plan.datasets, catalog);
  if (!metricResult && plan.metric) {
    const lowerMetric = plan.metric.toLowerCase();
    metricResult = resolveMetricAcrossDatasets(lowerMetric, plan.datasets, catalog);
    if (metricResult) {
      corrections.push(`Metric corrected from '${plan.metric}' to certified metric '${metricResult.metric.name}'.`);
      plan.metric = metricResult.metric.name;
    } else {
      const dynamicMatch = plan.metric.match(/^(SUM|AVG|MIN|MAX|COUNT)\s*(?:\(\s*([^)]+)\s*\)|\s+of\s+([a-zA-Z0-9_.]+))$/i);
      let dynamicSuccess = false;
      if (dynamicMatch) {
        const agg = dynamicMatch[1].toUpperCase();
        const colName = (dynamicMatch[2] || dynamicMatch[3]).trim();
        const colResolved = resolveColumnAcrossDatasets(colName, plan.datasets, catalog);
        if (colResolved) {
          if (!allowDynamicMetrics) {
            // Uncertified ad-hoc aggregates are not allowed here (e.g. simple pipeline):
            // ask the user to define a certified KPI instead of silently computing one.
            issues.push(`NEEDS_KPI_MODE|${agg}|${colName}|${colResolved.datasetName}`);
            dynamicSuccess = true;
          } else {
            const ds = getDynamicDataset(colResolved.datasetName, catalog);
            if (ds) {
              const dynamicMetricName = `${agg.toLowerCase()}_${colName.toLowerCase()}`;
              ds.metrics.push({
                name: dynamicMetricName,
                label: `${agg} of ${colName}`,
                expressionSql: `${agg}(${colName})`,
                format: "number",
                synonyms: []
              });
              plan.metric = dynamicMetricName;
              corrections.push(`Dynamically generated metric '${dynamicMetricName}' using formula ${agg}(${colName}).`);
              dynamicSuccess = true;
            }
          }
        } else {
          issues.push(`Column "${colName}" used in dynamic aggregation "${plan.metric}" does not exist in datasets: [${plan.datasets.join(", ")}].`);
          dynamicSuccess = true; // handled as a specific error, prevent generic message
        }
      }

      if (!dynamicSuccess) {
        // V4: Instead of silently swapping, list available metrics and fail
        const allAvailableMetrics: string[] = [];
        for (const dsName of plan.datasets) {
          const ds = getDynamicDataset(dsName, catalog);
          if (ds) {
            for (const m of ds.metrics) {
              allAvailableMetrics.push(`${m.label} (dataset: ${dsName})`);
            }
          }
        }

        if (allAvailableMetrics.length > 0) {
          issues.push(
            `Metric "${rawPlan.metric}" not found in any dataset. ` +
            `Available metrics: ${allAvailableMetrics.join(", ")}`
          );
        } else {
          issues.push(
            `Metric "${rawPlan.metric}" not found. No metrics are defined for datasets: [${plan.datasets.join(", ")}]. ` +
            `Create KPI metrics first in the KPI Metrics tab.`
          );
        }
        // Do NOT set plan.metric — leave it unset so validation fails downstream
      }
    }
  }

  //  6. groupBy (same as before but uses multi-dataset resolver) 
  if (rawPlan.groupBy !== undefined) {
    if (typeof rawPlan.groupBy === "string" || Array.isArray(rawPlan.groupBy)) {
      plan.groupBy = cloneJson(rawPlan.groupBy) as string | string[];
    } else {
      plan.groupBy = null;
    }
  } else {
    plan.groupBy = null;
  }

  //  6b. Raw record projections are separate from GROUP BY semantics.
  if (Array.isArray(rawPlan.select_columns)) {
    const requestedColumns = Array.from(new Set(
      stringArray(rawPlan.select_columns).map((column) => column.trim()).filter(Boolean),
    ));
    const MAX_SELECT_COLUMNS = 8;
    const limitedColumns = requestedColumns.slice(0, MAX_SELECT_COLUMNS);
    if (requestedColumns.length > MAX_SELECT_COLUMNS) {
      corrections.push(`Too many selected columns (${requestedColumns.length}). Truncated to ${MAX_SELECT_COLUMNS}.`);
    }
    const validColumns = limitedColumns.filter((column) => {
      const resolved = resolveColumnAcrossDatasets(column, plan.datasets, catalog);
      if (!resolved) {
        corrections.push(`Removed selected column '${column}' because it does not exist in the planned datasets.`);
      }
      return !!resolved;
    });
    if (requestedColumns.length > 0 && validColumns.length === 0) {
      issues.push("None of the requested output columns exist in the planned datasets.");
    }
    plan.select_columns = validColumns;
  } else {
    plan.select_columns = [];
  }

  //  7. timeGrain / timeGrainColumn (same logic, multi-dataset search) 
  if (
    rawTimeGrain !== undefined &&
    typeof rawTimeGrain === "string" &&
    ["day", "week", "month", "year"].includes(rawTimeGrain)
  ) {
    plan.timeGrain = rawTimeGrain as QueryPlan["timeGrain"];
  }

  if (typeof rawTimeGrainColumn === "string") {
    plan.timeGrainColumn = rawTimeGrainColumn;
  }

  //  8. sortDir, assumptions, requiresApproval (UNCHANGED from original) 
  if (rawPlan.sortDir === "asc" || rawPlan.sortDir === "desc") {
    plan.sortDir = rawPlan.sortDir;
  } else {
    plan.sortDir = "desc";
  }

  if (Array.isArray(rawPlan.assumptions)) {
    plan.assumptions = stringArray(rawPlan.assumptions);
  } else {
    plan.assumptions = [];
  }

  if (rawPlan.requiresApproval !== undefined) {
    plan.requiresApproval = Boolean(rawPlan.requiresApproval);
  } else {
    plan.requiresApproval = false;
  }

  //  9. Limit validation (UNCHANGED) 
  const rawLimit = rawPlan.limit;
  if (rawLimit !== undefined && rawLimit !== null) {
    const limitNum = Number(rawLimit);
    const hasGrouping = !!rawPlan.groupBy || !!rawPlan.timeGrain || !!rawPlan.timeGrainColumn;
    if (isNaN(limitNum)) {
      plan.limit = MAX_QUERY_LIMIT;
      if (!hasGrouping) corrections.push(`Invalid query limit value. Applied system maximum limit of ${MAX_QUERY_LIMIT} records instead.`);
    } else if (limitNum > MAX_QUERY_LIMIT) {
      plan.limit = MAX_QUERY_LIMIT;
      if (!hasGrouping) corrections.push(`Query limit of ${limitNum} exceeded the system maximum. Clamped to ${MAX_QUERY_LIMIT}.`);
    } else if (limitNum < 1) {
      plan.limit = 1;
      if (!hasGrouping) corrections.push(`Query limit of ${limitNum} is below minimum allowed value. Adjusted to 1.`);
    } else {
      plan.limit = Math.floor(limitNum);
    }
  } else {
    plan.limit = MAX_QUERY_LIMIT;
  }

  //  10. Validate timeGrain vs timeGrainColumn (multi-dataset search) 
  if (plan.timeGrain || plan.timeGrainColumn) {
    if (plan.timeGrain && !plan.timeGrainColumn) {
      // Search all datasets for a date column
      for (const dsName of plan.datasets) {
        const ds = getDynamicDataset(dsName, catalog);
        if (ds) {
          const dateCol = ds.columns.find(
            (c) => c.type.toLowerCase().includes("date") || c.type.toLowerCase().includes("time") || c.type.toLowerCase().includes("timestamp")
          );
          if (dateCol) {
            plan.timeGrainColumn = dateCol.name;
            corrections.push(`Assigned date column '${dateCol.name}' from dataset '${dsName}' to timeGrainColumn.`);
            break;
          }
        }
      }
      if (!plan.timeGrainColumn) {
        delete plan.timeGrain;
        corrections.push(`Removed timeGrain configuration because no valid date column was found across any dataset.`);
      }
    } else if (plan.timeGrainColumn && !plan.timeGrain) {
      plan.timeGrain = "month";
      corrections.push(`Defaulted timeGrain to 'month' because timeGrainColumn '${plan.timeGrainColumn}' was specified.`);
    }
  }

  //  11. Validate GroupBy columns (multi-dataset) 
  if (plan.groupBy) {
    const cols: string[] = Array.isArray(plan.groupBy)
      ? (plan.groupBy as string[])
      : (plan.groupBy ? [plan.groupBy as string] : []);
    let validCols = cols.filter((colName: string) => {
      const resolved = resolveColumnAcrossDatasets(colName, plan.datasets, catalog);
      if (!resolved) {
        corrections.push(`Removed group-by column '${colName}' because it does not exist in any dataset.`);
      }
      return !!resolved;
    });

    if (cols.length > 0 && validCols.length === 0) {
      issues.push(`No column named '${cols.join(", ")}' exists to groupby it. If it exists in another table please create a proper Global KPI for it.`);
    }

    const MAX_GROUP_BY_COLS = 5;
    if (validCols.length > MAX_GROUP_BY_COLS) {
      corrections.push(`Too many group-by columns (${validCols.length}). Truncated to the maximum limit of ${MAX_GROUP_BY_COLS}.`);
      validCols = validCols.slice(0, MAX_GROUP_BY_COLS);
    }

    plan.groupBy = validCols.length === 0 ? null : (validCols.length === 1 ? validCols[0] : validCols);
  }

  //  12. Validate filters (UNCHANGED logic, just keeps existing filter validation) 
  if (rawPlan.filters) {
    if (!Array.isArray(rawPlan.filters)) {
      plan.filters = [];
      corrections.push("Invalid filters format. Cleared filters.");
    } else {
      const MAX_FILTERS = 10;
      let validFilters = rawPlan.filters.map((rawFilter) => {
        const f = asRecord(rawFilter);
        if (Object.keys(f).length > 0) {
          const rawOp = typeof f.op === "string" ? f.op : (typeof f.operator === "string" ? f.operator : "");
          const opMap: Record<string, "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "between" | "relative"> = {
            "=": "eq", "eq": "eq", "==": "eq", "===": "eq",
            "!=": "neq", "<>": "neq", "neq": "neq",
            ">": "gt", "gt": "gt",
            ">=": "gte", "gte": "gte",
            "<": "lt", "lt": "lt",
            "<=": "lte", "lte": "lte",
            "in": "in", "between": "between", "relative": "relative"
          };
          const normalizedOp = opMap[rawOp.toLowerCase().trim()] || "eq";
          const normalizedFilter = {
            field: typeof f.field === "string" ? f.field : "",
            op: normalizedOp,
            value: normalizeFilterValue(f.value),
          };
          const dateNormalized = normalizeDateEqualityFilter(
            normalizedFilter.field,
            normalizedFilter.op,
            normalizedFilter.value,
            plan.datasets,
            catalog,
          );
          if (dateNormalized) {
            if ("issue" in dateNormalized) {
              issues.push(dateNormalized.issue);
              return normalizedFilter;
            }
            corrections.push(dateNormalized.correction);
            return dateNormalized.filter;
          }
          return normalizedFilter;
        }
        return null;
      }).filter((f): f is NonNullable<typeof f> => Boolean(f));

      if (validFilters.length > MAX_FILTERS) {
        corrections.push(`Too many query filters (${validFilters.length}). Truncated to the maximum limit of ${MAX_FILTERS}.`);
        validFilters = validFilters.slice(0, MAX_FILTERS);
      }
      plan.filters = validFilters;
    }
  } else {
    plan.filters = [];
  }

  //  13. Final cross-check: remove timeGrainColumn from groupBy if duplicated 
  if (plan.timeGrainColumn && plan.groupBy) {
    const cols: string[] = Array.isArray(plan.groupBy)
      ? (plan.groupBy as string[])
      : (plan.groupBy ? [plan.groupBy as string] : []);
    const filtered = cols.filter((c: string) => c !== plan.timeGrainColumn);
    if (filtered.length !== cols.length) {
      corrections.push(`Removed '${plan.timeGrainColumn}' from groupBy because it is already configured as the timeGrainColumn.`);
      plan.groupBy = filtered.length === 0 ? null : (filtered.length === 1 ? filtered[0] : filtered);
    }
  }

  if (
    options?.requireExplicitProjection
    && !plan.metric
    && !plan.groupBy
    && !plan.timeGrainColumn
    && !(plan.select_columns?.length)
  ) {
    issues.push("A raw record query must select explicit catalog columns; dataset-only plans and SELECT * are not allowed.");
  }

  return { plan: plan as QueryPlan, corrections, issues };
}

export { validatePlan, sanitizeAndCorrectPlan };
