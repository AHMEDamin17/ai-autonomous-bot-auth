import { useToast } from "../../../../hooks/useToast";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConnections,
  addConnection,
  removeConnection,
  updateConnectionName,
  getApiErrorMessage,
} from "../../../../api/services";
import { legacyQueryHistoryStorageKey, queryHistoryStorageKey } from "../../../../utils/storageKeys";
import InlineState from "../../../common/InlineState";
import { ASYNC_STATUS } from "../../../../utils/asyncState";
import { useAuth } from "../../../../auth/AuthContext";

const DATABASE_TYPES = [
  "MySQL",
  "MongoDB",
  "PostgreSQL",
  "Redis",
  "Redshift",
  "Snowflake",
  "Databricks",
  "BigQuery",
  "SQLite",
  "MariaDB",
  "SQL Server",
];

const DB_TYPE_LABELS = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  postgresql: "PostgreSQL",
  postgres: "PostgreSQL",
  redis: "Redis",
  redshift: "Redshift",
  snowflake: "Snowflake",
  databricks: "Databricks",
  bigquery: "BigQuery",
  sqlite: "SQLite",
  mongodb: "MongoDB",
  mssql: "SQL Server",
  "sql server": "SQL Server",
};

const normalizeDbType = (type) => {
  const normalized = String(type || "").trim().toLowerCase();
  return DB_TYPE_LABELS[normalized] || String(type || "Unknown");
};

const dbTypeColorKey = (type) => String(type || "").trim().toLowerCase();

const DB_TYPE_COLORS = {
  postgresql: {
    bg: "bg-blue-50",
    text: "text-blue-600",
    border: "border-blue-200",
  },
  postgres: {
    bg: "bg-blue-50",
    text: "text-blue-600",
    border: "border-blue-200",
  },
  mysql: {
    bg: "bg-orange-50",
    text: "text-orange-600",
    border: "border-orange-200",
  },
  mongodb: {
    bg: "bg-green-50",
    text: "text-green-600",
    border: "border-green-200",
  },
  redis: { bg: "bg-red-50", text: "text-red-600", border: "border-red-200" },
  redshift: { bg: "bg-red-50", text: "text-red-600", border: "border-red-200" },
  snowflake: {
    bg: "bg-cyan-50",
    text: "text-cyan-600",
    border: "border-cyan-200",
  },
  databricks: {
    bg: "bg-orange-50",
    text: "text-orange-600",
    border: "border-orange-200",
  },
  bigquery: {
    bg: "bg-blue-50",
    text: "text-blue-600",
    border: "border-blue-200",
  },
  sqlite: {
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-200",
  },
  mariadb: {
    bg: "bg-indigo-50",
    text: "text-indigo-600",
    border: "border-indigo-200",
  },
  mssql: {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-300",
  },
  "sql server": {
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-300",
  },
};

// Connection form component
const DatabaseConnectionForm = ({ onSubmit, isSubmitting }) => {
  const [formData, setFormData] = useState({
    name: "",
    type: "MySQL",
    host: "",
    user: "",
    password: "",
    schema: "",
  });
  const [touched, setTouched] = useState({
    name: false,
    host: false,
    user: false,
    password: false,
    schema: false,
  });

  const isFieldRequired = (fieldName) => {
    const type = formData.type.toLowerCase();
    if (fieldName === "name" || fieldName === "host") return true;
    if (type === "sqlite") return false;
    if (type === "bigquery") {
      return fieldName === "password"; // password stores credentials JSON
    }
    if (type === "redis" || type === "mongodb") return false;
    return true;
  };

  const errors = {
    name:
      touched.name && !formData.name.trim()
        ? "Connection name is required"
        : "",
    host: touched.host && !formData.host.trim() ? "Host is required" : "",
    user:
      touched.user && isFieldRequired("user") && !formData.user.trim()
        ? "Username is required"
        : "",
    password:
      touched.password && isFieldRequired("password") && !formData.password.trim()
        ? "Password is required"
        : "",
    schema:
      touched.schema && isFieldRequired("schema") && !formData.schema.trim()
        ? "Default schema is required"
        : "",
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleBlur = (e) => {
    setTouched((prev) => ({ ...prev, [e.target.name]: true }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    setTouched({
      name: true,
      host: true,
      user: true,
      password: true,
      schema: true,
    });

    const nameOk = !isFieldRequired("name") || formData.name.trim();
    const hostOk = !isFieldRequired("host") || formData.host.trim();
    const userOk = !isFieldRequired("user") || formData.user.trim();
    const passOk = !isFieldRequired("password") || formData.password.trim();
    const schemaOk = !isFieldRequired("schema") || formData.schema.trim();

    if (nameOk && formData.type && hostOk && userOk && passOk && schemaOk) {
      try {
        await onSubmit(formData);
        setFormData({
          name: "",
          type: "MySQL",
          host: "",
          user: "",
          password: "",
          schema: "",
        });
        setTouched({
          name: false,
          host: false,
          user: false,
          password: false,
          schema: false,
        });
      } catch {
        // Do not reset the form on failure
      }
    }
  };

  const labelCls = "block text-sm font-semibold text-gray-700 mb-1 break-words";
  const inputBase =
    "w-full min-w-0 px-3 py-2 rounded-xl border border-gray-200 text-gray-900 text-sm placeholder-gray-400 bg-(--theme-theme-background) focus:outline-none focus:ring-2 focus:bg-white transition-all duration-200";
  const inputCls = (field) =>
    `${inputBase} ${errors[field] ? "border-red-400 focus:ring-red-300 focus:border-red-400 bg-red-50" : "focus:ring-(--theme-primary)/40 focus:border-(--theme-primary)"}`;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 md:p-6 h-full min-w-0 overflow-hidden">
      <div className="flex flex-row items-center justify-between gap-3 mb-4 sm:mb-6">
        <h2 className="text-base sm:text-xl md:text-2xl font-bold text-gray-800 wrap-break-word min-w-0 shrink">
          Add Database Connection
        </h2>
        <button type="submit" form="connection-form" className="btn-primary">
          {isSubmitting ? "Connecting..." : "+ Add"}
        </button>
      </div>

      <form
        id="connection-form"
        onSubmit={handleSubmit}
        className="space-y-4 min-w-0"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2 min-w-0">
            <label htmlFor="name" className={labelCls}>
              Connection Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="Production DB"
              className={inputCls("name")}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name}</p>
            )}
          </div>

          <div className="sm:col-span-1 min-w-0">
            <label htmlFor="type" className={labelCls}>
              Database Type <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <select
                id="type"
                name="type"
                value={formData.type}
                onChange={handleChange}
                required
                className={`${inputCls("")} appearance-none cursor-pointer bg-(--theme-theme-background) focus:bg-white`}
              >
                {DATABASE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                <svg
                  className="w-4 h-4 text-gray-400"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <label htmlFor="host" className={labelCls}>
            Host <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            id="host"
            name="host"
            value={formData.host}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="localhost:5432"
            className={inputCls("host")}
          />
          {errors.host && (
            <p className="mt-1 text-xs text-red-500">{errors.host}</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="min-w-0">
            <label htmlFor="user" className={labelCls}>
              Username {isFieldRequired("user") && <span className="text-red-500">*</span>}
            </label>
            <input
              type="text"
              id="user"
              name="user"
              value={formData.user}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="root"
              className={inputCls("user")}
            />
            {errors.user && (
              <p className="mt-1 text-xs text-red-500">{errors.user}</p>
            )}
          </div>

          <div className="min-w-0">
            <label htmlFor="password" className={labelCls}>
              Password {isFieldRequired("password") && <span className="text-red-500">*</span>}
            </label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="••••••••"
              className={inputCls("password")}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-500">{errors.password}</p>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <label htmlFor="schema" className={labelCls}>
            Database Schema Name {isFieldRequired("schema") && <span className="text-red-500">*</span>}
          </label>
          <input
            type="text"
            id="schema"
            name="schema"
            value={formData.schema}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="public"
            className={inputCls("schema")}
          />
          {errors.schema && (
            <p className="mt-1 text-xs text-red-500">{errors.schema}</p>
          )}
        </div>
      </form>
    </div>
  );
};

// Connection card component
const DatabaseConnectionCard = ({ connection, onRemove, onRename, canManage }) => {
  const [isConfirming, setIsConfirming] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [nextName, setNextName] = useState(connection.name);
  const [isSaving, setIsSaving] = useState(false);
  const colors = DB_TYPE_COLORS[dbTypeColorKey(connection.rawType || connection.type)] || DB_TYPE_COLORS.postgresql;

  return (
    <div className="relative bg-white rounded-xl border border-gray-200 p-4 min-h-[72px]">
      {/* Remove Button */}
      {canManage && (isConfirming ? (
        <div className="absolute top-3 right-3 flex gap-1">
          <button
            onClick={async () => {
              const success = await onRemove();
              if (!success) {
                setIsConfirming(false);
              }
            }}
            className="text-[10px] font-semibold bg-red-600 text-white rounded-md px-2 py-0.5 hover:bg-red-700 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setIsConfirming(false)}
            className="text-[10px] font-semibold bg-gray-200 text-gray-700 rounded-md px-2 py-0.5 hover:bg-gray-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : !isEditing ? (
        <div className="absolute top-3 right-3 flex gap-1">
          <button
            onClick={() => setIsEditing(true)}
            className="text-[10px] font-semibold border border-(--theme-border) bg-(--theme-surface) text-(--theme-text) rounded-md px-2 py-0.5 hover:bg-(--theme-container-bg) transition-colors"
          >
            Edit
          </button>
          <button
            onClick={() => setIsConfirming(true)}
            className="text-[10px] font-semibold bg-red-500 text-white rounded-md px-2 py-0.5 hover:bg-red-600 transition-colors"
          >
            Remove
          </button>
        </div>
      ) : null)}

      {/* Database Type Badge */}
      <span
        className={`absolute bottom-3 right-3 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border}`}
      >
        {normalizeDbType(connection.rawType || connection.type)}
      </span>

      <div className="pr-20 min-w-0">
        {isEditing ? (
          <div className="mb-1 flex max-w-sm items-center gap-1.5">
            <input
              value={nextName}
              onChange={(event) => setNextName(event.target.value)}
              maxLength={255}
              className="min-w-0 flex-1 rounded-[var(--theme-radius-btn)] border border-(--theme-border) bg-(--theme-surface) px-2 py-1 text-xs font-semibold text-(--theme-text) focus:border-(--theme-primary) focus:ring-2 focus:ring-(--theme-primary)/20"
            />
            <button
              type="button"
              disabled={isSaving || !nextName.trim()}
              onClick={async () => {
                setIsSaving(true);
                const success = await onRename(nextName.trim());
                setIsSaving(false);
                if (success) setIsEditing(false);
              }}
              className="btn-primary text-[10px]! px-2! py-1!"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setNextName(connection.name);
                setIsEditing(false);
              }}
              className="text-[10px] font-semibold text-(--theme-text-muted)"
            >
              Cancel
            </button>
          </div>
        ) : (
          <h3 className="text-sm font-bold text-gray-900 truncate mb-1">
            {connection.name}
          </h3>
        )}
        <p className="text-xs text-gray-500 truncate mt-0.5">
          <span className="text-sm text-green-500 mr-1.5 leading-none">●</span>
          {connection.host}
          {connection.schema && ` / ${connection.schema}`}
        </p>
      </div>
    </div>
  );
};

// Database connections page
const DatabaseConnections = () => {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadStatus, setLoadStatus] = useState(ASYNC_STATUS.IDLE);
  const [loadError, setLoadError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(5);
  const { showToast, ToastComponent } = useToast();
  const { isAdmin } = useAuth();
  const containerRef = useRef(null);
  

  

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    setLoadStatus(ASYNC_STATUS.LOADING);
    setLoadError("");
    try {
      const data = await getConnections();
      const mapped = (data || []).map((c) => ({
        id: String(c.id),
        name: c.connection_name,
        type: normalizeDbType(c.db_type),
        rawType: c.db_type,
        host: c.host,
        schema: c.default_schema ?? "",
        createdAt: c.created_at,
      }));
      setConnections(mapped);
      setLoadStatus(ASYNC_STATUS.SUCCESS);
    } catch (err) {
      const detail = getApiErrorMessage(err, "Failed to load connections");
      setLoadError(detail);
      setLoadStatus(ASYNC_STATUS.ERROR);
      showToast(detail, true);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  // Fetch connections from backend
  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  useEffect(() => {
    const calculateItemsPerPage = () => {
      if (!containerRef.current) return;
      const containerHeight = containerRef.current.clientHeight || window.innerHeight * 0.6;
      const headerHeight = 80;
      const availableHeight = containerHeight - headerHeight;
      const cardHeight = 95;
      const cardGap = 8;
      const totalCardHeight = cardHeight + cardGap;
      const calculated = Math.floor(availableHeight / totalCardHeight);
      setItemsPerPage(Math.max(4, Math.min(calculated, 8)));
    };
    const frameId = requestAnimationFrame(calculateItemsPerPage);
    window.addEventListener("resize", calculateItemsPerPage);
    const ro = new ResizeObserver(calculateItemsPerPage);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(frameId);
      window.removeEventListener("resize", calculateItemsPerPage);
      ro.disconnect();
    };
  }, []);

  // Recalculate page boundaries after delete transitions (M20)
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(connections.length / itemsPerPage));
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [connections.length, itemsPerPage, currentPage]);

  const totalPages = Math.ceil(connections.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentConnections = connections.slice(
    startIndex,
    startIndex + itemsPerPage,
  );

  const handleAddConnection = async (formData) => {
    setIsSubmitting(true);
    try {
      const saved = await addConnection(formData);
      const mapped = {
        id: String(saved.id),
        name: saved.connection_name,
        type: normalizeDbType(saved.db_type),
        rawType: saved.db_type,
        host: saved.host,
        schema: saved.default_schema ?? "",
        createdAt: saved.created_at,
      };
      setConnections((prev) => [mapped, ...prev]);
      showToast(`"${mapped.name}" connected successfully`);
    } catch (err) {
      const detail = getApiErrorMessage(err, "Connection failed");
      showToast(detail, true);
      throw err;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemove = async (id) => {
    try {
      await removeConnection(id);
      setConnections((prev) => prev.filter((c) => c.id !== id));
      localStorage.removeItem(queryHistoryStorageKey(id));
      localStorage.removeItem(legacyQueryHistoryStorageKey(id));
      return true;
    } catch {
      showToast("Failed to remove connection", true);
      return false;
    }
  };

  const handleRename = async (id, connectionName) => {
    try {
      const saved = await updateConnectionName(id, connectionName);
      setConnections((previous) => previous.map((connection) => (
        connection.id === String(id)
          ? { ...connection, name: saved.connection_name }
          : connection
      )));
      showToast("Connection name updated");
      return true;
    } catch (error) {
      showToast(getApiErrorMessage(error, "Failed to update connection"), true);
      return false;
    }
  };

  return (
    <div className="w-full relative">
      <ToastComponent />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 md:gap-8 items-start">
        <div className="w-full">
          {isAdmin ? (
            <DatabaseConnectionForm
              onSubmit={handleAddConnection}
              isSubmitting={isSubmitting}
            />
          ) : (
            <div className="h-full rounded-xl border border-(--theme-border) bg-(--theme-surface) p-5 sm:p-6">
              <InlineState
                type="empty"
                title="Read-only connection access"
                message="An administrator manages database connections. You can inspect the active connections and use approved analytics features."
              />
            </div>
          )}
        </div>

        <div className="w-full">
          <div
            className="bg-white rounded-xl border border-gray-200 p-4 sm:p-5 md:p-6"
            ref={containerRef}
          >
            <div className="mb-4 sm:mb-6 flex items-center justify-between">
              <h2 className="text-base sm:text-xl md:text-2xl font-bold text-gray-900">
                Active Connections
              </h2>

              {connections.length > 0 && (
                <div className="flex items-center gap-2 sm:gap-3">
                  <button
                    onClick={() =>
                      setCurrentPage(
                        currentPage > 1 ? currentPage - 1 : currentPage,
                      )
                    }
                    className={`p-1.5 sm:p-2 rounded-md hover:bg-gray-100 transition-colors duration-200 ${!(totalPages > 1 && currentPage > 1) ? "opacity-0 pointer-events-none" : "opacity-100"}`}
                    aria-label="Previous page"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4 sm:h-5 sm:w-5 text-gray-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <span className="text-xs sm:text-sm text-gray-600 font-medium whitespace-nowrap">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() =>
                      setCurrentPage(
                        currentPage < totalPages
                          ? currentPage + 1
                          : currentPage,
                      )
                    }
                    className={`p-1.5 sm:p-2 rounded-md hover:bg-gray-100 transition-colors duration-200 ${!(totalPages > 1 && currentPage < totalPages) ? "opacity-0 pointer-events-none" : "opacity-100"}`}
                    aria-label="Next page"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-4 w-4 sm:h-5 sm:w-5 text-gray-600"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {loading ? (
                <InlineState type="loading" title="Loading connections" message="Checking configured database connections." />
              ) : loadStatus === ASYNC_STATUS.ERROR ? (
                <InlineState
                  type="error"
                  title="Connections unavailable"
                  message={loadError}
                  actionLabel="Retry"
                  onAction={fetchConnections}
                />
              ) : connections.length === 0 ? (
                <InlineState
                  type="empty"
                  title="No connections yet"
                  message="Add your first database connection to get started."
                />
              ) : (
                currentConnections.map((connection) => (
                  <DatabaseConnectionCard
                    key={connection.id}
                    connection={connection}
                    onRemove={() => handleRemove(connection.id)}
                    onRename={(name) => handleRename(connection.id, name)}
                    canManage={isAdmin}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DatabaseConnections;
