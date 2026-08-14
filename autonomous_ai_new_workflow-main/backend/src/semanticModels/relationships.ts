import type { CatalogRelationship } from "../types/types";
import type { SemanticEntitySchema, SemanticModelDocument } from "./schema";
import type { z } from "zod";

type SemanticEntity = z.infer<typeof SemanticEntitySchema>;

function key(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().split(".").pop() || "";
}

function relationshipName(source: SemanticEntity, target: SemanticEntity, sourceColumn: string): string {
  return `${source.name}_${target.name}_${sourceColumn}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function buildDeterministicRelationships(
  entities: SemanticEntity[],
  catalogRelationships: CatalogRelationship[],
): SemanticModelDocument["relationships"] {
  const entityByTable = new Map(entities.map((entity) => [key(entity.table_name), entity]));
  const output: SemanticModelDocument["relationships"] = [];
  const seen = new Set<string>();

  for (const relationship of catalogRelationships || []) {
    const source = entityByTable.get(key(relationship.sourceTable));
    const target = entityByTable.get(key(relationship.targetTable));
    if (!source || !target || source === target) continue;
    const identity = [
      key(source.table_name),
      key(relationship.sourceColumn),
      key(target.table_name),
      key(relationship.targetColumn),
    ].join("|");
    if (seen.has(identity)) continue;
    seen.add(identity);
    output.push({
      name: relationshipName(source, target, relationship.sourceColumn),
      source_entity: source.name,
      target_entity: target.name,
      source_column: relationship.sourceColumn,
      target_column: relationship.targetColumn,
      cardinality: "many_to_one",
      role: target.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    });
  }
  return output;
}
