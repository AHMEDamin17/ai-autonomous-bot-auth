import { useState, useEffect, useRef, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Bar,
  BarChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import {
  getConnections,
  askAnalyticsQuery,
  createAnalyticsConversation,
  deleteAnalyticsConversation,
  clearAnalyticsConversations,
  getApiErrorMessage,
} from "../../../../api/services";
import BottomPromptBar from "../../Analytics/BottomPromptBar";
import UserIcon from "../../../../assets/user-icon.png";
import { useCatalogStore } from "../../../../stores/catalogStore";

// Inline native SVG icons to avoid external package icon imports
const DatabaseIcon = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
  </svg>
);

const HistoryIcon = ({ className = "w-4 h-4" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="w-3 h-3 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const PlayIcon = () => (
  <svg className="w-3 h-3 text-(--theme-text-muted) group-hover:text-teal-600 transition-colors" fill="currentColor" viewBox="0 0 24 24">
    <path d="M8 5v14l11-7z" />
  </svg>
);

const ChevronRightIcon = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

const BotIcon = ({ className = "w-5 h-5" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V9a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2zm8-5h.01M9 12h.01" />
  </svg>
);

const SparklesIcon = () => (
  <svg className="w-4 h-4 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.286L13 21l-2.286-6.857L5 12l5.714-2.286L13 3z" />
  </svg>
);

const PanelCloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7M4 6h1" />
  </svg>
);

const PanelOpenIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7M20 6h-1" />
  </svg>
);

const AlertCircleIcon = () => (
  <svg className="w-4.5 h-4.5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const HelpCircleIcon = () => (
  <svg className="w-3 h-3 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const TrendingUpIcon = ({ className = "w-3 h-3" }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
  </svg>
);

const ZapIcon = () => (
  <svg className="w-3.5 h-3.5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const ChevronDown = () => (
  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
    <svg className="w-4 h-4 text-(--theme-text-muted)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  </div>
);

// Number formatter
const fmtValue = (v, format) => {
  const n = Number(v ?? 0);
  const isNeg = n < 0;
  const absN = Math.abs(n);
  if (format === "currency") return `${isNeg ? '-' : ''}$${absN.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${n.toFixed(1)}%`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

const businessLabel = (value) => String(value || "")
  .split(".")
  .pop()
  .replace(/([a-z])([A-Z])/g, "$1 $2")
  .replace(/_/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/\b\w/g, (character) => character.toUpperCase());

const resultHeaderLabel = (value, plan = {}) => {
  if (value === "metric_value" || value === "value") return "Value";
  if (value === "time_key") return "Period";
  const groupMatch = String(value || "").match(/^group_key(?:_(\d+))?$/);
  if (groupMatch || value === "key") {
    const groups = Array.isArray(plan.groupBy)
      ? plan.groupBy
      : (plan.groupBy ? [plan.groupBy] : []);
    const index = groupMatch?.[1] ? Number(groupMatch[1]) - 1 : 0;
    return businessLabel(groups[index] || value) || "Business Value";
  }
  return businessLabel(value) || "Business Value";
};

// Scorecard component
const Scorecard = ({ value, label }) => (
  <div className="flex flex-col items-center justify-center py-10 bg-linear-to-tr from-(--theme-container-bg) to-(--theme-accent)/10 rounded-2xl border border-(--theme-border) shadow-inner my-2">
    <div className="text-5xl font-extrabold text-(--theme-primary) mb-2 tracking-tight">{value}</div>
    <div className="text-sm text-(--theme-text-muted) font-bold uppercase tracking-wider">{label}</div>
  </div>
);

// Main connection-scoped analytics assistant.

const ChatMessage = {
  USER: "user",
  ASSISTANT: "assistant",
  TYPING: "typing",
};

const getHistoryEntryKey = (entry) => String(
  entry?.backendConversationId
  || entry?.id
  || `${entry?.question || entry?.title || "history"}:${entry?.updatedAt || ""}`,
);

const AnalyticsAssistant = () => {
  const { globalConnectionId } = useOutletContext() || {};
  const [connections, setConnections] = useState([]);
  const selectedConnectionId = globalConnectionId || "";

  const [catalog, setCatalog] = useState([]); // ai_catalog[]
  const [showSidebar, setShowSidebar] = useState(true);


  const [isQuerying, setIsQuerying] = useState(false);

  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyMutationKey, setHistoryMutationKey] = useState(null);
  const [historyActionError, setHistoryActionError] = useState("");
  // const [queryMode, setQueryMode] = useState("simple");
  const queryMode = "kpi";

  const chatEndRef = useRef(null);
  const queryCounter = useRef(0);
  const conversationIdRef = useRef(null);
  const conversationCreationRef = useRef(null);
  const conversationEpochRef = useRef(0);
  const activeHistoryIdRef = useRef(null);
  const historyMutationRef = useRef(0);
  const primaryColor = useMemo(
    () => getComputedStyle(document.documentElement).getPropertyValue('--theme-primary').trim() || "#0CA1B6",
    [],
  );

  // Load connections
  useEffect(() => {
    const load = async () => {
      try {
        const conns = await getConnections();
        setConnections((conns || []).map((c) => ({ id: String(c.id), name: c.connection_name, type: c.db_type })));
      } catch {
        /* silent */
      }
    };
    load();
  }, []);

  const loadCatalog = useCatalogStore(s => s.load);
  const byConnection = useCatalogStore(s => s.byConnection);
  useEffect(() => {
    if (selectedConnectionId) loadCatalog(selectedConnectionId);
  }, [selectedConnectionId, loadCatalog]);

  useEffect(() => {
    if (!selectedConnectionId) { setCatalog([]); return; }
    const storeData = byConnection[selectedConnectionId];
    if (storeData) {
      setCatalog(storeData.datasets);
    }
  }, [selectedConnectionId, byConnection]);

  // Load query history from localStorage when connection changes
  useEffect(() => {
    queryCounter.current += 1;
    conversationEpochRef.current += 1;
    historyMutationRef.current += 1;
    conversationIdRef.current = null;
    conversationCreationRef.current = null;
    activeHistoryIdRef.current = null;
    setHistoryMutationKey(null);
    setHistoryActionError("");
    setMessages([]);
    setIsQuerying(false);
    if (!selectedConnectionId) {
      setHistory([]);
      return;
    }
    try {
      const saved = localStorage.getItem(`query_history_${selectedConnectionId}`);
      setHistory(saved ? JSON.parse(saved) : []);
    } catch {
      setHistory([]);
    }
  }, [selectedConnectionId]);

  // Scroll to chat bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isQuerying]);

  const resetActiveChat = () => {
    queryCounter.current += 1;
    conversationEpochRef.current += 1;
    setMessages([]);
    setIsQuerying(false);
    conversationIdRef.current = null;
    conversationCreationRef.current = null;
    activeHistoryIdRef.current = null;
  };

  const handleNewChat = () => {
    resetActiveChat();
    setHistoryActionError("");
  };

  const setActiveConversationId = (id) => {
    const normalizedId = id || null;
    conversationIdRef.current = normalizedId;
  };

  const ensureConversation = async () => {
    if (conversationIdRef.current) return conversationIdRef.current;
    if (!conversationCreationRef.current) {
      const creationEpoch = conversationEpochRef.current;
      const creationPromise = createAnalyticsConversation(selectedConnectionId)
        .then((conversation) => {
          if (creationEpoch !== conversationEpochRef.current) {
            throw new Error("Conversation creation was superseded by a newer chat.");
          }
          if (!conversation?.id) {
            throw new Error("The backend did not return a conversation ID.");
          }
          setActiveConversationId(conversation.id);
          return conversation.id;
        })
        .finally(() => {
          if (conversationCreationRef.current === creationPromise) {
            conversationCreationRef.current = null;
          }
        });
      conversationCreationRef.current = creationPromise;
    }
    return conversationCreationRef.current;
  };

  // Generate stable context recommendations based on loaded database catalog
  const suggestions = useMemo(() => {
    const list = [];
    if (catalog && catalog.length > 0) {
      const allMetrics = [];
      catalog.forEach((ds) => {
        if (ds.metrics) {
          ds.metrics.forEach((m) => {
            allMetrics.push({
              label: m.label || m.name,
              dsName: ds.name,
              formula: m.expressionSql,
              dimensions: m.dimensions || m.kpi_dimensions || [],
            });
          });
        }
      });
      allMetrics.slice(0, 2).forEach((metric) => list.push(`Show me ${metric.label}`));
      if (list.length < 3) list.push("What KPIs are available?");
      if (list.length < 3) list.push("Break down a KPI by a business dimension");
    } else {
      list.push("What KPIs are available?");
      list.push("Show a KPI result");
      list.push("Show the business values I asked for");
    }
    return list.slice(0, 3);
  }, [catalog]);

  // Ask
  const handleAskPrompt = async (text, forcedTableContext = null) => {
    if (!text.trim()) return;
    if (historyMutationKey) return;
    if (!selectedConnectionId) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: ChatMessage.ASSISTANT, content: "Please select a database connection first.", error: true, timestamp: Date.now() }
      ]);
      return;
    }

    const userMsgId = crypto.randomUUID();
    queryCounter.current += 1;
    const currentRequestId = queryCounter.current;

    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: ChatMessage.USER, content: text.trim(), timestamp: Date.now() },
      { id: "typing", role: ChatMessage.TYPING, timestamp: Date.now() }
    ]);

    setIsQuerying(true);

    try {
      let activeConversationId = await ensureConversation();
      let data;
      try {
        data = await askAnalyticsQuery(text.trim(), selectedConnectionId, queryMode, activeConversationId, {
          forcedTableContext
        });
      } catch (error) {
        if (error?.response?.status !== 409 || error?.response?.data?.errorCode !== "CONVERSATION_UNAVAILABLE") {
          throw error;
        }
        setActiveConversationId(null);
        activeConversationId = await ensureConversation();
        data = await askAnalyticsQuery(text.trim(), selectedConnectionId, queryMode, activeConversationId, {
          forcedTableContext
        });
      }
      if (currentRequestId !== queryCounter.current) return;

      const currentCid = data.conversationId || activeConversationId;
      if (currentCid !== conversationIdRef.current) setActiveConversationId(currentCid);
      activeHistoryIdRef.current = currentCid;
      const hasSubError = !!(data.insight?.error || data.data?.error);
      const handledAssistantMode = data.mode === "clarification_required" || data.mode === "data_quality_issue" || data.mode === "unrecognized";
      const isError = (data.success === false && !handledAssistantMode) || hasSubError;
      const errMessage = data.insight?.error || data.data?.message || data.message;
      const content = data.insight?.answer || (isError ? errMessage : data.message) || "";

      const assistantMsg = { id: crypto.randomUUID(), role: ChatMessage.ASSISTANT, content, result: data, error: isError, queryMode: queryMode, timestamp: Date.now() };

      setMessages((prev) => {
        const updatedMsgs = [...prev.filter((m) => m.role !== ChatMessage.TYPING), assistantMsg];

        queueMicrotask(() => {
          setHistory((oldHist) => {
            const existing = oldHist.find(h => h.id === currentCid || h.question === text.trim());
            const item = {
              id: currentCid,
              backendConversationId: currentCid,
              updatedAt: Date.now(),
              title: existing?.title || existing?.question || text.trim(),
              question: existing?.title || existing?.question || text.trim(),
              result: data,
              messages: updatedMsgs
            };
            const updated = [item, ...oldHist.filter(h => h.id !== currentCid && h.question !== text.trim())].slice(0, 8);
            localStorage.setItem(`query_history_${selectedConnectionId}`, JSON.stringify(updated));
            return updated;
          });
        });

        return updatedMsgs;
      });
    } catch (err) {
      if (currentRequestId !== queryCounter.current) return;
      const detail = err?.response?.data?.detail || err?.response?.data?.error || err.message || "Query failed.";
      setMessages((prev) => [
        ...prev.filter((m) => m.role !== ChatMessage.TYPING),
        { id: crypto.randomUUID(), role: ChatMessage.ASSISTANT, content: detail, error: true, timestamp: Date.now() }
      ]);
    } finally {
      if (currentRequestId === queryCounter.current) setIsQuerying(false);
    }
  };

  const loadHistory = (h) => {
    if (historyMutationKey) return;
    if (h.messages && h.messages.length > 0) {
      queryCounter.current += 1;
      conversationEpochRef.current += 1;
      conversationCreationRef.current = null;
      setIsQuerying(false);
      setMessages(h.messages);
      setActiveConversationId(h.backendConversationId || null);
      activeHistoryIdRef.current = getHistoryEntryKey(h);
    } else {
      // Legacy fallback
      handleAskPrompt(h.question || h.title);
    }
  };

  const persistHistory = (connectionId, entries) => {
    const storageKey = `query_history_${connectionId}`;
    if (entries.length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(entries));
    } else {
      localStorage.removeItem(storageKey);
    }
  };

  const handleDeleteHistoryItem = async (entry) => {
    if (isQuerying || historyMutationKey || !selectedConnectionId) return;
    if (!window.confirm("Permanently delete this conversation history?")) return;

    const entryKey = getHistoryEntryKey(entry);
    const backendConversationId = entry.backendConversationId || null;
    const mutationId = historyMutationRef.current + 1;
    historyMutationRef.current = mutationId;
    setHistoryMutationKey(entryKey);
    setHistoryActionError("");

    try {
      if (backendConversationId) {
        await deleteAnalyticsConversation(backendConversationId, selectedConnectionId);
      }
      if (historyMutationRef.current !== mutationId) return;

      setHistory((currentHistory) => {
        const updated = currentHistory.filter((item) => getHistoryEntryKey(item) !== entryKey);
        persistHistory(selectedConnectionId, updated);
        return updated;
      });

      const deletedActiveConversation = backendConversationId
        && conversationIdRef.current === backendConversationId;
      if (deletedActiveConversation || activeHistoryIdRef.current === entryKey) {
        resetActiveChat();
      }
    } catch (error) {
      if (historyMutationRef.current === mutationId) {
        setHistoryActionError(getApiErrorMessage(error, "Could not delete this conversation."));
      }
    } finally {
      if (historyMutationRef.current === mutationId) {
        setHistoryMutationKey(null);
      }
    }
  };

  const handleClearHistory = async () => {
    if (isQuerying || historyMutationKey || !selectedConnectionId) return;
    if (!window.confirm("Permanently delete all conversation history for this connection?")) return;

    const mutationId = historyMutationRef.current + 1;
    historyMutationRef.current = mutationId;
    setHistoryMutationKey("all");
    setHistoryActionError("");

    try {
      await clearAnalyticsConversations(selectedConnectionId);
      if (historyMutationRef.current !== mutationId) return;

      persistHistory(selectedConnectionId, []);
      setHistory([]);
      setHistoryMutationKey(null);
      resetActiveChat();
    } catch (error) {
      if (historyMutationRef.current === mutationId) {
        setHistoryActionError(getApiErrorMessage(error, "Could not clear conversation history."));
      }
    } finally {
      if (historyMutationRef.current === mutationId) {
        setHistoryMutationKey(null);
      }
    }
  };

  // Chart renderer
  const renderChart = (res) => {
    if (!res?.data?.rows?.length) return <p className="text-sm text-(--theme-text-muted) italic text-center py-8">No data to chart.</p>;
    // The backend explicitly returns chart: null when a chart wouldn't add
    // information (e.g. a plain list of names, or every value identical) —
    // respect that instead of defaulting to a bar chart of nothing useful.
    if (res.chart === null) {
      return <p className="text-sm text-(--theme-text-muted) italic text-center py-8">No chart to show for this result — see the Data tab for the full list.</p>;
    }

    const rows = res.data.rows;
    const chartType = res.chart?.type || "bar";
    const metricLabel = businessLabel(res.semanticMatch?.metric || "Value");
    const metricFormat = catalog.find((d) => d.name === res.semanticMatch?.dataset)?.metrics?.find((m) => m.name === res.semanticMatch?.metric)?.format || "number";

    if (chartType === "scorecard" || (rows.length === 1 && !rows[0]?.key && res.semanticMatch?.metric)) {
      return <Scorecard value={fmtValue(rows[0]?.value, metricFormat)} label={metricLabel} />;
    }

    const chartDataRaw = rows.slice(0, 20).map((r) => {
      let key = r.key;
      let value = r.value;
      if (key === undefined && value === undefined) {
        let textKey = null;
        let numKey = null;
        for (const k of Object.keys(r)) {
          const val = r[k];
          if (val !== null && val !== undefined && val !== "" && !isNaN(Number(val)) && typeof val !== "boolean") {
            if (!numKey) numKey = k;
          } else {
            if (!textKey) textKey = k;
          }
        }
        key = textKey ? r[textKey] : (numKey ? r[numKey] : Object.values(r)[0]);
        value = numKey ? r[numKey] : 0;
      }
      return { name: key ?? "—", value: Number(value ?? 0) };
    });
    const allNegative = chartDataRaw.length > 0 && chartDataRaw.every((d) => d.value < 0);
    const chartData = allNegative ? chartDataRaw.map(d => ({ ...d, value: Math.abs(d.value) })) : chartDataRaw;
    const formatXAxisTick = (val) => {
      const str = String(val ?? "");
      if (str.length > 15) {
        const parsed = Date.parse(str);
        if (!isNaN(parsed)) {
          const d = new Date(parsed);
          return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
        }
      }
      if (str.length > 20) {
        return str.substring(0, 17) + "...";
      }
      return str;
    };

    if (chartType === "line") return (
      <div className="h-80 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 72 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} angle={-35} textAnchor="end" tickFormatter={formatXAxisTick} />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={(v) => fmtValue(allNegative ? -v : v, metricFormat)} />
            <Tooltip labelFormatter={formatXAxisTick} formatter={(v) => [fmtValue(allNegative ? -v : v, metricFormat), metricLabel]} />
            <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />
            <Line type="monotone" dataKey="value" stroke={primaryColor} strokeWidth={2} dot={{ r: 3, fill: primaryColor }} activeDot={{ r: 5 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );

    // default bar
    return (
      <div className="h-80 mt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 72 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} angle={-35} textAnchor="end" tickFormatter={formatXAxisTick} />
            <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={(v) => fmtValue(allNegative ? -v : v, metricFormat)} />
            <Tooltip labelFormatter={formatXAxisTick} formatter={(v) => [fmtValue(allNegative ? -v : v, metricFormat), metricLabel]} />
            <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} />
            <Bar dataKey="value" fill={primaryColor} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  };

  // Result tabs content

  const renderChatMessages = () => (
    <div className="space-y-6">
      {messages.length === 0 && !isQuerying && (
        <div className="flex flex-col items-center justify-center text-center p-6 max-w-md mx-auto my-auto select-none min-h-[300px]">
          <h3 className="text-sm font-bold text-(--theme-text) mb-1.5">Query Semantic Layer</h3>
          <p className="text-xs text-(--theme-text-muted) mb-6 leading-relaxed">Enter questions about the connection's datasets to extract insights.</p>
          <div className="w-full space-y-2 text-left">
            <p className="text-[9px] font-extrabold text-(--theme-text-muted) uppercase tracking-widest mb-1.5 pl-1">Suggested Prompts</p>
            {suggestions.map((s, idx) => (
              <button key={idx} onClick={() => handleAskPrompt(s)} className="w-full flex items-center justify-between text-left text-xs px-4 py-3 bg-(--theme-card-bg) hover:bg-(--theme-container-bg) hover:text-(--theme-primary) rounded-xl border border-(--theme-border) hover:border-(--theme-primary) transition-all cursor-pointer group shadow-sm font-semibold text-(--theme-text)">
                <span className="flex-1 leading-normal pr-3">{s}</span>
                <ChevronRightIcon className="w-4 h-4 text-(--theme-text-muted) group-hover:text-teal-500 transform group-hover:translate-x-0.5 transition-all shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((msg) => {
        if (msg.role === ChatMessage.TYPING) {
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><BotIcon className="w-4.5 h-4.5" /></div>
              <div className="bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) px-4 py-3 shadow-sm"><div className="flex items-center gap-2"><svg className="w-5 h-5 animate-spin text-(--theme-primary)" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg><p className="text-xs font-bold text-(--theme-text-muted) animate-pulse">Thinking…</p></div></div>
            </div>
          );
        }
        if (msg.role === ChatMessage.USER) {
          return (
            <div key={msg.id} className="flex justify-end items-start gap-3 pl-12">
              <div className="max-w-[420px] bg-(--theme-card-bg) border border-(--theme-border) rounded-b-2xl rounded-tl-2xl px-4 py-3 shadow-sm text-right"><p className="text-[13px] font-medium text-(--theme-text) leading-snug whitespace-pre-wrap select-text">{msg.content}</p></div>
              <div className="shrink-0 my-auto ml-3"><div className="h-8 w-8 rounded-full overflow-hidden border border-(--theme-border) bg-(--theme-card-bg)"><img src={UserIcon} alt="User" className="h-full w-full object-cover" /></div></div>
            </div>
          );
        }
        
        const res = msg.result;

        // UNRECOGNIZED — guide the user with catalog-backed example wording.
        if (res?.mode === "unrecognized") {
          const guidedQueries = res.suggestedQueries || res.insight?.followUps || [];
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><HelpCircleIcon /></div>
              <div className="flex-1 min-w-0">
                <div className="bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) overflow-hidden shadow-md p-4 space-y-4">
                  <div>
                    <p className="font-bold text-sm text-(--theme-text)">Try a clearer question</p>
                    <p className="text-xs mt-1 leading-relaxed text-(--theme-text-muted)">{res.insight?.answer || msg.content}</p>
                  </div>
                  {guidedQueries.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-(--theme-text-muted) uppercase tracking-wider">Example wording</p>
                      {guidedQueries.map((query, idx) => (
                        <button
                          key={`${query}-${idx}`}
                          onClick={() => handleAskPrompt(query)}
                          disabled={isQuerying}
                          className="w-full text-left px-4 py-3 border border-(--theme-border) rounded-xl bg-(--theme-container-bg) hover:border-(--theme-primary) hover:text-(--theme-primary) transition-all text-xs font-semibold text-(--theme-text) cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {query}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        // Error
        if (msg.error && !msg.result) {
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-red-400 to-red-600 flex items-center justify-center shrink-0 shadow-md text-white"><AlertCircleIcon className="w-4 h-4 text-white" /></div>
              <div className="bg-(--theme-card-bg) border border-red-200 rounded-2xl px-4 py-3 shadow-md text-sm text-red-700 max-w-[600px]"><p className="font-bold text-xs mb-1">Pipeline Error</p><p className="text-xs font-semibold leading-normal">{msg.content}</p></div>
            </div>
          );
        }

        // AMBIGUOUS
        if (res?.mode === "AMBIGUOUS" || res?.mode === "ambiguous") {
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><BotIcon className="w-4.5 h-4.5" /></div>
              <div className="flex-1 min-w-0"><div className="bg-(--theme-card-bg) rounded-2xl border border-amber-200 overflow-hidden shadow-md p-4 space-y-4">
                <div className="flex items-start gap-2 text-sm text-amber-800"><AlertCircleIcon /><div><p className="font-bold">More detail needed</p><p className="text-xs mt-1">{res.message}</p></div></div>
                {(res.options?.tables || res.candidateTables || []).length > 0 && <div className="space-y-2"><p className="text-[10px] font-bold text-(--theme-text-muted) uppercase tracking-wider">Choose one:</p>
                  {(res.options?.tables || res.candidateTables || []).map((t) => (
                    <button key={t.name || t} onClick={() => handleAskPrompt(res.question || msg.content, t.name || t)} disabled={isQuerying} className="w-full text-left px-4 py-3 border border-(--theme-border) rounded-xl hover:border-teal-400 hover:bg-teal-50/50 transition-all text-sm font-medium cursor-pointer"><span className="font-bold text-(--theme-text)">{t.label || t.name || t}</span><span className="text-(--theme-text-muted) ml-2 font-mono text-xs">{t.name || t}</span>{t.columnCount && <span className="text-(--theme-text-muted) text-xs ml-2">({t.columnCount} columns)</span>}</button>
                  ))}
                </div>}
              </div></div>
            </div>
          );
        }

        // CLARIFICATION REQUIRED
        if (res?.mode === "clarification_required") {
          const choices = res.clarification?.choices || [];
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-amber-400 to-orange-500 flex items-center justify-center shrink-0 shadow-md text-white"><HelpCircleIcon /></div>
              <div className="flex-1 min-w-0">
                <div className="bg-(--theme-card-bg) rounded-2xl border border-amber-200 overflow-hidden shadow-md p-4 space-y-4">
                  <div className="flex items-start gap-2 text-sm text-amber-900">
                    <AlertCircleIcon />
                    <div>
                      <p className="font-bold">Clarification needed</p>
                      <p className="text-xs mt-1 leading-relaxed whitespace-pre-wrap">{res.clarification?.message || res.insight?.answer}</p>
                    </div>
                  </div>
                  {choices.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-[10px] font-bold text-(--theme-text-muted) uppercase tracking-wider">Choose one:</p>
                      {choices.map((choice, idx) => (
                        <button
                          key={`${choice.value || choice.label}-${idx}`}
                          onClick={() => handleAskPrompt(choice.rewrite || choice.label)}
                          disabled={isQuerying}
                          className="w-full text-left px-4 py-3 border border-amber-200 rounded-xl hover:border-amber-400 hover:bg-amber-50/70 transition-all text-sm font-semibold cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <span className="text-(--theme-text)">{choice.label}</span>
                          {choice.rewrite && <span className="block mt-1 text-[11px] font-mono text-(--theme-text-muted) truncate">{choice.rewrite}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        }

        // NEEDS_KPI
        if (res?.mode === "needs-kpi") {
          return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><BotIcon className="w-4.5 h-4.5" /></div>
              <div className="flex-1 min-w-0">
                <div className="bg-(--theme-card-bg) rounded-2xl border border-rose-200 overflow-hidden shadow-md p-4 space-y-4">
                  <div className="flex items-start gap-2 text-sm text-rose-800">
                    <AlertCircleIcon />
                    <div>
                      <p className="font-bold">Missing Cross-Table KPI</p>
                      <p className="text-xs mt-1 leading-relaxed">{res.message || "This query requires joining multiple tables without a defined KPI. Please define a KPI to enable cross-table analytics."}</p>
                    </div>
                  </div>
                  {res.suggestedTables && res.suggestedTables.length > 1 && (
                    <div className="mt-2 text-xs font-mono text-rose-700 bg-rose-50 p-2 rounded">
                      Involved tables: {res.suggestedTables.join(", ")}
                    </div>
                  )}
                  <div className="pt-2 border-t border-rose-100">
                    <p className="text-[10px] text-(--theme-text-muted) font-semibold uppercase tracking-wider mb-2">Next Step</p>
                    <div className="text-xs font-bold px-4 py-2.5 bg-rose-50 text-rose-700 rounded-xl border border-rose-200 shadow-sm flex items-center gap-2 max-w-fit">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      Select the "KPI Metrics" tab to define this metric.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        // GREETING
        if (res?.mode === "greeting") {
           return (
            <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
              <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><BotIcon className="w-4.5 h-4.5" /></div>
              <div className="bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) px-4 py-3 shadow-md max-w-[600px] space-y-3"><p className="text-sm text-(--theme-text) leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                {res.insight?.followUps?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">{res.insight.followUps.map((q, i) => (<button key={i} onClick={() => handleAskPrompt(q)} disabled={isQuerying} className="text-xs px-3 py-1.5 rounded-xl border border-(--theme-border) text-(--theme-primary) hover:text-white bg-(--theme-container-bg) hover:bg-(--theme-primary) font-semibold shadow-sm cursor-pointer">{q}</button>))}</div>
                )}
              </div>
            </div>
           );
        }

        return (
          <div key={msg.id} className="flex justify-start items-start gap-3 pr-12">
            <div className="w-8.5 h-8.5 rounded-xl bg-linear-to-tr from-(--theme-primary) to-(--theme-accent) flex items-center justify-center shrink-0 shadow-md text-white"><BotIcon className="w-4.5 h-4.5" /></div>
            <div className="flex-1 min-w-0"><AssistantResultCard msg={msg} onAskFollowUp={handleAskPrompt} isQuerying={isQuerying} renderChart={renderChart} selectedQueryMode={msg.queryMode} /></div>
          </div>
        );
      })}
    </div>
  );
  // Render
  return (
    <div className="w-full flex flex-col lg:flex-row gap-6 text-(--theme-text)">

      {/* ── LEFT: CHAT INTERFACE ── */}
      <div className="flex-1 w-full flex flex-col bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) overflow-hidden relative shadow-sm h-[580px] sm:h-[640px] lg:h-[700px]">

        {/* Chat Control Header */}
        <div className="flex-none border-b border-(--theme-border) px-4 py-3 bg-(--theme-card-bg) flex items-center justify-between flex-wrap gap-2 z-10 shadow-sm">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold text-(--theme-text) flex items-center gap-1.5">
              <BotIcon className="w-4.5 h-4.5 text-(--theme-primary)" />
              <span>Analytics AI Chat</span>
            </h2>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-semibold text-(--theme-text-muted) bg-(--theme-container-bg) px-2 py-0.5 rounded-lg border border-(--theme-border) shadow-sm flex items-center gap-1">
                <DatabaseIcon className="w-3 h-3 text-(--theme-text-muted)" />
                {connections.find(c => c.id === selectedConnectionId)?.name || (selectedConnectionId ? "Loading..." : "Select connection")}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleNewChat}
              disabled={messages.length === 0 && !isQuerying}
              className="px-3 py-1.5 text-xs font-semibold bg-(--theme-surface) border border-(--theme-border) text-(--theme-text) hover:text-(--theme-primary) hover:border-(--theme-primary) hover:bg-(--theme-primary)/5 active:bg-(--theme-primary)/10 rounded-xl transition-all shadow-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              New Chat
            </button>
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              title="Toggle History"
              className="p-1.5 hover:bg-(--theme-container-bg) rounded-xl border border-(--theme-border) text-(--theme-text-muted) hover:text-(--theme-primary) active:scale-95 transition-all duration-200 cursor-pointer"
            >
              {showSidebar ? <PanelCloseIcon /> : <PanelOpenIcon />}
            </button>
          </div>
        </div>

        {/* Scrollable Conversation Content Area */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 bg-(--theme-container-bg) space-y-6 scrollbar-thin">

          {renderChatMessages()}
          <div ref={chatEndRef} />
        </div>

        {/* Anchored bottom input block */}
        <div className="flex-none p-4 border-t border-(--theme-border) bg-(--theme-card-bg)">
          {/*
          <div className="flex gap-2 mb-2 border-b border-(--theme-border) p-1 rounded-t-lg bg-(--theme-container-bg)">
            <button 
              onClick={() => setQueryMode("simple")}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${queryMode === "simple" ? "bg-(--theme-card-bg) shadow text-(--theme-primary)" : "text-(--theme-text-muted)"}`}
            >
              Simple Query (Tables & Columns)
            </button>
            <button 
              onClick={() => setQueryMode("kpi")}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${queryMode === "kpi" ? "bg-(--theme-card-bg) shadow text-(--theme-primary)" : "text-(--theme-text-muted)"}`}
            >
              KPI Metric Query
            </button>
          </div>
          */}
          <BottomPromptBar
            loading={isQuerying || !!historyMutationKey}
            onSend={(q) => handleAskPrompt(q)}
          />
        </div>

      </div>

      {/* ── RIGHT: COLLAPSIBLE SIDEBAR ── */}
      {showSidebar && (
        <div className="w-full lg:w-80 shrink-0 flex flex-col bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) shadow-sm overflow-hidden h-[400px] lg:h-[700px]">

          {/* History-only sidebar header */}
          <div className="flex border-b border-(--theme-border) bg-(--theme-container-bg)">
            <div className="flex-1 py-3 text-center text-xs font-bold border-b-2 border-(--theme-primary) text-(--theme-primary) flex items-center justify-center gap-1.5">
              <HistoryIcon className="w-3.5 h-3.5" />
              History
              {history.length > 0 && (
                <span className="text-[9px] bg-slate-200 text-(--theme-text) px-1.5 py-0.2 rounded-full font-bold ml-0.5">
                  {history.length}
                </span>
              )}
            </div>
          </div>

          {/* Sidebar Body */}
          <div className="flex-1 overflow-y-auto p-3.5 scrollbar-thin">

            <div className="space-y-3">
                {history.length > 0 ? (
                  <>
                    <div className="flex justify-end mb-1">
                      <button
                        onClick={handleClearHistory}
                        disabled={isQuerying || !!historyMutationKey}
                        className={`text-[10px] text-red-500 hover:text-red-700 flex items-center gap-1 transition-all duration-200 font-bold bg-red-50/50 border border-red-100 hover:bg-red-100 px-2 py-1 rounded-lg ${
                          isQuerying || historyMutationKey ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                        }`}
                      >
                        <TrashIcon />
                        {historyMutationKey === "all" ? "Clearing..." : "Clear History"}
                      </button>
                    </div>
                    {historyActionError && (
                      <p className="text-[10px] text-red-600 bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">
                        {historyActionError}
                      </p>
                    )}
                    <div className="space-y-2">
                      {history.map((h, i) => (
                        <div
                          key={getHistoryEntryKey(h) || i}
                          className="p-3 bg-(--theme-container-bg) hover:bg-(--theme-container-bg) rounded-xl border border-(--theme-border) hover:border-(--theme-primary) transition-all duration-200 group flex items-start justify-between gap-2 shadow-sm"
                        >
                          <div
                            className="flex-1 cursor-pointer min-w-0"
                            onClick={() => loadHistory(h)}
                          >
                            <p className="text-xs font-bold text-(--theme-text) group-hover:text-(--theme-primary) transition duration-200 leading-snug line-clamp-2 select-text">
                              {h.question}
                            </p>
                            <div className="flex items-center gap-1.5 mt-1.5">
                              <span className="text-[8px] font-extrabold tracking-wide uppercase px-1.5 py-0.2 rounded border bg-purple-50 text-purple-600 border-purple-100">
                                Autonomous AI
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => handleAskPrompt(h.question)}
                              disabled={isQuerying || !!historyMutationKey}
                              title="Run query again"
                              className={`p-1 hover:bg-(--theme-card-bg) rounded-lg border border-transparent hover:border-(--theme-border) text-(--theme-text-muted) hover:text-(--theme-primary) active:scale-95 transition-all cursor-pointer ${
                                isQuerying || historyMutationKey ? "opacity-50 pointer-events-none" : ""
                              }`}
                            >
                              <PlayIcon />
                            </button>
                            <button
                              onClick={() => handleDeleteHistoryItem(h)}
                              disabled={isQuerying || !!historyMutationKey}
                              title="Delete conversation"
                              className={`p-1 hover:bg-red-50 rounded-lg border border-transparent hover:border-red-100 active:scale-95 transition-all cursor-pointer ${
                                isQuerying || historyMutationKey ? "opacity-50 pointer-events-none" : ""
                              }`}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="py-12 flex flex-col items-center text-center text-(--theme-text-muted)">
                    <HistoryIcon className="w-10 h-10 mb-3 opacity-30 text-(--theme-text-muted)" />
                    <p className="text-xs font-semibold text-(--theme-text-muted) max-w-[200px] leading-normal">
                      Recent questions will appear in history.
                    </p>
                  </div>
                )}
            </div>

          </div>

        </div>
      )}

    </div>
  );
};

export default AnalyticsAssistant;

export const AssistantResultCard = ({ msg, onAskFollowUp, isQuerying, renderChart, selectedQueryMode }) => {
  const [activeDebugTab, setActiveDebugTab] = useState(null);
  const res = msg.result;
  if (!res) return null;
  const isControlledStop = res.mode === "clarification_required" || res.mode === "data_quality_issue";
  const visibleCorrections = (res.appliedCorrections || []).filter((correction) =>
    correction.startsWith("Interpreted date ")
    || correction.startsWith("Ignored unrequested constraints"),
  );

  // Render Table (extracted from previous "Data" tab)
  const renderTable = () => {
    if (!res.data?.rows?.length) return <p className="text-xs text-(--theme-text-muted) italic py-4 text-center">No data rows returned.</p>;
    return (
      <div className="space-y-3 mt-4">
        {visibleCorrections.length > 0 && (
          <div className="p-2 rounded-lg bg-amber-50/30 border border-amber-100 text-[10px] text-amber-800 font-bold">
            Result is constrained: {visibleCorrections.join(" | ")}
          </div>
        )}
        <div className="overflow-x-auto border border-(--theme-border) rounded-xl">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-(--theme-container-bg) border-b border-(--theme-border)">
                {Object.keys(res.data.rows[0]).map((k) => (
                  <th key={k} className="text-left px-3 py-2.5 font-bold text-(--theme-text-secondary) tracking-wider uppercase text-[9px]">{resultHeaderLabel(k, res.plan || res.semanticMatch)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {res.data.rows.slice(0, 50).map((row, i) => (
                <tr key={i} className="hover:bg-(--theme-container-bg) border-b border-(--theme-border) last:border-0 transition-colors">
                  {Object.values(row).map((v, j) => (
                    <td key={j} className="px-3 py-2 text-(--theme-text) font-mono">{String(v ?? "—")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(res.data?.rowCount || 0) > 50 && (
          <p className="text-[10px] text-(--theme-text-muted) italic text-center">Showing 50 of {res.data.rowCount} rows</p>
        )}
      </div>
    );
  };

  const hasNumericData = () => {
    if (isControlledStop) return false;
    if (res.semanticMatch?.metric) return true; // Aggregation query
    if (!res.data?.rows?.length) return false;
    const firstRow = res.data.rows[0];
    if (firstRow.key !== undefined && firstRow.value !== undefined) return true; // Pre-mapped format
    // Dynamically check if any column contains numeric values
    return Object.values(firstRow).some(v => v !== null && v !== undefined && v !== "" && !isNaN(Number(v)) && typeof v !== "boolean");
  };

  const canChart = hasNumericData();

  const toggleDebugTab = (tab) => {
    setActiveDebugTab((previous) => previous === tab ? null : tab);
  };


  return (
    <div className="bg-(--theme-card-bg) rounded-2xl border border-(--theme-border) overflow-hidden shadow-md flex flex-col mt-2">
      <div className="p-4 sm:p-5 space-y-6 text-(--theme-text)">
        
        {/* 1. Core Answer */}
        <div>
          {/* Mode badge */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-purple-50 text-purple-700 border-purple-100">
              Autonomous AI
            </span>
            {selectedQueryMode === "simple" && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-100">
                Simple Query
              </span>
            )}
            {selectedQueryMode === "kpi" && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-100">
                KPI Metric Query
              </span>
            )}
            {res.kpiUsed && (
              <span className="text-[9px] font-bold tracking-wider px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 flex items-center gap-1 shadow-sm" title="KPI Used">
                <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                {businessLabel(res.kpiUsed)}
              </span>
            )}
            {res.fromCache && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-sky-50 text-sky-700 border-sky-200 shadow-sm flex items-center gap-1">
                <svg className="w-3 h-3 text-sky-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                Cache Hit
              </span>
            )}
            {res.mode === "clarification_required" && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-100 flex items-center gap-1">
                <HelpCircleIcon /> Clarification Needed
              </span>
            )}
            {res.mode === "data_quality_issue" && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-100 flex items-center gap-1">
                <AlertCircleIcon /> Data Quality Issue
              </span>
            )}
            {res.success === false && !isControlledStop && (
              <span className="text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded-full border bg-red-50 text-red-700 border-red-100 flex items-center gap-1">
                <AlertCircleIcon /> Execution Failed
              </span>
            )}
          </div>

          {/* Applied corrections */}
          {visibleCorrections.length > 0 && (
            <div className="mb-3 p-4 rounded-xl bg-(--theme-container-bg) border border-(--theme-border) text-xs shadow-sm flex flex-col gap-1.5">
              <div className="flex items-center gap-2 font-extrabold text-(--theme-text)">
                <ZapIcon />
                <span>Query Constraints Applied</span>
              </div>
              <div className="text-(--theme-text-secondary) leading-relaxed font-semibold pl-6">
                <ul className="list-disc pl-3 space-y-1 text-(--theme-text)">
                  {visibleCorrections.map((corr, idx) => (
                    <li key={idx}>{corr}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {/* Main answer text */}
          <div className="px-4 py-3.5 rounded-xl bg-linear-to-r from-(--theme-container-bg) to-(--theme-card-bg) border border-(--theme-border) shadow-sm">
            <p className="text-(--theme-text) font-semibold text-sm leading-relaxed whitespace-pre-wrap">{res.insight?.answer || "No answer generated."}</p>
          </div>
          
          {/* Drivers */}
          {res.insight?.drivers?.length > 0 && (
            <div className="bg-(--theme-card-bg) p-3 rounded-xl border border-(--theme-border) shadow-sm mt-3">
              <p className="text-[10px] font-extrabold text-(--theme-text-muted) uppercase tracking-wider mb-2">Key Drivers</p>
              <ul className="space-y-1.5">
                {res.insight.drivers.map((d, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-xs font-semibold text-(--theme-text)">
                    <span className="shrink-0 mt-0.5 w-4.5 h-4.5 rounded-full bg-teal-50 text-teal-700 flex items-center justify-center text-[10px] font-extrabold border border-teal-100/60 shadow-sm">{i + 1}</span>
                    <span className="flex-1 pt-0.5">{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Core Visuals: Chart & Table */}
          {res.mode === "data_quality_issue" ? (
            <div className="mt-4 p-3 rounded-xl bg-amber-50/60 border border-amber-100 text-xs font-semibold text-amber-900 shadow-sm">
              Chart and table are hidden for this answer because the requested group-by field returned only blank or null values.
            </div>
          ) : canChart ? (
            // Aggregation / Numeric Mode: Show Chart AND Table
            <div className="mt-4">
              <div className="mb-4 bg-(--theme-container-bg) border border-(--theme-border) rounded-xl p-4 shadow-sm">
                {renderChart(res)}
              </div>
              <div>
                <p className="text-[10px] font-extrabold text-(--theme-text-muted) uppercase tracking-wider">Tabular Data</p>
                {renderTable()}
              </div>
            </div>
          ) : (
            // Pure Text / List Mode: Show ONLY Table
            <div className="mt-4">
              <p className="text-[10px] font-extrabold text-(--theme-text-muted) uppercase tracking-wider">Tabular Data</p>
              {renderTable()}
            </div>
          )}
          
          {/* Phase 5: MULTI_KPI View */}
          {res.queryMode === 'MULTI_KPI' && res.results?.length > 0 && (
            <div className="mt-4 border-t border-(--theme-border) pt-4">
              <h3 className="text-xs font-bold text-(--theme-text) mb-3 uppercase tracking-wider">KPI Comparison View</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {res.results.map((r, idx) => {
                   const kpi = r.kpisUsed?.find(k => k.name === r.semanticMatch?.metric);
                   return (
                     <div key={idx} className="p-4 border border-(--theme-border) rounded-xl bg-(--theme-card-bg) flex flex-col">
                       <div className="mb-3 text-center border-b border-(--theme-border) pb-2">
                         <p className="text-sm font-extrabold text-(--theme-primary)">{r.semanticMatch?.metric || 'KPI'}</p>
                         {kpi && <code className="text-[9px] text-teal-600 font-mono mt-1 block">{kpi.expressionSql}</code>}
                       </div>
                       <div className="flex-1">
                         {renderChart(r)}
                       </div>
                     </div>
                   );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Development response inspector — restored from the committed UI. */}
        <div className="pt-4 mt-2 border-t border-(--theme-border)">
          <div className="flex flex-wrap gap-2 mb-3" role="tablist" aria-label="Query response details">
            {[
              { id: "data", label: "Data" },
              { id: "sql", label: "SQL Query" },
              { id: "raw", label: "Raw JSON" },
              { id: "trace", label: "Execution Trace" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeDebugTab === tab.id}
                onClick={() => toggleDebugTab(tab.id)}
                className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                  activeDebugTab === tab.id
                    ? "bg-(--theme-primary) text-white border-(--theme-primary) shadow-sm"
                    : "bg-(--theme-container-bg) text-(--theme-text-muted) border-(--theme-border) hover:border-(--theme-border-dark) hover:text-(--theme-text)"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeDebugTab === "data" && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200" role="tabpanel" aria-label="Data">
              {renderTable()}
            </div>
          )}
          {activeDebugTab === "sql" && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-3" role="tabpanel" aria-label="SQL Query">
              <pre className="bg-slate-900 text-emerald-400 rounded-xl p-4 text-xs overflow-x-auto font-mono leading-relaxed whitespace-pre-wrap shadow-inner max-h-96 select-all">
                {res.sql?.sql || "No SQL generated."}
              </pre>
              {Array.isArray(res.sql?.params) && res.sql.params.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[9px] font-extrabold uppercase tracking-wider text-(--theme-text-muted)">Parameters</p>
                  <pre className="bg-slate-900 text-amber-300 rounded-xl p-4 text-xs overflow-x-auto font-mono leading-relaxed max-h-40 select-all shadow-inner">
                    {JSON.stringify(res.sql.params, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
          {activeDebugTab === "raw" && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200" role="tabpanel" aria-label="Raw JSON">
              <pre className="bg-slate-900 text-slate-300 rounded-xl p-4 text-xs overflow-x-auto font-mono leading-relaxed max-h-96 select-all shadow-inner">
                {JSON.stringify(res, null, 2)}
              </pre>
            </div>
          )}
          {activeDebugTab === "trace" && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200 space-y-2 max-h-96 overflow-y-auto pr-1 bg-(--theme-container-bg) p-3 rounded-xl border border-(--theme-border) shadow-inner" role="tabpanel" aria-label="Execution Trace">
              {(res.trace || []).map((step, index) => (
                <div key={`${step.step || "step"}-${index}`} className="flex items-start gap-3 px-3 py-2 rounded-lg border border-(--theme-border) bg-(--theme-card-bg)">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${step.status === "completed" ? "bg-green-500" : step.status === "error" ? "bg-rose-500" : "bg-amber-400 animate-pulse"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-(--theme-text) break-all">{step.step || `Step ${index + 1}`}</span>
                      {step.attempt && <span className="text-[9px] text-(--theme-text-muted)">attempt {step.attempt}</span>}
                      {Number.isFinite(step.durationMs) && <span className="text-[9px] text-(--theme-text-muted)">{step.durationMs} ms</span>}
                    </div>
                    {step.detail && <p className="mt-1 text-[10px] leading-relaxed text-(--theme-text-muted)">{step.detail}</p>}
                  </div>
                  <span className={`text-[9px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${step.status === "completed" ? "bg-green-50 text-green-700 border-green-100" : step.status === "error" ? "bg-red-50 text-red-700 border-red-100" : "bg-amber-50 text-amber-700 border-amber-100"}`}>
                    {step.status || "unknown"}
                  </span>
                </div>
              ))}
              {(!res.trace || res.trace.length === 0) && (
                <p className="text-xs text-(--theme-text-muted) italic text-center py-6">No trace pipeline execution steps available.</p>
              )}
            </div>
          )}
        </div>

        {/* Follow-ups */}
        {res.insight?.followUps?.length > 0 && (
          <div className="pt-2">
            <p className="text-[10px] font-bold text-(--theme-text-muted) uppercase tracking-wide mb-2">Suggested Follow-ups</p>
            <div className="flex flex-wrap gap-1.5">
              {res.insight.followUps.map((q, i) => (
                <button
                  key={i}
                  onClick={() => onAskFollowUp(q)}
                  disabled={isQuerying}
                  className={`text-xs px-3 py-1.5 rounded-xl border border-(--theme-border) text-(--theme-primary) hover:text-white bg-(--theme-container-bg) hover:bg-(--theme-primary) font-semibold active:scale-95 transition-all duration-200 shadow-sm cursor-pointer ${isQuerying ? "opacity-50 pointer-events-none" : ""}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Assumptions */}
        {res.semanticMatch?.assumptions?.length > 0 && (
          <div className="px-3 py-2 rounded-lg bg-amber-50/50 border border-amber-100 text-[11px] text-amber-700 font-semibold flex items-center gap-1.5 mt-2">
            <HelpCircleIcon />
            <span><span className="font-bold">Assumptions:</span> {res.semanticMatch.assumptions.join(" · ")}</span>
          </div>
        )}

      </div>
    </div>
  );
};
