// ============================================================================
// backend/src/routes/router.ts
// ============================================================================

import { Router, Request, Response, NextFunction } from "express";
import { getRouter as getConnectionsRouter } from "./semanticLayer/connections";
import { getRouter as getCatalogRouter } from "./semanticLayer/dataCatalog";
import { getRouter as getKpiMetricsRouter } from "./semanticLayer/kpiMetrics";
import { getRouter as getSemanticCatalogRouter } from "./semanticLayer/semanticCatalog";
import { getRouter as getSemanticModelsRouter } from "./semanticLayer/semanticModels";
import { getRouter as getAnalyticsRouter } from "./semanticLayer/analyticsQuery";
import { getRouter as getAssistantRouter } from "./assistant";
import { getRouter as getObservabilityRouter } from "./observability";
import { getRouter as getAuthRouter } from "./auth";
import { getRouter as getUsersRouter } from "./users";
import { sseRouter } from "./observability-sse";
import {
  ConversationConnectionNotFoundError,
  createConversation,
  deleteConversation,
  deleteConversationsByConnection,
} from "./semanticLayer/conversationStore";

import { rateLimiter } from "../mcp/security/rateLimiter";

import { requireAuth } from "../mcp/security/authMiddleware";
import { requireUserSession } from "../middleware/requireUserSession";
import { requireRole } from "../middleware/requireRole";
import { requireTrustedOrigin } from "../middleware/requireTrustedOrigin";

const router = Router();

router.use(requireAuth);
router.use(requireTrustedOrigin);
router.use("/auth", getAuthRouter());
router.use(requireUserSession);
router.use("/users", requireRole("admin"), getUsersRouter());

const apiLimiter = rateLimiter({ maxPoints: 100, windowMs: 60000 });

function parsePositiveConnectionId(value: unknown): number | undefined {
  const connectionId = Number(value);
  return Number.isInteger(connectionId) && connectionId > 0 ? connectionId : undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.post("/conversations", async (req: Request, res: Response, next: NextFunction) => {
  const connectionId = parsePositiveConnectionId(req.body?.connectionId);
  if (connectionId === undefined) {
    res.status(400).json({
      error: "Invalid conversation request",
      detail: "connectionId must be a positive integer",
    });
    return;
  }
  try {
    const conv = await createConversation(connectionId, req.user!.id);
    res.status(201).json({ data: conv });
  } catch (err) {
    if (err instanceof ConversationConnectionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.delete("/conversations/:id", async (req: Request, res: Response, next: NextFunction) => {
  const connectionId = parsePositiveConnectionId(req.query.connectionId);
  const conversationId = String(req.params.id || "").trim();
  if (connectionId === undefined || !UUID_PATTERN.test(conversationId)) {
    res.status(400).json({
      error: "Invalid conversation deletion request",
      detail: "A valid conversation ID and positive connectionId query parameter are required",
    });
    return;
  }

  try {
    const deleted = await deleteConversation(conversationId, connectionId, req.user!.id);
    res.json({ data: { conversationId, deleted } });
  } catch (err) {
    next(err);
  }
});

router.delete("/conversations", async (req: Request, res: Response, next: NextFunction) => {
  const connectionId = parsePositiveConnectionId(req.query.connectionId);
  if (connectionId === undefined) {
    res.status(400).json({
      error: "Invalid conversation deletion request",
      detail: "connectionId must be provided as a positive integer query parameter",
    });
    return;
  }

  try {
    const deletedCount = await deleteConversationsByConnection(connectionId, req.user!.id);
    res.json({ data: { connectionId, deletedCount } });
  } catch (err) {
    next(err);
  }
});

router.use("/connections", getConnectionsRouter());
router.use("/data-catalog", getCatalogRouter());
router.use("/kpi-metrics", getKpiMetricsRouter());
router.use("/semantic-catalog", getSemanticCatalogRouter());
router.use("/semantic-models", getSemanticModelsRouter());
router.use("/assistant", rateLimiter({ maxPoints: 60, windowMs: 60000 }), getAssistantRouter());
router.use("/analytics", rateLimiter({ maxPoints: 100, windowMs: 60000 }), getAnalyticsRouter());
router.use("/observability", apiLimiter, getObservabilityRouter());
router.use("/observability", apiLimiter, sseRouter);

export default router;
