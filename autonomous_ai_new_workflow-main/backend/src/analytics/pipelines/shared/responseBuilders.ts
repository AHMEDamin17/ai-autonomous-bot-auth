import { DateGuardResult } from "./queryUnderstanding";

export type TraceEntry = {
  step: string;
  status: "completed" | "error" | "warning";
  detail?: string;
};

export interface ConnectionSelectionCandidate {
  connectionId: number;
  label: string;
  semanticContext: string;
}

export function buildConnectionSelectionResponse(
  question: string,
  candidates: ConnectionSelectionCandidate[],
  reason = "More than one semantic model may answer this question.",
) {
  return {
    success: false,
    mode: "connection_selection_required",
    errorCode: "CONNECTION_SELECTION_REQUIRED",
    question,
    error: "Choose a data source",
    connectionChoices: candidates.map((candidate) => ({
      connectionId: candidate.connectionId,
      label: candidate.label,
      context: candidate.semanticContext,
    })),
    insight: {
      answer: reason,
      drivers: ["No SQL was executed until a connection is selected."],
      followUps: [],
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: {
      dialect: "none",
      sql: "-- Connection selection required; no SQL executed",
      params: [],
    },
    trace: [{
      step: "connection_router",
      status: "warning" as const,
      detail: "The routing score gap was too small to select safely.",
    }],
  };
}

export function buildClarificationResponse(
  question: string,
  dialect: string,
  guard: Extract<DateGuardResult, { action: "clarify" }>,
  trace: TraceEntry[],
) {
  return {
    success: false,
    mode: "clarification_required",
    errorCode: guard.errorCode,
    question,
    clarification: {
      message: guard.message,
      choices: guard.choices,
    },
    insight: {
      answer: guard.message,
      drivers: ["No SQL was executed because the request needs clarification."],
      followUps: guard.choices.map((choice) => choice.rewrite),
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: { dialect, sql: "-- Clarification required; no SQL executed", params: [] },
    trace,
  };
}

export function buildUnsupportedIntentResponse(
  question: string,
  dialect: string,
  message: string,
  trace: TraceEntry[]
) {
  return {
    success: false,
    mode: "unsupported_intent",
    errorCode: "UNSUPPORTED_INTENT",
    question,
    error: message,
    insight: {
      answer: message,
      drivers: ["Analytics AI is read-only and does not support data modification."],
      followUps: [],
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: { dialect, sql: "-- Unsupported intent; no SQL executed", params: [] },
    trace,
  };
}
