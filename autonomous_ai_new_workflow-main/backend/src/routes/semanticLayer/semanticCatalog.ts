// ============================================================================
// Deterministic semantic catalog used by analytics planning.
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import pool from "../../db/connection";
import { RowDataPacket } from "mysql2";
import {
  ApiResponse,
  DatabaseConnection,
  CatalogRelationship,
  KpiMetric,
  AiDatasetDefinition,
  AiDatasetColumn,
  AiColumnType,
  AiDatasetMetric,
  AiRelationship,
  GlobalAiKpi,
  AiCatalogContext,
} from "../../types/types";
import { fetchMetadata } from "./dataCatalog";
import { getJoinConditions, normalizeJoinConditions } from "../../analytics/utils/joinSpecs";

// ============================================================================
// HELPERS
function safeJsonParse(val: any): any { try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return null; } }
function normalizeDatasetKey(value: any): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[`"\[\]]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
// ============================================================================

function isSensitiveColumn(columnName: string): boolean {
  const sensitivePatterns = [
    /password/i, /pwd/i, /ssn/i, /salary/i, /hash/i, /salt/i, /token/i,
    /secret/i, /apikey/i, /api_key/i, /credit_card/i, /creditcard/i, /card_number/i
  ];
  return sensitivePatterns.some(pattern => pattern.test(columnName));
}

// Note: no dialect this app connects to (mysql/postgres/mssql/sqlite/
// snowflake/bigquery/databricks) is Oracle, so Oracle data-dictionary
// prefixes (ALL_*/DBA_*/USER_*) are deliberately NOT included here — they
// previously hid every legitimate business view whose name happened to
// start with "all_"/"dba_"/"user_" (e.g. "user_accounts", "all_time_sales").
const VIEW_EXCLUDE_PATTERNS = [
  /^vw_\w*_internal/i, /^sys_/i, /^pg_/i,
  /^information_schema/i, /^CHANGE_TRACKING/i, /_internal$/i, /_temp$/i,
  /_tmp$/i, /_bak$/i, /_old$/i, /_staging$/i, /_deprecated$/i, /^__/,
];

function isSystemView(viewName: string): boolean {
  return VIEW_EXCLUDE_PATTERNS.some(pattern => pattern.test(viewName));
}

function resolveColumnType(dataType: string): { type: AiColumnType; allowedForGrouping: boolean; allowedForFiltering: boolean } | null {
  const t = (dataType || "").toLowerCase();
  if (t.includes("binary") || t.includes("blob") || t.includes("varbinary") || t.includes("image") || t.includes("json") || t.includes("bytea")) {
    return null;
  }
  if (t.includes("int") || t.includes("decimal") || t.includes("float") || t.includes("double") || t.includes("numeric") || t.includes("real")) {
    return { type: "number", allowedForGrouping: true, allowedForFiltering: true };
  }
  if (t.includes("date") || t.includes("time") || t.includes("timestamp") || t === "year") {
    return { type: "date", allowedForGrouping: true, allowedForFiltering: true };
  }
  if (t.includes("varchar") || t.includes("char") || t.includes("text") || t.includes("enum") || t.includes("set") || t === "string") {
    return { type: "string", allowedForGrouping: true, allowedForFiltering: true };
  }
  // Postgres "boolean"/"bool" and MSSQL "bit" (single-bit flag columns like
  // is_active/is_deleted) were falling through to null and being dropped
  // from the catalog entirely — invisible to every downstream pipeline.
  // ("bit varying"/"varbit" are a different, non-boolean bit-string type,
  // so only match bare "bit"/"bit(n)", not that.)
  if (t.includes("bool") || t === "bit" || t.startsWith("bit(")) {
    return { type: "string", allowedForGrouping: true, allowedForFiltering: true };
  }
  return null;
}

function generateTableSynonyms(tableName: string): string[] {
  const synonyms = new Set<string>();
  const nameClean = tableName.trim().toLowerCase();
  if (!nameClean) return [];
  synonyms.add(nameClean);
  const spaced = nameClean.replace(/[_-]+/g, " ").trim();
  synonyms.add(spaced);
  const parts = spaced.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    parts.forEach(part => { if (part.length > 2) synonyms.add(part); });
    const singularParts = parts.map(p => p.endsWith("s") && p.length > 3 ? p.slice(0, -1) : p);
    synonyms.add(singularParts.join(" "));
  }
  if (nameClean.includes("cust")) { synonyms.add("client"); synonyms.add("user"); }
  if (nameClean.includes("emp")) { synonyms.add("staff"); synonyms.add("worker"); }
  if (nameClean.includes("prod")) { synonyms.add("item"); synonyms.add("goods"); }
  if (nameClean.includes("rev") || nameClean.includes("sales")) { synonyms.add("income"); synonyms.add("earnings"); }
  if (nameClean.includes("txn") || nameClean.includes("trans")) { synonyms.add("transaction"); synonyms.add("order"); }
  return Array.from(synonyms);
}

function generateMetricSynonyms(metricName: string): string[] {
  const synonyms = new Set<string>();
  const nameClean = metricName.trim().toLowerCase();
  if (!nameClean) return [];
  synonyms.add(nameClean);
  const spaced = nameClean.replace(/[_-]+/g, " ").trim();
  synonyms.add(spaced);
  let expanded = spaced;
  if (spaced.includes("avg")) expanded = expanded.replace(/\bavg\b/g, "average");
  if (spaced.includes("cnt") || spaced.includes("num")) expanded = expanded.replace(/\b(cnt|num)\b/g, "count");
  if (spaced.includes("pct")) expanded = expanded.replace(/\bpct\b/g, "percent");
  if (spaced.includes("rev")) expanded = expanded.replace(/\brev\b/g, "revenue");
  if (spaced.includes("qty")) expanded = expanded.replace(/\bqty\b/g, "quantity");
  if (spaced.includes("min")) expanded = expanded.replace(/\bmin\b/g, "minimum");
  if (spaced.includes("max")) expanded = expanded.replace(/\bmax\b/g, "maximum");
  if (spaced.includes("tot")) expanded = expanded.replace(/\btot\b/g, "total");
  synonyms.add(expanded);
  const parts = spaced.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    parts.forEach(part => { if (part.length > 2 && part !== "avg" && part !== "tot" && part !== "cnt" && part !== "num") synonyms.add(part); });
  }
  if (nameClean.includes("revenue") || nameClean.includes("sales")) { synonyms.add("income"); synonyms.add("earnings"); synonyms.add("turnover"); }
  if (nameClean.includes("cost") || nameClean.includes("expense")) { synonyms.add("spend"); synonyms.add("outlay"); }
  if (nameClean.includes("profit") || nameClean.includes("margin")) { synonyms.add("net income"); synonyms.add("markup"); }
  return Array.from(synonyms);
}

// ============================================================================
// INFERRED RELATIONSHIPS (unchanged)
// ============================================================================

function inferColumnRelationships(catalog: AiDatasetDefinition[]): void {
  const EXCLUDED_COLUMNS = new Set([
    "id", "status", "type", "name", "description", "title", "value",
    "created_at", "updated_at", "deleted_at", "created_by", "updated_by",
    "is_active", "is_deleted", "sort_order", "notes", "comment", "comments"
  ]);

  const columnIndex = new Map<string, string[]>();
  for (const ds of catalog) {
    for (const col of ds.columns) {
      const colLower = col.name.toLowerCase();
      if (EXCLUDED_COLUMNS.has(colLower)) continue;
      if (!columnIndex.has(colLower)) columnIndex.set(colLower, []);
      columnIndex.get(colLower)!.push(ds.name);
    }
  }

  for (const [colName, dsNames] of columnIndex) {
    if (dsNames.length < 2) continue;
    const isIdColumn = colName.endsWith("_id");
    for (let i = 0; i < dsNames.length; i++) {
      for (let j = i + 1; j < dsNames.length; j++) {
        const dsA = catalog.find(d => d.name === dsNames[i])!;
        const dsB = catalog.find(d => d.name === dsNames[j])!;
        const hasFK = dsA.relationships.some(r => r.targetDataset === dsB.name && r.type === "foreign_key") ||
          dsB.relationships.some(r => r.targetDataset === dsA.name && r.type === "foreign_key");
        if (hasFK) continue;
        if (!isIdColumn && (dsA.relationships.length > 0 || dsB.relationships.length > 0)) continue;
        dsA.relationships.push({ targetDataset: dsB.name, sourceColumn: colName, targetColumn: colName, type: "inferred" });
        dsB.relationships.push({ targetDataset: dsA.name, sourceColumn: colName, targetColumn: colName, type: "inferred" });
      }
    }
  }
}

function findDatasetByReference(ref: string, catalog: AiDatasetDefinition[]): AiDatasetDefinition | undefined {
  const raw = String(ref || "").trim();
  const lower = raw.toLowerCase();
  const normalized = normalizeDatasetKey(raw);
  return catalog.find((ds) => {
    const physical = ds.physicalTable || "";
    const barePhysical = physical.includes(".") ? physical.split(".").pop()! : physical;
    const aliases = [
      ds.name,
      ds.label,
      physical,
      barePhysical,
      physical.replace(/\./g, "_"),
    ].filter(Boolean);
    return aliases.some((alias) => alias.toLowerCase() === lower || normalizeDatasetKey(alias) === normalized);
  });
}

function normalizeTableRef(ref: string, catalog: AiDatasetDefinition[]): string {
  return findDatasetByReference(ref, catalog)?.name || ref;
}

function normalizeColumnRef(ref: string, catalog: AiDatasetDefinition[]): string {
  const clean = String(ref || "").replace(/[`"\[\]]/g, "").trim();
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return clean;

  for (let i = parts.length - 1; i >= 1; i--) {
    const tablePart = parts.slice(0, i).join(".");
    const ds = findDatasetByReference(tablePart, catalog);
    if (ds) {
      return `${ds.name}.${parts.slice(i).join(".")}`;
    }
  }
  return clean;
}

function normalizeFilterNodeRefs(node: any, catalog: AiDatasetDefinition[]): any {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => normalizeFilterNodeRefs(child, catalog));
  if (node.type === "condition") {
    return { ...node, field: normalizeColumnRef(node.field, catalog) };
  }
  if (node.type === "group") {
    return {
      ...node,
      children: Array.isArray(node.children)
        ? node.children.map((child: any) => normalizeFilterNodeRefs(child, catalog))
        : [],
    };
  }
  return node;
}

function normalizeKpiCatalogRefs(globalKpi: GlobalAiKpi, catalog: AiDatasetDefinition[]): GlobalAiKpi {
  const involvedTables = (globalKpi.involvedTables || []).map((table) => normalizeTableRef(table, catalog));
  const normalized: GlobalAiKpi = {
    ...globalKpi,
    involvedTables,
    allowedGroupByTables: involvedTables,
    dimensions: (globalKpi.dimensions || []).map((dim) => normalizeColumnRef(dim, catalog)),
    kpi_dimensions: (globalKpi.kpi_dimensions || globalKpi.dimensions || []).map((dim) => normalizeColumnRef(dim, catalog)),
    select_columns: (globalKpi.select_columns || []).map((col) => normalizeColumnRef(col, catalog)),
    join_spec: (globalKpi.join_spec || []).map((join) => normalizeJoinConditions({
      ...join,
      leftTable: normalizeTableRef(join.leftTable, catalog),
      rightTable: normalizeTableRef(join.rightTable, catalog),
      conditions: getJoinConditions(join).map((condition) => ({
        ...condition,
        leftTable: normalizeTableRef(condition.leftTable || join.leftTable, catalog),
        rightTable: normalizeTableRef(condition.rightTable || join.rightTable, catalog),
      })),
    })),
    filter_logic: globalKpi.filter_logic ? normalizeFilterNodeRefs(globalKpi.filter_logic, catalog) : globalKpi.filter_logic,
  };
  return normalized;
}

// ============================================================================
// BUILD AI CATALOG - UPDATED WITH KPI COMPILATION HINTS
// ============================================================================

async function buildAiCatalog(
  connections: DatabaseConnection[],
  kpis: RowDataPacket[],
  tableName?: string,
  metadataCache?: Map<number, any>
): Promise<AiCatalogContext> {
  const catalog: AiDatasetDefinition[] = [];
  const globalKpis: GlobalAiKpi[] = [];

  // Parse all KPIs into the new global structure FIRST
  // This allows us to reference them when building dataset metrics
  const parsedKpis: Array<{
    kpi: KpiMetric;
    globalKpi: GlobalAiKpi;
  }> = [];

  kpis.forEach(k => {
    let involvedTables: string[] = [];
    if (k.involved_tables) {
      involvedTables = typeof k.involved_tables === 'string' ? safeJsonParse(k.involved_tables) : k.involved_tables;
    }
    if (!involvedTables) involvedTables = [];
    if (involvedTables.length === 0) {
      if (k.table_name) involvedTables = [k.table_name.toLowerCase()];
    }
    
    let joinSpec: any[] = [];
    if (k.join_spec) {
      joinSpec = typeof k.join_spec === 'string' ? safeJsonParse(k.join_spec) : k.join_spec;
    }
    
    let filterLogic: any = null;
    if (k.filter_logic) {
      filterLogic = typeof k.filter_logic === 'string' ? safeJsonParse(k.filter_logic) : k.filter_logic;
    }
    
    let selectColumns: string[] = [];
    if (k.select_columns) {
      selectColumns = typeof k.select_columns === 'string' ? safeJsonParse(k.select_columns) : k.select_columns;
    }

    const globalKpi: GlobalAiKpi = {
      name: k.metric_name.toLowerCase().replace(/\s+/g, "_"),
      expressionSql: k.formula,
      valueFormat: k.format || "number",
      involvedTables: involvedTables,
      allowedGroupByTables: involvedTables,
      dimensions: safeJsonParse(k.dimensions),
      // NEW: KPI compilation hints attached directly
      join_spec: joinSpec,
      filter_logic: filterLogic,
      select_columns: selectColumns,
      kpi_dimensions: safeJsonParse(k.dimensions),
    };
    globalKpis.push(globalKpi);
    
    parsedKpis.push({ kpi: k as any, globalKpi });
  });

  // Accumulate all FK relationships from all connections
  const allFkRelationships: CatalogRelationship[] = [];

  for (const conn of connections) {
    let meta;
    try {
      if (metadataCache && metadataCache.has(Number(conn.id))) {
        meta = metadataCache.get(Number(conn.id));
      } else {
        meta = await fetchMetadata(conn);
      }
    } catch {
      continue; // skip offline connections
    }

    const schema = conn.default_schema || "";

    // Collect FK relationships from this connection's metadata
    if (meta.relationships && meta.relationships.length > 0) {
      allFkRelationships.push(...meta.relationships);
    }

    // Group columns by schema-qualified table key
    const columnsByTableKey: Record<string, AiDatasetColumn[]> = {};
    meta.columns.forEach((c: any) => {
      if (tableName && c.table_name.toLowerCase() !== tableName.toLowerCase()) return;
      if (isSensitiveColumn(c.column_name)) return;

      const schemaKey = (c.table_schema || schema || "default").toLowerCase();
      const tableKey = c.table_name.toLowerCase();
      const fullKey = `${schemaKey}.${tableKey}`;

      if (!columnsByTableKey[fullKey]) columnsByTableKey[fullKey] = [];
      const resolved = resolveColumnType(c.data_type);
      if (resolved) {
        columnsByTableKey[fullKey].push({
          name: c.column_name,
          ...resolved,
          isPrimaryKey: Boolean(c.is_primary_key),
          isAutoIncrement: Boolean(c.is_auto_increment),
        });
      }
    });

    // Combine physical tables and views (filter out system/internal views)
    const filteredViews = (meta.views || []).filter((v: any) => !isSystemView(v.table_name));
    let allObjects = [...(meta.tables || []), ...filteredViews];
    if (tableName) {
      allObjects = allObjects.filter((t: any) => t.table_name.toLowerCase() === tableName.toLowerCase());
    }

    // Each physical table/view → one DatasetDefinition
    
    allObjects.forEach((t: any) => {
      const tableSchema = (t.table_schema || schema || "default").toLowerCase();
      const tableNameLower = t.table_name.toLowerCase();
      const fullKey = `${tableSchema}.${tableNameLower}`;

      // Qualify by the table's OWN schema (t.table_schema), not just the
      // connection-level default. Without this, a connection with no
      // default_schema (e.g. MySQL enumerating tables across every non-system
      // database) collapses same-named tables from different schemas —
      // db1.orders and db2.orders — into one catalog entry, silently merging
      // their columns and losing the schema qualifier needed to query the
      // right one.
      const schemaForPhysical = t.table_schema || schema || "";
      const datasetName = schemaForPhysical
        ? `${tableSchema}_${tableNameLower}`.replace(/\s+/g, "_")
        : tableNameLower.replace(/\s+/g, "_");

      const physicalTable = schemaForPhysical ? `${schemaForPhysical}.${t.table_name}` : t.table_name;

      // KPI metrics whose table_name matches this table, or whose base table (involvedTables[0]) matches
      const tableKpis = parsedKpis.filter(
        (p) => {
          if (p.kpi.connection_id !== conn.id) return false;
          
          // If it's a cross-table KPI, it belongs in global_kpis, not here.
          if (p.globalKpi.join_spec?.length || p.globalKpi.involvedTables.length > 1) return false;

          // Match by explicit schema.table
          if (p.kpi.table_name && p.kpi.table_name.toLowerCase() === physicalTable.toLowerCase()) return true;
          // Match by just table_name (legacy)
          if (p.kpi.table_name && p.kpi.table_name.toLowerCase() === t.table_name.toLowerCase()) return true;
          
          // Match by base table in involvedTables array
          if (p.globalKpi.involvedTables && p.globalKpi.involvedTables.length > 0) {
            const baseTableFull = p.globalKpi.involvedTables[0].toLowerCase();
            const baseTableUnprefixed = baseTableFull.includes('.') ? baseTableFull.split('.').pop() : baseTableFull;
            return baseTableFull === physicalTable.toLowerCase() || 
                   baseTableUnprefixed === t.table_name.toLowerCase();
          }
          return false;
        }
      );

      const metrics: AiDatasetMetric[] = tableKpis.map((p) => ({
        name: p.kpi.metric_name.toLowerCase().replace(/\s+/g, "_"),
        label: p.kpi.metric_name,
        expressionSql: p.kpi.formula,
        format: (p.kpi.format as "currency" | "number" | "percent") || "number",
        synonyms: generateMetricSynonyms(p.kpi.metric_name),
        join_spec: safeJsonParse(p.kpi.join_spec),
        filter_logic: typeof p.kpi.filter_logic === 'string' ? safeJsonParse(p.kpi.filter_logic) : p.kpi.filter_logic,
        dimensions: safeJsonParse(p.kpi.dimensions),
      }));

      catalog.push({
        name: datasetName,
        label: t.table_name,
        physicalTable,
        certified: true,
        synonyms: generateTableSynonyms(t.table_name),
        columns: columnsByTableKey[fullKey] || [],
        metrics,
        relationships: [],  // populated below
      });
    });
  }

  // Phase 2: Populate FK relationships using physical→logical name map
  const physicalToLogical = new Map<string, string>();
  catalog.forEach(ds => {
    physicalToLogical.set(ds.physicalTable.toLowerCase(), ds.name);
    physicalToLogical.set(ds.physicalTable.replace(/\./g, "_").toLowerCase(), ds.name);
    physicalToLogical.set(ds.name.toLowerCase(), ds.name);
    const bareName = ds.physicalTable.includes(".")
      ? ds.physicalTable.split(".").pop()!.toLowerCase()
      : ds.physicalTable.toLowerCase();
    physicalToLogical.set(bareName, ds.name);
  });

  for (const parsed of parsedKpis) {
    parsed.globalKpi = normalizeKpiCatalogRefs(parsed.globalKpi, catalog);
  }
  globalKpis.splice(0, globalKpis.length, ...parsedKpis.map((parsed) => parsed.globalKpi));

  for (const rel of allFkRelationships) {
    const sourceLogical = physicalToLogical.get(rel.sourceTable.toLowerCase());
    const targetLogical = physicalToLogical.get(rel.targetTable.toLowerCase());
    if (!sourceLogical || !targetLogical) continue;
    if (sourceLogical === targetLogical) continue;

    const sourceDs = catalog.find(d => d.name === sourceLogical);
    if (sourceDs) {
      const exists = sourceDs.relationships.some(
        r => r.targetDataset === targetLogical &&
          r.sourceColumn === rel.sourceColumn &&
          r.targetColumn === rel.targetColumn &&
          r.type === "foreign_key"
      );
      if (!exists) {
        sourceDs.relationships.push({
          targetDataset: targetLogical,
          sourceColumn: rel.sourceColumn,
          targetColumn: rel.targetColumn,
          type: "foreign_key",
        });
      }
    }
  }

  // ============================================================================
  // NEW: Attach KPI join_spec as "kpi_defined" relationships
  // ============================================================================
  for (const { globalKpi } of parsedKpis) {
    if (globalKpi.join_spec?.length && globalKpi.involvedTables.length > 1) {
      for (const join of globalKpi.join_spec) {
        for (const condition of getJoinConditions(join)) {
          const leftTable = condition.leftTable || join.leftTable;
          const rightTable = condition.rightTable || join.rightTable;
          const leftDs = catalog.find(d => d.name === leftTable);
          const rightDs = catalog.find(d => d.name === rightTable);
          if (!leftDs || !rightDs) continue;
          // Add kpi_defined relationship (highest precedence)
          const exists = leftDs.relationships.some(r => 
            r.targetDataset === rightTable &&
            r.sourceColumn === condition.leftColumn &&
            r.targetColumn === condition.rightColumn &&
            r.type === "kpi_defined"
          );
          if (!exists) {
            leftDs.relationships.push({
              targetDataset: rightTable,
              sourceColumn: condition.leftColumn,
              targetColumn: condition.rightColumn,
              type: "kpi_defined",
            });
          }
        }
      }
    }
  }

  // ============================================================================
  // NEW: Create global_kpis virtual dataset with FULL compilation hints
  // ============================================================================
  const connectionLevelKpis = parsedKpis.filter(p => !p.kpi.table_name);
  const tableKpisWithHints = parsedKpis.filter(p => {
    // Include if it has a join spec, OR if it's a multi-table KPI (involvedTables.length > 1)
    if (p.globalKpi.join_spec?.length) return true;
    if (p.globalKpi.involvedTables.length > 1) return true;
    return false;
  });
  
  if (tableKpisWithHints.length > 0) {
    const globalMetrics: AiDatasetMetric[] = tableKpisWithHints.map(p => ({
      name: p.globalKpi.name,
      label: p.kpi.metric_name,
      expressionSql: p.globalKpi.expressionSql,
      format: p.globalKpi.valueFormat as any,
      synonyms: generateMetricSynonyms(p.kpi.metric_name),
      // FULL COMPILATION HINTS for planner/pipeline
      join_spec: p.globalKpi.join_spec,
      filter_logic: p.globalKpi.filter_logic,
      select_columns: p.globalKpi.select_columns,
      involved_tables: p.globalKpi.involvedTables,
      dimensions: p.globalKpi.dimensions,
    }));
    
    catalog.push({
      name: "global_kpis",
      label: "Global KPIs",
      physicalTable: "",
      certified: true,
      synonyms: ["global metrics", "company kpis", "cross-table kpis"],
      columns: [],
      metrics: globalMetrics,
      relationships: []
    });
  }

  // Phase 1: Infer column-name relationships (skips pairs with FKs or kpi_defined)
  inferColumnRelationships(catalog);

  return {
    datasets: catalog,
    kpiMetrics: globalKpis
  };
}

// ============================================================================
// Maps aggregation type to shortcode (unchanged)
// ============================================================================

const aggShort = (type: string): string => {
  const t = (type || "").toLowerCase().trim();
  if (t.includes("simple") || t.includes("direct")) return "simple";
  if (t.includes("ratio")) return "ratio";
  if (t.includes("cumulative")) return "cumulative";
  return "derived";
};

// Smallest time grain to expose for a time dimension, inferred from the real
// physical column data_type (DATE/DATETIME/TIMESTAMP -> day, YEAR -> year,
// bare TIME -> hour). Used only for the descriptive semantic_models layer.
const timeGranularity = (dataType: string): string => {
  const t = (dataType || "").toLowerCase();
  if (t === "year") return "year";
  if (t.startsWith("time") && !t.includes("stamp")) return "hour"; // TIME has no date part
  return "day";
};

// Derive the real SQL aggregation shown on a KPI measure from its formula
// (SUM(...) -> sum, COUNT(DISTINCT ...) -> count_distinct, etc.). Falls back to
// the KPI calculation-type shortcode when the formula has no recognizable agg.
const deriveSqlAgg = (expr: string, fallbackType: string): string => {
  const e = (expr || "").toUpperCase();
  if (/COUNT\s*\(\s*DISTINCT/.test(e)) return "count_distinct";
  if (/\bCOUNT\s*\(/.test(e)) return "count";
  if (/\bSUM\s*\(/.test(e)) return "sum";
  if (/\bAVG\s*\(/.test(e)) return "avg";
  if (/\bMIN\s*\(/.test(e)) return "min";
  if (/\bMAX\s*\(/.test(e)) return "max";
  return aggShort(fallbackType);
};

// ============================================================================
// Build full semantic model payload (unchanged)
// ============================================================================

const buildPayloadAsync = async (
  connections: DatabaseConnection[],
  kpis: RowDataPacket[],
  tableName?: string
): Promise<any> => {
  let latestTimestamp = 0;
  kpis.forEach((k) => {
    const ts = new Date(k.created_at).getTime();
    if (ts > latestTimestamp) latestTimestamp = ts;
  });

  const version = latestTimestamp > 0 ? `1.0.0+${latestTimestamp}` : "1.0.0";

  const metadataCache = new Map<number, any>();

  const payload: any = {
    version,
    department: "DynamicDataLayer",
    semantic_models: [],
    metrics: [],
    joins: [],
    db_connections: {},
    ai_catalog: [],
  };

  for (const conn of connections) {
    if (conn.connection_name) {
      payload.db_connections[conn.connection_name] = {};
    }

    try {
      const meta = await fetchMetadata(conn);
      metadataCache.set(Number(conn.id), meta);

      const colsByTableKey: Record<string, any[]> = {};
      meta.columns.forEach((c: any) => {
        if (tableName && c.table_name.toLowerCase() !== tableName.toLowerCase()) return;
        if (isSensitiveColumn(c.column_name)) return;

        const schemaKey = (c.table_schema || "").toLowerCase();
        const tableKey = c.table_name.toLowerCase();
        const fullKey = schemaKey ? `${schemaKey}.${tableKey}` : tableKey;

        if (!colsByTableKey[fullKey]) colsByTableKey[fullKey] = [];

        const resolved = resolveColumnType(c.data_type);
        if (resolved) {
          const typeStr = resolved.type === "date" ? "time" : resolved.type === "number" ? "numeric" : "categorical";
          colsByTableKey[fullKey].push(
            typeStr === "time"
              ? { name: c.column_name, type: typeStr, granularity: timeGranularity(c.data_type), expr: c.column_name }
              : { name: c.column_name, type: typeStr, expr: c.column_name },
          );
        }
      });

      let tables = meta.tables || [];
      if (tableName) {
        tables = tables.filter((t: any) => t.table_name.toLowerCase() === tableName.toLowerCase());
      }
      tables.forEach((t: any) => {
        const schemaKey = (t.table_schema || "").toLowerCase();
        const tableKey = t.table_name.toLowerCase();
        const fullKey = schemaKey ? `${schemaKey}.${tableKey}` : tableKey;
        const cols = colsByTableKey[fullKey] || [];

        // Entities from live metadata: primary keys (COLUMN_KEY='PRI') and the
        // source columns of foreign-key constraints. Deduped by column name;
        // a column that is both PK and FK stays as the primary entity.
        const entities: any[] = [];
        const seenEntity = new Set<string>();
        meta.columns.forEach((c: any) => {
          if (c.table_name.toLowerCase() !== tableKey) return;
          if (!c.is_primary_key || isSensitiveColumn(c.column_name)) return;
          const key = c.column_name.toLowerCase();
          if (seenEntity.has(key)) return;
          seenEntity.add(key);
          entities.push({ name: c.column_name, type: "primary", expr: c.column_name });
        });
        (meta.relationships || []).forEach((r: any) => {
          if (!r.sourceTable || r.sourceTable.toLowerCase() !== tableKey) return;
          if (!r.sourceColumn || isSensitiveColumn(r.sourceColumn)) return;
          const key = r.sourceColumn.toLowerCase();
          if (seenEntity.has(key)) return;
          seenEntity.add(key);
          entities.push({ name: r.sourceColumn, type: "foreign", expr: r.sourceColumn });
        });

        // Measures: a distinct count over the primary key when one exists,
        // plus the default row count. Both are grounded aggregations.
        const measures: any[] = [];
        const primaryEntity = entities.find((e) => e.type === "primary");
        if (primaryEntity) {
          measures.push({ name: `distinct_${primaryEntity.name}`, type: "measure", agg: "count_distinct", expr: primaryEntity.name });
        }
        measures.push({ name: "row_count", type: "measure", agg: "count", expr: "1" });

        payload.semantic_models.push({
          name: t.table_name,
          description: `Auto-generated model for physical table ${t.table_name}`,
          entities,
          dimensions: cols,
          measures,
        });
      });
    } catch (err) {
      console.error(`Skipping metadata fetch for connection ${conn.id}:`, (err as Error).message);
    }
  }

  // Existing KPI → semantic_models + metrics (unchanged format)
  kpis.forEach((m) => {
    if (tableName && !m.table_name) return;
    if (tableName && m.table_name && m.table_name.toLowerCase() !== tableName.toLowerCase()) return;
    const dims: string[] = safeJsonParse(m.dimensions) || [];
    const safeName = m.metric_name.toLowerCase().replace(/\s+/g, "_");

    const baseModel: any = {
      name: safeName + "_base",
      description: `Base model mapping for custom KPI: ${m.metric_name}`,
      entities: [],
      dimensions: dims.map((d: string) => ({ name: d, type: "categorical", expr: d })),
      measures: [{ name: safeName + "_measure", type: "measure", agg: deriveSqlAgg(m.formula, m.metric_type), expr: m.formula || "SUM()" }],
    };
    payload.semantic_models.push(baseModel);

    const metric: any = {
      name: safeName,
      description: m.metric_name,
      type: "derived",
      measures: [safeName + "_measure"],
      dimensions: dims,
      expr: safeName + "_measure",
    };

    payload.metrics.push(metric);
  });

  // Build ai_catalog with NEW compilation hints
  payload.ai_catalog = await buildAiCatalog(connections, kpis, tableName, metadataCache);

  return payload;
};

// ============================================================================
// ROUTES (unchanged)
// ============================================================================

const getAll = async (
  req: Request<any, any, any, { tableName?: string }>,
  res: Response<ApiResponse<any>>,
  next: NextFunction,
): Promise<void> => {
  const tableName = req.query.tableName as string | undefined;
  try {
    const [connRows] = await pool.query<RowDataPacket[]>("SELECT * FROM db_connections ORDER BY created_at DESC");
    const [kpiRows] = await pool.query<RowDataPacket[]>(
      `SELECT k.*, c.connection_name, c.host
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       ORDER BY c.connection_name, k.created_at DESC`
    );
    res.json({ data: await buildPayloadAsync(connRows as DatabaseConnection[], kpiRows, tableName) });
  } catch (err) {
    next(err);
  }
};

const getByConnection = async (
  req: Request<{ connectionId: string }, any, any, { tableName?: string }>,
  res: Response<ApiResponse<any>>,
  next: NextFunction,
): Promise<void> => {
  const { connectionId } = req.params;
  const tableName = req.query.tableName as string | undefined;
  try {
    const [connRows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ?",
      [connectionId]
    );
    if (connRows.length === 0) {
      res.status(404).json({
        error: "Connection not found",
        detail: `Connection with ID ${connectionId} does not exist.`
      } as any);
      return;
    }
    const [kpiRows] = await pool.query<RowDataPacket[]>(
      `SELECT k.*, c.connection_name, c.host
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       WHERE k.connection_id = ?
       ORDER BY k.created_at DESC`,
      [connectionId]
    );
    res.json({ data: await buildPayloadAsync(connRows as DatabaseConnection[], kpiRows, tableName) });
  } catch (err) {
    next(err);
  }
};

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();
  router.get("/", getAll);
  router.get("/:connectionId", getByConnection);
  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};

// ============================================================================
// EXPORTS
// ============================================================================

export { buildAiCatalog, buildPayloadAsync };
export type { AiDatasetDefinition, AiDatasetColumn, AiDatasetMetric, AiRelationship, GlobalAiKpi, AiCatalogContext } from "../../types/types";
