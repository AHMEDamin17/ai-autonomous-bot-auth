import axios from "axios";

export const API_BASE_URL = import.meta.env.VITE_BACKEND_URL || import.meta.env.VITE_API_URL || "";
const API_KEY = import.meta.env.VITE_API_KEY || "default-dev-key";

if (API_KEY) {
  axios.defaults.headers.common["x-api-key"] = API_KEY;
}
axios.defaults.withCredentials = true;

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401 && error?.response?.data?.code === "USER_SESSION_REQUIRED") {
      window.dispatchEvent(new Event("auth:session-expired"));
    }
    return Promise.reject(error);
  },
);
const READ_RETRY_DELAYS_MS = [300, 900];
const READ_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableReadError = (error) => {
  if (axios.isCancel(error) || error?.code === "ERR_CANCELED") return false;
  const status = error?.response?.status || error?.status;
  if (status) return READ_RETRY_STATUSES.has(status);
  return error?.code === "ERR_NETWORK" || error?.code === "ECONNABORTED" || !error?.response;
};

const getWithRetry = async (url, config = {}) => {
  let lastError;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await axios.get(url, config);
    } catch (error) {
      lastError = error;
      if (attempt >= READ_RETRY_DELAYS_MS.length || !isRetryableReadError(error)) {
        throw error;
      }
      await sleep(READ_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
};

// Existing query API
export const runQueryAPI = async (query, conversationIdOrOptions = null, maybeOptions = {}) => {
  const hasOptionsAsSecondArg = conversationIdOrOptions && typeof conversationIdOrOptions === "object";
  const conversationId = hasOptionsAsSecondArg ? null : conversationIdOrOptions;
  const options = hasOptionsAsSecondArg ? conversationIdOrOptions : maybeOptions;
  const activeConnId = localStorage.getItem("active_connection_id");
  let targetConnId = activeConnId;
  if (!targetConnId) {
    const conns = await getConnections();
    if (conns.length === 0) {
      throw new Error("No database connections found. Please configure a connection in the 'Layer' tab first.");
    }
    targetConnId = conns[0].id;
  }
  return askAnalyticsQuery(query, targetConnId, options.mode || "auto", conversationId, options);
};

// DB Connections
export const getConnections = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/connections`);
  return res.data.data ?? [];
};

const withDefaultPort = (host, type) => {
  if (!host || host.includes(":")) return host;
  const ports = {
    mysql: 3306,
    mariadb: 3306,
    postgresql: 5432,
    redshift: 5432,
    mongodb: 27017,
    "sql server": 1433,
    mssql: 1433,
    redis: 6379,
    snowflake: 443,
    databricks: 443,
  };
  const normalizedType = String(type || "").toLowerCase();
  return ports[normalizedType] ? `${host}:${ports[normalizedType]}` : host;
};

export const addConnection = async (formData) => {
  const dbType = formData.type.toLowerCase();
  const payload = {
    connection_name: formData.name,
    db_type: dbType,
    host: withDefaultPort(formData.host, dbType),
    db_user: formData.user,
    db_password: formData.password,
    default_schema: formData.schema,
  };
  const res = await axios.post(`${API_BASE_URL}/api/connections`, payload);
  return res.data.data;
};

export const removeConnection = async (id) => {
  await axios.delete(`${API_BASE_URL}/api/connections/${id}`);
};

export const updateConnectionName = async (id, connectionName) => {
  const res = await axios.patch(`${API_BASE_URL}/api/connections/${id}`, {
    connection_name: connectionName,
  });
  return res.data.data;
};

// KPI Metrics
export const getKpiMetrics = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/kpi-metrics`);
  return res.data.data ?? [];
};

export const addKpiMetric = async (metricData) => {
  const res = await axios.post(`${API_BASE_URL}/api/kpi-metrics`, metricData);
  return res.data.data;
};

export const updateKpiMetric = async (id, metricData) => {
  const res = await axios.patch(`${API_BASE_URL}/api/kpi-metrics/${id}`, metricData);
  return res.data.data;
};

export const removeKpiMetric = async (id) => {
  await axios.delete(`${API_BASE_URL}/api/kpi-metrics/${id}`);
};

// Semantic Models
export const getSemanticModels = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/semantic-catalog`);
  return res.data.data ?? { semantic_models: [] };
};

export const getSemanticModelsByConnection = async (connectionId) => {
  const res = await getWithRetry(`${API_BASE_URL}/api/semantic-catalog/${connectionId}`);
  return res.data.data ?? { semantic_models: [], ai_catalog: { datasets: [] } };
};

// User authentication
export const getCurrentUser = async () => {
  const res = await axios.get(`${API_BASE_URL}/api/auth/me`);
  return res.data.data?.user ?? null;
};

export const loginWithEntra = async (accessToken) => {
  const res = await axios.post(
    `${API_BASE_URL}/api/auth/entra/login`,
    { accessToken },
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.data.data?.user ?? null;
};

export const logoutUser = async () => {
  const res = await axios.post(`${API_BASE_URL}/api/auth/logout`);
  return res.data.data;
};


// Per-connection authoritative semantic models.
export const getDataCatalogByConnection = async (connectionId, refresh = false) => {
  const suffix = refresh ? "?refresh=true" : "";
  const res = await getWithRetry(`${API_BASE_URL}/api/data-catalog/${Number(connectionId)}${suffix}`);
  return res.data.data;
};

export const getConnectionSemanticModel = async (connectionId) => {
  const res = await getWithRetry(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}`);
  return res.data.data;
};

export const startConnectionSemanticGeneration = async (connectionId, tables, mode) => {
  const res = await axios.post(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}/generate`, {
    tables,
    mode,
  });
  return res.data.data;
};

export const regenerateSemanticModelTable = async (connectionId, table, revision) => {
  const res = await axios.post(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}/regenerate-table`, {
    table,
    revision,
  });
  return res.data.data;
};

export const removeSemanticModelTable = async (connectionId, table, revision) => {
  const res = await axios.delete(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}/tables`, {
    data: { table, revision },
  });
  return res.data.data;
};

export const saveConnectionSemanticModel = async (connectionId, model, revision) => {
  const res = await axios.put(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}`, {
    model,
    revision,
  });
  return res.data.data;
};

export const retrySemanticVectorSync = async (connectionId) => {
  const res = await axios.post(`${API_BASE_URL}/api/semantic-models/${Number(connectionId)}/retry-vector-sync`);
  return res.data.data;
};

// Analytics AI
export const createAnalyticsConversation = async (connectionId) => {
  const res = await axios.post(`${API_BASE_URL}/api/conversations`, {
    connectionId: Number(connectionId),
  });
  return res.data.data;
};

export const deleteAnalyticsConversation = async (conversationId, connectionId) => {
  const res = await axios.delete(
    `${API_BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}`,
    { params: { connectionId: Number(connectionId) } },
  );
  return res.data.data;
};

export const clearAnalyticsConversations = async (connectionId) => {
  const res = await axios.delete(`${API_BASE_URL}/api/conversations`, {
    params: { connectionId: Number(connectionId) },
  });
  return res.data.data;
};

export const askAnalyticsQuery = async (
  question,
  connectionId,
  mode = "auto",
  conversationId = null,
  options = {},
) => {
  const res = await axios.post(
    `${API_BASE_URL}/api/analytics/query`,
    {
      question,
      connectionId: connectionId ? Number(connectionId) : undefined,
      mode,
      ...(options.forcedTableContext && { forcedTableContext: options.forcedTableContext }),
      ...(conversationId && { conversationId }),
      ...(Array.isArray(options.filters) && options.filters.length > 0 && { filters: options.filters }),
    },
    { signal: options.signal },
  );
  return res.data;
};

// Dashboard assistant
export const askAssistant = async (question, options = {}) => {
  const res = await axios.post(
    `${API_BASE_URL}/api/assistant/ask`,
    {
      question,
      ...(options.conversationId && {
        conversationId: options.conversationId,
      }),
      ...(options.selectedConnectionId && {
        selectedConnectionId: Number(options.selectedConnectionId),
      }),
      ...(options.reroute && { reroute: true }),
      ...(options.mode && { mode: options.mode }),
      ...(Array.isArray(options.filters) && options.filters.length > 0 && {
        filters: options.filters,
      }),
    },
    { signal: options.signal },
  );
  return res.data;
};

export const getAssistantConversation = async (conversationId) => {
  const res = await getWithRetry(
    `${API_BASE_URL}/api/assistant/conversations/${encodeURIComponent(conversationId)}`,
  );
  return res.data.data;
};

export const deleteAssistantConversation = async (conversationId) => {
  const res = await axios.delete(
    `${API_BASE_URL}/api/assistant/conversations/${encodeURIComponent(conversationId)}`,
  );
  return res.data.data;
};

// Column browser returns tables + columns + FK relationships from the live target DB.
export const getColumnsByConnection = async (connectionId) => {
  const res = await getWithRetry(`${API_BASE_URL}/api/kpi-metrics/columns/${connectionId}`);
  return { tables: res.data.data ?? [], relationships: res.data.relationships ?? [] };
};

// Observability
export const getObservabilityLogs = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/observability/logs`);
  return res.data.data ?? [];
};

export const getLiveObservabilityLogs = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/observability/logs/live`);
  return res.data.data ?? [];
};

export const exportLiveObservabilityLogs = async (format = "json") => {
  const normalizedFormat = format === "csv" ? "csv" : "json";
  const res = await axios.get(`${API_BASE_URL}/api/observability/logs/live/export`, {
    params: { format: normalizedFormat },
    responseType: "blob",
  });
  return {
    blob: res.data,
    fileName: `live_logs.${normalizedFormat}`,
  };
};

export const getObservabilityMetrics = async () => {
  const res = await getWithRetry(`${API_BASE_URL}/api/observability/metrics`);
  return res.data.data ?? [];
};

export const getObservabilityTokenUsage = async () => {
  const res = await getWithRetry(
    `${API_BASE_URL}/api/observability/token-usage`,
  );
  return res.data.data ?? { enabled: false };
};

export const getCircuitBreakerState = async (connectionId) => {
  const res = await getWithRetry(`${API_BASE_URL}/api/observability/circuit/${connectionId}`);
  return res.data.data ?? {};
};
export const getApiErrorMessage = (error, fallback = "An unexpected error occurred") => (
  error?.normalized?.message ||
  error?.response?.data?.detail ||
  error?.response?.data?.error ||
  error?.response?.data?.message ||
  error?.message ||
  fallback
);

// Axios Interceptor for standardized error handling
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    // Keep the original Axios error intact while exposing a stable normalized shape.
    const normalizedError = {
      message: getApiErrorMessage(error),
      status: error?.response?.status || 500,
      data: error?.response?.data || null,
      response: error?.response,
    };
    error.normalized = normalizedError;
    error.status = normalizedError.status;
    error.data = normalizedError.data;
    error.message = normalizedError.message;
    return Promise.reject(error);
  }
);
