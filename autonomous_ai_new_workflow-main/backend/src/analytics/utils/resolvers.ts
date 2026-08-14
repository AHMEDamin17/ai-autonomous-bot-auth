import { AiDatasetDefinition, AiDatasetColumn, AiDatasetMetric } from "../../routes/semanticLayer/semanticCatalog";

function normalizeIdentifier(value: string | undefined | null): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`"\[\]]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function datasetAliases(dataset: AiDatasetDefinition): Set<string> {
  const aliases = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    aliases.add(value.toLowerCase());
    aliases.add(normalizeIdentifier(value));
    const parts = value.replace(/[`"\[\]]/g, "").split(".").filter(Boolean);
    if (parts.length > 0) {
      aliases.add(parts[parts.length - 1]!.toLowerCase());
      aliases.add(normalizeIdentifier(parts[parts.length - 1]));
    }
    if (parts.length > 1) {
      aliases.add(parts.slice(-2).join(".").toLowerCase());
      aliases.add(normalizeIdentifier(parts.slice(-2).join(".")));
    }
  };

  add(dataset.name);
  add(dataset.label);
  add(dataset.physicalTable);
  return aliases;
}

function getDynamicDataset(name: string, catalog: AiDatasetDefinition[]) {
  const raw = String(name || "").trim();
  const normalized = normalizeIdentifier(raw);
  const lower = raw.toLowerCase();
  return catalog.find((d) => {
    const aliases = datasetAliases(d);
    return aliases.has(lower) || aliases.has(normalized);
  });
}

function getDynamicMetric(datasetName: string, metricName: string, catalog: AiDatasetDefinition[]) {
  const normMetric = normalizeIdentifier(metricName);
  return getDynamicDataset(datasetName, catalog)?.metrics.find(
    (m) => m.name === metricName || normalizeIdentifier(m.label) === normMetric || normalizeIdentifier(m.name) === normMetric
  );
}

function getDynamicColumn(datasetName: string, columnName: string, catalog: AiDatasetDefinition[]) {
  const normCol = normalizeIdentifier(columnName);
  return getDynamicDataset(datasetName, catalog)?.columns.find(
    (c) => normalizeIdentifier(c.name) === normCol
  );
}

function datasetAllowedInPlan(dataset: AiDatasetDefinition, datasetNames: string[], catalog: AiDatasetDefinition[]): boolean {
  if (datasetNames.length === 0) return true;
  return datasetNames.some((name) => getDynamicDataset(name, catalog)?.name === dataset.name);
}

function splitQualifiedColumnRef(
  columnRef: string,
  datasetNames: string[],
  catalog: AiDatasetDefinition[]
): { dataset: AiDatasetDefinition; columnName: string } | null {
  const cleanRef = String(columnRef || "").replace(/[`"\[\]]/g, "").trim();
  const parts = cleanRef.split(".").filter(Boolean);
  if (parts.length < 2) return null;

  for (let i = parts.length - 1; i >= 1; i--) {
    const tablePart = parts.slice(0, i).join(".");
    const columnPart = parts.slice(i).join(".");
    const ds = getDynamicDataset(tablePart, catalog);
    if (ds && datasetAllowedInPlan(ds, datasetNames, catalog)) {
      return { dataset: ds, columnName: columnPart };
    }
  }

  return null;
}

// MULTI-DATASET COLUMN RESOLVER
// When multiple datasets are used, a bare column name like "status" is ambiguous.
// This function searches across ALL specified datasets to find the column.
// Returns { datasetName, column } or null.

function resolveColumnAcrossDatasets(
  columnName: string,
  datasetNames: string[],
  catalog: AiDatasetDefinition[]
): { datasetName: string; column: AiDatasetColumn } | null {
  const qualified = splitQualifiedColumnRef(columnName, datasetNames, catalog);
  if (qualified) {
      const { dataset: ds, columnName: colPart } = qualified;
      if (colPart === "__table__") {
        return { datasetName: ds.name, column: { name: "__table__", type: "string" } as AiDatasetColumn };
      }
      const normColPart = normalizeIdentifier(colPart);
      const col = ds.columns.find((c) => normalizeIdentifier(c.name) === normColPart);
      if (col) return { datasetName: ds.name, column: col };
      return null;
  }

  // Unqualified: search all datasets in order
  const normColName = normalizeIdentifier(columnName);
  const matches: { datasetName: string; column: AiDatasetColumn }[] = [];
  for (const dsName of datasetNames) {
    const ds = getDynamicDataset(dsName, catalog);
    if (!ds) continue;
    const col = ds.columns.find((c) => normalizeIdentifier(c.name) === normColName);
    if (col) matches.push({ datasetName: ds.name, column: col });
  }

  if (matches.length > 1) {
    // Sentinel-prefixed so callers route this through the same structured
    // AMBIGUOUS response/disambiguation picker used for ambiguous KPI
    // formula columns, instead of a generic failure message.
    const tables = matches.map((m) => m.datasetName).join(",");
    const reason = `'${columnName}' exists in multiple requested tables. Please specify the table name (e.g. table_name.${columnName}) or create a proper KPI for it.`;
    throw new Error(`AMBIGUOUS_MODE|${tables}|${columnName}|${reason}`);
  }

  if (matches.length === 1) {
    return matches[0];
  }

  return null;
}

// Resolve a metric across multiple datasets
function resolveMetricAcrossDatasets(
  metricName: string,
  datasetNames: string[],
  catalog: AiDatasetDefinition[]
): { datasetName: string; metric: AiDatasetMetric } | null {
  const normMetric = normalizeIdentifier(metricName);
  for (const dsName of datasetNames) {
    const ds = getDynamicDataset(dsName, catalog);
    if (ds) {
      const metric = ds.metrics.find(
        (m) => m.name === metricName || normalizeIdentifier(m.name) === normMetric || normalizeIdentifier(m.label) === normMetric
      );
      if (metric) return { datasetName: ds.name, metric };
    }
  }

  // Fallback: check the virtual global_kpis dataset for cross-table metrics
  const globalMetric = getDynamicMetric("global_kpis", metricName, catalog);
  if (globalMetric) return { datasetName: "global_kpis", metric: globalMetric };

  return null;
}
export { getDynamicDataset, getDynamicMetric, getDynamicColumn, normalizeIdentifier, resolveColumnAcrossDatasets, resolveMetricAcrossDatasets };
