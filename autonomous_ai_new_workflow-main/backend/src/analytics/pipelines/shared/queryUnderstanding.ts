export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function getDateInputOrder(): "MDY" | "DMY" {
  return String(process.env.DATE_INPUT_ORDER || "MDY").trim().toUpperCase() === "DMY" ? "DMY" : "MDY";
}

export function dateOrderFormat(order = getDateInputOrder()): string {
  return order === "DMY" ? "DD-MM-YYYY" : "MM-DD-YYYY";
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function toIsoDate(year: number, month: number, day: number): string | null {
  if (!isValidDateParts(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function formatHumanIsoDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${MONTH_NAMES[month - 1] || pad2(month)} ${day}, ${year}`;
}

export function rewriteDate(question: string, original: string, iso: string): string {
  return question.replace(original, iso);
}

export type ClarificationChoice = { label: string; rewrite: string; value?: string };
export type DateGuardResult =
  | { action: "ok"; notes: { value: string; message: string }[] }
  | { action: "clarify"; errorCode: "AMBIGUOUS_DATE" | "INVALID_DATE_FORMAT"; message: string; choices: ClarificationChoice[] };

export function analyzeLocalDateInputs(question: string): DateGuardResult {
  const notes: { value: string; message: string }[] = [];
  const matches = question.match(/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/g) || [];
  const seen = new Set<string>();
  const order = getDateInputOrder();
  const format = dateOrderFormat(order);

  for (const value of matches) {
    if (seen.has(value)) continue;
    seen.add(value);
    const parts = value.split(/[-/]/).map(Number);
    const [first, second, year] = parts as [number, number, number];
    const mdyIso = toIsoDate(year, first, second);
    const dmyIso = toIsoDate(year, second, first);

    if (mdyIso && dmyIso && mdyIso !== dmyIso) {
      const mdyChoice = {
        label: `${formatHumanIsoDate(mdyIso)} (MDY)`,
        rewrite: rewriteDate(question, value, mdyIso),
        value: mdyIso,
      };
      const dmyChoice = {
        label: `${formatHumanIsoDate(dmyIso)} (DMY)`,
        rewrite: rewriteDate(question, value, dmyIso),
        value: dmyIso,
      };
      const choices = order === "MDY" ? [mdyChoice, dmyChoice] : [dmyChoice, mdyChoice];
      return {
        action: "clarify",
        errorCode: "AMBIGUOUS_DATE",
        message: `The date '${value}' is ambiguous. It can mean ${formatHumanIsoDate(mdyIso)} in MDY order or ${formatHumanIsoDate(dmyIso)} in DMY order. I did not run SQL because that would guess the user's intent. Choose one option, or rewrite the date as ISO YYYY-MM-DD.`,
        choices,
      };
    }

    const preferredIso = order === "MDY" ? mdyIso : dmyIso;
    const alternateIso = order === "MDY" ? dmyIso : mdyIso;
    if (!preferredIso) {
      const choices = alternateIso
        ? [{
          label: `Use ${formatHumanIsoDate(alternateIso)} (ISO)`,
          rewrite: rewriteDate(question, value, alternateIso),
          value: alternateIso,
        }]
        : [];
      const alternateHint = alternateIso
        ? ` If you meant ${formatHumanIsoDate(alternateIso)}, use ${alternateIso}.`
        : "";
      return {
        action: "clarify",
        errorCode: "INVALID_DATE_FORMAT",
        message: `Invalid date '${value}' for ${order} order. Please write dates in ${format} order, or use ISO YYYY-MM-DD.${alternateHint}`,
        choices,
      };
    }

    notes.push({
      value,
      message: `Interpreted date '${value}' as ${preferredIso} using ${order} (${format}). Please write dates in ${format} order, or use ISO YYYY-MM-DD to avoid ambiguity.`,
    });
  }

  return { action: "ok", notes };
}

// Matches actual SQL-shaped write intent ("insert into ...", "update x set ...")
// rather than a bare word-boundary hit, so ordinary nouns/past-participles in
// read-only questions ("the latest update on orders", "when was this created")
// don't get rejected.
const WRITE_INTENT_SQL_PATTERNS = [
  /\binsert\s+into\b/,
  /\bupdate\s+\S+\s+set\b/,
  /\bdelete\s+from\b/,
  /\bdrop\s+(table|database|schema|index|view)\b/,
  /\btruncate\s+(table\s+)?\S+/,
  /\balter\s+(table|database|schema)\b/,
  /\bcreate\s+(table|database|schema|index|view)\b/,
  /\breplace\s+into\b/,
];

// Also catch imperative phrasing ("Update the price of...", "Delete the order..."),
// but not "Update me on..."/"Create a report of..." style requests for information.
const WRITE_INTENT_IMPERATIVE_RE =
  /^(please\s+)?(insert|update|delete|drop|truncate|alter|create|replace)\b(?!\s+(me|us|a report|a summary|on|about))/;

export function detectWriteIntent(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (WRITE_INTENT_SQL_PATTERNS.some((re) => re.test(q))) return true;
  return WRITE_INTENT_IMPERATIVE_RE.test(q);
}
