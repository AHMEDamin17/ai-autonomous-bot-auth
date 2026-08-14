import React, { useState, useEffect, useMemo } from 'react';
import {
  getApiErrorMessage,
  getObservabilityMetrics,
  getObservabilityTokenUsage,
  getObservabilityLogs,
  getLiveObservabilityLogs,
  exportLiveObservabilityLogs,
  getCircuitBreakerState
} from '../../../../api/services';
import { useObservabilityStream } from '../../../../hooks/useObservabilityStream';
import {
  Activity,
  CheckCircle,
  AlertTriangle,
  Zap,
  Cpu,
  Download,
  Terminal,
  RefreshCw,
  Database,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import InlineState from "../../../common/InlineState";
import { ASYNC_STATUS } from "../../../../utils/asyncState";
import { formatLatency, formatNumber, formatPercent, formatTime, toFiniteNumber } from "../../../../utils/formatters";

const LOG_LIMIT = Number(import.meta.env.VITE_OBSERVABILITY_LOG_LIMIT) || 50;
const configuredPollingInterval = Number(import.meta.env.VITE_OBSERVABILITY_POLLING_INTERVAL_MS);
const POLLING_INTERVAL_MS = Number.isFinite(configuredPollingInterval) && configuredPollingInterval >= 1000
  ? configuredPollingInterval
  : 30000;
const SUCCESS_STATUSES = new Set(["success", "successful", "ok", "completed"]);
const FAILURE_STATUSES = new Set(["failure", "failed", "error", "errored", "timeout", "rejected"]);

const normalizeLogStatus = (status) => {
  const normalized = String(status || "unknown").trim().toLowerCase();
  if (SUCCESS_STATUSES.has(normalized)) return "success";
  if (FAILURE_STATUSES.has(normalized)) return "failure";
  return normalized || "unknown";
};

const getStatusLabel = (status) => normalizeLogStatus(status).toUpperCase();

const isSuccessStatus = (status) => normalizeLogStatus(status) === "success";

const getStatusTextClass = (status) => (
  isSuccessStatus(status)
    ? "text-green-600"
    : normalizeLogStatus(status) === "failure"
      ? "text-red-600"
      : "text-amber-600"
);

const getStatusBadgeClass = (status) => (
  isSuccessStatus(status)
    ? "bg-green-50 text-green-700 border-green-200"
    : normalizeLogStatus(status) === "failure"
      ? "bg-red-50 text-red-700 border-red-200"
      : "bg-amber-50 text-amber-700 border-amber-200"
);

const getLogCardClass = (status) => (
  isSuccessStatus(status)
    ? "border-(--theme-border) bg-(--theme-card-bg) hover:border-(--theme-primary)"
    : normalizeLogStatus(status) === "failure"
      ? "border-red-200 bg-red-50/30 text-red-700 hover:border-red-300"
      : "border-amber-200 bg-amber-50/30 text-amber-700 hover:border-amber-300"
);

const LatencyTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="rounded-xl border border-(--theme-border) bg-(--theme-card-bg) px-3 py-2 text-xs shadow-lg text-(--theme-text)">
      <p className="font-bold">{point.time || "Unknown time"}</p>
      <p className="mt-1">Latency: <span className="font-bold">{formatLatency(point.latency)}</span></p>
      <p>Status: <span className={`${getStatusTextClass(point.status)} font-bold`}>{point.statusLabel || getStatusLabel(point.status)}</span></p>
    </div>
  );
};

const renderLatencyDot = (props) => {
  const { cx, cy, payload } = props;
  if (typeof cx !== "number" || typeof cy !== "number") return null;
  const isSuccess = isSuccessStatus(payload?.status);
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4}
      fill={isSuccess ? "var(--theme-primary)" : "#dc2626"}
      stroke="var(--theme-card-bg, #fff)"
      strokeWidth={2}
    />
  );
};

// The live trace list is fed by TWO sources — the SSE stream (recent in-memory
// events) and the polling fetch (persisted logs). They return different counts,
// so replacing `logs` from each source made the list flip (e.g. 50 <-> 20) and
// the latency chart re-render on every cycle. Instead we MERGE both into one
// deduplicated, newest-first, capped list, and return the previous reference
// unchanged when nothing new arrived so React (and the chart) don't re-render.
const logKey = (log) => `${log?.executionId ?? ""}|${log?.step ?? ""}|${log?.timestamp ?? ""}|${log?.connectionId ?? ""}`;
const logTimestamp = (log) => {
  const parsed = Date.parse(String(log?.timestamp || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

function mergeLogs(previous, incoming, limit) {
  if (!Array.isArray(incoming) || incoming.length === 0) return previous;
  const byKey = new Map(previous.map((log) => [logKey(log), log]));
  let added = false;
  for (const log of incoming) {
    const key = logKey(log);
    if (!byKey.has(key)) {
      byKey.set(key, log);
      added = true;
    }
  }
  if (!added) return previous;
  const merged = [...byKey.values()]
    .sort((a, b) => logTimestamp(b) - logTimestamp(a))
    .slice(0, limit);
  if (
    merged.length === previous.length
    && merged.every((log, index) => logKey(log) === logKey(previous[index]))
  ) {
    return previous;
  }
  return merged;
}

const ObservabilityDashboard = () => {
  const [logs, setLogs] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [tokenUsage, setTokenUsage] = useState({ enabled: false });
  const [tokenPage, setTokenPage] = useState(0);
  const [circuitStates, setCircuitStates] = useState({});
  const [error, setError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [metricsStatus, setMetricsStatus] = useState(ASYNC_STATUS.IDLE);
  const [logSearch, setLogSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const isFetchingRef = React.useRef(false);
  const fetchData = async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    setIsRefreshing(true);
    setMetricsStatus((prev) => prev === ASYNC_STATUS.SUCCESS ? prev : ASYNC_STATUS.LOADING);
    try {
      const [metricsData, recentLogs, tokenUsageData] = await Promise.all([
        getObservabilityMetrics(),
        getObservabilityLogs()
          .catch((logsErr) => {
            console.warn("Failed to fetch persisted observability logs", logsErr);
            return getLiveObservabilityLogs();
          })
          .catch((logsErr) => {
            console.warn("Failed to fetch recent live observability logs", logsErr);
            return null;
          }),
        getObservabilityTokenUsage().catch((usageErr) => {
          console.warn("Failed to fetch LLM token usage", usageErr);
          return { enabled: false };
        }),
      ]);
      setMetrics(metricsData);
      setTokenUsage(tokenUsageData);
      if (Array.isArray(recentLogs)) {
        setLogs((prev) => mergeLogs(prev, recentLogs, LOG_LIMIT));
      }
      
      const states = {};
      await Promise.all(metricsData.map(async (m) => {
        try {
          const state = await getCircuitBreakerState(m.connectionId);
          states[m.connectionId] = state;
        } catch (err) {
          console.warn(`Failed to fetch circuit breaker state for connection ${m.connectionId}:`, err);
          states[m.connectionId] = { status: 'unknown' };
        }
      }));
      setCircuitStates(states);
      setError(null);
      setMetricsStatus(ASYNC_STATUS.SUCCESS);
    } catch (err) {
      console.error("Failed to fetch observability data", err);
      setError(getApiErrorMessage(err, "Failed to load telemetry data."));
      setMetricsStatus(ASYNC_STATUS.ERROR);
    } finally {
      setIsRefreshing(false);
      isFetchingRef.current = false;
    }
  };

  const { logs: liveLogs, connected: streamConnected } = useObservabilityStream(true);
  useEffect(() => { setLogs((prev) => mergeLogs(prev, liveLogs, LOG_LIMIT)); }, [liveLogs]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLLING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const totalExecutions = metrics.reduce((acc, m) => acc + (toFiniteNumber(m.executions, 0) || 0), 0);
  const totalFailures = metrics.reduce((acc, m) => acc + (toFiniteNumber(m.failures, 0) || 0), 0);
  const failureRate = totalExecutions > 0 ? (totalFailures / totalExecutions) * 100 : 0;
  
  const avgLatency = totalExecutions > 0 
    ? (() => {
        const val = metrics.reduce((acc, m) => {
          const safeLatency = toFiniteNumber(m.avgLatencyMs, 0) || 0;
          const executions = toFiniteNumber(m.executions, 0) || 0;
          return acc + (safeLatency * executions);
        }, 0) / totalExecutions;
        return Number.isFinite(val) ? val : 0;
      })()
    : 0;
  const tokenSummary = tokenUsage?.summary || {};
  const recentTokenCalls = Array.isArray(tokenUsage?.recentCalls)
    ? tokenUsage.recentCalls
    : [];
  const TOKEN_PAGE_SIZE = 6;
  const tokenPageCount = Math.max(1, Math.ceil(recentTokenCalls.length / TOKEN_PAGE_SIZE));
  const safeTokenPage = Math.min(tokenPage, tokenPageCount - 1);
  const pagedTokenCalls = recentTokenCalls.slice(
    safeTokenPage * TOKEN_PAGE_SIZE,
    safeTokenPage * TOKEN_PAGE_SIZE + TOKEN_PAGE_SIZE,
  );
  const tokenUsageByStage = Array.isArray(tokenUsage?.byStage)
    ? tokenUsage.byStage
    : [];

  const filteredLogs = useMemo(() => {
    const query = logSearch.toLowerCase().trim();
    return logs.filter((log) => {
      const normalizedStatus = normalizeLogStatus(log.status);
      const statusMatches = statusFilter === "all" || normalizedStatus === statusFilter;
      const text = [
        log.executionId,
        log.connectionId,
        log.connector,
        log.authType,
        log.step,
        log.status,
        normalizedStatus,
        log.circuitState,
        log.message,
      ].join(" ").toLowerCase();
      return statusMatches && (!query || text.includes(query));
    });
  }, [logSearch, logs, statusFilter]);

  const chartData = useMemo(() => {
    return filteredLogs
      .slice(0, 15)
      .reverse()
      .map((log, index) => {
        const latency = toFiniteNumber(log.latencyMs, null);
        if (latency === null) return null;
        return {
          index,
          time: formatTime(log.timestamp) || "N/A",
          latency,
          status: normalizeLogStatus(log.status),
          statusLabel: getStatusLabel(log.status),
        };
      })
      .filter(Boolean);
  }, [filteredLogs]);

  const handleExport = async (format) => {
    try {
      const { blob, fileName } = await exportLiveObservabilityLogs(format);
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      setError(getApiErrorMessage(err, "Failed to export telemetry logs."));
    }
  };

  return (
    <div className="w-full relative space-y-6 sm:space-y-8">
      {error && (
        <div className="bg-red-50/80 backdrop-blur border border-red-200 text-red-700 px-4 py-3 rounded-xl flex items-center gap-3 animate-pulse">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span className="font-medium text-sm">{error}</span>
        </div>
      )}

      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-(--theme-border) pb-4">
        <div>
          <h2 className="text-base sm:text-xl md:text-2xl font-bold text-(--theme-text) flex items-center gap-2">
            System Observability
          </h2>
          <p className="text-xs text-(--theme-text-muted) mt-0.5">
            Real-time analytics engine telemetry and connection health circuit breakers.
          </p>
        </div>
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className={`border rounded-full px-3 py-1 text-xs font-semibold flex items-center gap-1.5 shadow-sm ${
            streamConnected ? "bg-green-50 text-green-700 border-green-200" : "bg-amber-50 text-amber-700 border-amber-200"
          }`}>
            {streamConnected ? "Live Feed Active" : "Live Feed Reconnecting"}
          </div>
          <button 
            onClick={fetchData} 
            className="p-2 text-(--theme-text-muted) hover:text-(--theme-primary) bg-(--theme-theme-background) hover:bg-(--theme-scrollbar-thumb) border border-(--theme-border) rounded-lg transition-colors duration-200 flex items-center justify-center cursor-pointer"
            title="Refresh telemetry"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin text-(--theme-primary)' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
        <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-6 flex flex-col relative overflow-hidden shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-(--theme-text-muted) text-xs font-bold uppercase tracking-wider mb-1">Total API Executions</p>
              <h3 className="text-3xl sm:text-4xl font-bold text-(--theme-text) tracking-tight leading-none my-1">{formatNumber(totalExecutions, { maximumFractionDigits: 0 })}</h3>
              <p className="text-(--theme-text-muted) text-xs mt-2 font-medium">All monitored query adapters</p>
            </div>
            <div className="p-3 bg-(--theme-chip-bg) rounded-xl text-(--theme-primary)">
              <Cpu className="h-6 w-6" />
            </div>
          </div>
        </div>

        <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-6 flex flex-col relative overflow-hidden shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-(--theme-text-muted) text-xs font-bold uppercase tracking-wider mb-1">Failure Rate</p>
              <h3 className={`text-3xl sm:text-4xl font-bold tracking-tight leading-none my-1 ${failureRate > 5 ? 'text-red-600' : 'text-green-600'}`}>
                {formatPercent(failureRate)}
              </h3>
              <p className="text-(--theme-text-muted) text-xs mt-2 font-medium">
                {formatNumber(totalFailures, { maximumFractionDigits: 0 })} failures recorded
              </p>
            </div>
            <div className={`p-3 rounded-xl ${failureRate > 5 ? 'bg-red-50 text-red-600 border border-red-100' : 'bg-green-50 text-green-600 border border-green-100'}`}>
              {failureRate > 5 ? <AlertTriangle className="h-6 w-6" /> : <CheckCircle className="h-6 w-6" />}
            </div>
          </div>
        </div>

        <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-6 flex flex-col relative overflow-hidden shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <p className="text-(--theme-text-muted) text-xs font-bold uppercase tracking-wider mb-1">System Avg Latency</p>
              <h3 className="text-3xl sm:text-4xl font-bold text-amber-600 tracking-tight leading-none my-1">{formatLatency(avgLatency)}</h3>
              <p className="text-(--theme-text-muted) text-xs mt-2 font-medium">Mean query processing time</p>
            </div>
            <div className="p-3 bg-amber-50 border border-amber-100 rounded-xl text-amber-600">
              <Zap className="h-6 w-6" />
            </div>
          </div>
        </div>
      </div>

      {tokenUsage?.enabled && (
        <section className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-5 sm:p-6 shadow-xs space-y-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-base sm:text-xl font-bold text-(--theme-text) flex items-center gap-2">
                <Cpu className="h-5 w-5 text-(--theme-primary)" />
                LLM Token & Context Usage
              </h2>
              <p className="text-xs text-(--theme-text-muted) font-medium">
                Provider-reported usage retained in the bounded live telemetry buffer.
              </p>
            </div>
            <span className="inline-flex w-fit items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-green-700">
              Metering enabled
            </span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              {
                label: "LLM Calls",
                value: formatNumber(tokenSummary.callCount, { maximumFractionDigits: 0 }),
                note: `${formatNumber(tokenSummary.measuredCallCount, { maximumFractionDigits: 0 })} reported token counts`,
              },
              {
                label: "Input Tokens",
                value: formatNumber(tokenSummary.inputTokens, { maximumFractionDigits: 0 }),
                note: "Prompts and scoped catalog context",
              },
              {
                label: "Output Tokens",
                value: formatNumber(tokenSummary.outputTokens, { maximumFractionDigits: 0 }),
                note: "Structured model completions",
              },
              {
                label: "Total Tokens",
                value: formatNumber(tokenSummary.totalTokens, { maximumFractionDigits: 0 }),
                note: `${formatNumber(tokenSummary.averageTokensPerCall, { maximumFractionDigits: 0 })} average per measured call`,
              },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4"
              >
                <p className="text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                  {item.label}
                </p>
                <p className="mt-1 text-2xl font-bold text-(--theme-text)">
                  {item.value}
                </p>
                <p className="mt-1 text-[10px] font-medium text-(--theme-text-muted)">
                  {item.note}
                </p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                Average Context Usage
              </p>
              <p className="mt-1 text-xl font-bold text-(--theme-primary)">
                {formatPercent(tokenSummary.averageContextUsagePercent)}
              </p>
            </div>
            <div className="rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                Peak Context Usage
              </p>
              <p className="mt-1 text-xl font-bold text-amber-600">
                {formatPercent(tokenSummary.maxContextUsagePercent)}
              </p>
            </div>
            <div className="rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                Failed LLM Calls
              </p>
              <p className={`mt-1 text-xl font-bold ${
                (toFiniteNumber(tokenSummary.failedCallCount, 0) || 0) > 0
                  ? "text-red-600"
                  : "text-green-600"
              }`}>
                {formatNumber(tokenSummary.failedCallCount, { maximumFractionDigits: 0 })}
              </p>
            </div>
          </div>

          {tokenUsageByStage.length > 0 && (
            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                Usage by LLM stage
              </p>
              <div className="flex flex-wrap gap-2">
                {tokenUsageByStage.map((stage) => (
                  <div
                    key={stage.stage}
                    className="rounded-lg border border-(--theme-border) bg-(--theme-container-bg) px-3 py-2 text-xs"
                  >
                    <span className="font-mono font-bold text-(--theme-text)">
                      {stage.stage}
                    </span>
                    <span className="ml-2 text-(--theme-text-muted)">
                      {formatNumber(stage.totalTokens, { maximumFractionDigits: 0 })} tokens · {formatNumber(stage.calls, { maximumFractionDigits: 0 })} calls
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                Recent provider calls
              </p>
              {recentTokenCalls.length > TOKEN_PAGE_SIZE && (
                <div className="flex items-center gap-2 text-[11px] text-(--theme-text-muted)">
                  <span>
                    {safeTokenPage * TOKEN_PAGE_SIZE + 1}&ndash;
                    {Math.min((safeTokenPage + 1) * TOKEN_PAGE_SIZE, recentTokenCalls.length)} of {recentTokenCalls.length}
                  </span>
                  <button
                    type="button"
                    disabled={safeTokenPage === 0}
                    onClick={() => setTokenPage((page) => Math.max(0, page - 1))}
                    className="rounded-md border border-(--theme-border-dark) bg-(--theme-surface) px-2 py-1 font-semibold text-(--theme-text-secondary) transition-colors hover:bg-(--theme-container-bg) disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={safeTokenPage >= tokenPageCount - 1}
                    onClick={() => setTokenPage((page) => Math.min(tokenPageCount - 1, page + 1))}
                    className="rounded-md border border-(--theme-border-dark) bg-(--theme-surface) px-2 py-1 font-semibold text-(--theme-text-secondary) transition-colors hover:bg-(--theme-container-bg) disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
            {recentTokenCalls.length === 0 ? (
              <InlineState
                type="empty"
                title="No measured LLM calls yet"
                message="Run a Dashboard or Analytics AI query to populate token usage."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-(--theme-border)">
                <table className="w-full min-w-[560px] text-left text-xs">
                  <thead className="border-b border-(--theme-border) bg-(--theme-container-bg) text-[10px] font-bold uppercase tracking-wider text-(--theme-text-muted)">
                    <tr>
                      <th className="px-3 py-3">Stage</th>
                      <th className="px-3 py-3">Provider</th>
                      <th className="px-3 py-3 text-right">Total tokens</th>
                      <th className="px-3 py-3 text-right">Context</th>
                      <th className="px-3 py-3 text-right">Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-(--theme-border)">
                    {pagedTokenCalls.map((call, index) => (
                      <tr key={`${call.executionId}-${index}`} className="text-(--theme-text-secondary)">
                        <td className="px-3 py-3 font-mono font-bold text-(--theme-text)">
                          {call.stage || "llm"}
                        </td>
                        <td className="px-3 py-3 font-semibold text-(--theme-text)">{call.provider || "unknown"}</td>
                        <td className="px-3 py-3 text-right font-bold text-(--theme-text)">{formatNumber(call.totalTokens, { maximumFractionDigits: 0 })}</td>
                        <td className="px-3 py-3 text-right">{formatPercent(call.contextUsagePercent)}</td>
                        <td className="px-3 py-3 text-right text-amber-600 font-bold">{formatLatency(call.latencyMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 sm:gap-8 items-start">
        {/* Left Column: Latency Chart & Connection Status Table */}
        <div className="space-y-6 sm:space-y-8">
          {/* Latency Trend AreaChart */}
          <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-5 sm:p-6 shadow-xs">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-base sm:text-xl font-bold text-(--theme-text) flex items-center gap-1.5">
                  <Activity className="h-4 w-4 text-(--theme-primary)" />
                  Latency Trend (Last 15 requests)
                </h2>
                <p className="text-xs text-(--theme-text-muted) font-medium">Response times of recent queries in ms</p>
              </div>
            </div>
            {filteredLogs.length === 0 ? (
              <InlineState
                type="empty"
                title="No matching request history"
                message="Try changing the log search or status filter."
                className="h-[200px] flex flex-col items-center justify-center"
              />
            ) : chartData.length === 0 ? (
              <InlineState
                type="empty"
                title="No valid latency values"
                message="The visible logs do not include numeric latency values to chart."
                className="h-[200px] flex flex-col items-center justify-center"
              />
            ) : (
              <div className="w-full">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="latencyGlow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--theme-primary)" stopOpacity={0.4}/>
                        <stop offset="95%" stopColor="var(--theme-primary)" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--theme-border)" />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fill: 'var(--theme-text-muted)', fontSize: 10, fontWeight: 500 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis 
                      tick={{ fill: 'var(--theme-text-muted)', fontSize: 10, fontWeight: 500 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(value) => formatLatency(value)}
                    />
                    <Tooltip content={<LatencyTooltip />} />
                    <Area
                      type="monotone"
                      dataKey="latency"
                      stroke="var(--theme-primary)"
                      strokeWidth={2.5}
                      fillOpacity={1}
                      fill="url(#latencyGlow)"
                      activeDot={renderLatencyDot}
                      dot={renderLatencyDot}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {/* Connection Metrics Table */}
          <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-5 sm:p-6 w-full overflow-hidden shadow-xs">
            <div className="flex items-center gap-2 mb-4">
              <Database className="h-5 w-5 text-(--theme-primary)" />
              <div>
                <h2 className="text-base sm:text-xl font-bold text-(--theme-text)">
                  Connector Status & Metrics
                </h2>
                <p className="text-xs text-(--theme-text-muted) font-medium">Aggregated database adaptor telemetries</p>
              </div>
            </div>
            <div className="overflow-x-auto border border-(--theme-border) rounded-xl">
              <table className="w-full text-left text-sm border-collapse">
                <thead className="bg-gray-50/50 text-(--theme-text-muted) uppercase text-[10px] font-bold tracking-wider border-b border-(--theme-border)">
                  <tr>
                    <th className="px-4 py-3.5">Connection ID</th>
                    <th className="px-4 py-3.5 text-center">Executions</th>
                    <th className="px-4 py-3.5">Reliability (Success Rate)</th>
                    <th className="px-4 py-3.5 text-right">Avg Latency</th>
                    <th className="px-4 py-3.5 text-center">Circuit Breaker</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {metricsStatus === ASYNC_STATUS.LOADING && metrics.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-4 py-8">
                        <InlineState type="loading" title="Loading connector metrics" />
                      </td>
                    </tr>
                  ) : metricsStatus === ASYNC_STATUS.ERROR && metrics.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-4 py-8">
                        <InlineState type="error" title="Telemetry unavailable" message={error} actionLabel="Retry" onAction={fetchData} />
                      </td>
                    </tr>
                  ) : metrics.length === 0 ? (
                    <tr>
                      <td colSpan="5" className="px-4 py-8 text-center text-(--theme-text-muted) font-medium">No connectors configured</td>
                    </tr>
                  ) : (
                    metrics.map((m) => {
                      const state = circuitStates[m.connectionId] || { status: 'unknown' };
                      const total = toFiniteNumber(m.executions, 0) || 0;
                      const failures = Math.min(total, toFiniteNumber(m.failures, 0) || 0);
                      const successes = Math.max(0, total - failures);
                      const reliability = total > 0 ? (successes / total) * 100 : 100;
                      const reliabilityWidth = Math.max(0, Math.min(100, reliability));
                      
                      // Determine progress bar color based on reliability
                      let barColor = 'bg-green-500';
                      let barBg = 'bg-green-50';
                      let textColor = 'text-green-700';
                      if (reliability < 90) {
                        barColor = 'bg-red-500';
                        barBg = 'bg-red-50';
                        textColor = 'text-red-700';
                      } else if (reliability < 98) {
                        barColor = 'bg-amber-500';
                        barBg = 'bg-amber-50';
                        textColor = 'text-amber-700';
                      }

                      return (
                        <tr key={m.connectionId} className="hover:bg-(--theme-container-bg)/50 transition-colors">
                          <td className="px-4 py-3.5 font-bold text-(--theme-text)">
                            {m.connectionId}
                          </td>
                          <td className="px-4 py-3.5 text-(--theme-text-secondary) text-center font-semibold">
                            {formatNumber(total, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="flex items-center gap-2">
                              <div className={`w-16 h-2 rounded-full ${barBg} overflow-hidden shrink-0`}>
                                <div className={`h-full ${barColor} rounded-full`} style={{ width: `${reliabilityWidth}%` }}></div>
                              </div>
                              <span className={`text-xs font-bold ${textColor}`}>
                              {formatPercent(reliability)}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right font-bold text-amber-600">
                            {formatLatency(m.avgLatencyMs)}
                          </td>
                          <td className="px-4 py-3.5 text-center">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold border ${
                              state.status === 'closed' ? 'bg-green-50 text-green-700 border-green-200' :
                              state.status === 'open' ? 'bg-red-50 text-red-700 border-red-200 animate-pulse' :
                              'bg-amber-50 text-amber-700 border-amber-200'
                            }`}>
                              {state.status.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Live Orchestrator Trace Feed / Log Viewer */}
        <div className="bg-(--theme-card-bg) rounded-xl border border-(--theme-border) p-5 sm:p-6 w-full overflow-hidden flex flex-col h-[525px] shadow-xs">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <Terminal className="h-5 w-5 text-(--theme-primary)" />
              <div>
                <h2 className="text-base sm:text-xl font-bold text-(--theme-text)">
                  Live Execution Trace Viewer
                </h2>
                <p className="text-xs text-(--theme-text-muted) font-medium">Real-time pipeline operations and API transactions</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => handleExport('json')}
                className="px-2.5 py-1.5 rounded-lg border border-(--theme-border) text-(--theme-text) text-xs font-semibold bg-(--theme-theme-background) hover:bg-(--theme-scrollbar-thumb) transition-colors duration-200 flex items-center gap-1 cursor-pointer"
              >
                <Download className="h-3 w-3" />
                JSON
              </button>
              <button 
                onClick={() => handleExport('csv')}
                className="px-2.5 py-1.5 rounded-lg border border-(--theme-border) text-(--theme-text) text-xs font-semibold bg-(--theme-theme-background) hover:bg-(--theme-scrollbar-thumb) transition-colors duration-200 flex items-center gap-1 cursor-pointer"
              >
                <Download className="h-3 w-3" />
                CSV
              </button>
            </div>
          </div>

          <div className="mb-3 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
            <input
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="Search logs by execution, adapter, step..."
              className="w-full rounded-lg border border-(--theme-border) bg-(--theme-theme-background) px-3 py-2 text-xs font-semibold text-(--theme-text) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-(--theme-border) bg-(--theme-theme-background) px-3 py-2 text-xs font-bold text-(--theme-text) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40"
            >
              <option value="all">All statuses</option>
              <option value="success">Success</option>
              <option value="failure">Failure / error</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>

          {/* Terminal Console */}
          <div className="flex-1 bg-(--theme-container-bg) rounded-xl border border-(--theme-border) p-4 overflow-y-auto text-(--theme-text) flex flex-col">
            <div className="flex items-center justify-between border-b border-(--theme-border) pb-2 mb-3 text-xs text-(--theme-text-muted) font-medium font-mono">
              <span>Logs ({filteredLogs.length} visible of {logs.length}, limit {LOG_LIMIT})</span>
              <span className={`text-[10px] font-bold flex items-center gap-1.5 uppercase tracking-wide ${
                streamConnected ? "text-green-600" : "text-amber-600"
              }`}>
                {streamConnected ? "Connected" : "Reconnecting"}
              </span>
            </div>

            {/* Logs List */}
            <div className="flex-1 space-y-2.5 overflow-y-auto pr-1">
              {filteredLogs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-(--theme-text-muted) py-20 text-center">
                  <Terminal className="h-8 w-8 mb-2 animate-bounce text-(--theme-primary)" />
                  <p className="text-xs font-mono">{logs.length === 0 ? "Listening for incoming orchestration transactions..." : "No logs match the current filter."}</p>
                  <p className="text-[10px] font-mono text-(--theme-text-muted) mt-1">{logs.length === 0 ? "Submit natural language queries to trigger logs" : "Adjust search or status filter to broaden results"}</p>
                </div>
              ) : (
                filteredLogs.map((log, i) => {
                  const logTime = formatTime(log.timestamp) || "N/A";
                  const statusLabel = getStatusLabel(log.status);
                  
                  return (
                    <div 
                      key={log.executionId + i} 
                      className={`p-2.5 rounded-xl border text-xs font-mono transition-colors duration-200 ${getLogCardClass(log.status)}`}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className="text-(--theme-text-muted) text-[10px]">{logTime}</span>
                          <span className="text-[10px] text-(--theme-primary) font-bold">
                            #{log.executionId ? log.executionId.split('-')[0] : 'N/A'}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold border ${getStatusBadgeClass(log.status)}`}>
                            {statusLabel}
                          </span>
                        </div>
                        <span className="text-amber-600 font-bold text-[10px]">{formatLatency(log.latencyMs)}</span>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-(--theme-text-secondary) pl-1 border-l border-(--theme-border) mt-1.5">
                        <div>
                          <span className="text-(--theme-text-muted)">Adapter:</span> <span className="text-(--theme-text) font-semibold">{log.connectionId}</span>
                        </div>
                        <div>
                          <span className="text-(--theme-text-muted)">Auth:</span> <span className="text-(--theme-text)">{log.authType || 'none'}</span>
                        </div>
                        <div className="sm:col-span-2">
                          <span className="text-(--theme-text-muted)">Pipeline Step:</span> <span className="text-(--theme-accent) font-bold uppercase">{log.step || 'query'}</span>
                        </div>
                        {log.message && (
                          <div className="sm:col-span-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-red-700">
                            <span className="font-bold">Error:</span> <span>{log.message}</span>
                          </div>
                        )}
                        {log.circuitState && (
                          <div className="sm:col-span-2">
                            <span className="text-(--theme-text-muted)">Breaker:</span> <span className={`font-bold ${
                              log.circuitState === 'closed' ? 'text-green-500' : 'text-red-500'
                            }`}>{log.circuitState.toUpperCase()}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ObservabilityDashboard;
