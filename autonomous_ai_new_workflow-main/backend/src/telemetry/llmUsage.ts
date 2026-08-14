import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { recordTelemetry, type TelemetryEvent } from "./inMemoryLogs";

export type LlmUsageSurface = "analytics-ai" | "dashboard-ai";

export interface LlmUsageContext {
  executionId?: string;
  connectionId?: number;
  surface?: LlmUsageSurface;
  stage?: string;
}

export interface NormalizedLlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageReported: boolean;
}

const usageContextStorage = new AsyncLocalStorage<LlmUsageContext>();

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.round(parsed)
    : undefined;
}

function firstTokenValue(
  sources: unknown[],
  keys: string[],
): number | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    for (const key of keys) {
      const value = nonNegativeInteger(record[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

export function extractLlmTokenUsage(
  response: any,
): NormalizedLlmTokenUsage {
  const message = response?.generations?.[0]?.[0]?.message;
  const sources = [
    response?.usage_metadata,
    response?.usageMetadata,
    response?.response_metadata?.tokenUsage,
    response?.response_metadata?.usage,
    response?.response_metadata?.usage_metadata,
    response?.llmOutput?.tokenUsage,
    response?.llmOutput?.estimatedTokenUsage,
    response?.llmOutput?.usage,
    message?.usage_metadata,
    message?.usageMetadata,
    message?.response_metadata?.tokenUsage,
    message?.response_metadata?.usage,
  ];
  const inputTokens = firstTokenValue(sources, [
    "input_tokens",
    "prompt_tokens",
    "promptTokens",
    "inputTokens",
  ]);
  const outputTokens = firstTokenValue(sources, [
    "output_tokens",
    "completion_tokens",
    "completionTokens",
    "outputTokens",
  ]);
  const reportedTotal = firstTokenValue(sources, [
    "total_tokens",
    "totalTokens",
  ]);
  const usageReported = (
    inputTokens !== undefined
    || outputTokens !== undefined
    || reportedTotal !== undefined
  );
  const normalizedInput = inputTokens || 0;
  const normalizedOutput = outputTokens || 0;
  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: reportedTotal ?? (normalizedInput + normalizedOutput),
    usageReported,
  };
}

function positiveIntegerEnv(names: string[]): number | undefined {
  for (const name of names) {
    const value = Number(process.env[name]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

export function resolveLlmContextWindowTokens(
  provider: string,
  model: string,
): number {
  const configured = positiveIntegerEnv([
    `${provider.toUpperCase()}_CONTEXT_WINDOW_TOKENS`,
    "LLM_CONTEXT_WINDOW_TOKENS",
  ]);
  if (configured) return configured;

  const normalizedModel = model.toLowerCase();
  if (
    normalizedModel.includes("llama-3.3-70b")
    || normalizedModel.includes("llama-3.1")
    || normalizedModel.includes("gpt-4o")
  ) {
    return 128_000;
  }
  return 0;
}

export function isLlmTokenUsageVisible(): boolean {
  const value = String(process.env.SHOW_LLM_TOKEN_USAGE || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function filterTelemetryForDisplay(
  events: TelemetryEvent[],
): TelemetryEvent[] {
  return isLlmTokenUsageVisible()
    ? events
    : events.filter((event) => event.step !== "llm_call");
}

export function withLlmUsageContext<T>(
  context: LlmUsageContext,
  work: () => T,
): T {
  const parent = usageContextStorage.getStore() || {};
  return usageContextStorage.run({ ...parent, ...context }, work);
}

export function recordLlmUsage(
  response: unknown,
  details: {
    provider: string;
    model: string;
    latencyMs: number;
    status: "success" | "failure";
    message?: string;
  },
): void {
  const context = usageContextStorage.getStore() || {};
  const usage = extractLlmTokenUsage(response);
  const contextWindowTokens = resolveLlmContextWindowTokens(
    details.provider,
    details.model,
  );
  const contextTokens = usage.inputTokens + usage.outputTokens;
  const contextUsagePercent = contextWindowTokens > 0
    ? Number(((contextTokens / contextWindowTokens) * 100).toFixed(4))
    : 0;

  recordTelemetry({
    executionId: crypto.randomUUID(),
    parentExecutionId: context.executionId,
    connectionId: context.connectionId || 0,
    surface: context.surface,
    step: "llm_call",
    stage: context.stage || "llm",
    status: details.status,
    latencyMs: Math.max(0, Math.round(details.latencyMs)),
    authType: "llm_provider",
    message: details.message,
    provider: details.provider,
    model: details.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    contextWindowTokens,
    contextUsagePercent,
    usageReported: usage.usageReported,
  });
}

export interface LlmUsageSnapshot {
  enabled: true;
  summary: {
    callCount: number;
    measuredCallCount: number;
    failedCallCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    averageTokensPerCall: number;
    averageContextUsagePercent: number;
    maxContextUsagePercent: number;
  };
  byStage: Array<{
    stage: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>;
  recentCalls: TelemetryEvent[];
}

export function summarizeLlmUsageEvents(
  events: TelemetryEvent[],
  recentLimit = 20,
): LlmUsageSnapshot {
  const calls = events.filter((event) => event.step === "llm_call");
  const measuredCalls = calls.filter((event) => event.usageReported);
  const inputTokens = measuredCalls.reduce(
    (total, event) => total + (event.inputTokens || 0),
    0,
  );
  const outputTokens = measuredCalls.reduce(
    (total, event) => total + (event.outputTokens || 0),
    0,
  );
  const totalTokens = measuredCalls.reduce(
    (total, event) => total + (event.totalTokens || 0),
    0,
  );
  const averageContextUsagePercent = measuredCalls.length > 0
    ? measuredCalls.reduce(
        (total, event) => total + (event.contextUsagePercent || 0),
        0,
      ) / measuredCalls.length
    : 0;
  const byStageMap = new Map<string, {
    stage: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }>();
  for (const event of calls) {
    const stage = event.stage || "llm";
    const aggregate = byStageMap.get(stage) || {
      stage,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    aggregate.calls += 1;
    aggregate.inputTokens += event.inputTokens || 0;
    aggregate.outputTokens += event.outputTokens || 0;
    aggregate.totalTokens += event.totalTokens || 0;
    byStageMap.set(stage, aggregate);
  }

  return {
    enabled: true,
    summary: {
      callCount: calls.length,
      measuredCallCount: measuredCalls.length,
      failedCallCount: calls.filter((event) => event.status === "failure").length,
      inputTokens,
      outputTokens,
      totalTokens,
      averageTokensPerCall: measuredCalls.length > 0
        ? Number((totalTokens / measuredCalls.length).toFixed(2))
        : 0,
      averageContextUsagePercent: Number(
        averageContextUsagePercent.toFixed(4),
      ),
      maxContextUsagePercent: measuredCalls.reduce(
        (maximum, event) => Math.max(
          maximum,
          event.contextUsagePercent || 0,
        ),
        0,
      ),
    },
    byStage: [...byStageMap.values()].sort(
      (left, right) =>
        right.totalTokens - left.totalTokens
        || left.stage.localeCompare(right.stage),
    ),
    recentCalls: calls.slice(0, Math.max(1, recentLimit)),
  };
}
