import crypto from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import {
  getFallbackCandidates,
  loadEligibleConnections,
  resolveTargetConnection,
  type ConnectionResolution,
  type RankedConnection,
} from "../analytics/router/semanticModelConnectionRouter";
import { buildConnectionSelectionResponse } from "../analytics/pipelines/shared/responseBuilders";
import {
  AnalyticsResponsePayload,
  executeResolvedAnalyticsQuery,
} from "../analytics/executeResolvedAnalyticsQuery";
import { recordTelemetry } from "../telemetry/inMemoryLogs";
import { getTraceId } from "../telemetry/correlation";
import { logExecution } from "../telemetry/telemetryStore";
import type { SqlFilter } from "../types/types";
import {
  addUserMessage,
  buildUserConversationContext,
  createUserConversation,
  deleteUserConversation,
  getUserConversation,
  pinUserConversation,
  UserConversationConnectionNotFoundError,
} from "./semanticLayer/userConversationStore";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AssistantFilterSchema = z.object({
  field: z.string().trim().min(1).max(256),
  op: z.enum([
    "eq",
    "neq",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "between",
    "relative",
  ]).optional().default("eq"),
  value: z.any(),
}).strict();

const AssistantAskSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  conversationId: z.string().regex(UUID_PATTERN).optional(),
  selectedConnectionId: z.coerce.number().int().positive().optional(),
  reroute: z.boolean().optional().default(false),
  filters: z.array(AssistantFilterSchema).max(10).optional().default([]),
  mode: z.enum(["simple", "kpi", "auto"]).optional().default("auto"),
}).strict();

function buildNeedsConnectionResponse(question: string, reason: string) {
  return {
    success: false,
    mode: "needs_connection",
    errorCode: "NEEDS_CONNECTION",
    question,
    error: "No ready semantic model matched this question.",
    insight: {
      answer: reason,
      drivers: ["No SQL was executed because no ready semantic model matched safely."],
      followUps: [
        "Try naming the business area or KPI you want to analyze.",
      ],
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: {
      dialect: "none",
      sql: "-- No matching connection; no SQL executed",
      params: [],
    },
    trace: [{
      step: "connection_router",
      status: "warning",
      detail: "No ready connection semantic model matched the question.",
    }],
  };
}

function buildUnavailableResponse(
  question: string,
  attempted: RankedConnection[],
) {
  return {
    success: false,
    mode: "database_unavailable",
    errorCode: "ROUTED_CONNECTIONS_UNAVAILABLE",
    question,
    error: "The matching data sources are temporarily unavailable.",
    insight: {
      answer: "I found a semantic-model source for this question, but none of the matching sources are currently reachable. Please try again shortly.",
      drivers: attempted.map((candidate) => `${candidate.label} is unavailable`),
      followUps: [],
    },
    chart: null,
    data: { rowCount: 0, rows: [] },
    sql: {
      dialect: "none",
      sql: "-- Matching connections unavailable; no SQL executed",
      params: [],
    },
    trace: [{
      step: "connection_router",
      status: "warning",
      detail: "Every eligible routed candidate was unavailable.",
    }],
  };
}

async function recordRoutingDecision(
  status: "success" | "failure",
  connectionId: number,
  message: string,
): Promise<void> {
  const executionId = crypto.randomUUID();
  const event = {
    executionId,
    connectionId,
    surface: "dashboard-ai",
    step: "connection_router",
    status,
    latencyMs: 0,
    authType: "api_key",
    message,
    circuitState: "closed",
  } as const;
  recordTelemetry(event);
  await logExecution({
    executionId,
    connectionId,
    surface: "dashboard-ai",
    connector: "connection-router",
    status,
    latencyMs: 0,
    authType: "api_key",
    message,
    traceId: getTraceId(),
  });
}

async function persistAssistantExchange(
  conversationId: string,
  userId: number,
  question: string,
  response: AnalyticsResponsePayload,
): Promise<void> {
  await addUserMessage(conversationId, userId, {
    role: "user",
    content: question,
    timestamp: Date.now(),
  });
  await addUserMessage(conversationId, userId, {
    role: "assistant",
    content: response.insight?.answer || "Query completed",
    queryResult: response,
    tableHint: response.semanticMatch?.datasets?.[0],
    columnHints: response.semanticMatch?.groupBy
      ? (
          Array.isArray(response.semanticMatch.groupBy)
            ? response.semanticMatch.groupBy
            : [response.semanticMatch.groupBy]
        )
      : [],
    timestamp: Date.now(),
  });
}

async function askAssistant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = AssistantAskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid assistant request",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    });
    return;
  }

  try {
    const {
      question,
      conversationId,
      selectedConnectionId,
      reroute,
      filters,
      mode,
    } = parsed.data;
    const existingConversation = conversationId
      ? await getUserConversation(conversationId, req.user!.id)
      : undefined;
    if (conversationId && !existingConversation) {
      res.status(409).json({
        success: false,
        mode: "conversation_unavailable",
        errorCode: "CONVERSATION_UNAVAILABLE",
        error: "The conversation expired or was removed.",
        detail: "Start a new Dashboard conversation and retry the question.",
      });
      return;
    }

    const eligibleConnections = await loadEligibleConnections();
    const routingEligibleConnections = (
      reroute && existingConversation?.connectionId
    )
      ? eligibleConnections.filter(
          (connection) =>
            connection.connectionId !== Number(existingConversation.connectionId),
        )
      : eligibleConnections;
    const conversationContext = existingConversation
      ? buildUserConversationContext(existingConversation)
      : undefined;
    let resolution: ConnectionResolution;
    const shouldUseStickyConnection = (
      !reroute
      && !selectedConnectionId
      && existingConversation?.connectionId
    );
    if (shouldUseStickyConnection) {
      const stickyId = Number(existingConversation!.connectionId);
      const sticky = routingEligibleConnections.find(
        (connection) => connection.connectionId === stickyId,
      );
      resolution = sticky
        ? {
            outcome: "confident",
            selected: {
              ...sticky,
              score: 1,
              reason: "Pinned to this conversation.",
            },
            ranked: [{
              ...sticky,
              score: 1,
              reason: "Pinned to this conversation.",
            }],
            reason: "Pinned to this conversation.",
          }
        : await resolveTargetConnection(
            question,
            routingEligibleConnections,
            conversationContext,
          );
    } else {
      resolution = await resolveTargetConnection(
        question,
        routingEligibleConnections,
        reroute ? undefined : conversationContext,
        { selectedConnectionId },
      );
    }

    if (resolution.outcome === "ambiguous") {
      await recordRoutingDecision("success", 0, "Connection selection required");
      res.json(buildConnectionSelectionResponse(
        question,
        resolution.candidates,
        resolution.reason,
      ));
      return;
    }
    if (resolution.outcome === "no_match") {
      await recordRoutingDecision("failure", 0, resolution.reason);
      res.json(buildNeedsConnectionResponse(question, resolution.reason));
      return;
    }

    const candidates = getFallbackCandidates(resolution);
    const attempted: RankedConnection[] = [];
    for (const candidate of candidates) {
      attempted.push(candidate);
      const canReuseConversation = (
        !reroute
        && existingConversation?.connectionId === String(candidate.connectionId)
      );
      let activeConversation = canReuseConversation
        ? existingConversation
        : undefined;
      let createdForAttempt = false;
      if (!activeConversation) {
        activeConversation = await createUserConversation(candidate.connectionId, req.user!.id);
        createdForAttempt = true;
      } else if (!activeConversation.connectionId) {
        const pinned = await pinUserConversation(
          activeConversation.id,
          candidate.connectionId,
          req.user!.id,
        );
        if (!pinned) {
          activeConversation = await createUserConversation(candidate.connectionId, req.user!.id);
          createdForAttempt = true;
        }
      }

      const result = await executeResolvedAnalyticsQuery({
        connectionId: candidate.connectionId,
        question,
        requestFilters: filters as SqlFilter[],
        mode,
        conversationContext: canReuseConversation
          ? conversationContext
          : undefined,
        conversationId: activeConversation.id,
        surface: "dashboard-ai",
        dashboardRouting: {
          method: candidate.reason === "Pinned to this conversation."
            ? "sticky_conversation"
            : candidate.reason === "Selected by the user."
              ? "user_selection"
              : "semantic_model",
          reason: candidate.reason || resolution.reason,
        },
        onSuccessfulResponse: async (responsePayload) => {
          await persistAssistantExchange(
            activeConversation!.id,
            req.user!.id,
            question,
            responsePayload,
          );
        },
      });
      if (result.connectionUnavailable) {
        if (createdForAttempt) {
          await deleteUserConversation(activeConversation.id, req.user!.id);
        }
        continue;
      }

      await recordRoutingDecision(
        "success",
        candidate.connectionId,
        resolution.reason,
      );
      res.status(result.statusCode).json(result.payload);
      return;
    }

    await recordRoutingDecision(
      "failure",
      attempted[0]?.connectionId || 0,
      "All routed candidates were unavailable",
    );
    res.status(503).json(buildUnavailableResponse(question, attempted));
  } catch (error) {
    if (error instanceof UserConversationConnectionNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    next(error);
  }
}

async function getAssistantConversation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(id)) {
    res.status(400).json({ error: "A valid conversation ID is required." });
    return;
  }
  try {
    const conversation = await getUserConversation(id, req.user!.id);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found or expired." });
      return;
    }
    res.json({ data: conversation });
  } catch (error) {
    next(error);
  }
}

async function removeAssistantConversation(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = String(req.params.id || "").trim();
  if (!UUID_PATTERN.test(id)) {
    res.status(400).json({ error: "A valid conversation ID is required." });
    return;
  }
  try {
    const deleted = await deleteUserConversation(id, req.user!.id);
    res.json({ data: { conversationId: id, deleted } });
  } catch (error) {
    next(error);
  }
}

let routerInstance: Router | null = null;

export function getRouter(): Router {
  const cacheable = process.env.NODE_ENV === "production"
    || process.env.NODE_ENV === "test";
  if (cacheable && routerInstance) return routerInstance;

  const router = Router();
  router.post("/ask", askAssistant);
  router.get("/conversations/:id", getAssistantConversation);
  router.delete("/conversations/:id", removeAssistantConversation);
  if (cacheable) routerInstance = router;
  return router;
}

export {
  AssistantAskSchema,
  askAssistant,
  buildNeedsConnectionResponse,
  buildUnavailableResponse,
};
