// ============================================================================
// backend/src/routes/semanticLayer/questionClassifier.ts
// ============================================================================

import { GlobalAiKpi, AiDatasetDefinition } from "./semanticCatalog";
import { FilterNode, FilterCondition, FilterGroup, KpiMetric, ConversationContext, ClassifyResult } from "../../types/types";
import {
  isEntityListRequest,
  isStrongEntityListWording,
} from "../../analytics/pipelines/simple/entityProjection";

// ============================================================================
// CONSTANTS
// ============================================================================

const AGGREGATION_KEYWORDS = [
  "sum", "avg", "average", "count", "min", "max", "total",
  "mean", "median", "distinct", "unique",
];

const CROSS_TABLE_KEYWORDS = [
  "across", "and also", "combine", "together with",
  "join", "vs", "versus", "compare", "correlate",
  "relationship between", "compare and",
];

const QUERY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "by", "for", "from", "give", "how", "i",
  "in", "is", "me", "of", "on", "please", "show", "tell", "the", "to",
  "what", "whats", "with",
]);

const AGGREGATION_INTENT_WORDS = new Set([
  "average", "avg", "count", "distinct", "max", "mean", "median", "min",
  "sum", "total", "unique",
]);

const DOMAIN_ONLY_TOKENS = new Set([
  "inbound", "outbound", "warehouse", "wms", "report",
]);

// Measure words that describe HOW MUCH but not WHICH measure. A numeric column
// whose only recognizable tokens are these cannot, on its own, tell us the user
// asked for one specific metric over another.
const GENERIC_MEASURE_TOKENS = new Set([
  "qty", "quantity", "volume", "amount", "amt", "value", "count", "cnt",
  "total", "sum", "avg", "average", "mean", "number", "num", "no", "price",
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  amount: ["amount", "amt", "value"],
  avg: ["avg", "average", "mean"],
  count: ["count", "cnt", "number", "num"],
  qty: ["qty", "quantity", "volume"],
  quantity: ["qty", "quantity", "volume"],
  value: ["amount", "amt", "value"],
  volume: ["qty", "quantity", "volume"],
};

type RelativeTimePattern = {
  regex: RegExp;
  map: (...args: string[]) => string;
};

const RELATIVE_TIME_PATTERNS: RelativeTimePattern[] = [
  { regex: /\b(last|past)\s+(\d+)\s+(day|week|month|year)s?\b/i, map: (_kind: string, n: string, u: string) => `last_${n}_${u}s` },
  { regex: /\bthis\s+(month|year|quarter)\b/i, map: (u: string) => `this_${u}` },
  { regex: /\bprevious\s+(month|year|quarter)\b/i, map: (u: string) => `last_${u}` },
  { regex: /\btoday\b/i, map: () => "today" },
  { regex: /\byesterday\b/i, map: () => "yesterday" },
];

const MONTH_NUMBERS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

// ============================================================================
// HELPERS
// ============================================================================

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(str: string): string[] {
  return normalize(str)
    .split(/\s+/)
    .map((token) => TOKEN_ALIASES[token]?.[0] || token)
    .filter((token) => token && !QUERY_STOP_WORDS.has(token) && !AGGREGATION_INTENT_WORDS.has(token));
}

function tokenMatches(kpiToken: string, queryTokens: Set<string>): boolean {
  if (queryTokens.has(kpiToken)) return true;
  return (TOKEN_ALIASES[kpiToken] || []).some((alias) => queryTokens.has(alias));
}

function phraseVariants(metricName: string): string[] {
  const spaced = normalize(metricName.replace(/[_-]+/g, " "));
  const expanded = spaced
    .replace(/\bavg\b/g, "average")
    .replace(/\b(cnt|num)\b/g, "count")
    .replace(/\bpct\b/g, "percent")
    .replace(/\brev\b/g, "revenue")
    .replace(/\bqty\b/g, "quantity")
    .replace(/\btot\b/g, "total");
  return [...new Set([normalize(metricName), spaced, expanded].filter(Boolean))];
}

function scoreKpiMatch(question: string, kpi: GlobalAiKpi): { score: number; matchedTokens: string[]; extraTokens: string[] } {
  const normQ = normalize(question);
  const queryTokens = new Set(tokenize(question));
  const kpiTokens = [...new Set(tokenize(kpi.name))];
  if (kpiTokens.length === 0 || queryTokens.size === 0) {
    return { score: 0, matchedTokens: [], extraTokens: kpiTokens };
  }

  let score = 0;
  for (const phrase of phraseVariants(kpi.name)) {
    if (phrase && ` ${normQ} `.includes(` ${phrase} `)) {
      score += 120;
      break;
    }
  }

  const matchedTokens = kpiTokens.filter((token) => tokenMatches(token, queryTokens));
  const extraTokens = kpiTokens.filter((token) => !matchedTokens.includes(token));
  const matchedQueryTokens = [...queryTokens].filter((token) =>
    kpiTokens.some((kpiToken) => tokenMatches(kpiToken, new Set([token])))
  );

  const matchedCoreTokens = matchedTokens.filter((token) => !DOMAIN_ONLY_TOKENS.has(token));
  const coverage = matchedTokens.length / kpiTokens.length;
  const queryCoverage = matchedQueryTokens.length / queryTokens.size;

  score += matchedTokens.length * 16;
  score += coverage * 45;
  score += queryCoverage * 30;
  score += matchedCoreTokens.length * 18;
  score -= extraTokens.length * 14;

  if (matchedTokens.length === 0) score = 0;
  if (matchedCoreTokens.length === 0 && matchedTokens.length < kpiTokens.length) score = 0;

  return { score, matchedTokens, extraTokens };
}

function containsFullKpiPhrase(question: string, kpi: GlobalAiKpi): boolean {
  const normalizedQuestion = normalize(question);
  return phraseVariants(kpi.name).some(
    (phrase) => phrase && ` ${normalizedQuestion} `.includes(` ${phrase} `),
  );
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split an identifier such as "rejectedQty", "R_deliveredQty" or
// "received_qty" into its lowercase word tokens: ["rejected","qty"], etc.
function splitIdentifierTokens(identifier: string): string[] {
  return String(identifier || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function datasetForInvolvedTable(ref: string, catalog: AiDatasetDefinition[]): AiDatasetDefinition | undefined {
  const key = normalize(String(ref || "")).replace(/\s+/g, "_");
  return catalog.find((ds) => {
    const candidates = [ds.name, ds.physicalTable, ds.label, ds.physicalTable?.split(".").pop()]
      .filter(Boolean)
      .map((value) => normalize(String(value)).replace(/\s+/g, "_"));
    return candidates.includes(key);
  });
}

// Detects when a matched KPI computes a DIFFERENT measure than the one the
// user's question explicitly names. Returns the conflicting "dataset.column"
// (a measure the question asks for that the KPI's formula does not compute), or
// null when the KPI's measure is consistent with the question. Deliberately
// conservative: it only fires when the question contains every distinctive
// (non-generic) token of a numeric, measure-like column that the KPI's formula
// does not reference — so "rejected quantity" flags a received-quantity KPI,
// while "inbound volume" or "... by region" never do.
function detectConflictingMeasure(
  question: string,
  kpi: GlobalAiKpi,
  catalog: AiDatasetDefinition[],
): string | null {
  const formula = String(kpi.expressionSql || "");
  if (!formula.trim()) return null;

  const normalizedQuestion = normalize(question);
  const questionWords = new Set(normalizedQuestion.split(/\s+/).filter(Boolean));
  if (questionWords.size === 0) return null;

  const involvedDatasets = (kpi.involvedTables || [])
    .map((table) => datasetForInvolvedTable(table, catalog))
    .filter(Boolean) as AiDatasetDefinition[];

  // Columns configured as this KPI's group-by dimensions are legitimate "by X"
  // targets, not competing measures — never treat them as a measure conflict.
  const configuredDimensionTokens = [...(kpi.dimensions || []), ...(kpi.kpi_dimensions || [])]
    .map((dimension) => splitIdentifierTokens(String(dimension).split(".").pop() || ""));
  const dimensionLeaves = new Set(configuredDimensionTokens.map((tokens) => tokens.join("")));
  // A token that comes from a configured dimension is not evidence that the
  // user named a competing measure. For example, `gsc` appears in both the
  // requested dimension `u_gsc_region` and unrelated measure-like columns
  // such as `u_gsc_amt_qty_1`. Treating that shared namespace token as the
  // measure name incorrectly rejects an otherwise exact KPI match.
  const dimensionContextTokens = new Set(configuredDimensionTokens.flat());

  for (const dataset of involvedDatasets) {
    for (const column of dataset.columns || []) {
      // A measure can be numeric OR — as in warehouses that store quantities as
      // text — a string column. Only dates are never measures. The measure-like
      // NAME check below is the real filter, so a text-typed "receivedQty" is
      // still recognized while a "region"/"channel" string never is.
      if (column.type === "date") continue;

      const columnTokens = splitIdentifierTokens(column.name);
      const isMeasureLike = columnTokens.some((token) => GENERIC_MEASURE_TOKENS.has(token));
      if (!isMeasureLike) continue;
      if (dimensionLeaves.has(columnTokens.join(""))) continue;

      // Skip the column(s) the KPI formula actually aggregates.
      if (new RegExp(`\\b${escapeForRegExp(column.name)}\\b`, "i").test(formula)) continue;

      const distinctiveTokens = columnTokens.filter(
        (token) =>
          !GENERIC_MEASURE_TOKENS.has(token) &&
          !DOMAIN_ONLY_TOKENS.has(token) &&
          !dimensionContextTokens.has(token) &&
          token.length > 2,
      );

      const compressed = columnTokens.join("");
      // Preserve a strong escape hatch for users who type the real column
      // identifier, including underscored names that `normalize()` splits.
      const namedExplicitly = normalizedQuestion.replace(/\s+/g, "").includes(compressed);
      if (distinctiveTokens.length === 0 && !namedExplicitly) continue;
      const allDistinctivePresent = distinctiveTokens.every((token) => questionWords.has(token));
      if (namedExplicitly || allDistinctivePresent) {
        return `${dataset.name}.${column.name}`;
      }
    }
  }

  return null;
}

function extractMentionedTables(question: string, catalog: AiDatasetDefinition[]): string[] {
  const normalized = normalize(question);
  const tables: string[] = [];
  const queryTokens = normalized.split(/\s+/);

  const prepositions = ["from", "in", "of", "for", "by", "per"];
  for (const prep of prepositions) {
    const regex = new RegExp(`\\b${prep}\\s+(?:the\\s+)?([a-zA-Z_][a-zA-Z0-9_]*)`, "gi");
    let match;
    while ((match = regex.exec(question)) !== null) {
      const candidate = match[1].toLowerCase();
      const compressedCandidate = candidate.replace(/[_\-\s]+/g, "");
      const found = catalog.find(
        (ds) =>
          ds.name.toLowerCase() === candidate ||
          ds.physicalTable?.toLowerCase() === candidate ||
          ds.physicalTable?.toLowerCase().endsWith(`.${candidate}`) ||
          ds.label?.toLowerCase() === candidate ||
          ds.name.toLowerCase().replace(/[_\-\s]+/g, "") === compressedCandidate
      );
      if (found && !tables.includes(found.name)) {
        tables.push(found.name);
      }
    }
  }

  for (const ds of catalog) {
    const names = [
      ds.name,
      ds.physicalTable,
      ds.label,
    ].filter(Boolean) as string[];

    for (const name of names) {
      const normName = normalize(name);
      const compressedName = name.toLowerCase().replace(/[_\-\s]+/g, "");
      if (` ${normalized} `.includes(` ${normName} `) || queryTokens.includes(compressedName)) {
        if (!tables.includes(ds.name)) {
          tables.push(ds.name);
        }
      }
    }
  }

  return tables;
}

function extractMentionedColumns(question: string, catalog: AiDatasetDefinition[]): string[] {
  const normalized = normalize(question);
  const columns: string[] = [];
  const queryTokens = normalized.split(/\s+/);

  for (const ds of catalog) {
    for (const col of ds.columns || []) {
      const normName = normalize(col.name);
      const compressedName = col.name.toLowerCase().replace(/[_\-\s]+/g, "");
      if (` ${normalized} `.includes(` ${normName} `) || queryTokens.includes(compressedName)) {
        if (!columns.includes(col.name)) {
          columns.push(col.name);
        }
      }
    }
  }

  return columns;
}

function findTablesContainingColumn(
  columnName: string,
  catalog: AiDatasetDefinition[]
): AiDatasetDefinition[] {
  const lower = columnName.toLowerCase();
  return catalog.filter((ds) =>
    (ds.columns || []).some((c) => c.name.toLowerCase() === lower)
  );
}

function isAggregationQuery(question: string): boolean {
  const normalized = normalize(question);
  return AGGREGATION_KEYWORDS.some(
    (kw) => ` ${normalized} `.includes(` ${kw} `)
  );
}

function aiDetectsCrossTableIntent(question: string): boolean {
  const normalized = question.toLowerCase();
  return CROSS_TABLE_KEYWORDS.some((keyword) =>
    normalized.includes(keyword)
  );
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
  if (spaced.includes("tot")) expanded = expanded.replace(/\btot\b/g, "total");
  synonyms.add(expanded);

  const parts = spaced.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    parts.forEach(part => {
      if (part.length > 2 && part !== "avg" && part !== "tot" && part !== "cnt" && part !== "num") {
        synonyms.add(part);
      }
    });
  }

  if (nameClean.includes("revenue") || nameClean.includes("sales")) {
    synonyms.add("income"); synonyms.add("earnings"); synonyms.add("turnover");
  }
  if (nameClean.includes("cost") || nameClean.includes("expense")) {
    synonyms.add("spend"); synonyms.add("outlay");
  }
  if (nameClean.includes("profit") || nameClean.includes("margin")) {
    synonyms.add("net income"); synonyms.add("markup");
  }

  return Array.from(synonyms);
}

// ============================================================================
// RELATIVE TIME PARSING
// ============================================================================

function parseRelativeTimeFilters(
  question: string,
  catalog: AiDatasetDefinition[],
  mentionedTables: string[],
  preferredDateRefs: string[] = [],
): FilterCondition[] {
  const filters: FilterCondition[] = [];
  const normalizeRef = (value: unknown) => String(value || "")
    .replace(/[`"\[\]]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const datasetMatches = (dataset: AiDatasetDefinition, ref: string) => {
    const normalizedRef = normalizeRef(ref);
    return [
      dataset.name,
      dataset.label,
      dataset.physicalTable,
      String(dataset.physicalTable || "").split(".").pop(),
    ].some((candidate) => normalizeRef(candidate) === normalizedRef);
  };
  const resolvePreferredDateColumn = (): string | null => {
    for (const ref of preferredDateRefs) {
      const clean = String(ref || "").replace(/[`"\[\]]/g, "").trim();
      const lastDot = clean.lastIndexOf(".");
      const qualifier = lastDot >= 0 ? clean.slice(0, lastDot) : "";
      const columnName = lastDot >= 0 ? clean.slice(lastDot + 1) : clean;
      for (const dataset of catalog) {
        if (qualifier && !datasetMatches(dataset, qualifier)) continue;
        if (
          !qualifier
          && mentionedTables.length > 0
          && !mentionedTables.some((table) => datasetMatches(dataset, table))
        ) continue;
        const column = dataset.columns.find(
          (candidate) =>
            candidate.name.toLowerCase() === columnName.toLowerCase()
            && candidate.type === "date"
            && candidate.allowedForFiltering,
        );
        if (column) return `${dataset.name}.${column.name}`;
      }
    }
    return null;
  };
  const findDateColumn = (): string | null => {
    const preferred = resolvePreferredDateColumn();
    if (preferred) return preferred;
    const searchDatasets = mentionedTables.length > 0
      ? catalog.filter((dataset) => mentionedTables.some((table) => datasetMatches(dataset, table)))
      : catalog;
    for (const dataset of searchDatasets) {
      const dateColumn = dataset.columns.find(
        (column) => column.type === "date" && column.allowedForFiltering,
      );
      if (dateColumn) return `${dataset.name}.${dateColumn.name}`;
    }
    for (const dataset of catalog) {
      const dateColumn = dataset.columns.find(
        (column) => column.type === "date" && column.allowedForFiltering,
      );
      if (dateColumn) return `${dataset.name}.${dateColumn.name}`;
    }
    return null;
  };

  for (const { regex, map } of RELATIVE_TIME_PATTERNS) {
    const match = question.match(regex);
    if (match) {
      const value = map.apply(null, match.slice(1));
      const dateCol = findDateColumn();
      if (dateCol) {
        filters.push({ type: "condition", field: dateCol, op: "relative", value });
      }
    }
  }

  if (filters.length === 0) {
    const monthMatch = question.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*[-/,]?\s*((?:19|20)\d{2})\b/i,
    );
    if (monthMatch) {
      const month = MONTH_NUMBERS[monthMatch[1]!.toLowerCase()];
      const year = Number(monthMatch[2]);
      const dateCol = findDateColumn();
      if (month && dateCol) {
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        const monthText = String(month).padStart(2, "0");
        filters.push({
          type: "condition",
          field: dateCol,
          op: "between",
          value: {
            start: `${year}-${monthText}-01`,
            end: `${year}-${monthText}-${String(lastDay).padStart(2, "0")}`,
          },
        });
      }
    }
  }
  return filters;
}

// ============================================================================
// MAIN CLASSIFIER
// ============================================================================

export function classifyQuery(
  question: string,
  availableKpis: GlobalAiKpi[],
  catalog: AiDatasetDefinition[],
  conversationContext?: ConversationContext
): ClassifyResult {
  // STEP 0: Check for conversational / greeting intent
  if (/^(hi|hello|hey|greetings|good morning|good afternoon|good evening|who are you|how are you|test|ping)[\s]*$/i.test(question.trim())) {
    return { mode: "GREETING", reason: "Greeting" };
  }

  const mentionedTables = extractMentionedTables(question, catalog);
  const mentionedColumns = extractMentionedColumns(question, catalog);
  const isAgg = isAggregationQuery(question);

  // STEP 1 & 2 Removed: LLM handles simple data queries now.

  // STEP 3: Check for KPI match
  const scoredKpis = availableKpis
    .map((kpi) => ({ kpi, ...scoreKpiMatch(question, kpi) }))
    .filter((candidate) => candidate.score >= 55)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aExtra = a.extraTokens.length;
      const bExtra = b.extraTokens.length;
      if (aExtra !== bExtra) return aExtra - bExtra;
      return (a.kpi.involvedTables?.length || 0) - (b.kpi.involvedTables?.length || 0);
    });

  // Record-list intent owns the execution shape. A partial KPI name match on
  // generic entity/status words (for example "resolved cases") must not turn
  // "list the high priority cases that are resolved" into a one-row KPI
  // scorecard. A full KPI phrase may still win for weak "show ..." wording;
  // stronger record verbs such as list/which/what-are always request rows.
  const entityListIntent = !isAgg
    && catalog.some((dataset) => isEntityListRequest(question, dataset));
  const hasFullKpiPhrase = scoredKpis.some((candidate) =>
    containsFullKpiPhrase(question, candidate.kpi));
  if (
    entityListIntent
    && (isStrongEntityListWording(question) || !hasFullKpiPhrase)
  ) {
    const userFilters = parseRelativeTimeFilters(question, catalog, mentionedTables);
    const userFilterAst = userFilters.length > 0
      ? { type: "group" as const, operator: "AND" as const, children: userFilters }
      : undefined;
    return {
      mode: "COMPLEX",
      userFilters: userFilterAst,
      reason: "Explicit entity-list intent requires record output rather than a KPI aggregate.",
    };
  }

  if (scoredKpis.length > 0) {
    // Prefer the highest-scoring KPI whose measure is consistent with the
    // question. A KPI that computes a different measure than the user named
    // (e.g. "rejected quantity" against a received-quantity KPI) is skipped
    // rather than silently answered — see detectConflictingMeasure. If every
    // candidate conflicts, we fall through to COMPLEX so the request is handled
    // honestly (ad-hoc planning / NEEDS_KPI) instead of returning a confident
    // but wrong KPI value.
    const best = scoredKpis.find(
      (candidate) => !detectConflictingMeasure(question, candidate.kpi, catalog),
    );

    if (best) {
      const bestKpi = best.kpi;
      const filterTables = bestKpi.involvedTables?.length ? bestKpi.involvedTables : mentionedTables;
      const userFilters = parseRelativeTimeFilters(
        question,
        catalog,
        filterTables,
        bestKpi.dimensions?.length ? bestKpi.dimensions : bestKpi.kpi_dimensions,
      );
      const userFilterAst = userFilters.length > 0
        ? { type: "group" as const, operator: "AND" as const, children: userFilters }
        : undefined;
      // A single-word KPI name (e.g. "Revenue") can score above threshold from
      // that one word appearing anywhere, even in an unrelated sentence. We
      // deliberately don't block this routing (doing so breaks common short
      // questions like "what is our revenue this quarter" — the orchestrator
      // surfaces weak matches visibly instead of silently trusting them),
      // but flag it so the pipeline can surface a visible "matched because of
      // X" note instead of silently trusting a weak signal.
      const kpiNameTokenCount = normalize(bestKpi.name).split(" ").filter(Boolean).length;
      const weakMatch = kpiNameTokenCount === 1 && best.score < 120 ? bestKpi.name : undefined;
      return { mode: "KPI", kpi: bestKpi, userFilters: userFilterAst, weakMatch };
    }
  }

  // STEP 4 Removed: Column ambiguity is now handled by the LLM.
  // STEP 5: Conversation context fallback - LLM handles context as well.

  // All non-KPI queries fall through to COMPLEX so the LLM planner can interpret the intent
  const userFilters = parseRelativeTimeFilters(question, catalog, mentionedTables);
  const userFilterAst = userFilters.length > 0 
    ? { type: "group" as const, operator: "AND" as const, children: userFilters }
    : undefined;
  return { mode: "COMPLEX", userFilters: userFilterAst };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { 
  extractMentionedTables,
  extractMentionedColumns,
  findTablesContainingColumn,
  isAggregationQuery,
  aiDetectsCrossTableIntent,
  generateMetricSynonyms,
  parseRelativeTimeFilters,
};
