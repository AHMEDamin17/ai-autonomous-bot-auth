import type { AiDatasetColumn, AiDatasetDefinition } from "../../../types/types";

const MAX_DEFAULT_ENTITY_COLUMNS = 5;
const ENTITY_LIST_STOP_WORDS = new Set([
  "a", "all", "an", "and", "any", "are", "as", "at", "be", "by", "can",
  "did", "do", "does", "each", "for", "from", "get", "give", "has", "have",
  "how", "in", "is", "it", "list", "many", "me", "much", "of", "on", "or",
  "our", "per", "show", "some", "that", "the", "to", "us", "was", "were",
  "what", "which", "who", "with", "you",
]);

export interface EntityListFilter {
  field: string;
  op: "eq";
  value: string;
}

function normalizeName(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function subjectTokens(dataset: AiDatasetDefinition): string[] {
  const tokens = [
    dataset.label,
    dataset.name,
    dataset.physicalTable,
    ...(dataset.synonyms || []),
  ]
    .flatMap((value) => normalizeName(value).split("_"))
    .filter((token) => token.length > 2);
  return Array.from(new Set(tokens)).reverse();
}

function stemEntityToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function entityQuestionTokens(value: unknown): Set<string> {
  const tokens = normalizeName(value)
    .split("_")
    .filter((token) => token.length > 1 && !ENTITY_LIST_STOP_WORDS.has(token))
    .map(stemEntityToken);
  return new Set(tokens);
}

export function isStrongEntityListWording(question: string): boolean {
  const normalized = normalizeName(question).replace(/_/g, " ");
  return (
    /\bwhat\s+are\b/.test(normalized)
    || /\bwhich\b/.test(normalized)
    || /\b(?:list|display)\b/.test(normalized)
    || /\bgive\s+me\b/.test(normalized)
  );
}

/**
 * Detect a request for entity records rather than an aggregate. Dataset
 * overlap keeps generic verbs such as "show" from suppressing unrelated KPIs.
 */
export function isEntityListRequest(
  question: string,
  dataset: AiDatasetDefinition,
): boolean {
  const normalized = normalizeName(question).replace(/_/g, " ");
  const hasListWording = (
    isStrongEntityListWording(question)
    || /\bshow\b/.test(normalized)
  );
  if (!hasListWording) return false;
  if (/\b(?:columns?|fields?|schema|tables?|kpis?|metrics?|formula|dimensions?)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:how\s+many|count|total|sum|average|avg|minimum|maximum)\b/.test(normalized)) {
    return false;
  }
  const questionTokens = entityQuestionTokens(normalized);
  return subjectTokens(dataset)
    .map(stemEntityToken)
    .some((token) => questionTokens.has(token));
}

export function isExplicitEntityListRequest(
  question: string,
  catalog: AiDatasetDefinition[],
): boolean {
  return catalog.some((dataset) => isEntityListRequest(question, dataset));
}

/**
 * Extract only high-confidence categorical filters whose field and value are
 * explicitly present in the request and whose column exists in the live
 * selected dataset.
 */
export function selectEntityListFilters(
  question: string,
  dataset: AiDatasetDefinition,
): EntityListFilter[] {
  const normalized = normalizeName(question).replace(/_/g, " ");
  const filters: EntityListFilter[] = [];
  const addFilter = (
    columnNames: string[],
    valuePatterns: Array<{ pattern: RegExp; value: string }>,
  ) => {
    const column = dataset.columns.find(
      (candidate) =>
        candidate.allowedForFiltering !== false
        && columnNames.includes(normalizeName(candidate.name)),
    );
    if (!column) return;
    const matchedValue = valuePatterns.find(({ pattern }) => pattern.test(normalized));
    if (matchedValue) {
      filters.push({ field: column.name, op: "eq", value: matchedValue.value });
    }
  };

  addFilter(
    ["priority", "severity", "urgency"],
    [
      { pattern: /\b(?:critical\s+(?:priority|severity|urgency)|(?:priority|severity|urgency)\s+(?:is\s+)?critical)\b/, value: "Critical" },
      { pattern: /\b(?:high\s+(?:priority|severity|urgency)|(?:priority|severity|urgency)\s+(?:is\s+)?high)\b/, value: "High" },
      { pattern: /\b(?:medium\s+(?:priority|severity|urgency)|(?:priority|severity|urgency)\s+(?:is\s+)?medium)\b/, value: "Medium" },
      { pattern: /\b(?:low\s+(?:priority|severity|urgency)|(?:priority|severity|urgency)\s+(?:is\s+)?low)\b/, value: "Low" },
    ],
  );
  addFilter(
    ["state", "status", "stage"],
    [
      { pattern: /\bin\s+progress\b/, value: "In Progress" },
      { pattern: /\bresolved\b/, value: "Resolved" },
      { pattern: /\bclosed\b/, value: "Closed" },
      { pattern: /\bopen\b/, value: "Open" },
      { pattern: /\bpending\b/, value: "Pending" },
      { pattern: /\binactive\b/, value: "Inactive" },
      { pattern: /\bactive\b/, value: "Active" },
    ],
  );
  return filters;
}

function findColumn(
  dataset: AiDatasetDefinition,
  candidates: string[],
  used: Set<string>,
): AiDatasetColumn | undefined {
  const candidateKeys = candidates.map(normalizeName);
  return dataset.columns.find((column) => {
    const key = normalizeName(column.name);
    return !used.has(key) && candidateKeys.includes(key);
  });
}

/**
 * Select a compact, business-readable projection for a vague entity-list
 * request after the LLM has selected one live catalog dataset.
 */
export function selectEntityDisplayColumns(
  dataset: AiDatasetDefinition,
  maxColumns = MAX_DEFAULT_ENTITY_COLUMNS,
): string[] {
  const used = new Set<string>();
  const selected: string[] = [];
  const subjects = subjectTokens(dataset);
  const addFirst = (candidates: string[]) => {
    if (selected.length >= maxColumns) return;
    const column = findColumn(dataset, candidates, used);
    if (!column) return;
    selected.push(column.name);
    used.add(normalizeName(column.name));
  };

  addFirst([
    ...subjects.flatMap((subject) => [`${subject}_number`, `${subject}_name`]),
    "number",
    "name",
    "code",
    ...subjects.map((subject) => `${subject}_id`),
    "id",
  ]);
  addFirst(["short_description", "description", "title", "subject", "summary"]);
  addFirst(["state", "status", "stage"]);
  addFirst(["priority", "severity", "urgency"]);
  addFirst(["assigned_to", "assignee", "owner", "owner_name", "created_by"]);
  addFirst(["opened_at", "created_at", "resolved_at", "closed_at", "updated_at"]);

  if (selected.length === 0) {
    const primaryKey = dataset.columns.find((column) => column.isPrimaryKey);
    if (primaryKey) {
      selected.push(primaryKey.name);
      used.add(normalizeName(primaryKey.name));
    }
  }

  // A catalog may not follow any conventional naming scheme. Retain a small
  // deterministic projection rather than ever falling back to SELECT *.
  if (selected.length === 0) {
    for (const column of dataset.columns) {
      if (selected.length >= Math.min(3, maxColumns)) break;
      const key = normalizeName(column.name);
      if (!key || used.has(key) || column.isAutoIncrement) continue;
      selected.push(column.name);
      used.add(key);
    }
  }

  return selected.slice(0, maxColumns);
}

/** Keep likely entity display fields available when a wide catalog is pruned. */
export function isEntityDisplayCandidateColumn(column: AiDatasetColumn): boolean {
  if (column.isPrimaryKey) return true;
  const name = normalizeName(column.name);
  return (
    /(?:^|_)(?:number|name|code|id)$/.test(name)
    || /(?:^|_)(?:short_description|description|title|subject|summary)$/.test(name)
    || /(?:^|_)(?:state|status|stage|priority|severity|urgency)$/.test(name)
    || /(?:^|_)(?:assigned_to|assignee|owner|owner_name|created_by)$/.test(name)
    || /(?:^|_)(?:opened_at|created_at|resolved_at|closed_at|updated_at)$/.test(name)
  );
}
