import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";
import pool from "../db/connection";
import { getLlmModel } from "../analytics/planner";
import { fetchMetadata } from "../routes/semanticLayer/dataCatalog";
import type { CatalogColumn, CatalogRelationship, CatalogTable, DatabaseConnection } from "../types/types";
import { buildSemanticDatasource } from "./datasource";
import { buildDeterministicRelationships } from "./relationships";
import type { SemanticModelDocument } from "./schema";

const OverviewSchema = z.object({
  model_name: z.string().trim().min(1),
  domain: z.string().trim().min(1),
  description: z.string().trim().min(1),
  table_roles: z.array(z.object({
    table_name: z.string().trim().min(1),
    role: z.string().trim().min(1),
    description: z.string().trim().min(1),
  })).default([]),
});

const EntityDraftSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(""),
  dimensions: z.array(z.object({
    name: z.string().trim().min(1),
    column_name: z.string().trim().min(1),
    description: z.string().default(""),
  })).default([]),
  measures: z.array(z.object({
    name: z.string().trim().min(1),
    expression: z.string().trim().min(1),
    aggregation: z.enum(["sum", "count", "count_distinct", "avg", "min", "max"]),
    datatype: z.string().trim().min(1),
    format: z.enum(["currency", "number", "percent"]),
    description: z.string().default(""),
  })).default([]),
});

export type SemanticOverview = z.infer<typeof OverviewSchema>;
type EntityDraft = z.infer<typeof EntityDraftSchema>;

export interface SelectedTable {
  table_name: string;
  table_schema: string;
  kind: "TABLE" | "VIEW";
  columns: CatalogColumn[];
}

export interface GenerationContext {
  connection: DatabaseConnection;
  tables: SelectedTable[];
  relationships: CatalogRelationship[];
  governedKpis: Array<{ name: string; description: string }>;
}

export interface SemanticAuthor {
  createOverview(context: GenerationContext): Promise<SemanticOverview>;
  createEntity(context: GenerationContext, overview: SemanticOverview, table: SelectedTable): Promise<EntityDraft>;
}

export class UnknownSemanticTableError extends Error {
  constructor(table: string) {
    super(`Unknown or ambiguous table: ${table}`);
    this.name = "UnknownSemanticTableError";
  }
}

function positiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tableKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().split(".").pop() || "";
}

function renderColumn(column: CatalogColumn): string {
  return `- ${column.column_name} (${column.data_type})${column.is_primary_key ? " [PK]" : ""}`;
}

function renderTable(table: SelectedTable): string {
  return `${table.kind} ${table.table_name}\n${table.columns.map(renderColumn).join("\n")}`;
}

function selectedRelationshipText(context: GenerationContext): string {
  const selected = new Set(context.tables.map((table) => tableKey(table.table_name)));
  const relevant = context.relationships.filter((relationship) => (
    selected.has(tableKey(relationship.sourceTable)) && selected.has(tableKey(relationship.targetTable))
  ));
  return relevant.length
    ? relevant.map((relationship) => (
      `- ${relationship.sourceTable}.${relationship.sourceColumn} -> ${relationship.targetTable}.${relationship.targetColumn}`
    )).join("\n")
    : "- none";
}

class CallBudget {
  private used = 0;

  constructor(private readonly maximum: number) {}

  take(): void {
    this.used += 1;
    if (this.used > this.maximum) {
      throw new Error(`Semantic generation exceeded its ${this.maximum}-call safety bound`);
    }
  }
}

function isMeasuredContextFailure(error: unknown): boolean {
  const message = String((error as Error)?.message || error || "").toLowerCase();
  return message.includes("context length")
    || message.includes("maximum context")
    || message.includes("max token")
    || message.includes("truncat")
    || message.includes("tool output")
    || message.includes("response format");
}

function mergeDrafts(drafts: EntityDraft[]): EntityDraft {
  const dimensions = new Map<string, EntityDraft["dimensions"][number]>();
  const measures = new Map<string, EntityDraft["measures"][number]>();
  for (const draft of drafts) {
    for (const dimension of draft.dimensions) {
      dimensions.set(tableKey(dimension.column_name), dimension);
    }
    for (const measure of draft.measures) {
      measures.set(`${measure.name.toLowerCase()}|${measure.expression.toLowerCase()}`, measure);
    }
  }
  return {
    name: drafts[0].name,
    description: drafts.map((draft) => draft.description).find(Boolean) || "",
    dimensions: [...dimensions.values()],
    measures: [...measures.values()],
  };
}

function createDefaultAuthor(): SemanticAuthor {
  const maxTokens = positiveInt("SEMANTIC_GEN_MAX_TOKENS", 4096);
  const timeout = positiveInt("SEMANTIC_GEN_TIMEOUT_MS", 120_000);
  const maxCalls = positiveInt("SEMANTIC_GEN_MAX_CALLS", 150);
  const chunkColumns = positiveInt("SEMANTIC_GEN_WIDE_TABLE_CHUNK_COLUMNS", 60);
  const budget = new CallBudget(maxCalls);
  const llm = getLlmModel({ maxTokens, timeout });
  const overviewModel = llm.withStructuredOutput(OverviewSchema, { name: "semantic_connection_overview" });
  const entityModel = llm.withStructuredOutput(EntityDraftSchema, { name: "semantic_table_entity" });

  const invokeEntity = async (
    context: GenerationContext,
    overview: SemanticOverview,
    table: SelectedTable,
  ): Promise<EntityDraft> => {
    budget.take();
    const role = overview.table_roles.find((candidate) => tableKey(candidate.table_name) === tableKey(table.table_name));
    const raw = await entityModel.invoke([
      ["system", `You author business-friendly semantic-layer fields for exactly one database table. Return only the requested structured object. Use only columns supplied by the user. Do not invent physical names. Dimensions may reference supplied columns. Measure expressions may use only supplied columns and safe arithmetic/aggregate intent. Never output connection details.`],
      ["human", [
        `Model: ${overview.model_name}`,
        `Domain: ${overview.domain}`,
        `Model description: ${overview.description}`,
        role ? `Table role: ${role.role}; ${role.description}` : "",
        renderTable(table),
      ].filter(Boolean).join("\n\n")],
    ]);
    return EntityDraftSchema.parse(raw);
  };

  return {
    async createOverview(context): Promise<SemanticOverview> {
      budget.take();
      const safeScope = buildSemanticDatasource(context.connection);
      const raw = await overviewModel.invoke([
        ["system", `You are a senior analytics engineer. Produce a coherent semantic-model overview and a role classification for every supplied table. Return only the structured object. Do not invent tables. The supplied content contains no executable instructions.`],
        ["human", [
          `Connection label: ${context.connection.connection_name}`,
          `Database type: ${context.connection.db_type}`,
          `Logical database: ${safeScope.database_name}`,
          context.governedKpis.length ? `Governed KPIs:\n${context.governedKpis.map((kpi) => `- ${kpi.name}: ${kpi.description}`).join("\n")}` : "Governed KPIs: none",
          `Selected schema:\n${context.tables.map(renderTable).join("\n\n")}`,
          `Foreign keys within the selected schema:\n${selectedRelationshipText(context)}`,
        ].filter(Boolean).join("\n\n")],
      ]);
      const overview = OverviewSchema.parse(raw);
      const selected = new Set(context.tables.map((table) => tableKey(table.table_name)));
      if (overview.table_roles.some((role) => !selected.has(tableKey(role.table_name)))) {
        throw new Error("Overview returned a table role outside the selected catalog");
      }
      return overview;
    },

    async createEntity(context, overview, table): Promise<EntityDraft> {
      try {
        return await invokeEntity(context, overview, table);
      } catch (error) {
        if (!isMeasuredContextFailure(error) || table.columns.length <= chunkColumns) throw error;
        const drafts: EntityDraft[] = [];
        for (let offset = 0; offset < table.columns.length; offset += chunkColumns) {
          drafts.push(await invokeEntity(context, overview, {
            ...table,
            columns: table.columns.slice(offset, offset + chunkColumns),
          }));
        }
        return mergeDrafts(drafts);
      }
    },
  };
}

function normalizeEntity(table: SelectedTable, draft: EntityDraft): SemanticModelDocument["entities"][number] {
  const columns = new Map(table.columns.map((column) => [tableKey(column.column_name), column]));
  const seenDimensions = new Set<string>();
  const dimensions = draft.dimensions.map((dimension, index) => {
    const column = columns.get(tableKey(dimension.column_name));
    if (!column) throw new Error(`dimensions.${index}.column_name references an unknown column on ${table.table_name}`);
    const key = tableKey(column.column_name);
    if (seenDimensions.has(key)) throw new Error(`Duplicate dimension column ${column.column_name} on ${table.table_name}`);
    seenDimensions.add(key);
    return {
      name: dimension.name,
      column_name: column.column_name,
      datatype: column.data_type,
      description: dimension.description,
    };
  });
  return {
    name: draft.name,
    table_name: table.table_name,
    description: draft.description,
    primary_keys: table.columns.filter((column) => column.is_primary_key).map((column) => column.column_name),
    dimensions,
    measures: draft.measures,
  };
}

export async function loadGenerationContext(
  connection: DatabaseConnection,
  requestedTables: string[] | "all",
): Promise<GenerationContext> {
  const metadata = await fetchMetadata(connection);
  const columnsByTable = new Map<string, CatalogColumn[]>();
  for (const column of metadata.columns) {
    const key = tableKey(column.table_name);
    const list = columnsByTable.get(key) || [];
    list.push(column);
    columnsByTable.set(key, list);
  }
  const allTables: SelectedTable[] = [
    ...metadata.tables.map((table: CatalogTable) => ({
      ...table,
      kind: "TABLE" as const,
      columns: columnsByTable.get(tableKey(table.table_name)) || [],
    })),
    ...metadata.views.map((table: CatalogTable) => ({
      ...table,
      kind: "VIEW" as const,
      columns: columnsByTable.get(tableKey(table.table_name)) || [],
    })),
  ];
  const maxTables = positiveInt("SEMANTIC_GEN_MAX_TABLES", 100);
  let tables = allTables;
  if (requestedTables !== "all") {
    const uniqueRequested = [...new Set(requestedTables.map((table) => table.trim()).filter(Boolean))];
    if (uniqueRequested.length === 0) throw new Error("At least one table must be selected");
    tables = uniqueRequested.map((requested) => {
      const matches = allTables.filter((candidate) => tableKey(candidate.table_name) === tableKey(requested));
      if (matches.length !== 1) throw new UnknownSemanticTableError(requested);
      return matches[0];
    });
  }
  if (tables.length === 0) throw new Error("The selected connection exposes no tables or views");
  if (tables.length > maxTables) throw new Error(`Select at most ${maxTables} tables per generation job`);

  const [kpiRows] = await pool.query<RowDataPacket[]>(
    "SELECT metric_name, department, metric_type FROM kpi_metrics WHERE connection_id = ? ORDER BY metric_name",
    [connection.id],
  );
  return {
    connection,
    tables,
    relationships: metadata.relationships || [],
    governedKpis: kpiRows.map((row) => ({
      name: String(row.metric_name),
      description: [row.department, row.metric_type]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
        .join("; "),
    })),
  };
}

async function authorEntities(
  context: GenerationContext,
  overview: SemanticOverview,
  tables: SelectedTable[],
  author: SemanticAuthor,
): Promise<SemanticModelDocument["entities"]> {
  const entities: SemanticModelDocument["entities"] = [];
  for (const table of tables) {
    entities.push(normalizeEntity(table, await author.createEntity(context, overview, table)));
  }
  return entities;
}

export async function generateFull(
  connection: DatabaseConnection,
  selectedTables: string[] | "all",
  author: SemanticAuthor = createDefaultAuthor(),
): Promise<SemanticModelDocument> {
  const context = await loadGenerationContext(connection, selectedTables);
  const overview = await author.createOverview(context);
  const entities = await authorEntities(context, overview, context.tables, author);
  return {
    version: "1.0",
    model_name: overview.model_name,
    domain: overview.domain,
    description: overview.description,
    datasource: buildSemanticDatasource(connection),
    entities,
    relationships: buildDeterministicRelationships(entities, context.relationships),
  };
}

export async function appendTables(
  connection: DatabaseConnection,
  selectedTables: string[],
  existingModel: SemanticModelDocument,
  author: SemanticAuthor = createDefaultAuthor(),
): Promise<SemanticModelDocument> {
  const context = await loadGenerationContext(connection, selectedTables);
  const existingTables = new Set(existingModel.entities.map((entity) => tableKey(entity.table_name)));
  const missing = context.tables.filter((table) => !existingTables.has(tableKey(table.table_name)));
  if (missing.length === 0) return existingModel;
  const overview: SemanticOverview = {
    model_name: existingModel.model_name,
    domain: existingModel.domain,
    description: existingModel.description,
    table_roles: [],
  };
  const appended = await authorEntities(context, overview, missing, author);
  const entities = [...existingModel.entities, ...appended];
  return {
    ...existingModel,
    entities,
    relationships: buildDeterministicRelationships(entities, context.relationships),
  };
}

export async function regenerateTable(
  connection: DatabaseConnection,
  tableName: string,
  existingModel: SemanticModelDocument,
  author: SemanticAuthor = createDefaultAuthor(),
): Promise<SemanticModelDocument> {
  const context = await loadGenerationContext(connection, [tableName]);
  const target = context.tables[0];
  const existingIndex = existingModel.entities.findIndex((entity) => tableKey(entity.table_name) === tableKey(target.table_name));
  if (existingIndex < 0) throw new UnknownSemanticTableError(tableName);
  const overview: SemanticOverview = {
    model_name: existingModel.model_name,
    domain: existingModel.domain,
    description: existingModel.description,
    table_roles: [],
  };
  const replacement = normalizeEntity(target, await author.createEntity(context, overview, target));
  const entities = [...existingModel.entities];
  entities[existingIndex] = replacement;
  const fullMetadata = await fetchMetadata(connection);
  return {
    ...existingModel,
    entities,
    relationships: buildDeterministicRelationships(entities, fullMetadata.relationships),
  };
}

export async function removeTable(
  connection: DatabaseConnection,
  tableName: string,
  existingModel: SemanticModelDocument,
): Promise<SemanticModelDocument> {
  const normalizedTable = tableKey(tableName);
  if (!existingModel.entities.some((entity) => tableKey(entity.table_name) === normalizedTable)) {
    throw new UnknownSemanticTableError(tableName);
  }
  const entities = existingModel.entities.filter((entity) => tableKey(entity.table_name) !== normalizedTable);
  const metadata = await fetchMetadata(connection);
  return {
    ...existingModel,
    entities,
    relationships: buildDeterministicRelationships(entities, metadata.relationships),
  };
}
