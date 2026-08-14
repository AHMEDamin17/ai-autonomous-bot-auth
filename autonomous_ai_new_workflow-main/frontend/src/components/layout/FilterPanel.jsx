import { useMemo, useState } from "react";

const EXCLUDED_FILTER_FIELDS = new Set([
  "key",
  "value",
  "metric_value",
  "time_key",
  "group_key",
]);

const formatFieldLabel = (field) => (
  String(field || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
);

const isPrimitiveFilterValue = (value) => (
  value !== null &&
  value !== undefined &&
  ["string", "number", "boolean"].includes(typeof value)
);

export default function FilterPanel({ open, onGenerate, data, loading }) {
  const [filters, setFilters] = useState({});
  const [enabledFilters, setEnabledFilters] = useState({});

  const values = useMemo(() => {
    const rows = data?.flatMap((item) => item?.data?.data?.rows || []) || [];
    const derived = {};

    rows.forEach((row) => {
      if (!row || typeof row !== "object") return;
      Object.entries(row).forEach(([key, value]) => {
        if (EXCLUDED_FILTER_FIELDS.has(key) || !isPrimitiveFilterValue(value)) return;
        if (!derived[key]) derived[key] = new Set();
        if (derived[key].size < 100) derived[key].add(value);
      });
    });

    return Object.fromEntries(
      Object.entries(derived)
        .map(([key, uniqueValues]) => [key, [...uniqueValues]])
        .filter(([, uniqueValues]) => uniqueValues.length > 0),
    );
  }, [data]);

  const toggleFilter = (key) => {
    setEnabledFilters((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const hasSelection = Object.keys(enabledFilters).some(
    (key) => enabledFilters[key] && filters[key] && filters[key] !== "select",
  );

  const handleApply = () => {
    const selected = {};
    Object.keys(enabledFilters).forEach((key) => {
      if (enabledFilters[key] && filters[key] && filters[key] !== "select") {
        selected[key] = filters[key];
      }
    });

    const query = data?.[0]?.prompt || "";
    const structuredFilters = Object.entries(selected).map(([field, value]) => ({
      field,
      op: "eq",
      value,
    }));
    
    onGenerate(query, { isFollowUp: true, isFilterApplied: true, filters: structuredFilters });
    setEnabledFilters({});
    setFilters({});
  };

  if (!open) return null;

  return (
    <div
      className="
      w-full
      bg-(--theme-container-bg)
      border border-(--theme-border)
      rounded-xl
      shadow-sm
      px-3 py-3
    "
    >
      {Object.keys(values).length === 0 ? (
        <div className="text-center text-xs text-slate-500 py-6">
          No filters available for this result.
        </div>
      ) : (
        <>
          {/* FILTER GRID */}
          <div className="grid grid-cols-6 gap-3 items-end">
            {Object.entries(values).map(([key, list]) => (
              <div key={key} className="w-full">
                <label
                  className="
                  flex items-center gap-2
                  text-[10px] font-semibold text-slate-700
                  mb-[2px]
                "
                >
                  <input
                    type="checkbox"
                    checked={enabledFilters[key] || false}
                    onChange={() => toggleFilter(key)}
                    className="accent-[#D40511]"
                  />
                  {formatFieldLabel(key)}
                </label>

                <select
                  disabled={!enabledFilters[key]}
                  className={`
                    w-full
                    px-2 py-[5px]
                    rounded-md
                    border border-slate-300
                    text-[11px]
                    bg-white
                    ${!enabledFilters[key] ? "opacity-50 cursor-not-allowed" : ""}
                  `}
                  value={filters[key] || "select"}
                  onChange={(e) => handleChange(key, e.target.value)}
                >
                  <option value="select">All</option>
                  {list.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {/* APPLY BUTTON CELL */}
            <div className="col-span-2 flex justify-end items-end">
              <button
                onClick={handleApply}
                disabled={!hasSelection || loading}
                style={{
                  backgroundColor: hasSelection ? "#D40511" : "#e2e1e1",
                  color: hasSelection ? "#ffffff" : "#a3a3a3",
                  borderRadius: "4px",
                  padding: "6px 25px",
                }}
                className="
                text-xs
                transition-all
                disabled:cursor-not-allowed
                "
              >
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
