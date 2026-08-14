import type { AiDatasetDefinition } from "../../../routes/semanticLayer/semanticCatalog";

// A table's "role" is a deterministic, schema-derived classification of what the
// table IS in business terms — the live source of truth, a backup copy, a
// pre-aggregated report, an append-only log, or a small reference/lookup list.
// It is computed from the table name + structural signals (column count, primary
// key), NOT stored and NOT LLM-generated, so it is always fresh, free, and
// explainable. The Simple planner uses it two ways:
//   1. ranking — a backup copy must never outrank the live table it duplicates;
//   2. prompt context — each scoped table carries a one-line `note` so the LLM
//      picks the canonical table (e.g. GS_SN_CUSTOMERSERVICE_CASE) over its
//      backup (BKP_CASE) or its report (…_CASE_REPORT).
export type DatasetRole = "entity" | "backup" | "report" | "log" | "lookup";

const BACKUP_PATTERN = /(?:^|[_\W])(?:bkp|backup|bak|archive|arch|tmp|temp|old|obsolete|deprecated|stg|staging)(?:$|[_\W])/i;
const REPORT_PATTERN = /(?:^|[_\W])(?:report|reports|summary|agg|aggregate|aggregated|rollup|stats|statistics|snapshot|mv|dashboard)(?:$|[_\W])/i;
const LOG_PATTERN = /(?:^|[_\W])(?:log|logs|audit|events?|history|hist|journal|changelog)(?:$|[_\W])/i;
const LOOKUP_HINT = /(?:^|[_\W])(?:type|types|status|statuses|category|categories|code|codes|lookup|ref|reference|dim|dimension|enum)(?:$|[_\W])/i;
const LOOKUP_MAX_COLUMNS = 8;
// Implementation prefixes stripped only when producing the human-readable note.
const NOISE_TOKENS = new Set(["gs", "sn", "u", "gsc", "bkp", "tbl", "dbo", "sys"]);

function tableLeaf(dataset: AiDatasetDefinition): string {
  const physical = dataset.physicalTable || dataset.label || dataset.name;
  return String(physical).split(".").filter(Boolean).pop() || String(physical);
}

/** "GS_SN_CUSTOMERSERVICE_CASE" -> "customerservice case" for readable notes. */
export function humanizeTableName(name: string): string {
  const cleaned = String(name || "")
    .replace(/[_\-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token && !NOISE_TOKENS.has(token))
    .join(" ")
    .trim();
  return cleaned || String(name || "").toLowerCase();
}

export function classifyDatasetRole(dataset: AiDatasetDefinition): DatasetRole {
  const haystack = `${dataset.name} ${dataset.label || ""} ${tableLeaf(dataset)}`;
  // Backup is checked first: a "bkp_case_report" is a backup, not a report.
  if (BACKUP_PATTERN.test(haystack)) return "backup";
  if (REPORT_PATTERN.test(haystack)) return "report";
  if (LOG_PATTERN.test(haystack)) return "log";
  const columnCount = dataset.columns?.length || 0;
  if (columnCount > 0 && columnCount <= LOOKUP_MAX_COLUMNS && LOOKUP_HINT.test(haystack)) {
    return "lookup";
  }
  return "entity";
}

export interface DatasetDescription {
  role: DatasetRole;
  note: string;
}

export function describeDataset(dataset: AiDatasetDefinition): DatasetDescription {
  const role = classifyDatasetRole(dataset);
  const subject = humanizeTableName(tableLeaf(dataset));
  const notes: Record<DatasetRole, string> = {
    entity: `Live source-of-truth records for ${subject}.`,
    backup: `Backup/archived copy of ${subject} data — NOT the live source; do not use unless the user explicitly asks for backup/archived data.`,
    report: `Pre-aggregated report/summary of ${subject}; use only when the user asks about the report or summary itself.`,
    log: `Append-only log/audit/history of ${subject} events.`,
    lookup: `Small reference/lookup list of ${subject} values.`,
  };
  return { role, note: notes[role] };
}

/**
 * Ranking penalty applied on top of intent-overlap scoring. A backup copy is
 * pushed well below the live table so it can never win a tie; a log/audit table
 * is nudged down. Reports and lookups are left neutral — the user may genuinely
 * want them, and the planner decides using the `note`.
 */
export function datasetRolePenalty(dataset: AiDatasetDefinition): number {
  switch (classifyDatasetRole(dataset)) {
    case "backup":
      return 8;
    case "log":
      return 2;
    default:
      return 0;
  }
}
