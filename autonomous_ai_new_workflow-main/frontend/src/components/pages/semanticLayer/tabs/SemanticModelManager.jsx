import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Copy,
  Database,
  Download,
  LockKeyhole,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import {
  getApiErrorMessage,
  getConnectionSemanticModel,
  getConnections,
  getDataCatalogByConnection,
  regenerateSemanticModelTable,
  removeSemanticModelTable,
  saveConnectionSemanticModel,
  startConnectionSemanticGeneration,
} from "../../../../api/services";
import { useAuth } from "../../../../auth/AuthContext";
import { useToast } from "../../../../hooks/useToast";
import InlineState from "../../../common/InlineState";

const POLL_INTERVAL_MS = 3000;

const STATUS_STYLE = {
  none: "border-(--theme-border) bg-(--theme-container-bg) text-(--theme-text-muted)",
  ready: "border-green-200 bg-green-50 text-green-700",
  generating: "border-amber-200 bg-amber-50 text-amber-700",
  error: "border-red-200 bg-red-50 text-red-700",
};

const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-[var(--theme-radius-button)] border border-(--theme-border) bg-(--theme-surface) px-3 py-2 text-xs font-bold text-(--theme-text-secondary) shadow-sm transition-colors hover:bg-(--theme-container-bg) disabled:cursor-not-allowed disabled:opacity-50";

function statusBadge(value) {
  return `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLE[value] || STATUS_STYLE.none}`;
}

function tableIdentity(value) {
  return String(value || "").trim().toLowerCase().split(".").pop();
}

export default function SemanticModelManager() {
  const { globalConnectionId, setGlobalConnectionId } = useOutletContext();
  const { isAdmin } = useAuth();
  const { showToast, ToastComponent } = useToast();
  const [connections, setConnections] = useState([]);
  const [catalog, setCatalog] = useState({ tables: [], views: [], columns: [] });
  const [modelState, setModelState] = useState(null);
  const [selectedTables, setSelectedTables] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [validationError, setValidationError] = useState("");
  const [action, setAction] = useState("");
  const [copied, setCopied] = useState(false);
  const requestRef = useRef(0);

  const connectionId = globalConnectionId ? Number(globalConnectionId) : 0;
  const catalogTables = useMemo(() => [
    ...(catalog.tables || []).map((table) => ({ ...table, kind: "Table" })),
    ...(catalog.views || []).map((table) => ({ ...table, kind: "View" })),
  ], [catalog]);

  const visibleTables = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return catalogTables;
    return catalogTables.filter((table) => (
      String(table.table_name || "").toLowerCase().includes(query)
      || String(table.table_schema || "").toLowerCase().includes(query)
      || table.kind.toLowerCase().includes(query)
    ));
  }, [catalogTables, search]);

  const modeledTables = useMemo(
    () => modelState?.model?.entities?.map((entity) => entity.table_name) || [],
    [modelState],
  );

  const refreshModel = useCallback(async (id, replaceEditor = false) => {
    const state = await getConnectionSemanticModel(id);
    setModelState(state);
    if (replaceEditor || !dirty) {
      setJsonText(state.model ? JSON.stringify(state.model, null, 2) : "");
      if (replaceEditor) setDirty(false);
    }
    return state;
  }, [dirty]);

  const loadConnection = useCallback(async (id) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setCatalogError("");
    setValidationError("");
    setDirty(false);
    try {
      const [catalogResult, modelResult] = await Promise.allSettled([
        getDataCatalogByConnection(id),
        getConnectionSemanticModel(id),
      ]);
      if (requestId !== requestRef.current) return;
      if (catalogResult.status === "fulfilled") {
        setCatalog(catalogResult.value || { tables: [], views: [], columns: [] });
      } else {
        setCatalog({ tables: [], views: [], columns: [] });
        setCatalogError(getApiErrorMessage(catalogResult.reason, "Live catalog is unavailable."));
      }
      if (modelResult.status === "rejected") throw modelResult.reason;
      const state = modelResult.value;
      setModelState(state);
      setJsonText(state.model ? JSON.stringify(state.model, null, 2) : "");
      setSelectedTables(new Set(state.model?.entities?.map((entity) => entity.table_name) || []));
    } catch (error) {
      if (requestId === requestRef.current) {
        setModelState(null);
        setJsonText("");
        showToast(getApiErrorMessage(error, "Failed to load semantic model."), true);
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    let active = true;
    getConnections().then((items) => {
      if (!active) return;
      setConnections(items);
      const currentExists = items.some((connection) => String(connection.id) === String(globalConnectionId));
      if (!currentExists) setGlobalConnectionId(items[0]?.id ? String(items[0].id) : "");
    }).catch((error) => {
      if (active) showToast(getApiErrorMessage(error, "Failed to load connections."), true);
    });
    return () => { active = false; };
  }, [globalConnectionId, setGlobalConnectionId, showToast]);

  useEffect(() => {
    if (!connectionId) {
      setLoading(false);
      setCatalog({ tables: [], views: [], columns: [] });
      setModelState(null);
      setJsonText("");
      return;
    }
    loadConnection(connectionId);
  }, [connectionId, loadConnection]);

  useEffect(() => {
    const shouldPoll = modelState?.status === "generating";
    if (!connectionId || !shouldPoll) return undefined;
    const timer = setInterval(() => {
      refreshModel(connectionId).catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [connectionId, modelState?.status, refreshModel]);

  const toggleTable = (tableName) => {
    setSelectedTables((current) => {
      const next = new Set(current);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  const runAction = async (name, operation, successMessage) => {
    if (action) return;
    setAction(name);
    setValidationError("");
    try {
      await operation();
      showToast(successMessage);
      await refreshModel(connectionId, true);
    } catch (error) {
      if (error?.response?.data?.code === "STALE_MODEL_REVISION") {
        await refreshModel(connectionId, true).catch(() => undefined);
        setValidationError("The model changed in another session. The latest revision has been loaded; review it before retrying.");
      } else {
        const message = getApiErrorMessage(error, "Semantic-model operation failed.");
        setValidationError(message);
        showToast(message, true);
      }
    } finally {
      setAction("");
    }
  };

  const handleGenerate = (mode) => {
    const tables = [...selectedTables];
    if (tables.length === 0) {
      setValidationError("Select at least one table or view.");
      return;
    }
    if (mode === "full" && modeledTables.length > 0) {
      const selectedKeys = new Set(tables.map(tableIdentity));
      const losing = modeledTables.filter((table) => !selectedKeys.has(tableIdentity(table)));
      if (losing.length > 0 && !window.confirm(`Full Generate will remove ${losing.length} existing entit${losing.length === 1 ? "y" : "ies"}. Continue?`)) {
        return;
      }
    }
    if (mode === "append") {
      const existingKeys = new Set(modeledTables.map(tableIdentity));
      const missing = tables.filter((table) => !existingKeys.has(tableIdentity(table)));
      if (missing.length === 0) {
        showToast("Every selected table is already in this model.");
        return;
      }
    }
    runAction(
      mode,
      () => startConnectionSemanticGeneration(connectionId, tables, mode),
      mode === "full" ? "Full generation started." : "Selected tables are being added.",
    );
  };

  const handleSave = () => {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      setValidationError(`Invalid JSON syntax: ${error.message}`);
      return;
    }
    runAction(
      "save",
      async () => {
        const next = await saveConnectionSemanticModel(connectionId, parsed, modelState.revision);
        setModelState(next);
        setJsonText(JSON.stringify(next.model, null, 2));
        setDirty(false);
      },
      "Semantic model saved.",
    );
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(jsonText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleExport = () => {
    const blob = new Blob([jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${modelState?.connection?.semantic_key || "semantic_model"}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const generating = modelState?.status === "generating";
  const writesDisabled = !isAdmin || generating || Boolean(action);

  if (loading && !modelState) {
    return <InlineState type="loading" title="Loading semantic model" message="Loading the selected connection and semantic model." />;
  }

  if (connections.length === 0) {
    return <InlineState title="No database connections" message="Create a database connection before generating a semantic model." />;
  }

  return (
    <div className="flex w-full flex-col gap-4 sm:gap-6">
      <ToastComponent />

      <section className="rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-4 shadow-[var(--theme-card-shadow)] sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-(--theme-text) sm:text-xl">Semantic Model</h2>
              {!isAdmin && <span className={statusBadge("none")}>Read only</span>}
              <span className={statusBadge(modelState?.status || "none")}>
                {modelState?.status === "none" || !modelState?.status ? "Not generated" : modelState.status}
              </span>
            </div>
            <p className="mt-1 text-xs font-medium text-(--theme-text-muted)">
              Select a connection to generate, review, and maintain its semantic model.
            </p>
          </div>
          <label className="min-w-0 lg:w-80">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-(--theme-text-muted)">Connection</span>
            <select
              value={globalConnectionId}
              onChange={(event) => setGlobalConnectionId(event.target.value)}
              className="w-full rounded-[var(--theme-radius-button)] border border-(--theme-border) bg-(--theme-surface) px-3 py-2.5 text-sm font-semibold text-(--theme-text) outline-none transition focus:border-(--theme-primary) focus:ring-2 focus:ring-(--theme-primary)/15"
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.connection_name} · {connection.db_type}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {modelState?.generation_error && (
        <InlineState type="error" title="Semantic generation failed" message={modelState.generation_error} />
      )}
      {validationError && <InlineState type="error" title="Review required" message={validationError} />}

      <section className="rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-4 shadow-[var(--theme-card-shadow)] sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-bold text-(--theme-text)">Semantic JSON</h3>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-(--theme-text-muted)"><LockKeyhole size={13} /> Datasource, physical identities, datatypes, primary keys, and relationships are backend-owned.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={!jsonText} onClick={handleCopy}><Copy size={13} /> {copied ? "Copied" : "Copy"}</button>
            <button type="button" className={secondaryButton} disabled={!jsonText} onClick={handleExport}><Download size={13} /> Export</button>
            {isAdmin && <button type="button" className="btn-primary" disabled={writesDisabled || !dirty || !jsonText} onClick={handleSave}><Save size={14} /> Save JSON</button>}
          </div>
        </div>

        {!modelState?.model ? (
          <InlineState className="mt-4" title="No schema generated yet" message={isAdmin ? "Select tables below and choose Full Generate." : "An administrator has not generated this connection's semantic model yet."} />
        ) : (
          <textarea
            value={jsonText}
            onChange={(event) => {
              setJsonText(event.target.value);
              setDirty(true);
              setValidationError("");
            }}
            readOnly={!isAdmin || generating}
            spellCheck={false}
            aria-label="Semantic model JSON"
            className="mt-4 min-h-[420px] w-full resize-y rounded-xl border border-(--theme-border) bg-(--theme-container-bg) p-4 font-mono text-xs leading-5 text-(--theme-text) outline-none transition focus:border-(--theme-primary) focus:ring-2 focus:ring-(--theme-primary)/15 read-only:cursor-default"
          />
        )}
      </section>

      <div className="grid items-start gap-4 sm:gap-6 lg:grid-cols-2">
        <section className="min-w-0 rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-4 shadow-[var(--theme-card-shadow)] sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-bold text-(--theme-text)"><Database size={16} className="text-(--theme-primary)" /> Select tables and views</h3>
              <p className="mt-1 text-xs text-(--theme-text-muted)">{selectedTables.size} selected · {catalogTables.length} available</p>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondaryButton} onClick={() => setSelectedTables(new Set(catalogTables.map((table) => table.table_name)))}>Select all</button>
                <button type="button" className={secondaryButton} onClick={() => setSelectedTables(new Set())}>Clear all</button>
              </div>
            )}
          </div>

          <label className="relative mt-4 block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--theme-text-muted)" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tables or schemas"
              className="w-full rounded-[var(--theme-radius-button)] border border-(--theme-border) bg-(--theme-surface) py-2.5 pl-9 pr-3 text-sm text-(--theme-text) outline-none transition focus:border-(--theme-primary) focus:ring-2 focus:ring-(--theme-primary)/15"
            />
          </label>

          {catalogError ? (
            <InlineState type="error" className="mt-4" title="Live catalog unavailable" message={catalogError} actionLabel="Retry catalog" onAction={() => loadConnection(connectionId)} />
          ) : (
            <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-(--theme-border)">
              {visibleTables.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs font-medium text-(--theme-text-muted)">No matching tables or views.</p>
              ) : visibleTables.map((table) => {
                const checked = selectedTables.has(table.table_name);
                const columnCount = (catalog.columns || []).filter((column) => tableIdentity(column.table_name) === tableIdentity(table.table_name)).length;
                return (
                  <label key={`${table.kind}-${table.table_schema}-${table.table_name}`} className={`flex items-center gap-3 border-b border-(--theme-border) px-3 py-3 last:border-b-0 ${isAdmin ? "cursor-pointer hover:bg-(--theme-container-bg)" : "cursor-default"}`}>
                    {isAdmin && <input type="checkbox" checked={checked} onChange={() => toggleTable(table.table_name)} className="h-4 w-4 accent-(--theme-primary)" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold text-(--theme-text)">{table.table_name}</p>
                      <p className="mt-0.5 text-[10px] font-medium text-(--theme-text-muted)">{table.table_schema || "default schema"} · {columnCount} columns</p>
                    </div>
                    <span className="rounded-full border border-(--theme-border) bg-(--theme-container-bg) px-2 py-0.5 text-[10px] font-bold text-(--theme-text-muted)">{table.kind}</span>
                  </label>
                );
              })}
            </div>
          )}

          {isAdmin && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={writesDisabled || selectedTables.size === 0 || Boolean(catalogError)} onClick={() => handleGenerate("full")}>
                <RefreshCw size={14} className={action === "full" ? "animate-spin" : ""} /> Full Generate
              </button>
              <button type="button" className={secondaryButton} disabled={writesDisabled || !modelState?.model || selectedTables.size === 0 || Boolean(catalogError)} onClick={() => handleGenerate("append")}>
                <Plus size={14} /> Add selected tables
              </button>
            </div>
          )}
        </section>

        <section className="min-w-0 rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-4 shadow-[var(--theme-card-shadow)] sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-bold text-(--theme-text)">Modeled entities</h3>
              <p className="mt-1 text-xs text-(--theme-text-muted)">Incremental actions change only the selected entity and its incident relationships.</p>
            </div>
            <span className="text-xs font-bold text-(--theme-primary)">{modeledTables.length} entities</span>
          </div>
          <div className="mt-4 max-h-72 overflow-y-auto divide-y divide-(--theme-border) rounded-xl border border-(--theme-border)">
            {!modelState?.model || modelState.model.entities.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-(--theme-text-muted)">No modeled entities yet.</p>
            ) : modelState.model.entities.map((entity) => (
              <div key={entity.table_name} className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-xs font-bold text-(--theme-text)">{entity.name}</p>
                  <p className="mt-0.5 truncate text-[10px] font-medium text-(--theme-text-muted)">{entity.table_name} · {entity.dimensions.length} dimensions · {entity.measures.length} measures</p>
                </div>
                {isAdmin && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={secondaryButton}
                      disabled={writesDisabled}
                      onClick={() => runAction(`regenerate-${entity.table_name}`, () => regenerateSemanticModelTable(connectionId, entity.table_name, modelState.revision), `Regenerating ${entity.name}.`)}
                    >
                      <RotateCcw size={13} /> Regenerate
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-[var(--theme-radius-button)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={writesDisabled}
                      onClick={() => {
                        if (window.confirm(`Remove ${entity.name} from this semantic model? No LLM call will run.`)) {
                          runAction(`remove-${entity.table_name}`, () => removeSemanticModelTable(connectionId, entity.table_name, modelState.revision), `${entity.name} removed.`);
                        }
                      }}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
