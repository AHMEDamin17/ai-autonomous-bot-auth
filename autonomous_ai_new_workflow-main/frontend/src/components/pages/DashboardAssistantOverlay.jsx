import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { History, Plus, Trash2, X } from "lucide-react";
import {
  askAssistant,
  deleteAssistantConversation,
  getApiErrorMessage,
} from "../../api/services";
import RenderChart from "../charts/RenderChart";
import InlineState from "../common/InlineState";
import { toSafeText } from "../../utils/safeText";

const AssistantResultCard = React.lazy(() =>
  import("./semanticLayer/tabs/AnalyticsAssistant").then((module) => ({
    default: module.AssistantResultCard,
  })));

const HISTORY_KEY = "dashboard_ai_history_v1";
const MAX_HISTORY = 10;
const MAX_HISTORY_MESSAGES = 20;

function newMessageId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry) => (
          typeof entry?.conversationId === "string"
          && Array.isArray(entry?.messages)
        )).slice(0, MAX_HISTORY)
      : [];
  } catch {
    return [];
  }
}

function upsertHistoryEntry(history, conversationId, messages, title) {
  const entry = {
    conversationId,
    title: toSafeText(title, "Dashboard conversation").slice(0, 100),
    messages: messages.slice(-MAX_HISTORY_MESSAGES),
    updatedAt: new Date().toISOString(),
  };
  return [
    entry,
    ...history.filter((item) => item.conversationId !== conversationId),
  ].slice(0, MAX_HISTORY);
}

function ConnectionSelectionCard({ result, disabled, onSelect }) {
  const choices = Array.isArray(result.connectionChoices)
    ? result.connectionChoices
    : [];
  return (
    <div className="rounded-2xl border border-(--theme-border) bg-(--theme-card-bg) p-5 shadow-md">
      <p className="text-sm font-bold text-(--theme-text)">Choose a data source</p>
      <p className="mt-1 text-xs font-medium leading-relaxed text-(--theme-text-muted)">
        {toSafeText(result.insight?.answer, "More than one semantic-model source may answer this question.")}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {choices.map((choice) => (
          <button
            key={choice.connectionId}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(choice, result)}
            className="rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4 text-left transition-colors hover:border-(--theme-primary) disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span className="block text-sm font-bold text-(--theme-text)">
              {toSafeText(choice.label, "Approved source")}
            </span>
            <span className="mt-1 block text-xs font-medium leading-relaxed text-(--theme-text-muted)">
              {toSafeText(choice.context)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function DashboardAssistantOverlay({
  onClose,
  onLoadingChange,
  open,
  request,
}) {
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [history, setHistory] = useState(loadHistory);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [showHistory, setShowHistory] = useState(true);
  const handledRequestRef = useRef(null);
  const chatEndRef = useRef(null);

  const latestAnsweredConnection = useMemo(() => {
    const lastAnswer = [...messages].reverse().find(
      (message) => message.role === "assistant"
        && message.result?.sourceConnection,
    );
    return lastAnswer?.result?.sourceConnection || null;
  }, [messages]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    if (open) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages, loading, open]);

  const rememberConversation = useCallback((
    nextConversationId,
    nextMessages,
    title,
  ) => {
    if (!nextConversationId) return;
    setHistory((current) => upsertHistoryEntry(
      current,
      nextConversationId,
      nextMessages,
      title,
    ));
  }, []);

  const submitQuestion = useCallback(async (rawQuestion, options = {}) => {
    const question = String(rawQuestion || "").trim();
    if (!question || loading) return;

    const baseMessages = options.skipUserEcho
      ? messages
      : [
          ...messages,
          {
            id: newMessageId(),
            role: "user",
            content: question,
          },
        ];
    setMessages(baseMessages);
    setPrompt("");
    setLoading(true);

    try {
      const result = await askAssistant(question, {
        conversationId,
        selectedConnectionId: options.selectedConnectionId,
        reroute: options.reroute,
        mode: "auto",
      });
      const resultWithUiContext = {
        ...result,
        _rerouteRequested: Boolean(options.reroute),
      };
      const nextMessages = [
        ...baseMessages,
        {
          id: newMessageId(),
          role: "assistant",
          result: resultWithUiContext,
        },
      ];
      const nextConversationId = result.conversationId || conversationId;
      setMessages(nextMessages);
      if (nextConversationId) {
        setConversationId(nextConversationId);
        rememberConversation(nextConversationId, nextMessages, question);
      }
    } catch (error) {
      const errorMessage = getApiErrorMessage(
        error,
        "The Dashboard assistant could not answer this question.",
      );
      setMessages([
        ...baseMessages,
        {
          id: newMessageId(),
          role: "assistant",
          result: {
            success: false,
            mode: "error",
            question,
            insight: {
              answer: errorMessage,
              drivers: [],
              followUps: [],
            },
            chart: null,
            data: { rowCount: 0, rows: [] },
            sql: { dialect: "none", sql: "-- Request failed", params: [] },
            trace: [{
              step: "dashboard_request",
              status: "error",
              detail: errorMessage,
            }],
          },
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [conversationId, loading, messages, rememberConversation]);

  useEffect(() => {
    if (!request || handledRequestRef.current === request.id) return;
    handledRequestRef.current = request.id;
    void submitQuestion(request.question);
  }, [request, submitQuestion]);

  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setPrompt("");
  };

  const openHistoryEntry = (entry) => {
    if (loading) return;
    setConversationId(entry.conversationId);
    setMessages(entry.messages);
  };

  const removeHistoryEntry = async (entry) => {
    if (loading) return;
    try {
      await deleteAssistantConversation(entry.conversationId);
    } catch {
      // Expired server history can still be removed from this browser.
    }
    setHistory((current) => current.filter(
      (item) => item.conversationId !== entry.conversationId,
    ));
    if (conversationId === entry.conversationId) {
      startNewConversation();
    }
  };

  const handleConnectionSelection = (choice, result) => {
    void submitQuestion(result.question, {
      selectedConnectionId: choice.connectionId,
      reroute: Boolean(result._rerouteRequested),
      skipUserEcho: true,
    });
  };

  const handleReroute = (result) => {
    void submitQuestion(result.question, {
      reroute: true,
      skipUserEcho: true,
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-3 sm:p-6 md:pl-24">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Dashboard AI conversation"
        className="flex h-[min(860px,92vh)] w-full max-w-7xl flex-col overflow-hidden rounded-2xl border border-(--theme-border) bg-(--theme-container-bg) shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-(--theme-border) bg-(--theme-card-bg) px-4 py-3 sm:px-5">
          <div>
            <p className="text-sm font-bold text-(--theme-text)">AI Insights</p>
            <p className="text-[11px] font-medium text-(--theme-text-muted)">
              {latestAnsweredConnection
                ? `Answered from ${toSafeText(latestAnsweredConnection.label)}`
                : "Ask across your approved data sources"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHistory((current) => !current)}
              className="rounded-lg border border-(--theme-border) p-2 text-(--theme-text-muted) hover:text-(--theme-primary)"
              title="Conversation history"
            >
              <History className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={startNewConversation}
              disabled={loading}
              className="rounded-lg border border-(--theme-border) p-2 text-(--theme-text-muted) hover:text-(--theme-primary) disabled:opacity-50"
              title="New conversation"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-(--theme-border) p-2 text-(--theme-text-muted) hover:text-(--theme-text)"
              title="Close"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {showHistory && (
            <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-(--theme-border) bg-(--theme-card-bg) p-3 md:block">
              <p className="px-1 text-[10px] font-extrabold uppercase tracking-wider text-(--theme-text-muted)">
                Conversation history
              </p>
              <div className="mt-3 space-y-2">
                {history.map((entry) => (
                  <div
                    key={entry.conversationId}
                    className={`group flex items-start gap-1 rounded-xl border p-2 ${
                      entry.conversationId === conversationId
                        ? "border-(--theme-primary) bg-(--theme-container-bg)"
                        : "border-(--theme-border) bg-(--theme-surface)"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => openHistoryEntry(entry)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-xs font-bold text-(--theme-text)">
                        {toSafeText(entry.title, "Conversation")}
                      </span>
                      <span className="mt-1 block text-[10px] font-medium text-(--theme-text-muted)">
                        {new Date(entry.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHistoryEntry(entry)}
                      className="rounded p-1 text-(--theme-text-muted) opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                      title="Delete conversation"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                ))}
                {history.length === 0 && (
                  <InlineState
                    type="empty"
                    title="No conversations yet"
                    message="Your routed questions will appear here."
                    className="px-2"
                  />
                )}
              </div>
            </aside>
          )}

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
              {messages.length === 0 && !loading && (
                <div className="mx-auto flex min-h-full max-w-md flex-col items-center justify-center text-center">
                  <p className="text-sm font-bold text-(--theme-text)">
                    How can I help you today?
                  </p>
                  <p className="mt-2 text-xs font-medium leading-relaxed text-(--theme-text-muted)">
                    Ask a question from the company Dashboard. Connection routing happens automatically.
                  </p>
                </div>
              )}

              {messages.map((message) => {
                if (message.role === "user") {
                  return (
                    <div key={message.id} className="flex justify-end pl-10">
                      <div className="max-w-xl rounded-2xl rounded-tr-sm border border-(--theme-border) bg-(--theme-card-bg) px-4 py-3 shadow-sm">
                        <p className="whitespace-pre-wrap text-sm font-medium text-(--theme-text)">
                          {toSafeText(message.content)}
                        </p>
                      </div>
                    </div>
                  );
                }

                const result = message.result;
                if (result?.mode === "connection_selection_required") {
                  return (
                    <ConnectionSelectionCard
                      key={message.id}
                      result={result}
                      disabled={loading}
                      onSelect={handleConnectionSelection}
                    />
                  );
                }

                return (
                  <div key={message.id} className="space-y-2">
                    {result?.sourceConnection && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-(--theme-border) bg-(--theme-card-bg) px-3 py-2">
                        <p className="text-xs font-bold text-(--theme-text)">
                          Answered from {toSafeText(result.sourceConnection.label)}
                        </p>
                        <button
                          type="button"
                          onClick={() => handleReroute(result)}
                          disabled={loading}
                          className="text-xs font-bold text-(--theme-primary) hover:underline disabled:opacity-50"
                        >
                          Wrong source? Re-route
                        </button>
                      </div>
                    )}
                    <Suspense
                      fallback={(
                        <InlineState
                          type="loading"
                          title="Loading answer"
                          message="Preparing the analytics result."
                        />
                      )}
                    >
                      <AssistantResultCard
                        msg={message}
                        onAskFollowUp={submitQuestion}
                        isQuerying={loading}
                        renderChart={(response) => (
                          <RenderChart responseData={response} />
                        )}
                        selectedQueryMode="auto"
                      />
                    </Suspense>
                  </div>
                );
              })}

              {loading && (
                <InlineState
                  type="loading"
                  title="Generating response"
                  message="Selecting the approved source and running analytics."
                />
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="border-t border-(--theme-border) bg-(--theme-card-bg) p-3 sm:p-4">
              <div className="flex items-end gap-2 rounded-xl border border-(--theme-border) bg-(--theme-surface) p-2">
                <textarea
                  value={prompt}
                  disabled={loading}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submitQuestion(prompt);
                    }
                  }}
                  placeholder={loading ? "Generating response…" : "Ask a follow-up"}
                  className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-(--theme-text) outline-none placeholder:text-(--theme-text-muted)"
                />
                <button
                  type="button"
                  disabled={!prompt.trim() || loading}
                  onClick={() => submitQuestion(prompt)}
                  className="rounded-lg bg-(--theme-primary) px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
