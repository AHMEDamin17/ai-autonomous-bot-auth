// ============================================================================
// ============================================================================
// backend/src/analytics/query.ts
// ============================================================================

import { RowDataPacket } from "mysql2";
import { Router } from "express";
import { getErrorRecoveryGuidance, getFriendlyErrorMessage } from "../utils/errorFormatter";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import pool from "../db/connection";
import { SqlFilter } from "../types/types";
import { planSimpleQuery } from "./pipelines/simple/simplePlanner";
import {
  addMessage,
  buildConversationContextFromConversation,
  getConversation,
} from "../routes/semanticLayer/conversationStore";
import {
  AnalyticsResponsePayload,
  executeResolvedAnalyticsQuery,
} from "./executeResolvedAnalyticsQuery";

const AnalyticsFilterSchema = z.object({
  field: z.string().trim().min(1).max(256),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "between", "relative"]).optional().default("eq"),
  value: z.any(),
}).strict();

const AnalyticsQuerySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  connectionId: z.coerce.number().int().positive().optional(),
  conversationId: z.string().trim().min(1).max(128).optional(),
  filters: z.array(AnalyticsFilterSchema).max(10).optional().default([]),
  mode: z.enum(["simple", "kpi", "auto"]).optional().default("auto"),
  forcedTableContext: z.string().trim().min(1).optional(),
}).strict();

function emptyDataResponse() {
  return { rowCount: 0, rows: [] };
}

function buildNeedsConnectionResponse(question: string) {
  return {
    success: false,
    mode: "needs_connection",
    errorCode: "NEEDS_CONNECTION",
    question,
    error: "Connection required",
    insight: {
      answer: "Please select a database connection first. I need a connection for table, KPI, and data questions.",
      drivers: ["No connection selected"],
      followUps: [],
    },
    chart: null,
    data: emptyDataResponse(),
    sql: { dialect: "none", sql: "-- Connection required", params: [] },
    trace: [{ step: "pre_query_router", status: "warning", detail: "Connection required" }],
  };
}

// ============================================================================
// MAIN QUERY HANDLER
// ============================================================================

const query = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = AnalyticsQuerySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid analytics query request",
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    });
    return;
  }
  const { question, connectionId, conversationId, filters, mode, forcedTableContext } = parsed.data;
  const requestFilters = filters as SqlFilter[];
  if (!connectionId) {
    try {
      const intakePlan = await planSimpleQuery(question, [], []);
      if (intakePlan.errorMode === "UNRECOGNIZED" && intakePlan.conversationalAnswer) {
        res.json({
          success: true,
          mode: "assistant",
          question,
          insight: {
            answer: intakePlan.conversationalAnswer,
            drivers: ["Language-model semantic entry"],
            followUps: ["Select a database connection to ask table, KPI, or data questions"],
          },
          chart: null,
          data: emptyDataResponse(),
          sql: { dialect: "none", sql: "-- Informational response; no SQL executed", params: [] },
          trace: [{ step: "llm_semantic_entry", status: "completed", detail: "Informational request interpreted by the configured LLM" }],
        });
        return;
      }
      const response = buildNeedsConnectionResponse(question);
      response.trace.unshift({ step: "llm_semantic_entry", status: "completed", detail: "A data request requiring a connection was identified by the configured LLM" });
      res.json(response);
    } catch (error) {
      const friendlyMessage = getFriendlyErrorMessage(error);
      res.json({
        success: false,
        mode: "error",
        question,
        error: friendlyMessage,
        friendlyError: friendlyMessage,
        insight: {
          answer: `Analytics AI was unable to interpret your query.\n\nReason: ${friendlyMessage}\n\n${getErrorRecoveryGuidance(friendlyMessage)}`,
          drivers: [],
          followUps: [],
        },
        chart: null,
        data: emptyDataResponse(),
        sql: { dialect: "none", sql: "-- LLM semantic entry failed; no SQL executed", params: [] },
        trace: [{ step: "llm_semantic_entry", status: "error", detail: friendlyMessage }],
      });
    }
    return;
  }

  try {
    let activeConversationId: string | undefined;
    let conversationContext;
    if (conversationId) {
      const [connectionRows] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM db_connections WHERE id = ? LIMIT 1",
        [connectionId],
      );
      if (!connectionRows.length) {
        res.status(404).json({ error: `Connection ${connectionId} not found` });
        return;
      }
      const conversation = await getConversation(conversationId, req.user!.id, connectionId);
      if (!conversation) {
        res.status(409).json({
          success: false,
          mode: "conversation_unavailable",
          errorCode: "CONVERSATION_UNAVAILABLE",
          error: "The conversation expired, was removed, or belongs to another connection.",
          detail: "Create a new conversation for the selected connection and retry the question.",
        });
        return;
      }
      activeConversationId = conversation.id;
      conversationContext = buildConversationContextFromConversation(conversation);
    }

    const result = await executeResolvedAnalyticsQuery({
      connectionId,
      question,
      requestFilters,
      mode,
      forcedTableContext,
      conversationContext,
      conversationId: activeConversationId,
      surface: "analytics-ai",
      onSuccessfulResponse: activeConversationId
        ? async (responsePayload: AnalyticsResponsePayload) => {
            await addMessage(activeConversationId!, req.user!.id, {
              role: "user",
              content: question,
              timestamp: Date.now(),
            });
            await addMessage(activeConversationId!, req.user!.id, {
              role: "assistant",
              content: responsePayload.insight?.answer || "Query completed",
              queryResult: responsePayload,
              tableHint: responsePayload.semanticMatch?.datasets?.[0],
              columnHints: responsePayload.semanticMatch?.groupBy
                ? (
                    Array.isArray(responsePayload.semanticMatch.groupBy)
                      ? responsePayload.semanticMatch.groupBy
                      : [responsePayload.semanticMatch.groupBy]
                  )
                : [],
              timestamp: Date.now(),
            });
          }
        : undefined,
    });
    res.status(result.statusCode).json(result.payload);
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// ROUTER EXPORT
// ============================================================================

let routerInstance: Router | null = null;
export const getRouter = (): Router => {
  const isCacheable = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
  if (isCacheable && routerInstance) {
    return routerInstance;
  }
  const router = Router();
  router.post("/query", query);
  if (isCacheable) {
    routerInstance = router;
  }
  return router;
};

export { query };
