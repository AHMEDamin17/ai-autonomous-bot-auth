// ============================================================================
// backend/src/routes/semanticLayer/kpiMetrics.ts
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import pool from "../../db/connection";
import {
  KpiMetric,
  CreateKpiMetricPayload,
  UpdateKpiMetricPayload,
  ApiResponse,
  ApiError,
  DatabaseConnection,
  FilterNode,
  FilterCondition,
  FilterGroup,
  KpiJoinSpec,
  SqlFilterOp,
  FilterOperator,
} from "../../types/types";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import { fetchMetadata } from "./dataCatalog";
import { resolveColumnAcrossDatasets, getDynamicDataset } from "../../analytics/utils/resolvers";
import { validateSqlExpression } from "../../utils/sqlValidator";
import { getJoinConditions, joinConditionKey, normalizeJoinConditions } from "../../analytics/utils/joinSpecs";
import { requireRole } from "../../middleware/requireRole";
import { z } from "zod";


// ============================================================================
// ZOD VALIDATION SCHEMAS (defined at top for reuse)
// ============================================================================

const QualifiedColumnRefSchema = z.string().trim().min(1).refine(
  (columnRef) =>
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(columnRef),
  { message: "Column reference must use the qualified table.column format" },
);

const NULL_FILTER_OPS = new Set<SqlFilterOp>(["is_null", "not_null"]);

const FilterConditionSchema: z.ZodSchema<any> = z.object({
  type: z.literal("condition"),
  field: QualifiedColumnRefSchema,
  op: z.enum([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "between",
    "relative",
    "is_null",
    "not_null",
  ]),
  value: z.any().optional(),
}).superRefine((condition, ctx) => {
  if (NULL_FILTER_OPS.has(condition.op)) return;
  const value = condition.value;
  if (condition.op === "between") {
    const range =
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const start = range?.start;
    const end = range?.end;
    if (
      start === undefined ||
      start === null ||
      end === undefined ||
      end === null ||
      (typeof start === "string" && start.trim().length === 0) ||
      (typeof end === "string" && end.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "BETWEEN requires both a start and an end value",
      });
    }
    return;
  }
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "A filter value is required unless the operator is IS NULL or IS NOT NULL",
    });
  }
});

const FilterGroupSchema: z.ZodSchema<FilterGroup> = z.lazy(() => z.object({
  type: z.literal("group"),
  operator: z.enum(["AND", "OR"]),
  children: z.array(FilterNodeSchema).min(1),
}));

const FilterNodeSchema: z.ZodSchema<any> = z.union([
  FilterConditionSchema,
  FilterGroupSchema,
]);

const KpiJoinConditionSchema = z.object({
  leftTable: z.string().min(1).optional(),
  leftColumn: z.string().min(1),
  rightTable: z.string().min(1).optional(),
  rightColumn: z.string().min(1),
  joinCondition: z.enum(["fk", "inferred", "manual", "dimension_match"]).optional(),
});

const KpiJoinSpecSchema = z.object({
  type: z.preprocess((value) => String(value || "INNER").toUpperCase(), z.enum(["INNER", "LEFT", "RIGHT", "FULL"])),
  leftTable: z.string().min(1),
  leftColumn: z.string().min(1),
  rightTable: z.string().min(1),
  rightColumn: z.string().min(1),
  conditions: z.array(KpiJoinConditionSchema).min(1).optional(),
  joinCondition: z.enum(["fk", "inferred", "manual", "dimension_match"]).optional(),
});

export function validateKpiJoinTree(
  involvedTables: string[],
  joinSpec: KpiJoinSpec[] = [],
): string | null {
  const tableKeys = involvedTables.map((tableName) => normalizeDatasetKey(tableName));
  const uniqueTableKeys = new Set(tableKeys);

  if (uniqueTableKeys.size !== tableKeys.length) {
    return "involved_tables contains duplicate table references";
  }

  if (tableKeys.length === 1) {
    return joinSpec.length > 0
      ? "A single-table KPI cannot contain joins"
      : null;
  }

  if (joinSpec.length !== tableKeys.length - 1) {
    return `A ${tableKeys.length}-table KPI requires exactly ${tableKeys.length - 1} connected join${tableKeys.length - 1 === 1 ? "" : "s"}`;
  }

  const connected = new Set<string>([tableKeys[0]]);
  for (let index = 0; index < joinSpec.length; index++) {
    const join = joinSpec[index];
    const leftKey = normalizeDatasetKey(join.leftTable);
    const rightKey = normalizeDatasetKey(join.rightTable);

    if (!uniqueTableKeys.has(leftKey) || !uniqueTableKeys.has(rightKey)) {
      return `Join ${index + 1} references a table outside involved_tables`;
    }
    if (leftKey === rightKey) {
      return `Join ${index + 1} cannot join a table to itself`;
    }
    if (!connected.has(leftKey)) {
      return `Join ${index + 1} left table must already be connected to the KPI root`;
    }
    if (connected.has(rightKey)) {
      return `Join ${index + 1} creates a duplicate or cyclic table connection`;
    }

    const conditions = getJoinConditions(join);
    if (conditions.length === 0) {
      return `Join ${index + 1} requires at least one ON condition`;
    }
    const uniqueConditions = new Set(conditions.map(joinConditionKey));
    if (uniqueConditions.size !== conditions.length) {
      return `Join ${index + 1} contains a duplicate ON condition`;
    }
    if (conditions.some((condition) =>
      normalizeDatasetKey(condition.leftTable) !== leftKey
      || normalizeDatasetKey(condition.rightTable) !== rightKey
    )) {
      return `Join ${index + 1} ON conditions must use that join's left and right tables`;
    }

    connected.add(rightKey);
  }

  return connected.size === uniqueTableKeys.size
    ? null
    : "join_spec does not connect every involved table";
}

const CreateKpiSchemaBase = z.object({
  connection_id: z.number().int().positive(),
  metric_name: z.string().min(1).max(255),
  department: z.string().min(1).max(100),
  metric_type: z.string().min(1).max(100),
  formula: z.string().min(1),
  format: z.enum(["currency", "number", "percent"]).default("number"),
  dimensions: z.array(QualifiedColumnRefSchema).default([]),
  involved_tables: z.array(z.string()).min(1, "At least one table required in involved_tables"),
  join_spec: z.array(KpiJoinSpecSchema).optional(),
  // "No filters" is a legitimate, common KPI state (matches all rows) — accept
  // null/omitted alongside a real filter tree. A *present* group must still
  // have at least one child (enforced by FilterGroupSchema below); only the
  // top-level "there is no filter at all" case is optional/nullable here.
  filter_logic: FilterNodeSchema.nullable().optional(),
  select_columns: z.array(z.string()).optional(),
});

export const CreateKpiSchema = CreateKpiSchemaBase.superRefine((data, ctx) => {
  const joinError = validateKpiJoinTree(data.involved_tables, data.join_spec || []);
  if (joinError) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: joinError, path: ["join_spec"] });
  }
});

export const UpdateKpiSchema = CreateKpiSchemaBase.partial().superRefine((data, ctx) => {
  if (data.involved_tables && data.join_spec !== undefined) {
    const joinError = validateKpiJoinTree(data.involved_tables, data.join_spec);
    if (joinError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: joinError, path: ["join_spec"] });
    }
  }
});

export type CreateKpiPayload = z.infer<typeof CreateKpiSchema>;
export type UpdateKpiPayload = z.infer<typeof UpdateKpiSchema>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function safeJsonParse(str: string | null | undefined, fallback: any = []): any {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (err) {
    console.error(`Failed to parse JSON string "${str}":`, err);
    return fallback;
  }
}

type CatalogDatasetRef = {
  name: string;
  physicalName: string;
  tableName: string;
  tableSchema?: string | null;
  columns: Array<{ name: string; data_type?: string; is_primary_key?: boolean; is_auto_increment?: boolean }>;
};

function normalizeDatasetKey(value: string | undefined | null): string {
  return String(value || "")
    .replace(/[`"\[\]]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/\./g, "_");
}

function logicalTableName(tableName: string, tableSchema?: string | null): string {
  const normalizedTable = String(tableName || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalizedTable) return normalizedTable;
  if (normalizedTable.includes(".")) return normalizedTable.replace(/\./g, "_");
  const normalizedSchema = String(tableSchema || "").trim().toLowerCase().replace(/\s+/g, "_");
  return normalizedSchema ? `${normalizedSchema}_${normalizedTable}` : normalizedTable;
}

function buildCatalogDatasets(catalogContext: any): CatalogDatasetRef[] {
  const records = [
    ...(catalogContext.tables || []),
    ...(catalogContext.views || []),
  ];

  return records.map((record: any) => {
    const tableName = String(record.table_name || "");
    const tableSchema = record.table_schema ? String(record.table_schema) : null;
    const physicalName = tableSchema ? `${tableSchema}.${tableName}` : tableName;
    const columns = (catalogContext.columns || [])
      .filter((column: any) => {
        const columnTable = String(column.table_name || "");
        const columnSchema = column.table_schema ? String(column.table_schema) : null;
        return columnTable === tableName && (!columnSchema || !tableSchema || columnSchema === tableSchema);
      })
      .map((column: any) => ({
        name: column.column_name,
        data_type: column.data_type,
        is_primary_key: Boolean(column.is_primary_key),
        is_auto_increment: Boolean(column.is_auto_increment),
      }));

    return {
      name: logicalTableName(tableName, tableSchema),
      physicalName,
      tableName,
      tableSchema,
      columns,
    };
  });
}

function catalogDatasetAliases(dataset: CatalogDatasetRef): Set<string> {
  const aliases = new Set<string>();
  [
    dataset.name,
    dataset.physicalName,
    dataset.tableName,
    dataset.physicalName.replace(/\./g, "_"),
    dataset.tableSchema ? `${dataset.tableSchema}.${dataset.tableName}` : "",
    dataset.tableSchema ? `${dataset.tableSchema}_${dataset.tableName}` : "",
  ]
    .filter(Boolean)
    .forEach((alias) => aliases.add(normalizeDatasetKey(alias)));
  return aliases;
}

function findCatalogDataset(ref: string, catalogDatasets: CatalogDatasetRef[]): CatalogDatasetRef | undefined {
  const normalized = normalizeDatasetKey(ref);
  return catalogDatasets.find((dataset) => catalogDatasetAliases(dataset).has(normalized));
}

function normalizeTableRefForCatalog(ref: string, catalogDatasets: CatalogDatasetRef[]): string {
  return findCatalogDataset(ref, catalogDatasets)?.name || ref;
}

function splitColumnRefForCatalog(
  ref: string,
  catalogDatasets: CatalogDatasetRef[],
): { dataset: CatalogDatasetRef; columnName: string } | null {
  const clean = String(ref || "").replace(/[`"\[\]]/g, "").trim();
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return null;

  for (let i = parts.length - 1; i >= 1; i--) {
    const tableRef = parts.slice(0, i).join(".");
    const dataset = findCatalogDataset(tableRef, catalogDatasets);
    if (dataset) {
      return { dataset, columnName: parts.slice(i).join(".") };
    }
  }

  return null;
}

function normalizeColumnRefForCatalog(ref: string, catalogDatasets: CatalogDatasetRef[]): string {
  const split = splitColumnRefForCatalog(ref, catalogDatasets);
  return split ? `${split.dataset.name}.${split.columnName}` : ref;
}

function normalizeJoinSpecForCatalog(joinSpec: KpiJoinSpec[] | undefined, catalogDatasets: CatalogDatasetRef[]): KpiJoinSpec[] {
  return (joinSpec || []).map((join) => normalizeJoinConditions({
    ...join,
    type: String(join.type || "INNER").toUpperCase() as KpiJoinSpec["type"],
    leftTable: normalizeTableRefForCatalog(join.leftTable, catalogDatasets),
    rightTable: normalizeTableRefForCatalog(join.rightTable, catalogDatasets),
    conditions: getJoinConditions(join).map((condition) => ({
      ...condition,
      leftTable: normalizeTableRefForCatalog(condition.leftTable || join.leftTable, catalogDatasets),
      rightTable: normalizeTableRefForCatalog(condition.rightTable || join.rightTable, catalogDatasets),
    })),
  }));
}

function validateJoinColumns(
  join: KpiJoinSpec,
  catalogDatasets: CatalogDatasetRef[],
): string | null {
  for (const condition of getJoinConditions(join)) {
    const leftTable = condition.leftTable || join.leftTable;
    const rightTable = condition.rightTable || join.rightTable;
    const leftDs = findCatalogDataset(leftTable, catalogDatasets);
    const rightDs = findCatalogDataset(rightTable, catalogDatasets);
    if (!leftDs?.columns.some((column) => column.name === condition.leftColumn)) {
      return `Column '${condition.leftColumn}' not found in '${leftTable}'`;
    }
    if (!rightDs?.columns.some((column) => column.name === condition.rightColumn)) {
      return `Column '${condition.rightColumn}' not found in '${rightTable}'`;
    }
  }
  return null;
}

function normalizeFilterRefsForCatalog(node: FilterNode | undefined, catalogDatasets: CatalogDatasetRef[]): FilterNode | undefined {
  if (!node) return node;
  if (node.type === "condition") {
    const field = normalizeColumnRefForCatalog(node.field, catalogDatasets);
    return NULL_FILTER_OPS.has(node.op)
      ? { type: "condition", field, op: node.op }
      : { ...node, field } as FilterNode;
  }
  if (node.type === "group") {
    return {
      ...node,
      children: node.children.map((child) => normalizeFilterRefsForCatalog(child, catalogDatasets)).filter(Boolean) as FilterNode[],
    } as FilterNode;
  }
  return node;
}

function columnExistsInTables(field: string, involvedTables: string[], catalogDatasets: CatalogDatasetRef[]): boolean {
  const normalizedTables = involvedTables.map((tableName) => normalizeTableRefForCatalog(tableName, catalogDatasets));
  const split = splitColumnRefForCatalog(field, catalogDatasets);
  const columnName = (split?.columnName || String(field || "").split(".").pop() || "").toLowerCase();
  const candidateTables = split ? [split.dataset.name] : normalizedTables;

  return candidateTables.some((tableName) => {
    const dataset = findCatalogDataset(tableName, catalogDatasets);
    if (!dataset || !normalizedTables.includes(dataset.name)) return false;
    return dataset.columns.some((column) => column.name.toLowerCase() === columnName);
  });
}



// ============================================================================
// ROUTE HANDLERS
// ============================================================================

// GET all KPIs
const getAll = async (
  _req: Request,
  res: Response<ApiResponse<any[]>>,
  next: NextFunction,
): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT k.id, k.connection_id, c.connection_name, k.metric_name,
              k.department, k.metric_type, k.formula, k.table_name, k.format,
              k.dimensions, k.involved_tables, 
              k.join_spec, k.filter_logic, k.select_columns, k.created_at
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       ORDER BY k.created_at DESC`,
    );

    const metrics = rows.map((r) => {
      const kpi = {
        ...r,
        dimensions: safeJsonParse(r.dimensions),
        involved_tables: safeJsonParse(r.involved_tables),
        join_spec: safeJsonParse(r.join_spec),
        filter_logic: r.filter_logic ? safeJsonParse(r.filter_logic) : null,
        select_columns: safeJsonParse(r.select_columns),
        format: r.format || "number",
      } as KpiMetric;

      return kpi;
    });

    res.json({ data: metrics });
  } catch (err) {
    next(err);
  }
};

// GET single KPI by ID
const getById = async (
  req: Request<{ id: string }>,
  res: Response<ApiResponse<any>>,
  next: NextFunction,
): Promise<void> => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT k.id, k.connection_id, c.connection_name, k.metric_name,
              k.department, k.metric_type, k.formula, k.table_name, k.format,
              k.dimensions, k.involved_tables, 
              k.join_spec, k.filter_logic, k.select_columns, k.created_at
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       WHERE k.id = ?`,
      [req.params.id]
    );

    if (!rows.length) {
      res.status(404).json({ data: null, error: `KPI metric with id ${req.params.id} not found` } as unknown as ApiResponse<any>);
      return;
    }

    const r = rows[0];
    const kpi = {
      ...r,
      dimensions: safeJsonParse(r.dimensions),
      involved_tables: safeJsonParse(r.involved_tables),
      join_spec: safeJsonParse(r.join_spec),
      filter_logic: r.filter_logic ? safeJsonParse(r.filter_logic) : null,
      select_columns: safeJsonParse(r.select_columns),
      format: r.format || "number",
    } as KpiMetric;

    res.json({ data: kpi });
  } catch (err) {
    next(err);
  }
};

// CREATE KPI
const create = async (
  req: Request<object, object, CreateKpiPayload>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const parse = CreateKpiSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Validation failed", detail: JSON.stringify(parse.error.flatten()) } as unknown as ApiResponse<any>);
    return;
  }

  const {
    connection_id,
    metric_name,
    department,
    metric_type,
    formula,
    format,
    dimensions,
    involved_tables,
    join_spec,
    filter_logic,
    select_columns,
  } = parse.data;

  // 1. Verify connection exists & is SQL
  let connection: DatabaseConnection;
  try {
    const [connRows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ?",
      [connection_id],
    );
    if (!connRows.length) {
      res.status(404).json({ error: "Connection not found", detail: `No connection with id ${connection_id}` } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }
    connection = connRows[0] as DatabaseConnection;
    const dbType = connection.db_type?.toLowerCase();
    if (dbType === "mongodb" || dbType === "redis") {
      res.status(400).json({ error: "Unsupported Database Type", detail: "KPIs require SQL database" } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }
  } catch (err) {
    next(err);
    return;
  }

  // 2-9. Fetch catalog and validate involved_tables/join_spec/filter_logic/
  // formula/dimensions/select_columns. Wrapped in try/catch — fetchMetadata
  // hits the target DB and, unguarded, a rejection here (unreachable DB,
  // auth failure, driver error) would leave the request hanging forever
  // with no response instead of surfacing a normal error.
  let normalizedInvolvedTables: string[];
  let normalizedJoinSpec: ReturnType<typeof normalizeJoinSpecForCatalog>;
  let normalizedFilterLogic: FilterNode | null | undefined;
  let normalizedDimensions: string[];
  let normalizedSelectColumns: string[] | undefined;
  try {
    // 2. Fetch catalog for this connection
    const catalogContext = await fetchMetadata(connection);
    const catalogDatasets = buildCatalogDatasets(catalogContext);
    normalizedInvolvedTables = involved_tables.map((tableName) => normalizeTableRefForCatalog(tableName, catalogDatasets));
    normalizedJoinSpec = normalizeJoinSpecForCatalog(join_spec, catalogDatasets);
    normalizedFilterLogic = normalizeFilterRefsForCatalog(filter_logic, catalogDatasets);
    normalizedDimensions = (dimensions || []).map((dimension) => normalizeColumnRefForCatalog(dimension, catalogDatasets));
    normalizedSelectColumns = select_columns?.map((column) => normalizeColumnRefForCatalog(column, catalogDatasets));

    // 3. Validate involved_tables exist in catalog
    const catalogTables = new Set(catalogDatasets.map(d => d.name));
    for (const t of normalizedInvolvedTables) {
      if (!catalogTables.has(t)) {
        res.status(400).json({ error: `Table '${t}' not found in catalog for this connection` } as unknown as import("../../types/types").ApiResponse<any>);
        return;
      }
    }

    // 4. Validate join_spec topology and columns
    const joinTreeError = validateKpiJoinTree(normalizedInvolvedTables, normalizedJoinSpec);
    if (joinTreeError) {
      res.status(400).json({ error: joinTreeError } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }
    if (normalizedJoinSpec.length) {
      for (const j of normalizedJoinSpec) {
        if (!normalizedInvolvedTables.includes(j.leftTable) || !normalizedInvolvedTables.includes(j.rightTable)) {
          res.status(400).json({ error: `Join references table not in involved_tables` } as unknown as import("../../types/types").ApiResponse<any>);
          return;
        }
        const columnError = validateJoinColumns(j, catalogDatasets);
        if (columnError) {
          res.status(400).json({ error: columnError } as unknown as import("../../types/types").ApiResponse<any>);
          return;
        }
      }
    }

    // 5. Validate filter_logic columns exist
    if (normalizedFilterLogic) {
      const validateColumns = (node: FilterNode): string | null => {
        if (node.type === "condition") {
          const found = columnExistsInTables(node.field, normalizedInvolvedTables, catalogDatasets);
          if (!found) return `Column '${node.field}' not found in involved_tables: [${normalizedInvolvedTables.join(", ")}]`;
          return null;
        }
        if (node.type === "group") {
          for (const child of node.children) {
            const err = validateColumns(child);
            if (err) return err;
          }
          return null;
        }
        return null;
      };
      const err = validateColumns(normalizedFilterLogic);
      if (err) {
        res.status(400).json({ error: "Invalid filter_logic", detail: err } as unknown as import("../../types/types").ApiResponse<any>);
        return;
      }
    }

    // 6. Validate formula
    const formulaCheck = validateSqlExpression(formula);
    if (!formulaCheck.valid) {
      res.status(400).json({ error: "Invalid formula", detail: formulaCheck.error } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }

    // 7. Validate dimensions
    for (const dim of normalizedDimensions) {
      if (!columnExistsInTables(dim, normalizedInvolvedTables, catalogDatasets)) {
        res.status(400).json({ error: `Dimension '${dim}' not found in involved_tables` } as unknown as import("../../types/types").ApiResponse<any>);
        return;
      }
    }

    // 8. Validate select_columns if provided
    if (normalizedSelectColumns?.length) {
      for (const col of normalizedSelectColumns) {
        if (!columnExistsInTables(col, normalizedInvolvedTables, catalogDatasets)) {
          res.status(400).json({ error: `Select column '${col}' not found in involved_tables` } as unknown as import("../../types/types").ApiResponse<any>);
          return;
        }
      }
    }
    // 9. (Removed legacy raw SQL validation)
  } catch (err) {
    next(err);
    return;
  }

  // 10. Insert
  try {
    const dimensionsJson = JSON.stringify(normalizedDimensions || []);
    const involvedTablesJson = JSON.stringify(normalizedInvolvedTables);
    const joinSpecJson = JSON.stringify(normalizedJoinSpec || []);
    const filterLogicJson = normalizedFilterLogic ? JSON.stringify(normalizedFilterLogic) : null;
    const selectColumnsJson = normalizedSelectColumns ? JSON.stringify(normalizedSelectColumns) : null;

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO kpi_metrics 
        (connection_id, metric_name, department, metric_type, formula, format, 
         dimensions, involved_tables, join_spec, filter_logic, select_columns,
         created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        connection_id,
        metric_name.trim(),
        department,
        metric_type,
        formula.trim(),
        format || "number",
        dimensionsJson,
        involvedTablesJson,
        joinSpecJson,
        filterLogicJson,
        selectColumnsJson,
        req.user!.id,
        req.user!.id,
      ],
    );

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT k.id, k.connection_id, c.connection_name, k.metric_name,
              k.department, k.metric_type, k.formula, k.table_name, k.format,
              k.dimensions, k.involved_tables, 
              k.join_spec, k.filter_logic, k.select_columns, k.created_at,
              k.updated_at, k.created_by, k.updated_by
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       WHERE k.id = ?`,
      [result.insertId],
    );

    const saved = rows[0];
    const kpi = {
      ...saved,
      dimensions: safeJsonParse(saved.dimensions),
      involved_tables: safeJsonParse(saved.involved_tables),
      join_spec: safeJsonParse(saved.join_spec),
      filter_logic: saved.filter_logic ? safeJsonParse(saved.filter_logic) : null,
      select_columns: safeJsonParse(saved.select_columns),
      format: saved.format || "number",
    } as KpiMetric;

    res.status(201).json({ 
      data: kpi, 
      message: "KPI metric created successfully" 
    });
  } catch (err) {
    next(err);
  }
};

// UPDATE KPI
const update = async (
  req: Request<{ id: string }, object, UpdateKpiPayload>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const parse = UpdateKpiSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "Validation failed", detail: JSON.stringify(parse.error.flatten()) } as unknown as ApiResponse<any>);
    return;
  }

  const { id } = req.params;
  const data: UpdateKpiPayload = { ...parse.data };

  try {
    // Check existing
    const [existing] = await pool.query<RowDataPacket[]>("SELECT * FROM kpi_metrics WHERE id = ?", [id]);
    if (!existing.length) {
      res.status(404).json({ data: null, error: `KPI metric with id ${id} not found` } as unknown as ApiResponse<any>);
      return;
    }

    {
      const [connRows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM db_connections WHERE id = ?",
        [existing[0].connection_id]
      );
      const connection = connRows[0] as DatabaseConnection;
      const catalogContext = await fetchMetadata(connection);
      const catalogDatasets = buildCatalogDatasets(catalogContext);

      const tables = (data.involved_tables || safeJsonParse(existing[0].involved_tables) || []) as string[];
      const dimensions = (data.dimensions || safeJsonParse(existing[0].dimensions) || []) as string[];
      const selectColumns = (data.select_columns || safeJsonParse(existing[0].select_columns) || []) as string[];
      const joinSpec = (data.join_spec || safeJsonParse(existing[0].join_spec) || []) as KpiJoinSpec[];
      const filterLogic = data.filter_logic !== undefined
        ? data.filter_logic
        : (existing[0].filter_logic ? safeJsonParse(existing[0].filter_logic) : null);
      const formula = data.formula || existing[0].formula;
      const normalizedTables = tables.map((tableName) => normalizeTableRefForCatalog(tableName, catalogDatasets));
      const normalizedDimensions = dimensions.map((dimension) => normalizeColumnRefForCatalog(dimension, catalogDatasets));
      const normalizedSelectColumns = selectColumns.map((column) => normalizeColumnRefForCatalog(column, catalogDatasets));
      const normalizedJoinSpec = normalizeJoinSpecForCatalog(joinSpec, catalogDatasets);
      const normalizedFilterLogic = normalizeFilterRefsForCatalog(filterLogic, catalogDatasets);

      if (data.involved_tables !== undefined) data.involved_tables = normalizedTables;
      if (data.dimensions !== undefined) data.dimensions = normalizedDimensions;
      if (data.select_columns !== undefined) data.select_columns = normalizedSelectColumns;
      if (data.join_spec !== undefined) data.join_spec = normalizedJoinSpec;
      if (data.filter_logic !== undefined) data.filter_logic = normalizedFilterLogic;

      const catalogTables = new Set(catalogDatasets.map(d => d.name));

      for (const tableName of normalizedTables) {
        if (!catalogTables.has(tableName)) {
          res.status(400).json({ error: `Table '${tableName}' not found in catalog for this connection` } as unknown as ApiResponse<any>);
          return;
        }
      }

      const joinTreeError = validateKpiJoinTree(normalizedTables, normalizedJoinSpec);
      if (joinTreeError) {
        res.status(400).json({ error: joinTreeError } as unknown as ApiResponse<any>);
        return;
      }
      if (normalizedJoinSpec.length) {
        for (const join of normalizedJoinSpec) {
          if (!normalizedTables.includes(join.leftTable) || !normalizedTables.includes(join.rightTable)) {
            res.status(400).json({ error: "Join references table not in involved_tables" } as unknown as ApiResponse<any>);
            return;
          }
          const columnError = validateJoinColumns(join, catalogDatasets);
          if (columnError) {
            res.status(400).json({ error: columnError } as unknown as ApiResponse<any>);
            return;
          }
        }
      }

      const columnExists = (field: string): boolean => {
        return columnExistsInTables(field, normalizedTables, catalogDatasets);
      };

      if (normalizedFilterLogic) {
        const validateColumns = (node: FilterNode): string | null => {
          if (node.type === "condition") {
            return columnExists(node.field)
              ? null
              : `Column '${node.field}' not found in involved_tables: [${normalizedTables.join(", ")}]`;
          }
          if (node.type === "group") {
            for (const child of node.children) {
              const err = validateColumns(child);
              if (err) return err;
            }
          }
          return null;
        };
        const err = validateColumns(normalizedFilterLogic);
        if (err) {
          res.status(400).json({ error: "Invalid filter_logic", detail: err } as unknown as ApiResponse<any>);
          return;
        }
      }

      const formulaCheck = validateSqlExpression(formula);
      if (!formulaCheck.valid) {
        res.status(400).json({ error: "Invalid formula", detail: formulaCheck.error } as unknown as ApiResponse<any>);
        return;
      }

      for (const dim of normalizedDimensions) {
        if (!columnExists(dim)) {
          res.status(400).json({ error: `Dimension '${dim}' not found in involved_tables` } as unknown as ApiResponse<any>);
          return;
        }
      }

      for (const col of normalizedSelectColumns) {
        if (!columnExists(col)) {
          res.status(400).json({ error: `Select column '${col}' not found in involved_tables` } as unknown as ApiResponse<any>);
          return;
        }
      }

    }

    // Build update query dynamically
    const fields: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, (v: any) => any> = {
      metric_name: (v) => v.trim(),
      department: (v) => v,
      metric_type: (v) => v,
      formula: (v) => v.trim(),
      format: (v) => v,
      dimensions: (v) => JSON.stringify(v),
      involved_tables: (v) => JSON.stringify(v),
      join_spec: (v) => JSON.stringify(v),
      filter_logic: (v) => v ? JSON.stringify(v) : null,
      select_columns: (v) => v ? JSON.stringify(v) : null,
    };

    for (const [key, transform] of Object.entries(fieldMap)) {
      if (data[key as keyof UpdateKpiPayload] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(transform(data[key as keyof UpdateKpiPayload]));
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: "No valid fields to update" } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }

    fields.push("updated_by = ?");
    values.push(req.user!.id);
    values.push(id);
    await pool.query(`UPDATE kpi_metrics SET ${fields.join(", ")} WHERE id = ?`, values);

    // Return updated
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT k.id, k.connection_id, c.connection_name, k.metric_name,
              k.department, k.metric_type, k.formula, k.table_name, k.format,
              k.dimensions, k.involved_tables, 
              k.join_spec, k.filter_logic, k.select_columns, k.created_at,
              k.updated_at, k.created_by, k.updated_by
       FROM kpi_metrics k
       JOIN db_connections c ON k.connection_id = c.id
       WHERE k.id = ?`,
      [id]
    );

    const saved = rows[0];
    const kpi = {
      ...saved,
      dimensions: safeJsonParse(saved.dimensions),
      involved_tables: safeJsonParse(saved.involved_tables),
      join_spec: safeJsonParse(saved.join_spec),
      filter_logic: saved.filter_logic ? safeJsonParse(saved.filter_logic) : null,
      select_columns: safeJsonParse(saved.select_columns),
      format: saved.format || "number",
    } as KpiMetric;

    res.json({ data: kpi, message: "KPI metric updated successfully" });
  } catch (err) {
    next(err);
  }
};

// DELETE KPI
const remove = async (
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const { id } = req.params;
  try {
    const [result] = await pool.query<ResultSetHeader>(
      "DELETE FROM kpi_metrics WHERE id = ?",
      [id],
    );
    if (result.affectedRows === 0) {
      res.status(404).json({ data: null, error: `KPI metric with id ${id} not found` } as unknown as ApiResponse<any>);
      return;
    }
    res.json({ data: null, message: `KPI metric ${id} removed successfully` });
  } catch (err) {
    next(err);
  }
};

// GET columns for connection (for KPI builder UI)
const getColumns = async (
  req: Request<{ connectionId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const { connectionId } = req.params;
  try {
    const [connRows] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM db_connections WHERE id = ?",
      [connectionId],
    );
    if (!connRows.length) {
      res.status(404).json({ error: `Connection ${connectionId} not found` } as unknown as import("../../types/types").ApiResponse<any>);
      return;
    }
    const connection = connRows[0] as DatabaseConnection;
    const meta = await fetchMetadata(connection);
    const catalogDatasets = buildCatalogDatasets(meta);

    const columnsByTable: Record<string, { name: string; data_type: string; is_primary_key: boolean; is_auto_increment: boolean }[]> = {};
    meta.columns.forEach((c: any) => {
      const tableKey = `${c.table_schema || ""}.${c.table_name}`;
      if (!columnsByTable[tableKey]) columnsByTable[tableKey] = [];
      columnsByTable[tableKey].push({
        name: c.column_name,
        data_type: c.data_type,
        is_primary_key: Boolean(c.is_primary_key),
        is_auto_increment: Boolean(c.is_auto_increment),
      });
    });

    const result = meta.tables.map((t: any) => ({
      table_name: t.table_name,
      table_schema: t.table_schema,
      logical_name: logicalTableName(t.table_name, t.table_schema),
      physical_name: t.table_schema ? `${t.table_schema}.${t.table_name}` : t.table_name,
      columns: columnsByTable[`${t.table_schema || ""}.${t.table_name}`] || [],
    }));

    // Include FK relationships for join auto-suggestion
    const relationships = (meta.relationships || []).map((r: any) => ({
      source_table: normalizeTableRefForCatalog(r.sourceTable, catalogDatasets),
      source_column: r.sourceColumn,
      target_table: normalizeTableRefForCatalog(r.targetTable, catalogDatasets),
      target_column: r.targetColumn,
      constraint_name: r.constraintName || null,
    }));

    res.json({ data: result, relationships });
  } catch (err) {
    next(err);
  }
};

// ============================================================================
// ROUTER
// ============================================================================

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();
  router.get("/", getAll);
  router.get("/columns/:connectionId", getColumns);
  router.get("/:id", getById);
  router.post("/", requireRole("admin"), create);
  router.patch("/:id", requireRole("admin"), update);
  router.delete("/:id", requireRole("admin"), remove);
  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};
