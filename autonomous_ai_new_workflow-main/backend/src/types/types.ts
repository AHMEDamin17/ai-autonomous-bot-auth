// ============================================================================
// backend/src/types/types.ts
// ============================================================================

// db_type is stored lowercase (e.g. mysql, postgresql, mssql, sqlite, snowflake, bigquery, databricks, mongodb, redis)
export type DbType = string;

export interface DatabaseConnection {
  id: number;
  connection_name: string;
  semantic_key?: string;
  db_type: DbType;
  host: string; // format: "hostname:port"
  db_user?: string;
  db_password?: string;
  credentials_json?: string;
  default_schema?: string;
  created_at: Date;
  updated_at?: Date;
  created_by?: number | null;
  updated_by?: number | null;
}

export interface CreateConnectionPayload {
  connection_name: string;
  db_type: DbType;
  host: string; // format: "hostname:port"
  db_user?: string;
  db_password?: string;
  credentials_json?: string;
  default_schema?: string;
}

export interface CatalogTable {
  table_name: string;
  table_schema: string;
}

export interface CatalogColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  table_schema: string;
  is_primary_key?: boolean;
  is_auto_increment?: boolean;
}

export interface CatalogFunction {
  function_name: string;
  function_schema: string;
  return_type: string;
}

export interface CatalogRelationship {
  sourceTable: string;       // physical table name from information_schema
  sourceColumn: string;
  targetTable: string;       // physical table name (referenced table)
  targetColumn: string;
  constraintName?: string;
}

export interface CatalogEntry {
  connection_id: number;
  connection_name: string;
  tables: CatalogTable[];
  views: CatalogTable[];
  columns: CatalogColumn[];
  functions: CatalogFunction[];
  relationships?: CatalogRelationship[];
  error?: string;
}

// ============================================================================
// KPI FILTER AST TYPES
// ============================================================================

export type FilterOperator = "AND" | "OR";
export type SqlFilterOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "between"
  | "relative"
  | "is_null"
  | "not_null";

export interface FilterCondition {
  type: "condition";
  field: string;           // qualified: "table.column" or bare column name
  op: SqlFilterOp;
  value?: any;             // omitted for is_null/not_null
}

export interface FilterGroup {
  type: "group";
  operator: FilterOperator;
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

// ============================================================================
// KPI JOIN SPEC
// ============================================================================

export interface KpiJoinCondition {
  leftColumn: string;
  rightColumn: string;
  // Usually inherited from the parent edge. Runtime KPI dimension matching
  // may point back to the root table while the edge attaches a later table.
  leftTable?: string;
  rightTable?: string;
  joinCondition?: "fk" | "inferred" | "manual" | "dimension_match";
}

export interface KpiJoinSpec {
  type: "INNER" | "LEFT" | "RIGHT" | "FULL";
  leftTable: string;       // logical dataset name (from catalog)
  leftColumn: string;
  rightTable: string;      // logical dataset name (from catalog)
  rightColumn: string;
  // `leftColumn` / `rightColumn` remain the canonical first condition so
  // existing KPI rows and older clients continue to work unchanged.
  conditions?: KpiJoinCondition[];
  joinCondition?: "fk" | "inferred" | "manual" | "dimension_match";  // for UI hints
}

// ============================================================================
// KPI METRIC
// ============================================================================

export interface KpiMetric {
  id: number;
  connection_id: number;
  connection_name: string;
  metric_name: string;
  department: string;
  metric_type: string;
  formula: string;                    // metric expression (e.g., "SUM(amount)")
  table_name?: string;                // deprecated: single table (legacy)
  format: "currency" | "number" | "percent";
  dimensions: string[];               // minimum GROUP BY columns
  involved_tables: string[];          // authoritative table list (required)
  join_spec?: KpiJoinSpec[];          // JOIN definitions for multi-table KPIs
  filter_logic?: FilterNode;          // NEW: structured filter AST
  select_columns?: string[];          // explicit SELECT columns (defaults to dimensions + metric)
  created_at: Date;
  updated_at?: Date;
}

// API Payloads
export interface CreateKpiMetricPayload {
  connection_id: number;
  metric_name: string;
  department: string;
  metric_type: string;
  formula: string;
  format?: "currency" | "number" | "percent";
  dimensions?: string[];
  involved_tables: string[];          // REQUIRED
  join_spec?: KpiJoinSpec[];
  filter_logic?: FilterNode;
  select_columns?: string[];
}

export interface UpdateKpiMetricPayload extends Partial<CreateKpiMetricPayload> {}

export interface ApiResponse<T> {
  data: T;
  message?: string;
  meta?: Record<string, any>;
}

export interface ApiError {
  error: string;
  detail?: string;
}

// ============================================================================
// SEMANTIC MODEL TYPES
// ============================================================================

export type AiColumnType = "string" | "number" | "date";

export interface AiDatasetColumn {
  name: string;
  type: AiColumnType;
  allowedForGrouping: boolean;
  allowedForFiltering: boolean;
  isPrimaryKey?: boolean;
  isAutoIncrement?: boolean;
}

export interface GlobalAiKpi {
  name: string;
  expressionSql: string;
  valueFormat: string;
  involvedTables: string[];
  allowedGroupByTables: string[];
  dimensions: string[];
  // KPI-specific compilation hints (attached by semanticModels.ts)
  join_spec?: KpiJoinSpec[];
  filter_logic?: FilterNode;
  select_columns?: string[];
  kpi_dimensions?: string[];  // alias for dimensions
}

export interface AiDatasetMetric {
  name: string;
  label: string;
  expressionSql: string;
  format: "currency" | "number" | "percent";
  synonyms: string[];
  // KPI compilation hints (for global_kpis dataset)
  join_spec?: KpiJoinSpec[];
  filter_logic?: FilterNode;
  select_columns?: string[];
  involved_tables?: string[];
  dimensions?: string[];
}

export interface AiRelationship {
  targetDataset: string;     // LOGICAL dataset name (e.g., "dbo_sales_orders")
  sourceColumn: string;      // column in THIS dataset
  targetColumn: string;      // column in the TARGET dataset
  type: "foreign_key" | "inferred" | "kpi_defined";  // kpi_defined = from KPI join_spec
}

export interface AiDatasetDefinition {
  name: string;
  label: string;
  physicalTable: string;
  certified: boolean;
  synonyms: string[];
  columns: AiDatasetColumn[];
  metrics: AiDatasetMetric[];
  relationships: AiRelationship[];
}

export interface AiCatalogContext {
  datasets: AiDatasetDefinition[];
  kpiMetrics: GlobalAiKpi[];
}

// ============================================================================
// COMPILER TYPES
// ============================================================================

export type DialectType = "mysql" | "postgresql" | "sqlserver" | "sqlite" | "snowflake" | "bigquery" | "databricks";

export interface JoinSpec {
  type: "INNER" | "LEFT" | "RIGHT" | "FULL";
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  conditions?: KpiJoinCondition[];
  joinCondition?: "fk" | "inferred" | "manual" | "dimension_match";
}

export interface CompiledQuery {
  dialect: DialectType;
  sql: string;
  params: unknown[];
  dataset: string;              // primary dataset (backward compat)
  metric: string;
  groupBy?: string | string[];
  filters?: any[];
  datasets?: string[];          // all datasets in query
  joins?: JoinSpec[];
}

export interface CompileOptions {
  readonly maxParams?: number;
  readonly rejectSubquery?: boolean;
}

export interface SqlFilter {
  field: string;
  op: SqlFilterOp;
  value?: string | number | boolean | (string | number)[] | { start: string | number; end: string | number };
}

export interface CombinedGroupBySpec {
  /** Canonical configured dimension retained in QueryPlan.groupBy. */
  groupBy: string;
  /** Same-named configured columns whose distinct row values form one group set. */
  columns: string[];
}

export interface QueryPlanInput {
  datasets: string[];
  metric: string;
  groupBy?: string | string[] | null;
  timeGrain?: "day" | "week" | "month" | "year" | null;
  timeGrainColumn?: string | null;
  sortDir?: "asc" | "desc" | null;
  limit?: number | null;
  filters?: SqlFilter[] | null;
  joins?: JoinSpec[] | null;
  assumptions?: string[] | null;
  select_columns?: string[] | null;
  combinedGroupBy?: CombinedGroupBySpec[] | null;
}

export interface CompileKpiOptions {
  kpi: GlobalAiKpi;
  userFilters?: FilterNode;           // from classifyQuery
  queryGroupBy?: string | string[];   // additional GROUP BY from user query
  querySortDir?: "asc" | "desc";
  queryLimit?: number;
  userAst?: any;
}

// ============================================================================
// EXECUTION TYPES
// ============================================================================

export interface QueryResultRow {
  key?: string;
  value: any;
}

export interface QueryResult {
  dataset: string;
  metric: string;
  groupBy?: string | string[];
  sql: string;
  rowCount: number;
  rows: QueryResultRow[];
}

export interface LiveAdapter {
  dialect: DialectType;
  execute: (query: CompiledQuery, signal?: AbortSignal) => Promise<QueryResult>;
  close: () => Promise<void>;
}

// ============================================================================
// CLASSIFIER TYPES
// ============================================================================

export interface ConversationContext {
  conversationId?: string;
  referencedTables: string[];
  referencedColumns: string[];
  lastTopic: string | null;
  messageCount: number;
}

export interface ClassifyResult {
  mode: "KPI" | "SIMPLE" | "AMBIGUOUS" | "NEEDS_KPI" | "GREETING" | "UNKNOWN" | "COMPLEX";
  kpi?: GlobalAiKpi;           // when KPI
  userFilters?: FilterNode;  // parsed from query (relative time, etc.)
  tableHint?: string;        // when SIMPLE
  column?: string;           // when AMBIGUOUS
  columnHints?: string[];    // when SIMPLE/AMBIGUOUS
  reason?: string;           // when NEEDS_KPI/AMBIGUOUS
  candidateTables?: string[]; // when AMBIGUOUS
  weakMatch?: string;        // when KPI: set if the match rests on a single generic keyword, so the pipeline can surface a "did you mean this KPI?" note instead of silently trusting it
}

// ============================================================================
// TELEMETRY TYPES
// ============================================================================

export interface TelemetryEvent {
  executionId: string;
  connectionId: number;
  step: string;
  status: "success" | "failure";
  latencyMs: number;
  authType: string;
  circuitState?: string;
  timestamp: string;
  traceId?: string;
}

export interface ExecutionLogEntry {
  executionId: string;
  connectionId: number;
  connector: string;
  status: "success" | "failure";
  latencyMs: number;
  authType: string;
  message?: string;
  traceId?: string;
}

// ============================================================================
// AUTH TYPES
// ============================================================================

export interface AuthContext {
  tokenPresent: boolean;
  authType: "credentials" | "none";
}

export interface SemanticModelEntry {
  name: string;
  description: string;
  department: string;
  measures: { name: string; agg: string; expr: string }[];
  dimensions?: { name: string; type: string }[];
}

export interface SemanticModelGroup {
  connection: string;
  models: SemanticModelEntry[];
}

export interface SemanticModelPayload {
  semantic_models: SemanticModelGroup[];
}

export type ColumnResolver = (columnRef: string) => { table: string; column: string } | null;
export const TABLE_KEY = "__table__" as const;
