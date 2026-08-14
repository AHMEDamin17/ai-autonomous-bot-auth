// ============================================================================
// backend/src/routes/swagger.ts
// Dynamic Express Router Stack Inspector & Swagger UI Generator
// Auto-discovers 100% of live Express endpoints without hardcoding route lists.
// ============================================================================

import { Application, Request, Response } from "express";

interface DiscoveredRoute {
  path: string;
  methods: string[];
}

/** Recursively traverse Express router stacks to discover 100% of registered routes. */
function extractExpressRoutes(stack: any[], prefix = ""): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const layer of stack) {
    if (layer.route) {
      // Direct route (e.g. app.get('/healthz'))
      let path = (prefix + layer.route.path).replace(/\/+/g, "/");
      if (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
      }
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      routes.push({ path, methods });
    } else if (layer.name === "router" && layer.handle?.stack) {
      // Router middleware (e.g. app.use('/api', router))
      let pathPrefix = prefix;
      if (layer.regexp) {
        const match = layer.regexp.source
          .replace("^", "")
          .replace("\\/?(?=\\/|$)", "")
          .replace("(?=^|\\/)", "")
          .replace(/\\\//g, "/")
          .replace(/\(\?:\\\/(.*?)\)/, "")
          .replace(/\?$/, "")
          .replace(/\$$/, "");
        if (match && match !== "/" && !match.includes(".+")) {
          pathPrefix = prefix + (match.startsWith("/") ? match : "/" + match);
        }
      }
      routes.push(...extractExpressRoutes(layer.handle.stack, pathPrefix));
    }
  }

  return routes;
}

/** Enriches auto-discovered endpoints with rich parameter schemas, tags & response examples. */
function getEndpointDetails(path: string, method: string): any {
  const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const lowerPath = openApiPath.toLowerCase();
  const lowerMethod = method.toLowerCase();

  let tag = "General";
  if (lowerPath.includes("/connections")) tag = "Connections";
  else if (lowerPath.includes("/data-catalog")) tag = "Data Catalog";
  else if (lowerPath.includes("/kpi-metrics")) tag = "KPI Metrics";
  else if (lowerPath.includes("/semantic-models")) tag = "Semantic Models";
  else if (lowerPath.includes("/conversations")) tag = "Conversations";
  else if (lowerPath.includes("/analytics")) tag = "Analytics AI Engine";
  else if (lowerPath.includes("/observability")) tag = "Observability";
  else if (lowerPath.includes("healthz") || lowerPath.includes("readyz")) tag = "System";

  const operation: any = {
    tags: [tag],
    summary: `${method} ${openApiPath}`,
    responses: {
      "200": { description: "Successful operation" }
    },
    security: lowerPath.startsWith("/api/")
      ? lowerPath === "/api/observability/stream"
        ? [{ ApiKeyAuth: [] }, { ApiKeyQueryParam: [] }]
        : [{ ApiKeyAuth: [] }]
      : [],
  };

  // Extract path parameters automatically from {param}
  const pathParams = openApiPath.match(/\{([A-Za-z0-9_]+)\}/g);
  if (pathParams) {
    operation.parameters = pathParams.map((p) => {
      const name = p.replace(/[{}]/g, "");
      const isConversationId = lowerPath.includes("/conversations/") && name.toLowerCase() === "id";
      return {
        name,
        in: "path",
        required: true,
        schema: isConversationId
          ? { type: "string", format: "uuid" }
          : { type: name.toLowerCase().includes("id") ? "integer" : "string" }
      };
    });
  }

  if (lowerMethod === "delete" && lowerPath.startsWith("/api/conversations")) {
    operation.parameters = operation.parameters || [];
    operation.parameters.push({
      name: "connectionId",
      in: "query",
      required: true,
      description: "Connection owner used to scope conversation deletion",
      schema: { type: "integer", minimum: 1 },
    });
    operation.summary = lowerPath.includes("{id}")
      ? "Delete one conversation owned by a connection"
      : "Delete all conversations owned by a connection";
  }

  // Add specific query params for observability
  if (
    lowerPath === "/api/observability/logs"
    || lowerPath === "/api/observability/logs/live"
    || lowerPath === "/api/observability/metrics"
  ) {
    operation.parameters = operation.parameters || [];
    operation.parameters.push(
      { name: "page", in: "query", schema: { type: "integer", default: 1 } },
      { name: "limit", in: "query", schema: { type: "integer", default: 50 } }
    );
  }
  if (lowerPath.includes("/observability/logs/live/export")) {
    operation.parameters = operation.parameters || [];
    operation.parameters.push({
      name: "format",
      in: "query",
      schema: { type: "string", enum: ["json", "csv"], default: "json" }
    });
  }

  // Add request body schemas for POST/PATCH
  if (["post", "patch", "put"].includes(lowerMethod)) {
    if (lowerPath.includes("/connections")) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connection_name", "db_type", "host"],
              properties: {
                connection_name: { type: "string", example: "Sales MySQL" },
                db_type: { type: "string", example: "mysql" },
                host: { type: "string", example: "127.0.0.1:3306" },
                db_user: { type: "string", example: "root" },
                db_password: { type: "string", format: "password", writeOnly: true },
                credentials_json: { type: "string", format: "password", writeOnly: true },
                default_schema: { type: "string", example: "sales_db" }
              }
            }
          }
        }
      };
    } else if (lowerPath.includes("/kpi-metrics")) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              ...(lowerMethod === "post" && {
                required: ["connection_id", "metric_name", "department", "metric_type", "formula", "involved_tables"],
              }),
              properties: {
                connection_id: { type: "integer", example: 1 },
                metric_name: { type: "string", example: "Total Revenue" },
                department: { type: "string", example: "Finance" },
                metric_type: { type: "string", example: "Simple (Direct Measure)" },
                formula: { type: "string", example: "SUM(orders.amount)" },
                format: { type: "string", enum: ["currency", "number", "percent"], default: "number" },
                involved_tables: { type: "array", items: { type: "string" }, example: ["orders"] },
                dimensions: { type: "array", items: { type: "string" }, example: ["orders.region"] },
                join_spec: { type: "array", items: { type: "object" } },
                filter_logic: { type: "object", nullable: true },
                select_columns: { type: "array", items: { type: "string" } }
              }
            }
          }
        }
      };
    } else if (lowerPath.includes("/conversations")) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["connectionId"],
              properties: { connectionId: { type: "integer", example: 1 } }
            }
          }
        }
      };
    } else if (lowerPath.includes("/analytics/query")) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["question"],
              properties: {
                question: { type: "string", example: "Show revenue by region for last month" },
                connectionId: { type: "integer", example: 1 },
                mode: { type: "string", enum: ["simple", "kpi", "auto"], default: "auto" },
                conversationId: { type: "string" },
                forcedTableContext: { type: "string" },
                filters: {
                  type: "array",
                  maxItems: 10,
                  items: {
                    type: "object",
                    required: ["field", "value"],
                    properties: {
                      field: { type: "string" },
                      op: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "between", "relative"] },
                      value: {},
                    },
                  },
                },
              }
            }
          }
        }
      };
      operation.responses["200"] = {
        description: "Analytics response payload (scorecard, bar/line chart, plain list, clarification, data-quality response, or error)",
        content: {
          "application/json": {
            examples: {
              "BarChart": {
                summary: "Categorical Bar Chart Payload",
                value: {
                  success: true,
                  executionId: "exec_992182",
                  question: "Show revenue by region",
                  mode: "certified-kpi",
                  kpiUsed: "Total Order Value",
                  data: {
                    rowCount: 4,
                    rows: [
                      { key: "North America", value: 240000.00 },
                      { key: "Europe", value: 130000.00 }
                    ]
                  },
                  chart: { type: "bar", x: "key", y: "value" },
                  insight: { answer: "North America leads with $240,000.00 in revenue.", drivers: [], followUps: [] }
                }
              },
              "LineChart": {
                summary: "Time-Series Line Trend Chart Payload",
                value: {
                  success: true,
                  executionId: "exec_992183",
                  question: "Show monthly revenue trend",
                  mode: "certified-kpi",
                  kpiUsed: "Total Order Value",
                  data: {
                    rowCount: 6,
                    rows: [
                      { key: "2026-01-01", value: 35000.00 },
                      { key: "2026-02-01", value: 42000.00 }
                    ]
                  },
                  chart: { type: "line", x: "key", y: "value" },
                  insight: { answer: "Revenue shows a steady upward trend over the last 6 months.", drivers: [], followUps: [] }
                }
              },
              "Scorecard": {
                summary: "Single Scalar Metric Scorecard Payload",
                value: {
                  success: true,
                  executionId: "exec_883921",
                  question: "What is total revenue?",
                  mode: "certified-kpi",
                  kpiUsed: "Total Order Value",
                  data: { rowCount: 1, rows: [{ value: 458920.50 }] },
                  insight: { answer: "The Total Order Value is $458,920.50.", drivers: [], followUps: [] },
                  chart: { type: "scorecard", y: "value" }
                }
              },
              "Clarification": {
                summary: "Ambiguous Date Clarification Picker Payload",
                value: {
                  success: false,
                  executionId: "exec_330192",
                  mode: "clarification_required",
                  errorCode: "AMBIGUOUS_DATE_FORMAT",
                  clarification: {
                    message: "The date '01/02/2026' is ambiguous. Please select which date you meant:",
                    choices: [
                      { label: "January 2, 2026 (MDY)", rewrite: "Show sales for January 2, 2026" },
                      { label: "February 1, 2026 (DMY)", rewrite: "Show sales for February 1, 2026" }
                    ]
                  }
                }
              },
              "LlmRateLimitError": {
                summary: "LLM Provider Rate Limit (HTTP 429) Payload",
                value: {
                  success: false,
                  executionId: "exec_771029",
                  mode: "autonomous-ai",
                  friendlyError: "AI Services error: The language model provider rate limit was exceeded.",
                  insight: { answer: "Analytics AI was unable to complete your query due to provider rate limit.", drivers: [], followUps: [] },
                  chart: null
                }
              }
            }
          }
        }
      };
    }
  }

  if (
    lowerMethod === "post"
    && (
      lowerPath === "/api/connections"
      || lowerPath === "/api/conversations"
      || lowerPath === "/api/kpi-metrics"
    )
  ) {
    operation.responses["201"] = operation.responses["200"];
    delete operation.responses["200"];
  }

  return { openApiPath, operation };
}

/** Generates dynamic OpenAPI 3.0 specification from Express router memory. */
export function buildDynamicOpenApiSpec(app: Application): any {
  const rawRoutes = extractExpressRoutes(app._router.stack);
  const paths: Record<string, any> = {};

  // Deduplicate and group routes into OpenAPI paths
  for (const route of rawRoutes) {
    // Exclude internal swagger endpoints from self-indexing
    if (route.path.startsWith("/docs") || route.path.startsWith("/api-docs")) continue;

    for (const method of route.methods) {
      const { openApiPath, operation } = getEndpointDetails(route.path, method);
      if (!paths[openApiPath]) paths[openApiPath] = {};
      paths[openApiPath][method.toLowerCase()] = operation;
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "ANONYMOUS_AI Analytics API",
      description: "Auto-discovered Swagger API documentation generated dynamically from Express router stack.",
      version: "1.0.0"
    },
    servers: [
      { url: "/", description: "Current host" },
      ...(process.env.PUBLIC_API_BASE_URL
        ? [{ url: process.env.PUBLIC_API_BASE_URL, description: "Configured public API URL" }]
        : []),
      { url: "http://localhost:3005", description: "Local backend" },
      { url: "http://localhost:5173", description: "Vite development proxy" }
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key"
        },
        ApiKeyQueryParam: {
          type: "apiKey",
          in: "query",
          name: "api_key"
        }
      }
    },
    paths
  };
}

/** Mounts /docs (interactive UI) and /api-docs.json (dynamic spec) onto Express. */
export function mountSwagger(app: Application): void {
  app.get("/api-docs.json", (_req: Request, res: Response) => {
    const spec = buildDynamicOpenApiSpec(app);
    res.json(spec);
  });

  app.get("/docs", (_req: Request, res: Response) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ANONYMOUS_AI - Dynamic Swagger API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <style>
    html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: "/api-docs.json",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
      window.ui = ui;
    };
  </script>
</body>
</html>
    `);
  });
}
