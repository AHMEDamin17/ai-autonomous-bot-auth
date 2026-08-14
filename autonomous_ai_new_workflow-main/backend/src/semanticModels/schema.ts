import { z } from "zod";
import type { CatalogColumn, CatalogRelationship, CatalogTable, DatabaseConnection } from "../types/types";
import { validateSqlExpression } from "../utils/sqlValidator";
import { buildSemanticDatasource, SemanticDatasource } from "./datasource";

const NonEmpty = z.string().trim().min(1);

export const SemanticDatasourceSchema = z.object({
  connection_id: NonEmpty,
  database_name: NonEmpty,
  catalog: NonEmpty.optional(),
  schema: NonEmpty.optional(),
  project: NonEmpty.optional(),
  dataset: NonEmpty.optional(),
}).strict();

export const SemanticDimensionSchema = z.object({
  name: NonEmpty,
  column_name: NonEmpty,
  datatype: NonEmpty,
  description: z.string(),
}).strict();

export const SemanticMeasureSchema = z.object({
  name: NonEmpty,
  expression: NonEmpty,
  aggregation: z.enum(["sum", "count", "count_distinct", "avg", "min", "max"]),
  datatype: NonEmpty,
  format: z.enum(["currency", "number", "percent"]),
  description: z.string(),
}).strict();

export const SemanticEntitySchema = z.object({
  name: NonEmpty,
  table_name: NonEmpty,
  description: z.string(),
  primary_keys: z.array(NonEmpty),
  dimensions: z.array(SemanticDimensionSchema),
  measures: z.array(SemanticMeasureSchema),
}).strict();

export const SemanticRelationshipSchema = z.object({
  name: NonEmpty,
  source_entity: NonEmpty,
  target_entity: NonEmpty,
  source_column: NonEmpty,
  target_column: NonEmpty,
  cardinality: NonEmpty,
  role: z.string().optional(),
}).strict();

export const SemanticModelDocumentSchema = z.object({
  version: z.literal("1.0"),
  model_name: NonEmpty,
  domain: NonEmpty,
  description: NonEmpty,
  datasource: SemanticDatasourceSchema,
  entities: z.array(SemanticEntitySchema),
  relationships: z.array(SemanticRelationshipSchema),
}).strict().superRefine((model, context) => {
  const entityNames = new Set<string>();
  const tableNames = new Set<string>();
  for (const [index, entity] of model.entities.entries()) {
    const entityKey = entity.name.toLowerCase();
    const tableKey = entity.table_name.toLowerCase();
    if (entityNames.has(entityKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entities", index, "name"], message: "Entity names must be unique" });
    }
    if (tableNames.has(tableKey)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["entities", index, "table_name"], message: "Each physical table may appear only once" });
    }
    entityNames.add(entityKey);
    tableNames.add(tableKey);
  }
});

export type SemanticModelDocument = z.infer<typeof SemanticModelDocumentSchema>;

export interface SemanticCatalogMetadata {
  tables: CatalogTable[];
  views: CatalogTable[];
  columns: CatalogColumn[];
  relationships: CatalogRelationship[];
}

export class SemanticModelFieldError extends Error {
  constructor(public readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "SemanticModelFieldError";
  }
}

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function sorted(values: string[]): string[] {
  return values.map(normalized).sort();
}

function assertEqualField(field: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new SemanticModelFieldError(field, "is deterministic and cannot be changed manually");
  }
}

const SQL_WORDS = new Set([
  "abs", "avg", "case", "cast", "coalesce", "count", "date", "decimal", "distinct",
  "else", "end", "false", "if", "ifnull", "max", "min", "null", "nullif", "round",
  "sum", "then", "true", "when",
]);

function referencedExpressionColumns(expression: string): string[] {
  const withoutStrings = expression.replace(/'(?:''|[^'])*'/g, " ").replace(/"(?:""|[^"])*"/g, " ");
  const tokens = withoutStrings.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return [...new Set(tokens.map(normalized).filter((token) => !SQL_WORDS.has(token)))];
}

function deterministicProjection(model: SemanticModelDocument): unknown {
  return {
    version: model.version,
    datasource: model.datasource,
    entities: [...model.entities].map((entity) => ({
      table_name: normalized(entity.table_name),
      primary_keys: sorted(entity.primary_keys),
      dimensions: entity.dimensions.map((dimension) => ({
        column_name: normalized(dimension.column_name),
        datatype: normalized(dimension.datatype),
      })).sort((left, right) => left.column_name.localeCompare(right.column_name)),
    })).sort((left, right) => left.table_name.localeCompare(right.table_name)),
    relationships: model.relationships,
  };
}

export function validateSemanticModelDocument(args: {
  value: unknown;
  connection: DatabaseConnection;
  metadata: SemanticCatalogMetadata;
  existing?: SemanticModelDocument | null;
  mode: "manual" | "generation" | "conversion";
}): SemanticModelDocument {
  const parsed = SemanticModelDocumentSchema.safeParse(args.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SemanticModelFieldError(issue.path.join(".") || "model", issue.message);
  }
  const model = parsed.data;
  const expectedDatasource = buildSemanticDatasource(args.connection);
  assertEqualField("datasource", model.datasource, expectedDatasource);

  const tablesByName = new Map<string, CatalogTable[]>();
  for (const table of [...args.metadata.tables, ...args.metadata.views]) {
    const key = normalized(table.table_name);
    const list = tablesByName.get(key) || [];
    list.push(table);
    tablesByName.set(key, list);
  }
  const columnsByTable = new Map<string, CatalogColumn[]>();
  for (const column of args.metadata.columns) {
    const key = normalized(column.table_name);
    const list = columnsByTable.get(key) || [];
    list.push(column);
    columnsByTable.set(key, list);
  }

  const entityByName = new Map(model.entities.map((entity) => [normalized(entity.name), entity]));
  for (const [entityIndex, entity] of model.entities.entries()) {
    const tableKey = normalized(entity.table_name);
    const matchingTables = tablesByName.get(tableKey) || [];
    if (matchingTables.length === 0) {
      throw new SemanticModelFieldError(`entities.${entityIndex}.table_name`, "does not exist in the live catalog");
    }
    if (matchingTables.length > 1) {
      throw new SemanticModelFieldError(`entities.${entityIndex}.table_name`, "is ambiguous across live schemas");
    }
    const columns = columnsByTable.get(tableKey) || [];
    const columnByName = new Map(columns.map((column) => [normalized(column.column_name), column]));
    const expectedPrimaryKeys = sorted(columns.filter((column) => column.is_primary_key).map((column) => column.column_name));
    if (JSON.stringify(sorted(entity.primary_keys)) !== JSON.stringify(expectedPrimaryKeys)) {
      throw new SemanticModelFieldError(`entities.${entityIndex}.primary_keys`, "must match the live catalog primary keys");
    }

    for (const [dimensionIndex, dimension] of entity.dimensions.entries()) {
      const column = columnByName.get(normalized(dimension.column_name));
      if (!column) {
        throw new SemanticModelFieldError(`entities.${entityIndex}.dimensions.${dimensionIndex}.column_name`, "does not exist on the entity table");
      }
      if (normalized(dimension.datatype) !== normalized(column.data_type)) {
        throw new SemanticModelFieldError(`entities.${entityIndex}.dimensions.${dimensionIndex}.datatype`, `must match live type ${column.data_type}`);
      }
    }
    for (const [measureIndex, measure] of entity.measures.entries()) {
      const safe = validateSqlExpression(measure.expression);
      if (!safe.valid) {
        throw new SemanticModelFieldError(`entities.${entityIndex}.measures.${measureIndex}.expression`, safe.error || "is unsafe");
      }
      const unknown = referencedExpressionColumns(measure.expression).filter((column) => !columnByName.has(column));
      if (unknown.length > 0) {
        throw new SemanticModelFieldError(`entities.${entityIndex}.measures.${measureIndex}.expression`, `references unknown column ${unknown[0]}`);
      }
    }
  }

  for (const [index, relationship] of model.relationships.entries()) {
    const source = entityByName.get(normalized(relationship.source_entity));
    const target = entityByName.get(normalized(relationship.target_entity));
    if (!source || !target) {
      throw new SemanticModelFieldError(`relationships.${index}`, "references an entity outside this model");
    }
    const sourceColumns = columnsByTable.get(normalized(source.table_name)) || [];
    const targetColumns = columnsByTable.get(normalized(target.table_name)) || [];
    if (!sourceColumns.some((column) => normalized(column.column_name) === normalized(relationship.source_column))) {
      throw new SemanticModelFieldError(`relationships.${index}.source_column`, "does not exist on the source entity");
    }
    if (!targetColumns.some((column) => normalized(column.column_name) === normalized(relationship.target_column))) {
      throw new SemanticModelFieldError(`relationships.${index}.target_column`, "does not exist on the target entity");
    }
  }

  if (args.mode === "manual" && args.existing) {
    assertEqualField("deterministic_fields", deterministicProjection(model), deterministicProjection(args.existing));
  }
  return model;
}
