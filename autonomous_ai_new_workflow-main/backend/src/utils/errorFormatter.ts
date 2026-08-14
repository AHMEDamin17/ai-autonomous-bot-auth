import { z } from "zod";

export function sanitizeDbError(error: any): string {
  const msg = error?.message || String(error);
  if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    return "Database connection failed (unreachable/timeout).";
  }
  if (msg.includes("Access denied") || msg.includes("ER_ACCESS_DENIED_ERROR") || msg.includes("login failed")) {
    return "Database authentication failed (invalid credentials).";
  }
  if (msg.includes("does not exist") || msg.includes("not found") || msg.includes("ER_NO_SUCH_TABLE")) {
    return "Query references a table or column that does not exist in the database.";
  }
  if (msg.includes("syntax error") || msg.includes("Parse error") || msg.includes("SQL syntax")) {
    return `Database syntax error: ${msg.substring(0, 200)}...`;
  }
  if (msg.includes("Recursion limit")) {
    return "AI Planning Error: The query is too complex or references unavailable metrics, causing the AI to loop endlessly. Try simplifying your question.";
  }
  return `Database error: ${msg.substring(0, 200)}...`;
}

export function getResilientErrorResponse(
  mode: "autonomous-ai",
  question: string,
  friendlyMessage: string,
  trace: any[] = [],
  corrections: string[] = [],
  compiledQuery?: any
): any {
  const publicMessage = getPublicAnalyticsErrorMessage(friendlyMessage);
  const recoveryGuidance = getErrorRecoveryGuidance(friendlyMessage);
  return {
    success: false,
    mode,
    question,
    friendlyError: publicMessage,
    appliedCorrections: corrections,
    insight: {
      answer: `Analytics AI was unable to complete your query.\n\nReason: ${publicMessage}\n\n${recoveryGuidance}`,
      drivers: [],
      followUps: []
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: compiledQuery || { dialect: "mysql", sql: "-- Query failed", params: [] },
    trace: trace.length ? trace : [{ step: "query_setup", status: "error" }]
  };
}

/** Keep technical identifiers in server logs while returning business-safe errors. */
export function getPublicAnalyticsErrorMessage(friendlyMessage: string): string {
  const message = String(friendlyMessage || "");
  if (/^AI Services error:/i.test(message)) return message;
  if (/database connection failed|database authentication failed|circuit breaker/i.test(message)) return message;
  if (/validation failed|sql compilation|analytics planning|internal routing|unknown column|unknown dataset/i.test(message)) {
    return "The request could not be safely matched to the configured business model. No database query was executed.";
  }
  if (/database (?:error|syntax error)|query execution/i.test(message)) {
    return "The generated query could not be executed safely. Review the business request and try again.";
  }
  return "The analytics request could not be completed safely. Review the business request and try again.";
}

export function getErrorRecoveryGuidance(friendlyMessage: string): string {
  if (/^AI Services error:/i.test(friendlyMessage)) {
    return "No database query was executed. Review the configured LLM provider quota, credentials, and model access, then retry.";
  }
  if (/(?:validation failed|sql compilation failed|analytics planning error|internal routing error)/i.test(friendlyMessage)) {
    return "No database query was executed. Review the requested metric, dimensions, and semantic relationships, then try again.";
  }
  return "Review your connection settings or query and try again.";
}

export function getFriendlyErrorMessage(error: any): string {
  if (error === null || error === undefined) {
    return "Unexpected internal error: No error details were provided.";
  }
  const msg = String(error?.message || error || "Unknown error");
  const lowerMsg = msg.toLowerCase();
  const name = String(error?.name || "");
  const code = String(error?.code || error?.cause?.code || "");
  const status = String(error?.status || error?.response?.status || "");
  const stack = String(error?.stack || "");

  if (error instanceof z.ZodError || name === "ZodError" || (error && Array.isArray((error as any).issues))) {
    const zodError = error as z.ZodError;
    return zodError.issues
      .map((issue) => `Validation failed on '${issue.path.join(".")}': ${issue.message}`)
      .join(" ");
  }

  if (code === "CERTIFIED_METRIC_REQUIRES_KPI") {
    return `Analytics planning error: ${msg}`;
  }
  if (name === "SqlCompileError") {
    return `SQL compilation error: ${msg} No database query was executed.`;
  }

  if (msg.includes("API key") || msg.includes("Unauthorized") || msg.includes("auth")) {
    return "AI Services error: Invalid credentials or authentication failed.";
  }
  if (lowerMsg.includes("language model request queue")) {
    return "AI Services error: The local language-model request queue is full or waited too long. Retry after the active provider requests finish.";
  }
  if (
    status === "429" ||
    msg.includes("429 status code") ||
    lowerMsg.includes("rate_limit") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("too many requests")
  ) {
    return "AI Services error: The language model provider rate limit was exceeded. Wait for the limit window to refill or switch the configured LLM provider.";
  }
  if (
    status === "403" ||
    msg.includes("403 status code") ||
    lowerMsg.includes("forbidden")
  ) {
    return "AI Services error: The language model provider refused the request (HTTP 403). This usually means the API key lacks access to the selected model, the account is out of credits, or a provider request cap was hit — check the model name/permissions or switch LLM_PROVIDER/model.";
  }
  if (
    msg.includes("reduce the length of the messages") ||
    msg.includes("reduce the length of the messages or completion") ||
    msg.includes("param\":\"messages") ||
    msg.includes("context_length_exceeded")
  ) {
    // Fires for both the KPI and simple/COMPLEX planners — the label used
    // to say "KPI planner" unconditionally, which was misleading when a
    // plain non-KPI question failed here.
    return "AI Services error: The query planner prompt was too large for the configured language model. Try naming the specific table in your question, or switch to a larger-context model.";
  }
  if (msg.includes("tool_use_failed") || msg.includes("tool call validation failed")) {
    return "AI Services error: The language model returned a response that didn't match the expected format. This is usually transient — please try rephrasing your question or asking again.";
  }
  // LangChain structured-output failures (OutputParserException) and empty
  // structured completions are AI-provider problems, not database problems.
  // Without this branch they fall through to sanitizeDbError and get the
  // misleading "Database error:" prefix.
  if (
    msg.includes("Failed to parse") ||
    msg.includes("OutputParserException") ||
    msg.includes("Could not parse") ||
    lowerMsg.includes("empty query plan")
  ) {
    return "AI Services error: The language model returned output that couldn't be parsed into a valid query plan. This is usually transient — please try rephrasing your question or asking again.";
  }
  if (lowerMsg.includes("language model returned an empty response after retrying")) {
    return "AI Services error: The language model returned an empty response after retrying. This is usually a transient provider issue — please try again.";
  }
  if (msg.includes("invalid_request_error")) {
    return "AI Services error: The language model provider rejected the request. Please try rephrasing your question or check the LLM provider configuration.";
  }
  if (
    status === "402" ||
    msg.includes("402 ") ||
    lowerMsg.includes("insufficient credits") ||
    lowerMsg.includes("requires more credits") ||
    lowerMsg.includes("exceeded your current quota")
  ) {
    return "AI Services error: The language model provider refused the request because the account is out of credits or the free-tier daily quota is exhausted (HTTP 402). Wait for the quota to reset, add credits, or switch LLM_PROVIDER to another configured provider.";
  }
  if (lowerMsg.includes("provider returned error")) {
    return "AI Services error: The language model provider (or its upstream serving partner) failed to handle the request. This is common with free-pool models under load — retry shortly, or switch the configured model or provider.";
  }
  if (
    name.includes("APIConnectionError") ||
    code === "EACCES" ||
    stack.includes("api.groq.com") ||
    stack.includes("api.openai.com") ||
    stack.includes("openrouter.ai") ||
    stack.includes("api.nvidia.com")
  ) {
    return "AI Services error: Unable to reach the configured language model provider.";
  }
  // The OpenAI-compatible SDK (Groq/OpenRouter/NVIDIA/OpenAI) throws
  // `APITimeoutError` with the message "Request timed out." — distinct from the
  // database `withTimeout` message "Query timed out after <n>ms", which must
  // stay a database error. Match the LLM signature precisely so a slow model
  // (free tiers queue large models) is labeled correctly, not as a DB failure.
  if (name.includes("APITimeout") || msg.includes("Request timed out")) {
    return "AI Services error: The language model provider took too long to respond (request timed out). Free tiers can queue large models — retry, raise the provider's *_TIMEOUT_MS, or switch to a smaller/faster model.";
  }
  if (msg.includes("timeout") || msg.includes("Timeout")) {
    return "AI Services error: The connection to the AI provider timed out.";
  }
  if (msg.includes("Semantic validation failed")) {
    return msg;
  }
  if (msg.includes("Circuit breaker") || msg.includes("temporarily unavailable")) {
    return "Database connection is temporarily blocked by the circuit breaker.";
  }

  return sanitizeDbError(error);
}
