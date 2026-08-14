/**
 * Safe SQL Compiler — Phase 1.1 of the End-to-End Refactor Plan.
 *
 * Responsibilities:
 *   1. Build SQL by appending pre-validated fragments and parameter placeholders.
 *   2. Enforce identifier allowlists — never interpolate raw user input.
 *   3. Render dialect-specific parameter markers (`?`, `$1`, `@p1`).
 *   4. Emit parameterised compiled queries safe for mysql2/pg/mssql/etc.
 *
 * What this module WILL NOT do:
 *   - Validate KPI `expressionSql` or `inclusionFilters` (those are KPI editor
 *     concerns — see `kpiMetrics.ts` `validateSqlExpression` / `validateFilterFragment`).
 *   - Execute the query — that belongs to `LiveAdapter`.
 *   - Know about HTTP, sessions, or LLM planners.
 *
 * Usage:
 *
 *   import { compileKpiQuery } from "../sql/compiler";
 *
 *   const compiled = compileKpiQuery(plan, "postgresql", resolver, metricSql);
 *   await pgPool.query(compiled.sql, compiled.params);
 */

import type {
  CompiledQuery,
  DialectType,
  JoinSpec,
  CompileKpiOptions,
  AiDatasetDefinition,
  FilterNode,
  CompileOptions,
  SqlFilterOp,
  SqlFilter,
  QueryPlanInput
} from "../types/types";
import { ERROR_CODES, type ErrorCode } from "../types/errors";
import { getJoinConditions, mergeMasterJoinSpecs } from "../analytics/utils/joinSpecs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Resolves a logical column reference (which may be qualified as
 * "table.column" or just "column") into a concrete physical table +
 * column pair. The compiler never invents identifiers — if the resolver
 * returns `null` for any reference, compilation fails.
 */
export type ColumnResolver = (
  columnRef: string,
) => { table: string; column: string } | null;

/**
 * Special resolver key — pass `<datasetName>.__table__` to obtain the
 * physical table backing a dataset. This is the only way to teach the
 * compiler which FROM/JOIN target to render.
 */
export const TABLE_KEY = "__table__" as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SqlCompileError extends Error {
  /** Stable error code — frontend & monitoring can branch on this. */
  public readonly code: ErrorCode | string;
  /** Field of the plan that caused the failure (for telemetry). */
  public readonly field: string;
  constructor(code: ErrorCode | string, field: string, message: string) {
    super(message);
    this.name = "SqlCompileError";
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Identifier safety
// ---------------------------------------------------------------------------

/**
 * Allowed: letters, digits, underscores. Must start with a letter or
 * underscore. Optional second segment joined by `.` for qualified names.
 * Length capped to 64 chars (most DB identifier limits).
 */
const SAFE_IDENT_SINGLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_IDENT_QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63})?$/;

/**
 * Identifier keywords that must NEVER be used as a table/column name.
 * These are reserved by every supported dialect.
 */
const RESERVED_KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset",
  "union", "join", "inner", "left", "right", "full", "outer", "cross", "on",
  "insert", "update", "delete", "drop", "alter", "truncate", "create", "grant",
  "revoke", "into", "values", "set", "as", "and", "or", "not", "null", "is",
  "like", "in", "between", "exists", "case", "when", "then", "else", "end",
  "true", "false", "table", "database", "schema", "index", "view", "function",
  "procedure", "trigger", "begin", "commit", "rollback", "transaction",
]);

export function isSafeIdentifier(name: string): boolean {
  if (!SAFE_IDENT_QUALIFIED.test(name)) return false;
  const parts = name.split(".");
  for (const p of parts) {
    if (!SAFE_IDENT_SINGLE.test(p)) return false;
    if (RESERVED_KEYWORDS.has(p.toLowerCase())) return false;
  }
  return true;
}

export function quoteId(name: string, dialect: DialectType): string {
  if (!isSafeIdentifier(name)) {
    throw new SqlCompileError(
      ERROR_CODES.UNSAFE_IDENTIFIER,
      "identifier",
      `Unsafe identifier: ${JSON.stringify(name)}`,
    );
  }
  if (name.includes(".")) {
    return name
      .split(".")
      .map((part) => quoteId(part, dialect))
      .join(".");
  }
  switch (dialect) {
    case "sqlserver":
      return `[${name}]`;
    case "mysql":
    case "sqlite":
    case "bigquery":
      return `\`${name}\``;
    case "postgresql":
    case "snowflake":
    case "databricks":
      return `"${name}"`;
    default:
      return `"${name}"`;
  }
}

export function paramPlaceholder(index: number, dialect: DialectType): string {
  if (!Number.isInteger(index) || index < 1 || index > 9999) {
    throw new SqlCompileError(
      ERROR_CODES.BAD_PARAM_INDEX,
      "params",
      `Param index out of range: ${index}`,
    );
  }
  switch (dialect) {
    case "postgresql":
      return `$${index}`;
    case "sqlserver":
      return `@p${index}`;
    default:
      return "?";
  }
}

// ---------------------------------------------------------------------------
// Date grain (dialect-specific)
// ---------------------------------------------------------------------------

type Grain = "day" | "week" | "month" | "year";
type DateGrainFn = (col: string, grain: Grain) => string;

const DATE_GRAIN: Record<DialectType, DateGrainFn> = {
  mysql: (c, g) => {
    switch (g) {
      case "day": return `DATE_FORMAT(${c}, '%Y-%m-%d')`;
      case "week": return `DATE_FORMAT(DATE_ADD(${c}, INTERVAL -WEEKDAY(${c}) DAY), '%Y-%m-%d')`;
      case "month": return `DATE_FORMAT(${c}, '%Y-%m-01')`;
      case "year": return `DATE_FORMAT(${c}, '%Y-01-01')`;
    }
  },
  sqlserver: (c, g) => {
    switch (g) {
      case "day": return `CAST(${c} AS DATE)`;
      case "week": return `DATEADD(DAY, 1 - DATEPART(WEEKDAY, ${c}), CAST(${c} AS DATE))`;
      case "month": return `DATEFROMPARTS(YEAR(${c}), MONTH(${c}), 1)`;
      case "year": return `DATEFROMPARTS(YEAR(${c}), 1, 1)`;
    }
  },
  sqlite: (c, g) => {
    switch (g) {
      case "day": return `strftime('%Y-%m-%d', ${c})`;
      case "week": return `date(${c}, '-6 days', 'weekday 1')`;
      case "month": return `strftime('%Y-%m-01', ${c})`;
      case "year": return `strftime('%Y-01-01', ${c})`;
    }
  },
  postgresql: (c, g) => `DATE_TRUNC('${g}', ${c})`,
  snowflake: (c, g) => `DATE_TRUNC('${g}', ${c})`,
  databricks: (c, g) => `DATE_TRUNC('${g}', ${c})`,
  bigquery: (c, g) => `DATE_TRUNC(${c}, ${g.toUpperCase()})`,
};

// ---------------------------------------------------------------------------
// Safe SQL builder
// ---------------------------------------------------------------------------

export interface CompiledSegment {
  sql: string;
  params: unknown[];
}

/**
 * Append-only SQL builder that only emits segments produced by the helper
 * methods (`append`, `quote`, `bind`). It does NOT support string
 * interpolation of arbitrary user input — that's the entire point.
 */
export class SafeSqlBuilder {
  private readonly parts: string[] = [];
  private readonly params: unknown[] = [];
  private readonly dialect: DialectType;
  private readonly opts: CompileOptions;

  constructor(dialect: DialectType, opts: CompileOptions = {}) {
    this.dialect = dialect;
    this.opts = opts;
  }

  /** Append a pre-validated SQL fragment. */
  append(sql: string): this {
    this.parts.push(sql);
    return this;
  }

  /** Append an identifier (validated against the allowlist). */
  quote(name: string): string {
    return quoteId(name, this.dialect);
  }

  /**
   * Bind a literal value and return its placeholder. Caller substitutes
   * the placeholder in any pre-built SQL fragment.
   */
  bind(value: unknown): string {
    const cap = this.opts.maxParams ?? 1000;
    if (this.params.length >= cap) {
    throw new SqlCompileError(
        ERROR_CODES.PARAM_CAP_EXCEEDED,
        "params",
        `Parameter cap ${cap} exceeded`,
      );
    }
    // Reject obviously dangerous payload types
    if (value === undefined) {
    throw new SqlCompileError(
        ERROR_CODES.UNDEFINED_PARAM,
        "params",
        "Cannot bind `undefined` — caller must coerce to null or omit",
      );
    }
    if (typeof value === "function" || typeof value === "symbol") {
    throw new SqlCompileError(
        ERROR_CODES.BAD_PARAM_TYPE,
        "params",
        `Cannot bind value of type ${typeof value}`,
      );
    }
    this.params.push(value);
    return paramPlaceholder(this.params.length, this.dialect);
  }

  toSegment(): CompiledSegment {
    return {
      sql: this.parts.join("\n"),
      params: this.params.slice(),
    };
  }
}

// ---------------------------------------------------------------------------
// Plan → CompiledQuery
// ---------------------------------------------------------------------------

const OP_MAP: Record<
  Exclude<SqlFilterOp, "in" | "between" | "relative" | "is_null" | "not_null">,
  string
> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

type FilterRecord = Record<string, unknown>;

function isRecord(value: unknown): value is FilterRecord {
  return value !== null && typeof value === "object";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

const SUPPORTED_DIALECTS: ReadonlyArray<DialectType> = [
  "mysql",
  "postgresql",
  "sqlserver",
  "sqlite",
  "snowflake",
  "bigquery",
  "databricks",
];

function assertDialect(dialect: DialectType): void {
  if (!SUPPORTED_DIALECTS.includes(dialect)) {
    throw new SqlCompileError(
      ERROR_CODES.UNSUPPORTED_DIALECT,
      "dialect",
      `Unsupported dialect: ${dialect}`,
    );
  }
}

function resolveTable(
  plan: QueryPlanInput,
  resolver: ColumnResolver,
): { table: string; dataset: string } {
  if (plan.datasets.length === 0) {
    throw new SqlCompileError(ERROR_CODES.NO_DATASETS, "datasets", "Plan has no datasets");
  }
  const dataset = plan.datasets[0]!;
  const resolved = resolver(`${dataset}.${TABLE_KEY}`);
  if (!resolved) {
      throw new SqlCompileError(
      ERROR_CODES.UNKNOWN_DATASET,
      "datasets",
      `Dataset not in catalog: ${dataset}`,
    );
  }
  if (!isSafeIdentifier(resolved.table)) {
      throw new SqlCompileError(
      ERROR_CODES.UNSAFE_PHYSICAL_TABLE,
      "datasets",
      `Resolved physical table is unsafe: ${JSON.stringify(resolved.table)}`,
    );
  }
  return { table: resolved.table, dataset };
}

function resolveQualified(
  ref: string,
  plan: QueryPlanInput,
  resolver: ColumnResolver,
): { table: string; column: string } {
  const r = resolver(ref);
  if (!r) {
      throw new SqlCompileError(
      ERROR_CODES.UNKNOWN_COLUMN,
      "columns",
      `Unknown column reference: ${JSON.stringify(ref)}`,
    );
  }
  if (!resolvedTableBelongsToPlan(r.table, plan, resolver)) {
      throw new SqlCompileError(
      ERROR_CODES.COLUMN_OUTSIDE_PLAN,
      "columns",
      `Column ${JSON.stringify(ref)} resolves to ${JSON.stringify(r.table)} which is not in the plan`,
    );
  }
  return r;
}

function resolvedTableBelongsToPlan(
  resolvedTable: string,
  plan: QueryPlanInput,
  resolver: ColumnResolver,
): boolean {
  const resolvedKeys = tableKeySet(resolvedTable);
  for (const dataset of plan.datasets) {
    let physicalTable: string | undefined;
    try {
      physicalTable = resolver(`${dataset}.${TABLE_KEY}`)?.table;
    } catch {
      physicalTable = undefined;
    }
    if (setsIntersect(resolvedKeys, tableKeySet(dataset, physicalTable))) return true;
  }
  return false;
}

export function compileFilterSql(filter: unknown, b: SafeSqlBuilder, resolver: ColumnResolver, plan: QueryPlanInput): string | null {
  if (!isRecord(filter)) return null;
  const f = filter;

  // Group node (frontend uses f.conditions, backend uses f.children)
  if (f.type === "group" || f.type === "and" || f.type === "or" || f.children) {
    const conditions = Array.isArray(f.children) ? f.children : [];
    if (conditions.length === 0) return null;

    const parts: string[] = [];
    const defaultOp = (f.type === "or" || f.operator === "OR" || f.operator === "or") ? "OR" : "AND";

    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      const compiled = compileFilterSql(cond, b, resolver, plan);
      if (!compiled) continue;

      if (parts.length > 0) {
        const connector = defaultOp;
        parts.push(connector);
      }
      parts.push(compiled);
    }

    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return `(${parts.join(" ")})`;
  }

  // Raw condition
  const field = stringValue(f.field);
  const op = stringValue(f.op) || stringValue(f.operator);
  if (field && op) {
    const r = resolveQualified(field, plan, resolver);
    const col = `${b.quote(r.table)}.${b.quote(r.column)}`;
    
    switch (op) {
      case "eq":
      case "neq":
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        return `${col} ${OP_MAP[op as keyof typeof OP_MAP]} ${b.bind(f.value)}`;
      case "is_null":
        return `${col} IS NULL`;
      case "not_null":
        return `${col} IS NOT NULL`;
      case "in":
      case "not_in": {
        const vals = typeof f.value === "string"
          ? f.value.split(",").map((s) => s.trim())
          : arrayValue(f.value);
        if (vals.length === 0) throw new SqlCompileError(ERROR_CODES.EMPTY_IN_FILTER, "filters", `IN filter on ${field} is empty`);
        const placeholders = vals.map((v) => b.bind(v)).join(", ");
        const opStr = op === "in" ? "IN" : "NOT IN";
        return `${col} ${opStr} (${placeholders})`;
      }
      case "like":
        return `${col} LIKE ${b.bind(f.value)}`;
      case "relative": {
        if (typeof f.value !== "string") throw new SqlCompileError(ERROR_CODES.BAD_RELATIVE_VALUE, "filters", "RELATIVE filter requires string");
        const { start, end } = resolveRelativeTime(f.value);
        return `${col} BETWEEN ${b.bind(start)} AND ${b.bind(end)}`;
      }
      case "between": {
        if (!isRecord(f.value) || !("start" in f.value) || !("end" in f.value)) {
          throw new SqlCompileError(ERROR_CODES.BAD_BETWEEN_VALUE, "filters", `BETWEEN filter requires {start, end}`);
        }
        return `${col} BETWEEN ${b.bind(f.value.start)} AND ${b.bind(f.value.end)}`;
      }
      default:
        throw new SqlCompileError(ERROR_CODES.BAD_FILTER_OP, "filters", `Unknown operator: ${op}`);
    }
  }
  
  return null;
}

export function resolveRelativeTime(val: string): { start: string; end: string } {
  const normalized = val.trim().toLowerCase().replace(/\s+/g, "_");
  const today = new Date();
  const toDate = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  // BETWEEN bounds must cover the whole day, not just midnight, or a
  // timestamp/datetime column matches almost nothing (e.g. "today" would
  // only match rows recorded at exactly 00:00:00).
  const toStartOfDay = (d: Date) => `${toDate(d)} 00:00:00`;
  const toEndOfDay = (d: Date) => `${toDate(d)} 23:59:59`;
  const addDays = (d: Date, days: number) => {
    const next = new Date(d);
    next.setDate(next.getDate() + days);
    return next;
  };
  const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);
  const endOfYear = (d: Date) => new Date(d.getFullYear(), 11, 31);

  if (normalized === "today") {
    return { start: toStartOfDay(today), end: toEndOfDay(today) };
  }
  if (normalized === "yesterday") {
    const yesterday = addDays(today, -1);
    return { start: toStartOfDay(yesterday), end: toEndOfDay(yesterday) };
  }
  if (normalized === "this_month") {
    return { start: toStartOfDay(startOfMonth(today)), end: toEndOfDay(today) };
  }
  if (normalized === "last_month") {
    const previousMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { start: toStartOfDay(startOfMonth(previousMonth)), end: toEndOfDay(endOfMonth(previousMonth)) };
  }
  if (normalized === "this_year") {
    return { start: toStartOfDay(startOfYear(today)), end: toEndOfDay(today) };
  }
  if (normalized === "last_year") {
    const previousYear = new Date(today.getFullYear() - 1, 0, 1);
    return { start: toStartOfDay(startOfYear(previousYear)), end: toEndOfDay(endOfYear(previousYear)) };
  }

  const lastMatch = normalized.match(/^last_(\d+)_(day|days|week|weeks|month|months|year|years)$/);
  if (lastMatch) {
    const amount = Number(lastMatch[1]);
    const unit = lastMatch[2];
    const start = new Date(today);
    if (unit.startsWith("day")) start.setDate(start.getDate() - amount);
    else if (unit.startsWith("week")) start.setDate(start.getDate() - amount * 7);
    else if (unit.startsWith("month")) start.setMonth(start.getMonth() - amount);
    else if (unit.startsWith("year")) start.setFullYear(start.getFullYear() - amount);
    return { start: toStartOfDay(start), end: toEndOfDay(today) };
  }

  throw new SqlCompileError(ERROR_CODES.BAD_RELATIVE_VALUE, "filters", `Unsupported relative time value: ${val}`);
}

export function mergeFilterAsts(
  kpiAst: FilterNode | undefined,
  userAst: FilterNode | undefined
): FilterNode | undefined {
  if (!kpiAst && !userAst) return undefined;
  if (!kpiAst) return userAst;
  if (!userAst) return kpiAst;
  return { type: "group", operator: "AND", children: [kpiAst, userAst] };
}

interface TableReferenceAnalysis {
  metricTables: Set<string>;
  allTables: Set<string>;
  // Tables referenced by the SELECT/GROUP BY/metric/time-grain — i.e. anything
  // that consumes the joined ROWS (not just their existence). A join whose
  // right table appears here CANNOT be collapsed to a semi-join. Filter-only
  // references are deliberately excluded, because a filter can be pushed inside
  // an EXISTS subquery instead of forcing a fan-out-prone real join.
  nonFilterTables: Set<string>;
}

function stripIdentifierQuotes(value: string): string {
  return value.replace(/[`"\[\]]/g, "").trim();
}

function addTableVariants(target: Set<string>, tableName: string | null | undefined): void {
  if (!tableName) return;
  const clean = stripIdentifierQuotes(tableName).toLowerCase();
  if (!clean) return;

  target.add(clean);

  const parts = clean.split(".").filter(Boolean);
  if (parts.length > 1) {
    target.add(parts[parts.length - 1]!);
    target.add(parts.slice(-2).join("."));
  }
}

function tableKeySet(logicalTable: string, physicalTable?: string): Set<string> {
  const keys = new Set<string>();
  addTableVariants(keys, logicalTable);
  addTableVariants(keys, physicalTable);
  return keys;
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const value of b) {
    if (a.has(value)) return true;
  }
  return false;
}

function addTableRefsFromQualifiedRef(target: Set<string>, ref: string): void {
  const clean = stripIdentifierQuotes(ref);
  const parts = clean.split(".").filter(Boolean);
  if (parts.length < 2) return;

  addTableVariants(target, parts.slice(0, -1).join("."));
  if (parts.length >= 3) {
    addTableVariants(target, parts[parts.length - 2]);
  }
}

function addResolvedFieldTableRef(
  target: Set<string>,
  ref: string | null | undefined,
  resolver: ColumnResolver,
): void {
  if (!ref) return;

  addTableRefsFromQualifiedRef(target, ref);

  const resolved = resolver(ref);
  if (resolved) {
    addTableVariants(target, resolved.table);
  }
}

function collectFilterTableRefs(
  node: unknown,
  target: Set<string>,
  resolver: ColumnResolver,
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectFilterTableRefs(child, target, resolver);
    return;
  }
  if (!isRecord(node)) return;

  addResolvedFieldTableRef(target, stringValue(node.field), resolver);

  if (Array.isArray(node.children)) {
    collectFilterTableRefs(node.children, target, resolver);
  }
}

function extractMetricTableRefs(metricSql: string): Set<string> {
  const refs = new Set<string>();
  const withoutSingleQuotedLiterals = metricSql.replace(/'([^']|'')*'/g, " ");
  const clean = stripIdentifierQuotes(withoutSingleQuotedLiterals);
  const matches = clean.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g) ?? [];

  for (const match of matches) {
    addTableRefsFromQualifiedRef(refs, match);
  }

  return refs;
}

function analyzeTableReferences(
  plan: QueryPlanInput,
  metricSql: string,
  resolver: ColumnResolver,
  kpiFilterLogic?: unknown,
  userAst?: unknown,
): TableReferenceAnalysis {
  const metricTables = extractMetricTableRefs(metricSql);
  const nonFilterTables = new Set<string>(metricTables);

  const groupBy = plan.groupBy
    ? (Array.isArray(plan.groupBy) ? plan.groupBy : [plan.groupBy])
    : [];
  for (const groupRef of groupBy) {
    addResolvedFieldTableRef(nonFilterTables, groupRef, resolver);
  }
  for (const combinedGroup of plan.combinedGroupBy ?? []) {
    for (const columnRef of combinedGroup.columns) {
      addResolvedFieldTableRef(nonFilterTables, columnRef, resolver);
    }
  }
  addResolvedFieldTableRef(nonFilterTables, plan.timeGrainColumn ?? undefined, resolver);

  const allTables = new Set<string>(nonFilterTables);
  collectFilterTableRefs(plan.filters ?? [], allTables, resolver);
  collectFilterTableRefs(kpiFilterLogic, allTables, resolver);
  collectFilterTableRefs(userAst, allTables, resolver);

  return { metricTables, allTables, nonFilterTables };
}

// Flatten a filter source into its top-level AND-conjunction "units": an AND
// group's children are inlined (recursively), while a single condition or an
// OR group stays as one atomic unit (an OR can't be split across tables).
// Returned units are the SAME object references found in the source AST, so
// they can be matched by identity when pushing/removing them later.
function flattenAndUnits(node: unknown): unknown[] {
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenAndUnits);
  if (!isRecord(node)) return [];
  const tag = String((node.operator ?? node.type) ?? "").toLowerCase();
  const isOr = node.type === "or" || tag === "or";
  if (Array.isArray(node.children) && !isOr) {
    return node.children.flatMap(flattenAndUnits);
  }
  return [node];
}

function nodeTableKeys(node: unknown, resolver: ColumnResolver): Set<string> {
  const keys = new Set<string>();
  collectFilterTableRefs(node, keys, resolver);
  return keys;
}

function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

// Returns a copy of a filter source with the given (identity-matched) units
// removed — used to strip filters that were pushed into a semi-join EXISTS from
// the outer WHERE. An emptied group/array collapses to null.
function removePushedNodes(node: unknown, pushed: Set<unknown>): unknown {
  if (node == null || pushed.has(node)) return null;
  if (Array.isArray(node)) {
    const kept = node.map((child) => removePushedNodes(child, pushed)).filter((child) => child != null);
    return kept.length > 0 ? kept : null;
  }
  if (isRecord(node) && Array.isArray(node.children)) {
    const kept = node.children.map((child) => removePushedNodes(child, pushed)).filter((child) => child != null);
    if (kept.length === 0) return null;
    return { ...node, children: kept };
  }
  return node;
}

const SQL_FUNCTION_OR_KEYWORD = new Set([
  "abs", "and", "as", "avg", "case", "cast", "coalesce", "count", "date",
  "day", "distinct", "else", "end", "false", "ifnull", "in", "is", "max",
  "min", "month", "not", "null", "nullif", "or", "round", "sum", "then",
  "true", "when", "year",
]);

function rewriteMetricSqlIdentifiers(
  metricSql: string,
  dialect: DialectType,
  resolver: ColumnResolver,
): string {
  const rewriteSegment = (segment: string): string =>
    segment.replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\b/g, (token, offset, source) => {
      const lower = token.toLowerCase();
      if (SQL_FUNCTION_OR_KEYWORD.has(lower)) return token;

      const nextChar = source[offset + token.length];
      if (nextChar === "(" && !token.includes(".")) return token;

      const resolved = resolver(token);
      if (!resolved) return token;
      return `${quoteId(resolved.table, dialect)}.${quoteId(resolved.column, dialect)}`;
    });

  return metricSql
    .split(/('(?:[^']|'')*')/g)
    .map((segment, index) => index % 2 === 1 ? segment : rewriteSegment(segment))
    .join("");
}

function sameLogicalTable(left: string, right: string): boolean {
  return stripIdentifierQuotes(left).toLowerCase() === stripIdentifierQuotes(right).toLowerCase();
}

function joinRightTableFeedsLaterJoin(activeJoins: JoinSpec[], joinIndex: number, rightTable: string): boolean {
  return activeJoins.some((candidate, candidateIndex) =>
    candidateIndex > joinIndex && sameLogicalTable(candidate.leftTable, rightTable)
  );
}

function shouldRenderJoinAsExists(
  join: JoinSpec,
  joinIndex: number,
  activeJoins: JoinSpec[],
  references: TableReferenceAnalysis,
  availableTableKeys: Set<string>,
  leftPhysicalTable: string,
  rightPhysicalTable: string,
): boolean {
  if (join.type !== "INNER") return false;
  if (getJoinConditions(join).length > 1 || join.joinCondition === "dimension_match") return false;
  if (getJoinConditions(join).some((condition) => condition.joinCondition === "dimension_match")) return false;
  if (references.metricTables.size === 0) return false;
  if (joinRightTableFeedsLaterJoin(activeJoins, joinIndex, join.rightTable)) return false;

  const leftKeys = tableKeySet(join.leftTable, leftPhysicalTable);
  const rightKeys = tableKeySet(join.rightTable, rightPhysicalTable);

  if (!setsIntersect(availableTableKeys, leftKeys)) return false;
  // Eligible when the joined table's ROWS aren't consumed by SELECT/GROUP/metric.
  // Filter-only references no longer block this — the caller pushes those
  // filters into the EXISTS subquery (and falls back to a real join if a filter
  // spans multiple tables and therefore can't be pushed).
  return !setsIntersect(references.nonFilterTables, rightKeys);
}

function buildAiJoinGraph(catalog: AiDatasetDefinition[]) {
  const graph: Record<string, { to: string, fromCol: string, toCol: string }[]> = {};
  for (const ds of catalog) {
    graph[ds.name.toLowerCase()] = [];
  }
  for (const ds of catalog) {
    for (const rel of ds.relationships) {
      const fromTable = ds.name.toLowerCase();
      const toTable = rel.targetDataset.toLowerCase();
      if (!graph[fromTable]) graph[fromTable] = [];
      if (!graph[toTable]) graph[toTable] = [];
      graph[fromTable].push({ to: toTable, fromCol: rel.sourceColumn, toCol: rel.targetColumn });
      graph[toTable].push({ to: fromTable, fromCol: rel.targetColumn, toCol: rel.sourceColumn });
    }
  }
  return graph;
}

function autoGenerateJoins(datasets: string[], catalog: AiDatasetDefinition[] | undefined): JoinSpec[] {
  if (!catalog || datasets.length <= 1) return [];

  const graph = buildAiJoinGraph(catalog);
  const joins: JoinSpec[] = [];
  const connected = new Set<string>();
  // Only hop through tables the plan actually asked for — never bridge
  // through an unrequested table just because a relationship happens to
  // connect through it, which would silently change result cardinality.
  const allowedTables = new Set(datasets.map((d) => d.toLowerCase()));

  const startTable = datasets[0].toLowerCase();
  connected.add(startTable);

  // Connect remaining tables one by one using BFS
  for (let i = 1; i < datasets.length; i++) {
    const targetTable = datasets[i].toLowerCase();
    if (connected.has(targetTable)) continue;

    // BFS to find shortest path from any connected table to targetTable,
    // restricted to the plan's own datasets.
    const queue: { current: string, path: { from: string, to: string, fromCol: string, toCol: string }[] }[] = [];
    const visited = new Set<string>();

    for (const c of connected) {
      queue.push({ current: c, path: [] });
      visited.add(c);
    }

    let foundPath: { from: string, to: string, fromCol: string, toCol: string }[] | null = null;

    while (queue.length > 0) {
      const { current, path } = queue.shift()!;
      if (current === targetTable) {
        foundPath = path;
        break;
      }

      const neighbors = graph[current] || [];
      for (const n of neighbors) {
        if (!allowedTables.has(n.to)) continue;
        if (!visited.has(n.to)) {
          visited.add(n.to);
          queue.push({
            current: n.to,
            path: [...path, { from: current, to: n.to, fromCol: n.fromCol, toCol: n.toCol }]
          });
        }
      }
    }
    
    if (foundPath) {
      for (const edge of foundPath) {
        if (!connected.has(edge.to)) {
          joins.push({
            type: "INNER",
            leftTable: edge.from,
            leftColumn: edge.fromCol,
            rightTable: edge.to,
            rightColumn: edge.toCol
          });
          connected.add(edge.to);
        }
      }
    } else {
      throw new SqlCompileError(ERROR_CODES.NO_JOIN_PATH, "joins", `Cannot auto-generate join: No relationship path found connecting to ${targetTable}`);
    }
  }
  
  return joins;
}

interface CombinedGroupExpansion {
  groupByKey: string;
  groupSql: string;
  joinSql: string;
}

function normalizedColumnRefKey(columnRef: string): string {
  return stripIdentifierQuotes(String(columnRef || "")).trim().toLowerCase();
}

/**
 * Build Option-A grouping expansion: each joined base row contributes once to
 * every distinct value found across the configured same-named dimension
 * columns. UNION (never UNION ALL) de-duplicates equal values on the same
 * joined row; an all-null row yields one Unspecified group.
 */
function buildCombinedGroupExpansions(
  plan: QueryPlanInput,
  dialect: DialectType,
  resolver: ColumnResolver,
  b: SafeSqlBuilder,
): CombinedGroupExpansion[] {
  const expansions: CombinedGroupExpansion[] = [];

  for (const spec of plan.combinedGroupBy ?? []) {
    const resolvedColumns = spec.columns.map((columnRef) => {
      const resolved = resolveQualified(columnRef, plan, resolver);
      return `${b.quote(resolved.table)}.${b.quote(resolved.column)}`;
    });
    const columns = Array.from(new Set(resolvedColumns));
    if (columns.length < 2) continue;

    const ordinal = expansions.length + 1;
    const alias = `__combined_dimension_${ordinal}`;
    const valueColumn = "group_value";
    const quotedAlias = b.quote(alias);
    const quotedValueColumn = b.quote(valueColumn);
    const unionSql = [
      ...columns.map(
        (columnSql) => `SELECT ${columnSql} AS ${quotedValueColumn} WHERE ${columnSql} IS NOT NULL`,
      ),
      // Keep a qualifying base row visible as one Unspecified group only when
      // every configured source is null. A row with at least one real value
      // never receives an additional null group.
      `SELECT NULL AS ${quotedValueColumn} WHERE ${columns.map((columnSql) => `${columnSql} IS NULL`).join(" AND ")}`,
    ].join(" UNION ");

    if (dialect === "sqlite") {
      throw new SqlCompileError(
        ERROR_CODES.UNSUPPORTED_DIALECT,
        "combinedGroupBy",
        "Combined same-named KPI dimensions require lateral row expansion, which is not supported for SQLite",
      );
    }

    let joinSql: string;
    let groupSql: string;
    if (dialect === "sqlserver") {
      joinSql = `CROSS APPLY (${unionSql}) AS ${quotedAlias}`;
      groupSql = `${quotedAlias}.${quotedValueColumn}`;
    } else if (dialect === "bigquery") {
      const values = columns.join(", ");
      const distinctValues = `ARRAY(SELECT DISTINCT ${quotedValueColumn} FROM UNNEST([${values}]) AS ${quotedValueColumn} WHERE ${quotedValueColumn} IS NOT NULL)`;
      joinSql = `CROSS JOIN UNNEST(IF(ARRAY_LENGTH(${distinctValues}) = 0, [NULL], ${distinctValues})) AS ${quotedAlias}`;
      groupSql = quotedAlias;
    } else if (dialect === "databricks") {
      const compactValues = `ARRAY_COMPACT(ARRAY(${columns.join(", ")}))`;
      joinSql = `LATERAL VIEW EXPLODE(IF(SIZE(${compactValues}) = 0, ARRAY(${columns[0]}), ARRAY_DISTINCT(${compactValues}))) ${quotedAlias} AS ${quotedValueColumn}`;
      groupSql = `${quotedAlias}.${quotedValueColumn}`;
    } else {
      // MySQL, PostgreSQL, and Snowflake support correlated LATERAL derived
      // tables. Each UNION branch decides whether its source value contributes.
      groupSql = `${quotedAlias}.${quotedValueColumn}`;
      joinSql = `CROSS JOIN LATERAL (${unionSql}) AS ${quotedAlias}`;
    }

    expansions.push({
      groupByKey: normalizedColumnRefKey(spec.groupBy),
      groupSql,
      joinSql,
    });
  }

  return expansions;
}

function dedupeCountMetricForCombinedGrouping(metricSql: string, primaryIdentitySql?: string): string {
  const match = metricSql.trim().match(/^COUNT\s*\(\s*(?!DISTINCT\b)([\s\S]+?)\s*\)$/i);
  if (!match) return metricSql;
  const argument = match[1]!.trim();
  if (argument === "*" || argument === "1") return metricSql;
  if (primaryIdentitySql) {
    return `COUNT(DISTINCT CASE WHEN ${argument} IS NOT NULL THEN ${primaryIdentitySql} END)`;
  }
  return `COUNT(DISTINCT ${argument})`;
}

function resolvePrimaryIdentitySql(
  plan: QueryPlanInput,
  catalog: AiDatasetDefinition[] | undefined,
  resolver: ColumnResolver,
  b: SafeSqlBuilder,
): string | undefined {
  const primaryDatasetRef = plan.datasets[0];
  const primaryDataset = catalog?.find(
    (dataset) => sameLogicalTable(dataset.name, primaryDatasetRef),
  );
  const primaryKey = primaryDataset?.columns.find((column) => column.isPrimaryKey);
  if (!primaryDataset || !primaryKey) return undefined;
  const resolved = resolver(`${primaryDataset.name}.${primaryKey.name}`);
  return resolved ? `${b.quote(resolved.table)}.${b.quote(resolved.column)}` : undefined;
}

/**
 * Compile a normalised query plan into a parameterised `CompiledQuery`.
 *
 * @param plan       The validated query plan (datasets, filters, joins, etc.)
 * @param dialect    Target database dialect.
 * @param resolver   Maps logical refs to physical `{ table, column }` pairs.
 * @param metricSql  The KPI metric expression (already validated upstream).
 * @param opts       Compiler options.
 * @param kpiOptions KPI compilation options.
 * @param catalog    AI Catalog definitions for auto-joins.
 */
export function compileKpiQuery(
  plan: QueryPlanInput,
  dialect: DialectType,
  resolver: ColumnResolver,
  metricSql: string,
  opts: CompileOptions = {},
  kpiOptions?: CompileKpiOptions,
  catalog?: AiDatasetDefinition[]
): CompiledQuery {
  assertDialect(dialect);

  plan = { ...plan };
  if (kpiOptions?.queryGroupBy) plan.groupBy = kpiOptions.queryGroupBy;
  if (kpiOptions?.querySortDir) plan.sortDir = kpiOptions.querySortDir;
  if (kpiOptions?.queryLimit) plan.limit = kpiOptions.queryLimit;

  if (plan.datasets.length === 0) {
    throw new SqlCompileError(ERROR_CODES.NO_DATASETS, "datasets", "Plan has no datasets");
  }

  // Determine active joins
  let activeJoins = plan.joins || [];
  if (kpiOptions?.kpi?.join_spec?.length) {
    activeJoins = mergeMasterJoinSpecs(kpiOptions.kpi.join_spec, activeJoins);
  } else if (plan.datasets.length > 1 && activeJoins.length === 0) {
    // Fallback: AI Auto-Generate Joins via BFS
    activeJoins = autoGenerateJoins(plan.datasets, catalog);
  }

  const userAst = kpiOptions?.userAst ?? kpiOptions?.userFilters;
  const referencedTables = analyzeTableReferences(
    plan,
    metricSql,
    resolver,
    kpiOptions?.kpi?.filter_logic,
    userAst,
  );

  if (catalog && metricSql) {
    // Check for ambiguous prefix-less columns in the metric formula
    const withoutStrings = metricSql.replace(/'([^']|'')*'/g, " ");
    const bareMatches = withoutStrings.match(/(?<!\.)\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\.)/g) || [];
    const potentialColumns = Array.from(new Set(bareMatches.map(w => w.toLowerCase())));
    const sqlReserved = new Set(["sum", "avg", "count", "min", "max", "as", "and", "or", "case", "when", "then", "else", "end", "cast", "coalesce", "nullif", "ifnull"]);
    
    const activeDatasets = catalog.filter(ds => plan.datasets.includes(ds.name) || plan.datasets.some(d => d.toLowerCase() === ds.name.toLowerCase()));
    
    for (const col of potentialColumns) {
      if (sqlReserved.has(col)) continue;
      
      const foundIn = activeDatasets.filter(ds => ds.columns?.some(c => c.name.toLowerCase() === col));
      if (foundIn.length > 1) {
        throw new Error(`AMBIGUOUS_KPI_MODE|${foundIn.map(d => d.name).join(",")}|${col}`);
      }
    }
  }

  const b = new SafeSqlBuilder(dialect, opts);
  const compiledMetricSql = metricSql
    ? rewriteMetricSqlIdentifiers(metricSql, dialect, resolver)
    : metricSql;
  const combinedGroupExpansions = buildCombinedGroupExpansions(plan, dialect, resolver, b);
  const primaryIdentitySql = resolvePrimaryIdentitySql(plan, catalog, resolver, b);
  const effectiveMetricSql = combinedGroupExpansions.length > 0
    ? dedupeCountMetricForCombinedGrouping(compiledMetricSql, primaryIdentitySql)
    : compiledMetricSql;

  // ---------- 1. SELECT ----------
  const selectParts: string[] = [];
  const groupParts: string[] = [];

  if (plan.groupBy) {
    const grps = Array.isArray(plan.groupBy) ? plan.groupBy : [plan.groupBy];
    for (let index = 0; index < grps.length; index++) {
      const g = grps[index]!;
      const combinedExpansion = combinedGroupExpansions.find(
        (expansion) => expansion.groupByKey === normalizedColumnRefKey(g),
      );
      const col = combinedExpansion?.groupSql || (() => {
        const r = resolveQualified(g, plan, resolver);
        return `${b.quote(r.table)}.${b.quote(r.column)}`;
      })();
      const alias = grps.length === 1 ? "group_key" : `group_key_${index + 1}`;
      groupParts.push(col);
      selectParts.push(`${col} AS ${b.quote(alias)}`);
    }
  }
  if (plan.timeGrain && plan.timeGrainColumn) {
    const r = resolveQualified(plan.timeGrainColumn, plan, resolver);
    const col = `${b.quote(r.table)}.${b.quote(r.column)}`;
    const trunc = (DATE_GRAIN[dialect] as DateGrainFn)(col, plan.timeGrain);
    groupParts.push(trunc);
    selectParts.push(`${trunc} AS ${b.quote("time_key")}`);
  }
  if (plan.metric) {
    // metricSql comes from a pre-validated KPI row, never from the prompt.
    selectParts.push(`(${effectiveMetricSql}) AS ${b.quote("metric_value")}`);
  }

  if (selectParts.length === 0) {
    if (kpiOptions?.kpi?.select_columns && kpiOptions.kpi.select_columns.length > 0) {
      for (const col of kpiOptions.kpi.select_columns) {
        const r = resolveQualified(col, plan, resolver);
        selectParts.push(`${b.quote(r.table)}.${b.quote(r.column)}`);
      }
    } else {
      throw new SqlCompileError(
        ERROR_CODES.EMPTY_SELECT,
        "select_columns",
        "Certified query has no metric or catalog-approved selected columns",
      );
    }
  }

  const selectKeyword = (dialect === "sqlserver" && plan.limit) 
    ? `SELECT TOP ${Math.floor(plan.limit)}` 
    : "SELECT";
  b.append(`${selectKeyword} ${selectParts.join(", ")}`);

  // ---------- 2. FROM ----------
  const primary = resolveTable(plan, resolver);
  if (opts.rejectSubquery && /\(\s*select/i.test(primary.table)) {
    throw new SqlCompileError(
      ERROR_CODES.SUBQUERY_DISALLOWED,
      "datasets",
      "Subquery-style physical tables are disabled by config",
    );
  }
  b.append(`FROM ${b.quote(primary.table)}`);

  // ---------- 3. JOINs ----------
  const availableTableKeys = tableKeySet(primary.dataset, primary.table);
  const semiJoinWhereParts: string[] = [];
  // Flat list of AND-conjunction filter units across every filter source, used
  // to push a filter-only joined table's conditions into its EXISTS subquery.
  const filterUnits: unknown[] = [
    ...flattenAndUnits(plan.filters ?? []),
    ...flattenAndUnits(kpiOptions?.kpi?.filter_logic),
    ...flattenAndUnits(userAst),
  ];
  const pushedUnits = new Set<unknown>();
  for (let joinIndex = 0; joinIndex < activeJoins.length; joinIndex++) {
    const join = activeJoins[joinIndex]!;
    if (!["INNER", "LEFT", "RIGHT", "FULL"].includes(join.type)) {
      throw new SqlCompileError(
        ERROR_CODES.BAD_JOIN_TYPE,
        "joins",
        `Invalid join type: ${join.type}`,
      );
    }
    if (join.leftTable === join.rightTable) {
      throw new SqlCompileError(
        ERROR_CODES.SELF_JOIN,
        "joins",
        `Self-join not allowed: ${join.leftTable}`,
      );
    }
    const leftTable = resolver(`${join.leftTable}.${TABLE_KEY}`);
    const rightTable = resolver(`${join.rightTable}.${TABLE_KEY}`);
    if (!leftTable || !rightTable) {
      throw new SqlCompileError(
        ERROR_CODES.UNKNOWN_JOIN_DATASET,
        "joins",
        `Unknown dataset in join: ${join.leftTable} / ${join.rightTable}`,
      );
    }
    // Validate ON clause columns exist on both sides
    const leftCol = resolver(`${join.leftTable}.${join.leftColumn}`);
    const rightCol = resolver(`${join.rightTable}.${join.rightColumn}`);
    if (!leftCol || !rightCol) {
      throw new SqlCompileError(
        ERROR_CODES.UNKNOWN_JOIN_COLUMN,
        "joins",
        `Join references unknown column: ${join.leftTable}.${join.leftColumn} ↔ ${join.rightTable}.${join.rightColumn}`,
      );
    }
    const onConditions: string[] = [];
    for (const condition of getJoinConditions(join)) {
      const conditionLeftTable = condition.leftTable || join.leftTable;
      const conditionRightTable = condition.rightTable || join.rightTable;
      const leftConditionTable = resolver(`${conditionLeftTable}.${TABLE_KEY}`);
      const rightConditionTable = resolver(`${conditionRightTable}.${TABLE_KEY}`);
      const conditionLeftColumn = resolver(`${conditionLeftTable}.${condition.leftColumn}`);
      const conditionRightColumn = resolver(`${conditionRightTable}.${condition.rightColumn}`);
      if (!leftConditionTable || !rightConditionTable || !conditionLeftColumn || !conditionRightColumn) {
        throw new SqlCompileError(
          ERROR_CODES.UNKNOWN_JOIN_COLUMN,
          "joins",
          "Join references an unknown configured condition",
        );
      }
      if (!setsIntersect(availableTableKeys, tableKeySet(conditionLeftTable, leftConditionTable.table))) {
        throw new SqlCompileError(
          ERROR_CODES.NO_JOIN_PATH,
          "joins",
          "Join condition references a left-side dataset that is not connected yet",
        );
      }
      if (!sameLogicalTable(conditionRightTable, join.rightTable)) {
        throw new SqlCompileError(
          ERROR_CODES.NO_JOIN_PATH,
          "joins",
          "Join condition must target the dataset introduced by its join edge",
        );
      }
      onConditions.push(
        `${b.quote(leftConditionTable.table)}.${b.quote(conditionLeftColumn.column)} = ${b.quote(rightConditionTable.table)}.${b.quote(conditionRightColumn.column)}`,
      );
    }

    if (shouldRenderJoinAsExists(
      join,
      joinIndex,
      activeJoins,
      referencedTables,
      availableTableKeys,
      leftTable.table,
      rightTable.table,
    )) {
      const rightKeys = tableKeySet(join.rightTable, rightTable.table);
      const referencingUnits = filterUnits.filter(
        (unit) => !pushedUnits.has(unit) && setsIntersect(nodeTableKeys(unit, resolver), rightKeys),
      );
      // Only collapse to a semi-join when every filter touching the joined
      // table touches ONLY that table. A filter mixing it with another table
      // (e.g. an OR spanning tables) can't be pushed into the EXISTS, so keep a
      // real join for that one — correctness over de-duplication.
      const allPushable = referencingUnits.every(
        (unit) => isSubsetOf(nodeTableKeys(unit, resolver), rightKeys),
      );
      if (allPushable) {
        const existsConditions = [...onConditions];
        for (const unit of referencingUnits) {
          const compiled = compileFilterSql(unit, b, resolver, plan);
          if (compiled) existsConditions.push(compiled);
          pushedUnits.add(unit);
        }
        semiJoinWhereParts.push(`EXISTS (SELECT 1 FROM ${b.quote(rightTable.table)} WHERE ${existsConditions.join(" AND ")})`);
        continue;
      }
    }

    b.append(`${join.type} JOIN ${b.quote(rightTable.table)} ON ${onConditions.join(" AND ")}`);
    for (const key of tableKeySet(join.rightTable, rightTable.table)) {
      availableTableKeys.add(key);
    }
  }

  for (const expansion of combinedGroupExpansions) {
    b.append(expansion.joinSql);
  }

  // ---------- 4. WHERE ----------
  const whereParts: string[] = [...semiJoinWhereParts];

  // Each filter source is compiled MINUS any units already pushed into a
  // semi-join EXISTS above (removePushedNodes is a no-op copy when nothing was
  // pushed, so the common case is unchanged).

  // 1. Plan filters (SqlFilter[])
  for (const f of plan.filters ?? []) {
    const outer = removePushedNodes(f, pushedUnits);
    if (outer == null) continue;
    const compiled = compileFilterSql(outer, b, resolver, plan);
    if (compiled) whereParts.push(compiled);
  }

  // 2. KPI filter logic (AST from UI)
  const outerKpiFilterLogic = removePushedNodes(kpiOptions?.kpi?.filter_logic, pushedUnits);
  if (outerKpiFilterLogic) {
    const compiled = compileFilterSql(outerKpiFilterLogic, b, resolver, plan);
    if (compiled) whereParts.push(compiled);
  }

  // 3. User AST filters (from natural language)
  const outerUserAst = removePushedNodes(userAst, pushedUnits);
  if (outerUserAst) {
    const compiled = compileFilterSql(outerUserAst, b, resolver, plan);
    if (compiled) whereParts.push(compiled);
  }

  if (whereParts.length > 0) {
    b.append(`WHERE ${whereParts.join(" AND ")}`);
  }

  // ---------- 5. GROUP / ORDER / LIMIT ----------
  const isAggregated = groupParts.length > 0 || !!plan.timeGrainColumn;
  if (isAggregated && plan.metric) {
    b.append(`GROUP BY ${groupParts.join(", ")}`);
    if (plan.timeGrainColumn) {
      const secondarySort = groupParts.length > 1
        ? `, ${b.quote("metric_value")} ${plan.sortDir === "asc" ? "ASC" : "DESC"}`
        : "";
      b.append(`ORDER BY ${b.quote("time_key")} ASC${secondarySort}`);
    } else {
      b.append(`ORDER BY ${b.quote("metric_value")} ${plan.sortDir === "asc" ? "ASC" : "DESC"}`);
    }
  }
  if (plan.limit) {
    const limit = Math.floor(plan.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new SqlCompileError(
        ERROR_CODES.BAD_LIMIT,
        "limit",
        `Limit must be a positive integer, got ${plan.limit}`,
      );
    }
    if (dialect !== "sqlserver") {
      b.append(`LIMIT ${limit}`);
    }
  }

  const seg = b.toSegment();
  return finalize({ dialect, sql: seg.sql, params: seg.params, plan, joins: activeJoins });
}

interface FinalizeInput {
  dialect: DialectType;
  sql: string;
  params: unknown[];
  plan: QueryPlanInput;
  joins?: JoinSpec[];
}

function finalize({ dialect, sql, params, plan, joins }: FinalizeInput): CompiledQuery {
  return {
    dialect,
    sql,
    params,
    dataset: plan.datasets[0]!,
    metric: plan.metric,
    groupBy: plan.groupBy ?? undefined,
    filters: plan.filters ?? undefined,
    datasets: plan.datasets,
    // Reflect the joins actually rendered into `sql` (including any that
    // were auto-generated), not just what the caller originally supplied,
    // so the SQL/Trace views shown to the user match the executed query.
    joins: (joins && joins.length > 0 ? joins : plan.joins) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Simple Select Compiler (Phase 4)
// ---------------------------------------------------------------------------

export function compileSimpleSelectQuery(
  plan: QueryPlanInput,
  dialect: DialectType,
  resolver: ColumnResolver,
  options?: CompileOptions,
  catalog?: AiDatasetDefinition[]
): CompiledQuery {
  if (!plan.datasets || plan.datasets.length === 0) {
    throw new SqlCompileError(ERROR_CODES.UNKNOWN_JOIN_DATASET, "datasets", "Query plan must specify at least one dataset");
  }

  const normalizedMetricName = String(plan.metric || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const isInlineAggregate = /^(SUM|AVG|MIN|MAX|COUNT)\s*\(/i.test(String(plan.metric || ""));
  const isCertifiedMetric = normalizedMetricName && (catalog || []).some((dataset) =>
    (dataset.metrics || []).some((metric) => {
      const names = [metric.name, metric.label].map((value) => String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""));
      return names.includes(normalizedMetricName);
    }),
  );
  if (plan.metric && !isInlineAggregate && isCertifiedMetric) {
    throw new SqlCompileError(
      ERROR_CODES.CERTIFIED_METRIC_REQUIRES_KPI,
      "metric",
      `Internal routing error: Certified metric "${plan.metric}" reached the Simple SQL compiler. It must be compiled through the KPI profile so its formula, datasets, joins, and filters remain pinned. No database query was executed.`,
    );
  }

  const b = new SafeSqlBuilder(dialect, options);
  const selectParts: string[] = [];
  const groupParts: string[] = [];
  const isValueList = Boolean(plan.groupBy) && !plan.metric && !plan.timeGrain;

  let isAggregated = false;
  if (plan.groupBy) {
    isAggregated = true;
    const gList = Array.isArray(plan.groupBy) ? plan.groupBy : [plan.groupBy];
    for (let index = 0; index < gList.length; index++) {
      const g = gList[index]!;
      const r = resolveQualified(g, plan, resolver);
      const col = `${b.quote(r.table)}.${b.quote(r.column)}`;
      const alias = gList.length === 1 ? "group_key" : `group_key_${index + 1}`;
      groupParts.push(col);
      selectParts.push(`${col} AS ${b.quote(alias)}`);
    }
  }

  let timeGrainColumnSql: string | undefined;
  if (plan.timeGrain && plan.timeGrainColumn) {
    isAggregated = true;
    const r = resolveQualified(plan.timeGrainColumn, plan, resolver);
    const col = `${b.quote(r.table)}.${b.quote(r.column)}`;
    const trunc = (DATE_GRAIN[dialect] as DateGrainFn)(col, plan.timeGrain);
    timeGrainColumnSql = col;
    groupParts.push(trunc);
    selectParts.push(`${trunc} AS ${b.quote("time_key")}`);
  }

  if (isAggregated) {
    if (plan.metric) {
      const metricMatch = plan.metric.match(/^(SUM|AVG|MIN|MAX|COUNT)\((.*)\)$/i);
      if (metricMatch) {
        const func = metricMatch[1]!.toUpperCase();
        const arg = metricMatch[2]!.trim();
        let argSql = "*";
        if (arg !== "1" && arg !== "*") {
           const r = resolveQualified(arg, plan, resolver);
           argSql = `${b.quote(r.table)}.${b.quote(r.column)}`;
        }
        selectParts.push(`${func}(${argSql}) AS ${b.quote("metric_value")}`);
      } else {
        const r = resolveQualified(plan.metric, plan, resolver);
        selectParts.push(`SUM(${b.quote(r.table)}.${b.quote(r.column)}) AS ${b.quote("metric_value")}`);
      }
    } else if (!isValueList) {
      selectParts.push(`COUNT(1) AS ${b.quote("metric_value")}`);
    }
  } else {
    if (plan.metric) {
      const r = resolveQualified(plan.metric, plan, resolver);
      selectParts.push(`${b.quote(r.table)}.${b.quote(r.column)}`);
    } else if (plan.select_columns && plan.select_columns.length > 0) {
      for (const col of plan.select_columns) {
        const r = resolveQualified(col, plan, resolver);
        selectParts.push(`${b.quote(r.table)}.${b.quote(r.column)}`);
      }
    } else {
      throw new SqlCompileError(
        ERROR_CODES.EMPTY_SELECT,
        "select_columns",
        "Raw record queries must specify catalog-approved selected columns",
      );
    }
  }

  if (selectParts.length === 0) {
    throw new SqlCompileError(
      ERROR_CODES.EMPTY_SELECT,
      "select_columns",
      "Query has no catalog-approved output columns",
    );
  }

  const selectKeyword = (dialect === "sqlserver" && plan.limit) 
    ? `SELECT TOP ${Math.floor(plan.limit)}` 
    : "SELECT";
  b.append(`${selectKeyword} ${selectParts.join(", ")}`);

  const primary = resolveTable(plan, resolver);
  b.append(`FROM ${b.quote(primary.table)}`);

  // Multi-table plans with no explicit joins need the same catalog-driven
  // BFS the KPI compiler uses, or a table referenced in SELECT/WHERE is
  // never introduced via FROM/JOIN and the query fails (or worse, silently
  // resolves) at execution time instead of compile time.
  let activeJoins = plan.joins ?? [];
  if (plan.datasets.length > 1 && activeJoins.length === 0) {
    activeJoins = autoGenerateJoins(plan.datasets, catalog);
  }
  for (const join of activeJoins) {
    if (!["INNER", "LEFT", "RIGHT", "FULL"].includes(join.type)) {
      throw new SqlCompileError(ERROR_CODES.BAD_JOIN_TYPE, "joins", `Invalid join type: ${join.type}`);
    }
    const leftTable = resolver(`${join.leftTable}.${TABLE_KEY}`);
    const rightTable = resolver(`${join.rightTable}.${TABLE_KEY}`);
    if (!leftTable || !rightTable) {
      throw new SqlCompileError(ERROR_CODES.UNKNOWN_JOIN_DATASET, "joins", `Unknown dataset in join`);
    }
    const leftCol = resolver(`${join.leftTable}.${join.leftColumn}`);
    const rightCol = resolver(`${join.rightTable}.${join.rightColumn}`);
    if (!leftCol || !rightCol) {
      throw new SqlCompileError(ERROR_CODES.UNKNOWN_JOIN_COLUMN, "joins", `Join references unknown column`);
    }
    const ltQ = `${b.quote(leftTable.table)}.${b.quote(leftCol.column)}`;
    const rtQ = `${b.quote(rightTable.table)}.${b.quote(rightCol.column)}`;

    b.append(`${join.type} JOIN ${b.quote(rightTable.table)} ON ${ltQ} = ${rtQ}`);
  }

  const whereParts: string[] = [];
  for (const f of plan.filters ?? []) {
    const compiled = compileFilterSql(f, b, resolver, plan);
    if (compiled) whereParts.push(compiled);
  }

  if (timeGrainColumnSql) {
    whereParts.push(`${timeGrainColumnSql} IS NOT NULL`);
  }

  if (whereParts.length > 0) {
    b.append(`WHERE ${whereParts.join(" AND ")}`);
  }

  if (groupParts.length > 0) {
    b.append(`GROUP BY ${groupParts.join(", ")}`);
  }
  
  if (plan.sortDir || plan.timeGrainColumn) {
    if (isAggregated) {
      if (timeGrainColumnSql) {
        const secondarySort = groupParts.length > 1 ? `, ${b.quote("metric_value")} ${plan.sortDir === "asc" ? "ASC" : "DESC"}` : "";
        b.append(`ORDER BY ${b.quote("time_key")} ASC${secondarySort}`);
      } else if (isValueList) {
        b.append(`ORDER BY 1 ${plan.sortDir === "desc" ? "DESC" : "ASC"}`);
      } else {
        b.append(`ORDER BY ${b.quote("metric_value")} ${plan.sortDir === "asc" ? "ASC" : "DESC"}`);
      }
    } else {
       b.append(`ORDER BY 1 ${plan.sortDir === "desc" ? "DESC" : "ASC"}`);
    }
  }

  if (plan.limit && dialect !== "sqlserver") {
    b.append(`LIMIT ${Math.floor(plan.limit)}`);
  }

  const seg = b.toSegment();
  return finalize({ dialect, sql: seg.sql, params: seg.params, plan, joins: activeJoins });
}

// ---------------------------------------------------------------------------
// Self-test entry — `npx tsx src/sql/compiler.ts --selftest`
// Useful for CI smoke without Jest.
// ---------------------------------------------------------------------------

export function runSelfTest(): { passed: number; failed: number; cases: string[] } {
  const cases: { name: string; fn: () => void }[] = [
    { name: "quote mysql", fn: () => expect(quoteId("foo", "mysql")).toBe("`foo`") },
    { name: "quote postgres", fn: () => expect(quoteId("foo", "postgresql")).toBe('"foo"') },
    { name: "quote sqlserver", fn: () => expect(quoteId("foo", "sqlserver")).toBe("[foo]") },
    { name: "quote qualified", fn: () => expect(quoteId("my_schema.my_table", "mysql")).toBe("`my_schema`.`my_table`") },
    { name: "reject SQLi ident", fn: () => expect(() => quoteId("foo; DROP TABLE x", "mysql")).toThrow(SqlCompileError) },
    { name: "reject reserved keyword", fn: () => expect(() => quoteId("select", "mysql")).toThrow(SqlCompileError) },
    { name: "placeholder pg", fn: () => expect(paramPlaceholder(1, "postgresql")).toBe("$1") },
    { name: "placeholder mysql", fn: () => expect(paramPlaceholder(1, "mysql")).toBe("?") },
    { name: "placeholder mssql", fn: () => expect(paramPlaceholder(1, "sqlserver")).toBe("@p1") },
    { name: "simple metric", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "SUM(amount)", filters: [], joins: [] },
        "mysql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.amount" ? { table: "orders", column: "amount" }
          : null,
        "SUM(amount)",
      );
      expect(r.sql).toContain("SELECT");
      expect(r.sql).toContain("(SUM(amount)) AS `metric_value`");
      expect(r.params).toEqual([]);
    }},
    { name: "with eq filter", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", filters: [{ field: "orders.region", op: "eq", value: "EMEA" }] },
        "postgresql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.region" ? { table: "orders", column: "region" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain('"orders"."region" = $1');
      expect(r.params).toEqual(["EMEA"]);
    }},
    { name: "with explicit null filters", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["orders"],
          metric: "COUNT(1)",
          filters: [
            { field: "orders.closedAt", op: "is_null" },
            { field: "orders.ownerId", op: "not_null" },
          ],
        },
        "postgresql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.closedAt" ? { table: "orders", column: "closed_at" }
          : ref === "orders.ownerId" ? { table: "orders", column: "owner_id" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain('"orders"."closed_at" IS NULL');
      expect(r.sql).toContain('"orders"."owner_id" IS NOT NULL');
      expect(r.params).toEqual([]);
    }},
    { name: "allow physical table resolver for logical dataset", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["semantic_orders"], metric: "COUNT(1)", filters: [{ field: "semantic_orders.status", op: "eq", value: "open" }] },
        "mysql",
        (ref) => ref === "semantic_orders.__table__" ? { table: "warehouse.orders", column: "__table__" }
          : ref === "semantic_orders.status" ? { table: "warehouse.orders", column: "status" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain("`warehouse`.`orders`.`status` = ?");
      expect(r.params).toEqual(["open"]);
    }},
    { name: "with IN filter", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", filters: [{ field: "orders.region", op: "in", value: ["EMEA", "APAC"] }] },
        "mysql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.region" ? { table: "orders", column: "region" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain("`orders`.`region` IN (?, ?)");
      expect(r.params).toEqual(["EMEA", "APAC"]);
    }},
    { name: "with between filter", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", filters: [{ field: "orders.orderDate", op: "between", value: { start: "2025-01-01", end: "2025-12-31" } }] },
        "postgresql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.orderDate" ? { table: "orders", column: "order_date" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain('BETWEEN $1 AND $2');
      expect(r.params).toEqual(["2025-01-01", "2025-12-31"]);
    }},
    { name: "with relative time filter", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", filters: [{ field: "orders.orderDate", op: "relative", value: "last_30_days" }] },
        "mysql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.orderDate" ? { table: "orders", column: "order_date" }
          : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain("`orders`.`order_date` BETWEEN ? AND ?");
      expect(r.params.length).toBe(2);
      if (String(r.params[0]) === "1970-01-01" || String(r.params[1]) === "2999-12-31") {
        throw new Error("Relative time filter used fallback all-time range");
      }
    }},
    { name: "multi table + join", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders", "customers"], metric: "SUM(amount)", joins: [{ type: "LEFT", leftTable: "orders", leftColumn: "customer_id", rightTable: "customers", rightColumn: "id" }] },
        "mysql",
        (ref) => {
          if (ref === "orders.__table__") return { table: "orders", column: "" };
          if (ref === "customers.__table__") return { table: "customers", column: "" };
          if (ref === "orders.customer_id") return { table: "orders", column: "customer_id" };
          if (ref === "customers.id") return { table: "customers", column: "id" };
          if (ref === "orders.amount") return { table: "orders", column: "amount" };
          return null;
        },
        "SUM(orders.amount)",
      );
      expect(r.sql).toContain("LEFT JOIN `customers` ON `orders`.`customer_id` = `customers`.`id`");
    }},
    { name: "fanout inner join becomes exists when joined table is unused", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "existence_dimension"],
          metric: "SUM(amount)",
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "dimension_id", rightTable: "existence_dimension", rightColumn: "id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "analytics.primary_fact", column: "__table__" };
          if (ref === "existence_dimension.__table__") return { table: "analytics.existence_dimension", column: "__table__" };
          if (ref === "primary_fact.dimension_id") return { table: "analytics.primary_fact", column: "dimension_id" };
          if (ref === "existence_dimension.id") return { table: "analytics.existence_dimension", column: "id" };
          return null;
        },
        "SUM(primary_fact.amount)",
      );
      expect(r.sql).toContain("WHERE EXISTS (SELECT 1 FROM `analytics`.`existence_dimension`");
      expect(r.sql).toContain("`analytics`.`primary_fact`.`dimension_id` = `analytics`.`existence_dimension`.`id`");
      expect(r.sql).not.toContain("INNER JOIN");
    }},
    { name: "fanout inner join remains when metric uses joined table", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "detail_fact"],
          metric: "SUM(amount) + SUM(quantity)",
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "id", rightTable: "detail_fact", rightColumn: "primary_id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "analytics.primary_fact", column: "__table__" };
          if (ref === "detail_fact.__table__") return { table: "analytics.detail_fact", column: "__table__" };
          if (ref === "primary_fact.id") return { table: "analytics.primary_fact", column: "id" };
          if (ref === "detail_fact.primary_id") return { table: "analytics.detail_fact", column: "primary_id" };
          return null;
        },
        "SUM(primary_fact.amount) + SUM(detail_fact.quantity)",
      );
      expect(r.sql).toContain("INNER JOIN `analytics`.`detail_fact`");
      expect(r.sql).not.toContain("WHERE EXISTS");
    }},
    { name: "filter-only joined table becomes a semi-join with the filter pushed into EXISTS (no fan-out)", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "existence_dimension"],
          metric: "SUM(amount)",
          filters: [{ field: "existence_dimension.status", op: "eq", value: "active" }],
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "dimension_id", rightTable: "existence_dimension", rightColumn: "id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "primary_fact", column: "__table__" };
          if (ref === "existence_dimension.__table__") return { table: "existence_dimension", column: "__table__" };
          if (ref === "primary_fact.dimension_id") return { table: "primary_fact", column: "dimension_id" };
          if (ref === "existence_dimension.id") return { table: "existence_dimension", column: "id" };
          if (ref === "existence_dimension.status") return { table: "existence_dimension", column: "status" };
          return null;
        },
        "SUM(primary_fact.amount)",
      );
      // The joined table is used ONLY by a filter, so it collapses to a
      // semi-join and its filter is pushed inside — avoiding COUNT/SUM fan-out.
      expect(r.sql).not.toContain("INNER JOIN");
      expect(r.sql).toContain("EXISTS (SELECT 1 FROM `existence_dimension`");
      expect(r.sql).toContain("`primary_fact`.`dimension_id` = `existence_dimension`.`id`");
      expect(r.sql).toContain("`existence_dimension`.`status` = ?");
      expect(r.params).toEqual(["active"]);
    }},
    { name: "mixed OR filter across tables keeps a real join (cannot push into EXISTS)", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "existence_dimension"],
          metric: "SUM(amount)",
          filters: [{
            type: "group", operator: "OR", children: [
              { field: "primary_fact.region", op: "eq", value: "EU" },
              { field: "existence_dimension.status", op: "eq", value: "active" },
            ],
          } as any],
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "dimension_id", rightTable: "existence_dimension", rightColumn: "id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "primary_fact", column: "__table__" };
          if (ref === "existence_dimension.__table__") return { table: "existence_dimension", column: "__table__" };
          if (ref === "primary_fact.dimension_id") return { table: "primary_fact", column: "dimension_id" };
          if (ref === "existence_dimension.id") return { table: "existence_dimension", column: "id" };
          if (ref === "existence_dimension.status") return { table: "existence_dimension", column: "status" };
          if (ref === "primary_fact.region") return { table: "primary_fact", column: "region" };
          return null;
        },
        "SUM(primary_fact.amount)",
      );
      // The OR spans both tables, so its existence_dimension condition can't be
      // pushed — the real join must remain to preserve semantics.
      expect(r.sql).toContain("INNER JOIN `existence_dimension`");
      expect(r.sql).not.toContain("EXISTS");
    }},
    { name: "mixed filters: same-table filter pushed to EXISTS, primary-table filter stays in outer WHERE", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "existence_dimension"],
          metric: "SUM(amount)",
          filters: [
            { field: "primary_fact.region", op: "eq", value: "EU" },
            { field: "existence_dimension.status", op: "eq", value: "active" },
          ],
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "dimension_id", rightTable: "existence_dimension", rightColumn: "id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "primary_fact", column: "__table__" };
          if (ref === "existence_dimension.__table__") return { table: "existence_dimension", column: "__table__" };
          if (ref === "primary_fact.dimension_id") return { table: "primary_fact", column: "dimension_id" };
          if (ref === "existence_dimension.id") return { table: "existence_dimension", column: "id" };
          if (ref === "existence_dimension.status") return { table: "existence_dimension", column: "status" };
          if (ref === "primary_fact.region") return { table: "primary_fact", column: "region" };
          return null;
        },
        "SUM(primary_fact.amount)",
      );
      expect(r.sql).not.toContain("INNER JOIN");
      expect(r.sql).toContain("EXISTS (SELECT 1 FROM `existence_dimension`");
      expect(r.sql).toContain("`existence_dimension`.`status` = ?");
      // The primary-table filter is NOT pushed — it stays in the outer WHERE.
      expect(r.sql).toContain("`primary_fact`.`region` = ?");
      expect(r.params).toEqual(["active", "EU"]);
    }},
    { name: "group-by on joined table keeps a real join (rows are consumed, not just existence)", fn: () => {
      const r = compileKpiQuery(
        {
          datasets: ["primary_fact", "existence_dimension"],
          metric: "SUM(amount)",
          groupBy: ["existence_dimension.status"],
          joins: [{ type: "INNER", leftTable: "primary_fact", leftColumn: "dimension_id", rightTable: "existence_dimension", rightColumn: "id" }],
        },
        "mysql",
        (ref) => {
          if (ref === "primary_fact.__table__") return { table: "primary_fact", column: "__table__" };
          if (ref === "existence_dimension.__table__") return { table: "existence_dimension", column: "__table__" };
          if (ref === "primary_fact.dimension_id") return { table: "primary_fact", column: "dimension_id" };
          if (ref === "existence_dimension.id") return { table: "existence_dimension", column: "id" };
          if (ref === "existence_dimension.status") return { table: "existence_dimension", column: "status" };
          return null;
        },
        "SUM(primary_fact.amount)",
      );
      expect(r.sql).toContain("INNER JOIN `existence_dimension`");
      expect(r.sql).not.toContain("EXISTS");
    }},
    { name: "time grain month", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "SUM(amount)", timeGrain: "month", timeGrainColumn: "orders.orderDate", groupBy: ["orders.region"] },
        "mysql",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" }
          : ref === "orders.orderDate" ? { table: "orders", column: "order_date" }
          : ref === "orders.region" ? { table: "orders", column: "region" }
          : ref === "orders.amount" ? { table: "orders", column: "amount" }
          : null,
        "SUM(amount)",
      );
      expect(r.sql).toContain("DATE_FORMAT(`orders`.`order_date`");
      expect(r.sql).toContain("GROUP BY");
    }},
    { name: "reject multi table without joins", fn: () => expect(() => compileKpiQuery(
      { datasets: ["orders", "customers"], metric: "COUNT(1)" },
      "mysql",
      () => null,
      "COUNT(1)",
    )).toThrow(SqlCompileError) },
    { name: "reject column from outside plan", fn: () => expect(() => compileKpiQuery(
      { datasets: ["orders"], metric: "COUNT(1)", filters: [{ field: "users.id", op: "eq", value: 1 }] },
      "mysql",
      (ref) => ref === "orders.__table__" ? { table: "orders", column: "" } : ref === "users.id" ? { table: "users", column: "id" } : null,
      "COUNT(1)",
    )).toThrow(SqlCompileError) },
    { name: "param cap", fn: () => {
      const big: QueryPlanInput = { datasets: ["t"], metric: "COUNT(1)", filters: [{ field: "t.x", op: "in", value: Array.from({ length: 5 }, (_, i) => i) }] };
      expect(() => compileKpiQuery(big, "mysql", (ref) => ref === "t.__table__" ? { table: "t", column: "" } : { table: "t", column: "x" }, "COUNT(1)", { maxParams: 3 })).toThrow(/PARAM_CAP_EXCEEDED|UNSAFE_IDENTIFIER/);
    }},
    { name: "sqlserver TOP", fn: () => {
      const r = compileKpiQuery(
        { datasets: ["orders"], metric: "COUNT(1)", limit: 10 },
        "sqlserver",
        (ref) => ref === "orders.__table__" ? { table: "orders", column: "" } : null,
        "COUNT(1)",
      );
      expect(r.sql).toContain("SELECT TOP 10");
      expect(r.sql).not.toContain("LIMIT");
    }},
  ];

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      c.fn();
      passed++;
    } catch (e: unknown) {
      failed++;
      failures.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    passed,
    failed,
    cases: failures,
  };
}

interface TestExpectation<T> {
  toBe(expected: T): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toThrow(matcher?: RegExp | (new (...args: never[]) => Error)): void;
  not: {
    toContain(expected: unknown): void;
  };
}

function expect<T>(actual: T): TestExpectation<T> {
  return {
    toBe(expected: T) {
      if (!Object.is(actual, expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
      }
    },
    toContain(expected: unknown) {
      if (!String(actual).includes(String(expected))) {
        throw new Error(`Expected ${actual} to contain ${expected}`);
      }
    },
    toThrow(matcher?: RegExp | (new (...args: never[]) => Error)) {
      if (!(actual instanceof Function)) {
        throw new Error("toThrow() must be called on a function");
      }
      let thrown: unknown = null;
      try { (actual as unknown as () => unknown)(); } catch (e) { thrown = e; }
      if (thrown === null) throw new Error("Expected function to throw, but it did not");
      const thrownText = thrown instanceof Error
        ? ("code" in thrown ? String((thrown as Error & { code?: string }).code || thrown.message) : thrown.message)
        : String(thrown);
      if (matcher instanceof RegExp && !matcher.test(thrownText)) {
        throw new Error(`Threw, but message/code did not match ${matcher}: ${thrownText}`);
      }
      if (typeof matcher === "function" && !(thrown instanceof matcher)) {
        throw new Error(`Threw, but not an instance of ${matcher.name}`);
      }
    },
    not: {
      toContain(expected: unknown) {
        if (String(actual).includes(String(expected))) {
          throw new Error(`Expected ${actual} not to contain ${expected}`);
        }
      }
    }
  };
}

// Allow running via `tsx src/sql/compiler.ts --selftest`
if (require.main === module) {
  if (process.env.NODE_ENV === "production") {
    console.error("Compiler self-test is disabled in production.");
    process.exit(1);
  }
  if (!process.argv.includes("--selftest")) {
    console.log("Compiler module. Run with --selftest to execute tests.");
    process.exit(0);
  }
  const result = runSelfTest();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.failed === 0 ? 0 : 1);
}
