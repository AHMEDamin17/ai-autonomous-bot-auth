// ============================================================================
// backend/src/analytics/planner/index.ts
// ============================================================================

import { z } from "zod";
import { ChatGroq } from "@langchain/groq";
import { ChatOpenAI } from "@langchain/openai";
import { AiDatasetDefinition, GlobalAiKpi } from "../../routes/semanticLayer/semanticCatalog";
import { recordLlmUsage } from "../../telemetry/llmUsage";
import { CombinedGroupBySpec, FilterNode } from "../../types/types";

// --- llmClient ---
type LlmProvider = "groq" | "openai" | "openrouter" | "nvidia";

type LlmClient = {
  invoke: (...args: any[]) => Promise<any>;
  withStructuredOutput?: (...args: any[]) => any;
  bindTools?: (...args: any[]) => any;
};

class LlmRateLimiter {
  private active = 0;
  private lastStartAt = 0;
  private queue: Array<{ start: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> | null }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly enabled: boolean,
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
    private readonly maxQueueSize: number,
    private readonly maxQueueWaitMs: number,
  ) {}

  schedule<T>(work: () => Promise<T>): Promise<T> {
    if (!this.enabled) {
      return work();
    }

    return new Promise<T>((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error(`The language model request queue is full (${this.maxQueueSize} waiting requests).`));
        return;
      }

      let entry: { start: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> | null };
      entry = {
        start: () => {
          if (entry.timeout) clearTimeout(entry.timeout);
          this.active += 1;
          this.lastStartAt = Date.now();

          Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              this.pump();
            });
        },
        reject,
        timeout: null,
      };
      entry.timeout = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new Error(`The language model request waited longer than ${this.maxQueueWaitMs}ms in the local provider queue.`));
      }, this.maxQueueWaitMs);
      this.queue.push(entry);

      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.active >= this.maxConcurrent) {
      return;
    }

    const next = this.queue.shift();
    if (!next) {
      return;
    }

    const waitMs = Math.max(0, this.minIntervalMs - (Date.now() - this.lastStartAt));
    if (waitMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        next.start();
        this.pump();
      }, waitMs);
      return;
    }

    next.start();
    this.pump();
  }
}

const llmLimiters = new Map<string, LlmRateLimiter>();

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function positiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const value = Number(process.env[name]);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return fallback;
}

function nonNegativeIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const value = Number(process.env[name]);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }
  return fallback;
}

function normalizeLlmProvider(): LlmProvider {
  const requested = String(process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (requested === "groq" || requested === "openai" || requested === "openrouter" || requested === "nvidia") {
    return requested;
  }

  if (process.env.NVIDIA_API_KEY && !process.env.GROQ_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return "nvidia";
  }

  if (process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY) {
    return "openrouter";
  }

  if (!process.env.GROQ_API_KEY && (process.env.LLM_BASE_URL || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY)) {
    return "openai";
  }

  return "groq";
}

function resolveModel(provider: LlmProvider): string {
  if (provider === "openai") {
    return process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";
  }

  if (provider === "openrouter") {
    return process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || "openai/gpt-oss-20b:free";
  }

  if (provider === "nvidia") {
    // 8B is fast + reliable on NVIDIA's free build tier; the 70B is more capable
    // but the free tier queues it and heavier queries time out. Override via
    // NVIDIA_MODEL with any tool-calling model from build.nvidia.com.
    return process.env.NVIDIA_MODEL || process.env.LLM_MODEL || "meta/llama-3.1-8b-instruct";
  }

  return process.env.GROQ_MODEL || process.env.LLM_MODEL || "llama-3.1-8b-instant";
}

function getConfiguredLlmSelection(): { provider: LlmProvider; model: string } {
  const provider = normalizeLlmProvider();
  return { provider, model: resolveModel(provider) };
}

function getMaxCompletionTokens(provider: LlmProvider): number {
  return positiveIntEnv([`${provider.toUpperCase()}_MAX_COMPLETION_TOKENS`, "LLM_MAX_COMPLETION_TOKENS"], 1024);
}

function getLlmTimeoutMs(provider: LlmProvider): number {
  return positiveIntEnv([`${provider.toUpperCase()}_TIMEOUT_MS`, "LLM_TIMEOUT_MS"], 30000);
}

function getLlmMaxRetries(provider: LlmProvider): number {
  return nonNegativeIntEnv([`${provider.toUpperCase()}_MAX_RETRIES`, "LLM_MAX_RETRIES"], 3);
}

function getLimiter(provider: LlmProvider, model: string): LlmRateLimiter {
  const enabled = boolEnv("LLM_RATE_LIMIT_ENABLED", true);
  const defaultInterval = provider === "groq"
    ? 12000
    : provider === "openrouter"
      ? 3200
      : 1500;
  const minIntervalMs = positiveIntEnv([`${provider.toUpperCase()}_MIN_INTERVAL_MS`, "LLM_MIN_INTERVAL_MS"], defaultInterval);
  const maxConcurrent = positiveIntEnv([`${provider.toUpperCase()}_MAX_CONCURRENT`, "LLM_MAX_CONCURRENT"], 1);
  const maxQueueSize = positiveIntEnv(["LLM_MAX_QUEUE_SIZE"], 100);
  const maxQueueWaitMs = positiveIntEnv(["LLM_MAX_QUEUE_WAIT_MS"], 60000);
  const key = `${provider}:${model}:${enabled}:${maxConcurrent}:${minIntervalMs}:${maxQueueSize}:${maxQueueWaitMs}`;
  const existing = llmLimiters.get(key);
  if (existing) {
    return existing;
  }

  const limiter = new LlmRateLimiter(enabled, maxConcurrent, minIntervalMs, maxQueueSize, maxQueueWaitMs);
  llmLimiters.set(key, limiter);
  return limiter;
}

// Known bug in @langchain/core 0.3.80's BaseChatModel.invoke(): when the
// provider returns a response with zero generations (an empty/malformed API
// response — observed intermittently under Groq load, likely rate-limit- or
// queueing-related on their end) it does `result.generations[0][0].message`
// without checking the generation exists, crashing with "Cannot read
// properties of undefined (reading 'message')" instead of a catchable error.
// We can't patch node_modules, so retry once here (this has been transient
// in practice) and only then surface a clean, real error.
const EMPTY_GENERATION_ERROR_PATTERN = /Cannot read propert(?:y|ies) of undefined \(reading '(?:message|text)'\)/;

async function invokeWithEmptyResponseRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (!EMPTY_GENERATION_ERROR_PATTERN.test(String(error?.message || ""))) {
      throw error;
    }
    try {
      return await fn();
    } catch (retryError: any) {
      if (EMPTY_GENERATION_ERROR_PATTERN.test(String(retryError?.message || ""))) {
        throw new Error("The language model returned an empty response after retrying. This is usually a transient provider issue — please try again.");
      }
      throw retryError;
    }
  }
}

type ProviderRetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

function isProviderRateLimitError(error: any): boolean {
  const status = String(error?.status || error?.response?.status || error?.cause?.status || "");
  const message = String(error?.message || error || "").toLowerCase();
  return status === "429"
    || message.includes("429 status code")
    || message.includes("rate_limit")
    || message.includes("rate limit")
    || message.includes("too many requests");
}

function readHeader(error: any, name: string): string | undefined {
  const sources = [error?.headers, error?.response?.headers, error?.cause?.headers];
  for (const source of sources) {
    if (!source) continue;
    if (typeof source.get === "function") {
      const value = source.get(name);
      if (value) return String(value);
    }
    const value = source[name] ?? source[name.toLowerCase()] ?? source[name.toUpperCase()];
    if (value !== undefined && value !== null && String(value).trim()) return String(value);
  }
  return undefined;
}

function parseRetryAfterMs(error: any): number | undefined {
  const rawHeader = readHeader(error, "retry-after");
  if (rawHeader) {
    const seconds = Number(rawHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const retryDate = Date.parse(rawHeader);
    if (Number.isFinite(retryDate)) return Math.max(0, retryDate - Date.now());
  }

  const message = String(error?.message || error || "");
  const duration = message.match(/(?:try again|retry)\s+in\s+(?:(\d+(?:\.\d+)?)m)?\s*(\d+(?:\.\d+)?)s/i);
  if (duration) {
    const minutes = Number(duration[1] || 0);
    const seconds = Number(duration[2] || 0);
    return Math.ceil((minutes * 60 + seconds) * 1000);
  }
  return undefined;
}

export async function invokeWithProviderRetry<T>(
  fn: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? nonNegativeIntEnv(["LLM_RATE_LIMIT_MAX_RETRIES"], 2);
  const baseDelayMs = options.baseDelayMs ?? positiveIntEnv(["LLM_RATE_LIMIT_RETRY_BASE_MS"], 2000);
  const maxDelayMs = options.maxDelayMs ?? positiveIntEnv(["LLM_RATE_LIMIT_RETRY_MAX_MS"], 60000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await invokeWithEmptyResponseRetry(fn);
    } catch (error) {
      if (!isProviderRateLimitError(error) || attempt >= maxRetries) throw error;
      const providerDelay = parseRetryAfterMs(error);
      const exponentialDelay = baseDelayMs * (2 ** attempt);
      const jitterMs = Math.floor(Math.random() * Math.min(250, Math.max(1, baseDelayMs)));
      const delayMs = Math.min(maxDelayMs, Math.max(providerDelay || 0, exponentialDelay) + jitterMs);
      await sleep(delayMs);
    }
  }
}

type LlmMeteringConfig = {
  provider: LlmProvider;
  model: string;
};

function wrapWithRateLimit<T extends object>(
  target: T,
  limiter: LlmRateLimiter,
  metering?: LlmMeteringConfig,
  unwrapStructuredResult = false,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);

      if (prop === "invoke" && typeof value === "function") {
        const invokeAttempt = (...args: any[]) => limiter.enabled
          ? limiter.schedule(() => value.apply(obj, args))
          : value.apply(obj, args);
        return async (...args: any[]) => {
          const startedAt = Date.now();
          try {
            const result: any = await invokeWithProviderRetry(
              () => invokeAttempt(...args),
            );
            if (metering) {
              const usageSource = unwrapStructuredResult && result?.raw
                ? result.raw
                : result;
              recordLlmUsage(usageSource, {
                ...metering,
                latencyMs: Date.now() - startedAt,
                status: "success",
              });
            }
            return unwrapStructuredResult && result?.parsed !== undefined
              ? result.parsed
              : result;
          } catch (error: any) {
            if (metering) {
              recordLlmUsage(undefined, {
                ...metering,
                latencyMs: Date.now() - startedAt,
                status: "failure",
                message: String(error?.message || "LLM request failed").slice(
                  0,
                  500,
                ),
              });
            }
            throw error;
          }
        };
      }

      if (prop === "withStructuredOutput" && typeof value === "function") {
        return (...args: any[]) => {
          const requestedOptions = (
            args[1]
            && typeof args[1] === "object"
            && !Array.isArray(args[1])
          )
            ? args[1]
            : {};
          const callerRequestedRaw = requestedOptions.includeRaw === true;
          const structuredArgs = [
            args[0],
            { ...requestedOptions, includeRaw: true },
          ];
          return wrapWithRateLimit(
            value.apply(obj, structuredArgs),
            limiter,
            metering,
            !callerRequestedRaw,
          );
        };
      }

      if (prop === "bindTools" && typeof value === "function") {
        return (...args: any[]) => wrapWithRateLimit(
          value.apply(obj, args),
          limiter,
          metering,
        );
      }

      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

function createOpenAiCompatibleModel(model: string, maxTokens: number, maxRetries: number, timeout: number): LlmClient {
  return new ChatOpenAI({
    model,
    temperature: 0,
    maxTokens,
    maxRetries,
    timeout,
    apiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "sk-local-dev",
    configuration: {
      baseURL: process.env.LLM_BASE_URL,
    },
  }) as unknown as LlmClient;
}

function createOpenRouterModel(model: string, maxTokens: number, maxRetries: number, timeout: number): LlmClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OpenRouter API key. Set OPENROUTER_API_KEY when LLM_PROVIDER=openrouter.");
  }

  const defaultHeaders: Record<string, string> = {};
  const httpReferer = String(process.env.OPENROUTER_HTTP_REFERER || "").trim();
  const appTitle = String(process.env.OPENROUTER_APP_TITLE || "").trim();
  if (httpReferer) defaultHeaders["HTTP-Referer"] = httpReferer;
  if (appTitle) defaultHeaders["X-OpenRouter-Title"] = appTitle;

  return new ChatOpenAI({
    model,
    temperature: 0,
    maxTokens,
    maxRetries,
    timeout,
    apiKey,
    configuration: {
      baseURL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      defaultHeaders,
    },
  }) as unknown as LlmClient;
}

// NVIDIA NIM exposes an OpenAI-compatible chat-completions API
// (https://docs.api.nvidia.com/nim/reference/llm-apis), so it reuses ChatOpenAI
// with NVIDIA's base URL. Any model id from build.nvidia.com works via
// NVIDIA_MODEL (e.g. meta/llama-3.3-70b-instruct,
// nvidia/llama-3.1-nemotron-70b-instruct); pick one that supports tool calls
// and structured output, which this project relies on for planning.
function createNvidiaModel(model: string, maxTokens: number, maxRetries: number, timeout: number): LlmClient {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NVIDIA API key. Set NVIDIA_API_KEY when LLM_PROVIDER=nvidia.");
  }

  return new ChatOpenAI({
    model,
    temperature: 0,
    maxTokens,
    maxRetries,
    timeout,
    apiKey,
    configuration: {
      baseURL: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    },
  }) as unknown as LlmClient;
}

function createGroqModel(model: string, maxTokens: number, maxRetries: number, timeout: number): LlmClient {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Missing Groq API key. Set GROQ_API_KEY or switch LLM_PROVIDER to openai/openrouter/nvidia.");
  }

  return new ChatGroq({
    model,
    temperature: 0,
    maxTokens,
    maxRetries,
    timeout,
    apiKey: process.env.GROQ_API_KEY,
  }) as unknown as LlmClient;
}

function getLlmModel(overrides?: { maxTokens?: number; timeout?: number }): any {
  const { provider, model } = getConfiguredLlmSelection();
  const maxTokens = overrides?.maxTokens ?? getMaxCompletionTokens(provider);
  const maxRetries = getLlmMaxRetries(provider);
  const timeout = overrides?.timeout ?? getLlmTimeoutMs(provider);
  const limiter = getLimiter(provider, model);
  const metering = { provider, model };

  if (provider === "openai") {
    return wrapWithRateLimit(
      createOpenAiCompatibleModel(model, maxTokens, maxRetries, timeout),
      limiter,
      metering,
    );
  }

  if (provider === "openrouter") {
    return wrapWithRateLimit(
      createOpenRouterModel(model, maxTokens, maxRetries, timeout),
      limiter,
      metering,
    );
  }

  if (provider === "nvidia") {
    return wrapWithRateLimit(
      createNvidiaModel(model, maxTokens, maxRetries, timeout),
      limiter,
      metering,
    );
  }

  return wrapWithRateLimit(
    createGroqModel(model, maxTokens, maxRetries, timeout),
    limiter,
    metering,
  );
}

// --- planSchema ---
const MAX_QUERY_LIMIT = Number(process.env.MAX_QUERY_LIMIT) || 100;

const FilterSchema = z.object({
  field: z.string(),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "between", "relative"]),
  value: z.union([
    z.string(),
    z.array(z.string()),
    z.object({ start: z.string(), end: z.string() }),
  ]),
});

const JoinConditionSchema = z.object({
  leftTable: z.string().optional(),
  leftColumn: z.string(),
  rightTable: z.string().optional(),
  rightColumn: z.string(),
  joinCondition: z.enum(["fk", "inferred", "manual", "dimension_match"]).optional(),
});

const JoinSpecSchema = z.object({
  type: z.enum(["INNER", "LEFT", "RIGHT", "FULL"]).default("LEFT"),
  leftTable: z.string(),
  leftColumn: z.string(),
  rightTable: z.string(),
  rightColumn: z.string(),
  conditions: z.array(JoinConditionSchema).optional(),
  joinCondition: z.enum(["fk", "inferred", "manual", "dimension_match"]).optional(),
});

const QueryPlanSchema = z.object({
  datasets: z.array(z.string()).default([]),
  joins: z.array(JoinSpecSchema).nullable().optional(),
  metric: z.union([z.string(), z.null()]).optional().transform(v => v || ""),
  groupBy: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  select_columns: z.array(z.string()).max(8).nullable().optional(),
  timeGrain: z.enum(["day", "week", "month", "year"]).nullable().optional(),
  timeGrainColumn: z.string().nullable().optional(),
  sortDir: z.enum(["asc", "desc"]).nullable().optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).nullable().optional(),
  filters: z.array(FilterSchema).nullable().optional(),
  assumptions: z.array(z.string()).nullable().optional(),
  requiresApproval: z.boolean().nullable().optional().default(false),
  // .nullable() matters here: Groq's (and other providers') tool-calling
  // commonly emits explicit `null` for an absent optional field rather than
  // omitting it. Without .nullable(), that null fails schema validation and
  // rejects the ENTIRE tool call — including an otherwise perfectly valid
  // plan — before it ever reaches our code.
  errorMode: z.enum(["AMBIGUOUS", "UNRECOGNIZED"]).nullable().optional(),
  conversationalAnswer: z.string().nullable().optional(),
  ambiguityDetails: z.object({
    reason: z.string(),
    candidateTables: z.array(z.string()),
    column: z.string()
  }).nullable().optional(),
}).superRefine((d, ctx) => {
  if (d.timeGrain && !d.timeGrainColumn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timeGrainColumn is required when timeGrain is provided", path: ["timeGrainColumn"] });
  } else if (!d.timeGrain && d.timeGrainColumn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "timeGrain is required when timeGrainColumn is provided", path: ["timeGrain"] });
  }
  if (d.joins && d.joins.length > 0) {
    for (let i = 0; i < d.joins.length; i++) {
      if (!d.datasets.includes(d.joins[i].leftTable)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Join references leftTable "${d.joins[i].leftTable}" which is not in datasets`, path: ["joins", i, "leftTable"] });
      }
      if (!d.datasets.includes(d.joins[i].rightTable)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Join references rightTable "${d.joins[i].rightTable}" which is not in datasets`, path: ["joins", i, "rightTable"] });
      }
    }
  }
});

const LaxQueryPlanSchema = z.object({
  datasets: z.array(z.string()).default([]),
  joins: z.array(JoinSpecSchema).nullable().optional(),
  metric: z.union([z.string(), z.null()]).optional().transform(v => v || ""),
  groupBy: z.union([z.string(), z.array(z.string())]).nullable().optional(),
  select_columns: z.array(z.string()).max(8).nullable().optional(),
  timeGrain: z.enum(["day", "week", "month", "year"]).nullable().optional(),
  timeGrainColumn: z.string().nullable().optional(),
  sortDir: z.enum(["asc", "desc"]).nullable().optional(),
  limit: z.number().int().min(1).nullable().optional(),
  filters: z.array(FilterSchema).nullable().optional(),
  assumptions: z.array(z.string()).nullable().optional(),
  requiresApproval: z.boolean().nullable().optional().default(false),
  // .nullable() matters here: Groq's (and other providers') tool-calling
  // commonly emits explicit `null` for an absent optional field rather than
  // omitting it. Without .nullable(), that null fails schema validation and
  // rejects the ENTIRE tool call — including an otherwise perfectly valid
  // plan — before it ever reaches our code.
  errorMode: z.enum(["AMBIGUOUS", "UNRECOGNIZED"]).nullable().optional(),
  conversationalAnswer: z.string().nullable().optional(),
  ambiguityDetails: z.object({
    reason: z.string(),
    candidateTables: z.array(z.string()),
    column: z.string()
  }).nullable().optional(),
});

type Filter = z.infer<typeof FilterSchema>;
type QueryPlan = z.infer<typeof QueryPlanSchema> & {
  /** Backend-owned grouping expansion; never authored by the LLM. */
  combinedGroupBy?: CombinedGroupBySpec[] | null;
};

// --- planWithLlm ---
export {
  getConfiguredLlmSelection,
  getLlmModel,
  invokeWithEmptyResponseRetry,
  wrapWithRateLimit,
  QueryPlanSchema,
  LaxQueryPlanSchema,
  JoinSpecSchema,
  FilterSchema
};
export type { Filter, QueryPlan };
