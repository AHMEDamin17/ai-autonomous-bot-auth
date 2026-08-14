import { JoinSpec, KpiJoinCondition } from "../../types/types";

function cleanCondition(
  condition: KpiJoinCondition,
  join: Pick<JoinSpec, "leftTable" | "rightTable">,
): KpiJoinCondition {
  return {
    leftTable: condition.leftTable || join.leftTable,
    leftColumn: String(condition.leftColumn || "").trim(),
    rightTable: condition.rightTable || join.rightTable,
    rightColumn: String(condition.rightColumn || "").trim(),
    ...(condition.joinCondition ? { joinCondition: condition.joinCondition } : {}),
  };
}

export function getJoinConditions(join: JoinSpec): KpiJoinCondition[] {
  const explicit = Array.isArray(join.conditions)
    ? join.conditions.filter((condition) => condition?.leftColumn && condition?.rightColumn)
    : [];
  const source = explicit.length > 0
    ? explicit
    : (join.leftColumn && join.rightColumn
      ? [{
        leftColumn: join.leftColumn,
        rightColumn: join.rightColumn,
        joinCondition: join.joinCondition,
      }]
      : []);
  return source.map((condition) => cleanCondition(condition, join));
}

export function joinConditionKey(condition: KpiJoinCondition): string {
  return [
    condition.leftTable,
    condition.leftColumn,
    condition.rightTable,
    condition.rightColumn,
  ].map((value) => String(value || "").trim().toLowerCase()).join("|");
}

export function normalizeJoinConditions<T extends JoinSpec>(join: T): T {
  const conditions = getJoinConditions(join);
  const first = conditions[0];
  return {
    ...join,
    leftColumn: first?.leftColumn || join.leftColumn || "",
    rightColumn: first?.rightColumn || join.rightColumn || "",
    conditions,
  };
}

/**
 * Saved KPI joins are the master topology. Planner/runtime joins may add ON
 * predicates, but they cannot replace or remove a saved edge.
 */
export function mergeMasterJoinSpecs(
  masterJoins: JoinSpec[] = [],
  runtimeJoins: JoinSpec[] = [],
): JoinSpec[] {
  if (masterJoins.length === 0) return runtimeJoins.map(normalizeJoinConditions);

  const merged = masterJoins.map(normalizeJoinConditions);
  for (const runtimeJoin of runtimeJoins.map(normalizeJoinConditions)) {
    const target = merged.find((masterJoin) =>
      masterJoin.leftTable === runtimeJoin.leftTable
      && masterJoin.rightTable === runtimeJoin.rightTable
    );
    if (!target) {
      merged.push(runtimeJoin);
      continue;
    }

    const existing = new Set(getJoinConditions(target).map(joinConditionKey));
    const additional = getJoinConditions(runtimeJoin).filter(
      (condition) => !existing.has(joinConditionKey(condition)),
    );
    if (additional.length > 0) {
      target.conditions = [...getJoinConditions(target), ...additional];
    }
  }
  return merged.map(normalizeJoinConditions);
}
