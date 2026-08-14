import { useToast } from "../../../../hooks/useToast";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  getConnections,
  getKpiMetrics,
  addKpiMetric,
  updateKpiMetric,
  removeKpiMetric,
  getColumnsByConnection,
  getApiErrorMessage,
} from "../../../../api/services";
import { toSafeText } from "../../../../utils/safeText";
import InlineState from "../../../common/InlineState";
import { ASYNC_STATUS } from "../../../../utils/asyncState";

const DEPT_COLORS = {
  Audit: "bg-slate-100 text-slate-700",
  "Customer Service": "bg-teal-100 text-teal-700",
  Finance: "bg-blue-100 text-blue-700",
  Sales: "bg-green-100 text-green-700",
  Marketing: "bg-pink-100 text-pink-700",
  Operations: "bg-orange-100 text-orange-700",
  "Human Resources": "bg-purple-100 text-purple-700",
  Engineering: "bg-cyan-100 text-cyan-700",
};

const TYPE_COLORS = {
  "Simple (Direct Measure)": "bg-gray-100 text-gray-600",
  Ratio: "bg-yellow-100 text-yellow-700",
  Cumulative: "bg-teal-100 text-teal-700",
  "Derived (Complex)": "bg-indigo-100 text-indigo-700",
};

const TYPE_SHORT = {
  "Simple (Direct Measure)": "simple",
  Ratio: "ratio",
  Cumulative: "cumulative",
  "Derived (Complex)": "derived",
};

const FORMAT_LABELS = {
  currency: "Currency ($)",
  number: "Number",
  percent: "Percent",
};

const departments = [
  "Audit",
  "Customer Service",
  "Finance",
  "Sales",
  "Marketing",
  "Operations",
  "Human Resources",
  "Engineering",
];
const metricTypes = [
  "Simple (Direct Measure)",
  "Ratio",
  "Cumulative",
  "Derived (Complex)",
];
const formatOptions = ["number", "currency", "percent"];
const getMetricPageSize = () => {
  if (typeof window === "undefined") return 4;
  if (window.innerHeight >= 1000) return 6;
  if (window.innerHeight < 720) return 3;
  return 4;
};

const labelCls = "block text-sm font-semibold text-gray-700 mb-1";
const inputBase =
  "w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-(--theme-theme-background) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40 focus:border-(--theme-primary) focus:bg-white transition-all duration-200";
const selectCls = `${inputBase} min-w-0 appearance-none cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap pr-9`;

const ChevronDown = () => (
  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
    <svg
      className="w-4 h-4 text-gray-400"
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
);

// Human-readable operator labels
const OPERATOR_LABELS = {
  eq: "equals",
  neq: "not equal to",
  gt: "greater than",
  lt: "less than",
  gte: "greater or equal",
  lte: "less or equal",
  like: "contains (LIKE)",
  in: "is one of (IN)",
  not_in: "is not one of",
  is_null: "is NULL",
  not_null: "is not NULL",
  relative: "relative date",
};

const NULL_FILTER_OPERATORS = new Set(["is_null", "not_null"]);
const filterConditionUsesNoValue = (op) => NULL_FILTER_OPERATORS.has(op);

// AST Filter rendering (read-only, for saved metric cards)
const renderAST = (node) => {
  if (!node) return null;
  if (node.type === "group") {
    if (!node.children || node.children.length === 0) return null;
    return (
      <div className="ml-2 pl-2 border-l-2 border-gray-200 mt-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
          {node.operator === "AND" ? "Match ALL" : "Match ANY"}
        </span>
        {node.children.map((c, i) => (
          <div key={i}>{renderAST(c)}</div>
        ))}
      </div>
    );
  }
  return (
    <p className="text-xs text-gray-600 mt-1.5 flex items-center gap-1.5 flex-wrap">
      <span className="font-bold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 font-mono text-[11px]">
        {toSafeText(node.field)}
      </span>
      <span className="text-gray-500 font-semibold text-[10px]">
        {toSafeText(OPERATOR_LABELS[node.op] || node.op)}
      </span>
      {!filterConditionUsesNoValue(node.op) && (
        <span className="font-bold text-green-700 bg-green-50 px-1.5 py-0.5 rounded border border-green-100 font-mono text-[11px]">
          "{toSafeText(
            node.op === "between" && node.value && typeof node.value === "object"
              ? `${node.value.start ?? ""} and ${node.value.end ?? ""}`
              : node.value,
          )}"
        </span>
      )}
    </p>
  );
};

const buildFilterSummary = (node) => {
  if (!node) return null;
  if (node.type === "condition") {
    if (!node.field) return null;
    const operatorLabel = OPERATOR_LABELS[node.op] || node.op;
    if (filterConditionUsesNoValue(node.op)) {
      return `${node.field} ${operatorLabel}`;
    }
    const displayValue =
      node.op === "between" && node.value && typeof node.value === "object"
        ? `${node.value.start || "..."} and ${node.value.end || "..."}`
        : node.value || "...";
    return `${node.field} ${operatorLabel} "${displayValue}"`;
  }
  if (node.type === "group") {
    if (!node.children || node.children.length === 0) return null;
    const parts = node.children.map(buildFilterSummary).filter(Boolean);
    if (parts.length === 0) return null;
    const joiner = node.operator === "OR" ? " OR " : " AND ";
    return parts.length > 1 ? `(${parts.join(joiner)})` : parts[0];
  }
  return null;
};

function FilterRow({ condition, onChange, onRemove }) {
  const usesNoValue = filterConditionUsesNoValue(condition.op);
  const isBetween = condition.op === "between";
  const betweenValue =
    isBetween && condition.value && typeof condition.value === "object"
      ? condition.value
      : { start: "", end: "" };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(5.5rem,0.7fr)_auto] items-center gap-2 rounded border bg-white p-2 shadow-sm">
      <input
        value={condition.field || ""}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          const columnRef = getDraggedColumnRef(e);
          if (columnRef) onChange({ ...condition, field: columnRef });
        }}
        list="kpi-filter-field-options"
        placeholder="Field (table.column)"
        aria-label="Filter field"
        title="Use a qualified table.column reference; drag a column here or choose one from the list"
        className={inputBase}
      />
      <select
        aria-label="Filter operator"
        value={condition.op || "eq"}
        onChange={(e) => {
          const nextOp = e.target.value;
          onChange({
            ...condition,
            op: nextOp,
            value: filterConditionUsesNoValue(nextOp)
              ? undefined
              : nextOp === "between"
                ? { start: "", end: "" }
                : "",
          });
        }}
        className={selectCls}
      >
        <option value="eq">=</option>
        <option value="neq">!=</option>
        <option value="gt">&gt;</option>
        <option value="lt">&lt;</option>
        <option value="gte">&gt;=</option>
        <option value="lte">&lt;=</option>
        <option value="between">BETWEEN</option>
        <option value="in">IN</option>
        <option value="is_null">IS NULL</option>
        <option value="not_null">IS NOT NULL</option>
        <option value="relative">RELATIVE DATE</option>
      </select>
      <button
        type="button"
        onClick={onRemove}
        className="justify-self-end rounded px-2 py-1 font-bold text-red-500 hover:bg-red-50 hover:text-red-700"
        aria-label="Remove filter condition"
      >
        &times;
      </button>
      {usesNoValue ? (
        <div className="col-span-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500">
          No value required
        </div>
      ) : isBetween ? (
        <div className="col-span-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
          <input
            value={betweenValue.start || ""}
            onChange={(e) =>
              onChange({
                ...condition,
                value: { ...betweenValue, start: e.target.value },
              })
            }
            placeholder="Start"
            className={inputBase}
          />
          <span className="text-[10px] font-bold uppercase text-gray-400">
            and
          </span>
          <input
            value={betweenValue.end || ""}
            onChange={(e) =>
              onChange({
                ...condition,
                value: { ...betweenValue, end: e.target.value },
              })
            }
            placeholder="End"
            className={inputBase}
          />
        </div>
      ) : (
        <input
          value={condition.value ?? ""}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          placeholder={
            condition.op === "in"
              ? "Comma-separated values"
              : condition.op === "relative"
                ? "e.g. last_30_days"
                : "Value"
          }
          className={`${inputBase} col-span-3`}
        />
      )}
    </div>
  );
}

function FilterGroupCard({ node, onChange, onRemove, depth = 0 }) {
  if (!node || node.type !== "group") return null;

  const updateOperator = (op) => onChange({ ...node, operator: op });

  const addCondition = () => {
    onChange({
      ...node,
      children: [
        ...(node.children || []),
        { type: "condition", field: "", op: "eq", value: "" },
      ],
    });
  };

  const addGroup = () => {
    onChange({
      ...node,
      children: [
        ...(node.children || []),
        {
          type: "group",
          operator: "AND",
          children: [{ type: "condition", field: "", op: "eq", value: "" }],
        },
      ],
    });
  };

  const updateChild = (idx, newChild) => {
    if (!newChild) {
      removeChild(idx);
      return;
    }
    const nextChildren = [...(node.children || [])];
    nextChildren[idx] = newChild;
    onChange({ ...node, children: nextChildren });
  };

  const removeChild = (idx) => {
    const nextChildren = [...(node.children || [])];
    nextChildren.splice(idx, 1);
    if (nextChildren.length === 0 && onRemove) {
      onRemove();
      return;
    }
    onChange({ ...node, children: nextChildren });
  };

  return (
    <div
      className={`p-3 border rounded-lg ${depth === 0 ? "bg-gray-50 border-gray-200" : "mt-2 ml-1 border-purple-200 bg-white sm:ml-2"}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-gray-500 uppercase">
          {depth === 0 ? "Combine top-level filters" : "Match within group"}
        </span>
        <div className="min-w-0 flex-1 basis-44">
          <select
            value={node.operator}
            onChange={(e) => updateOperator(e.target.value)}
            className={selectCls}
          >
            <option value="AND">ALL (AND)</option>
            <option value="OR">ANY (OR)</option>
          </select>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-bold text-red-500 transition-colors hover:bg-red-50 hover:text-red-700"
          >
            {depth === 0 ? "Clear Filters" : "Remove Group"}
          </button>
        )}
      </div>

      <div className="space-y-2 pl-2 border-l-2 border-gray-200">
        {(node.children || []).map((child, idx) => {
          if (child.type === "group") {
            return (
              <div key={idx}>
                <FilterGroupCard
                  node={child}
                  onChange={(n) => updateChild(idx, n)}
                  onRemove={() => removeChild(idx)}
                  depth={depth + 1}
                />
              </div>
            );
          }
          if (child.type === "raw") {
            return (
              <div
                key={idx}
                className="p-2 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-xs flex justify-between items-center"
              >
                <span>
                  Legacy raw SQL filter:{" "}
                  <code className="font-mono">{child.sql}</code> (Read-only)
                </span>
                <button
                  onClick={() => removeChild(idx)}
                  className="text-red-500 hover:text-red-700 font-bold px-2"
                >
                  X
                </button>
              </div>
            );
          }
          return (
            <FilterRow
              key={idx}
              condition={child}
              onChange={(c) => updateChild(idx, c)}
              onRemove={() => removeChild(idx)}
            />
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={addCondition}
          className="text-teal-600 font-bold"
        >
          {depth === 0 ? "+ Add Top-Level Condition" : "+ Add Condition"}
        </button>
        <button
          type="button"
          onClick={addGroup}
          className="text-purple-600 font-bold"
        >
          {depth === 0 ? "+ Add Top-Level Group" : "+ Add Nested Group"}
        </button>
      </div>
    </div>
  );
}

// Helper to convert schema.table_name to logical dataset name
const getLogicalDatasetName = (tableName, tableSchema) => {
  const schema = String(tableSchema || "")
    .toLowerCase()
    .trim();
  let name = String(tableName || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
  // If the name already contains a dot, it was passed as schema.table
  if (name.includes(".")) return name.replace(/\./g, "_");
  return schema ? `${schema}_${name}` : name;
};

const getBrowserDatasetName = (table) =>
  table?.logical_name ||
  getLogicalDatasetName(table?.table_name, table?.table_schema);

const findBrowserTableByName = (tables, tableName) => {
  const normalized = String(tableName || "")
    .toLowerCase()
    .replace(/\./g, "_");
  return (tables || []).find((table) => {
    const logical = getBrowserDatasetName(table);
    const physical =
      table?.physical_name ||
      (table?.table_schema
        ? `${table.table_schema}.${table.table_name}`
        : table?.table_name);
    return [logical, table?.table_name, physical]
      .filter(Boolean)
      .some(
        (candidate) =>
          String(candidate).toLowerCase().replace(/\./g, "_") === normalized,
      );
  });
};

const normalizeDatasetKey = (value) =>
  String(value || "")
    .replace(/[`"[\]]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/\./g, "_");

const getJoinConditions = (join) => {
  const explicit = Array.isArray(join?.conditions)
    ? join.conditions.filter(Boolean)
    : [];
  if (explicit.length > 0) return explicit;
  return [{
    leftColumn: join?.leftColumn || join?.left_column || "",
    rightColumn: join?.rightColumn || join?.right_column || "",
  }];
};

const normalizeJoinSpec = (joinSpec) =>
  (joinSpec || []).map((join) => {
    const leftTable = join.leftTable || join.left_table || "";
    const rightTable = join.rightTable || join.right_table || "";
    const conditions = getJoinConditions(join).map((condition) => ({
      leftTable: condition.leftTable || leftTable,
      leftColumn: condition.leftColumn || condition.left_column || "",
      rightTable: condition.rightTable || rightTable,
      rightColumn: condition.rightColumn || condition.right_column || "",
      ...(condition.joinCondition ? { joinCondition: condition.joinCondition } : {}),
    }));
    const first = conditions[0] || {};
    return {
      type: String(join.type || join.join_type || "INNER").toUpperCase(),
      leftTable,
      leftColumn: first.leftColumn || "",
      rightTable,
      rightColumn: first.rightColumn || "",
      conditions,
      ...(join.joinCondition ? { joinCondition: join.joinCondition } : {}),
    };
  });

const validateJoinTree = (involvedTables, joinSpec) => {
  const tableKeys = involvedTables.map(normalizeDatasetKey);
  const tableSet = new Set(tableKeys);

  if (tableSet.size !== tableKeys.length) {
    return "Source tables contain duplicate references.";
  }
  if (tableKeys.length === 1) {
    return joinSpec.length > 0
      ? "A single-table KPI cannot contain joins."
      : null;
  }
  for (let index = 0; index < joinSpec.length; index += 1) {
    const join = joinSpec[index];
    if (!join.leftTable || !join.rightTable) {
      return `Complete both tables in Join ${index + 1} before adding or saving another branch.`;
    }
    const conditions = getJoinConditions(join);
    if (
      conditions.length === 0 ||
      conditions.some(
        (condition) =>
          !(condition.leftColumn || condition.left_column) ||
          !(condition.rightColumn || condition.right_column),
      )
    ) {
      return `Complete every ON condition in Join ${index + 1} before adding or saving another branch.`;
    }
  }
  if (joinSpec.length !== tableKeys.length - 1) {
    return `Connect all ${tableKeys.length} source tables with exactly ${tableKeys.length - 1} join${tableKeys.length - 1 === 1 ? "" : "s"}.`;
  }

  const connected = new Set([tableKeys[0]]);
  for (let index = 0; index < joinSpec.length; index += 1) {
    const join = joinSpec[index];
    const leftKey = normalizeDatasetKey(join.leftTable);
    const rightKey = normalizeDatasetKey(join.rightTable);
    if (!tableSet.has(leftKey) || !tableSet.has(rightKey)) {
      return `Join ${index + 1} uses a table outside the selected KPI tables.`;
    }
    if (leftKey === rightKey) {
      return `Join ${index + 1} cannot join a table to itself.`;
    }
    if (!connected.has(leftKey)) {
      return `Join ${index + 1}'s left table must already be connected to the KPI root.`;
    }
    if (connected.has(rightKey)) {
      return `Join ${index + 1} creates a duplicate or cyclic connection.`;
    }
    connected.add(rightKey);
  }

  return connected.size === tableSet.size
    ? null
    : "The join configuration does not connect every selected table.";
};

const joinMatchesForeignKey = (join, fk) => {
  const leftTable = join.leftTable || join.left_table;
  const rightTable = join.rightTable || join.right_table;
  return getJoinConditions(join).some((condition) => {
    const leftColumn = condition.leftColumn || condition.left_column;
    const rightColumn = condition.rightColumn || condition.right_column;
    return (
      (leftTable === fk.source_table && leftColumn === fk.source_column && rightTable === fk.target_table && rightColumn === fk.target_column) ||
      (leftTable === fk.target_table && leftColumn === fk.target_column && rightTable === fk.source_table && rightColumn === fk.source_column)
    );
  });
};

const JoinBuilder = memo(
  ({
    joinSpec,
    onChange,
    tables = [],
    columnBrowserData = [],
    fkRelationships = [],
  }) => {
    const [mainTable, setMainTable] = useState(tables[0] || "");
    const savedRoot =
      joinSpec?.[0]?.leftTable || joinSpec?.[0]?.left_table || "";

    useEffect(() => {
      const nextMainTable = tables.includes(savedRoot)
        ? savedRoot
        : tables.includes(mainTable)
          ? mainTable
          : tables[0] || "";
      if (nextMainTable !== mainTable) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMainTable(nextMainTable);
      }
    }, [tables, mainTable, savedRoot]);

    const getAvailableLeftTables = (idx) => {
      const previousJoins = (joinSpec || []).slice(0, idx);
      return [
        mainTable,
        ...previousJoins.map((j) => j.rightTable || j.right_table),
      ].filter(Boolean);
    };

    const getAllJoinedTables = () => {
      return [
        mainTable,
        ...(joinSpec || []).map((j) => j.rightTable || j.right_table),
      ].filter(Boolean);
    };

    const addJoinFrom = (leftTable) => {
      onChange([
        ...(joinSpec || []),
        {
          leftTable: leftTable || mainTable || "",
          leftColumn: "",
          type: "INNER",
          rightTable: "",
          rightColumn: "",
          conditions: [{ leftColumn: "", rightColumn: "" }],
        },
      ]);
    };
    const updateJoin = (idx, newJoin) => {
      const next = [...(joinSpec || [])];
      next[idx] = newJoin;
      onChange(next);
    };

    const removeDependentJoinBranch = (joins, parentTable, ignoredIndex = -1) => {
      if (!parentTable) return joins;
      const removedTables = new Set([parentTable]);
      return joins.filter((join, index) => {
        if (index === ignoredIndex) return true;
        const leftTable = join.leftTable || join.left_table;
        if (!removedTables.has(leftTable)) return true;
        const rightTable = join.rightTable || join.right_table;
        if (rightTable) removedTables.add(rightTable);
        return false;
      });
    };

    const removeJoin = (idx) => {
      const joins = joinSpec || [];
      const removedRightTable =
        joins[idx]?.rightTable || joins[idx]?.right_table || "";
      const withoutSelected = joins.filter((_, index) => index !== idx);
      onChange(removeDependentJoinBranch(withoutSelected, removedRightTable));
    };

    const updateJoinRightTable = (idx, rightTable) => {
      const joins = joinSpec || [];
      const currentJoin = joins[idx];
      const previousRightTable =
        currentJoin?.rightTable || currentJoin?.right_table || "";
      const next = [...joins];
      next[idx] = {
        ...currentJoin,
        rightTable,
        right_table: rightTable,
        rightColumn: "",
        right_column: "",
        conditions: getJoinConditions(currentJoin).map((condition) => ({
          ...condition,
          rightColumn: "",
          right_column: "",
        })),
      };
      onChange(
        previousRightTable && previousRightTable !== rightTable
          ? removeDependentJoinBranch(next, previousRightTable, idx)
          : next,
      );
    };
    const updateJoinCondition = (joinIndex, conditionIndex, patch) => {
      const next = [...(joinSpec || [])];
      const join = { ...next[joinIndex] };
      const conditions = getJoinConditions(join).map((condition) => ({ ...condition }));
      conditions[conditionIndex] = { ...conditions[conditionIndex], ...patch };
      const first = conditions[0] || {};
      next[joinIndex] = {
        ...join,
        leftColumn: first.leftColumn || first.left_column || "",
        left_column: first.leftColumn || first.left_column || "",
        rightColumn: first.rightColumn || first.right_column || "",
        right_column: first.rightColumn || first.right_column || "",
        conditions,
      };
      onChange(next);
    };
    const addJoinCondition = (joinIndex) => {
      const next = [...(joinSpec || [])];
      const join = { ...next[joinIndex] };
      next[joinIndex] = {
        ...join,
        conditions: [...getJoinConditions(join), { leftColumn: "", rightColumn: "" }],
      };
      onChange(next);
    };
    const removeJoinCondition = (joinIndex, conditionIndex) => {
      const next = [...(joinSpec || [])];
      const join = { ...next[joinIndex] };
      const conditions = getJoinConditions(join).filter((_, index) => index !== conditionIndex);
      if (conditions.length === 0) return;
      next[joinIndex] = {
        ...join,
        leftColumn: conditions[0].leftColumn || conditions[0].left_column || "",
        left_column: conditions[0].leftColumn || conditions[0].left_column || "",
        rightColumn: conditions[0].rightColumn || conditions[0].right_column || "",
        right_column: conditions[0].rightColumn || conditions[0].right_column || "",
        conditions,
      };
      onChange(next);
    };

    const applyFk = (fk) => {
      const exists = (joinSpec || []).some((join) =>
        joinMatchesForeignKey(join, fk),
      );
      if (!exists) {
        const existingJoinIndex = (joinSpec || []).findIndex((join) => {
          const left = join.leftTable || join.left_table;
          const right = join.rightTable || join.right_table;
          return (left === fk.source_table && right === fk.target_table)
            || (left === fk.target_table && right === fk.source_table);
        });
        if (existingJoinIndex >= 0) {
          const existingJoin = joinSpec[existingJoinIndex];
          const sourceIsLeft = (existingJoin.leftTable || existingJoin.left_table) === fk.source_table;
          const fkCondition = {
            leftColumn: sourceIsLeft ? fk.source_column : fk.target_column,
            rightColumn: sourceIsLeft ? fk.target_column : fk.source_column,
            joinCondition: "fk",
          };
          const currentConditions = getJoinConditions(existingJoin);
          const hasOnlyEmptyCondition = currentConditions.length === 1
            && !(currentConditions[0].leftColumn || currentConditions[0].left_column)
            && !(currentConditions[0].rightColumn || currentConditions[0].right_column);
          const nextConditions = hasOnlyEmptyCondition
            ? [fkCondition]
            : [...currentConditions, fkCondition];
          const next = [...(joinSpec || [])];
          next[existingJoinIndex] = {
            ...existingJoin,
            leftColumn: nextConditions[0].leftColumn,
            left_column: nextConditions[0].leftColumn,
            rightColumn: nextConditions[0].rightColumn,
            right_column: nextConditions[0].rightColumn,
            conditions: nextConditions,
          };
          onChange(next);
          return;
        }
        let leftOptions = getAvailableLeftTables(joinSpec?.length || 0);
        let leftTableToUse = fk.source_table;
        let rightTableToUse = fk.target_table;
        let leftColumnToUse = fk.source_column;
        let rightColumnToUse = fk.target_column;

        if (
          !leftOptions.includes(fk.source_table) &&
          leftOptions.includes(fk.target_table)
        ) {
          leftTableToUse = fk.target_table;
          rightTableToUse = fk.source_table;
          leftColumnToUse = fk.target_column;
          rightColumnToUse = fk.source_column;
        }
        onChange([
          ...(joinSpec || []),
          {
            leftTable: leftTableToUse,
            leftColumn: leftColumnToUse,
            type: "INNER",
            rightTable: rightTableToUse,
            rightColumn: rightColumnToUse,
            conditions: [{
              leftColumn: leftColumnToUse,
              rightColumn: rightColumnToUse,
              joinCondition: "fk",
            }],
            joinCondition: "fk",
          },
        ]);
      }
    };

    const activeTables = new Set(getAllJoinedTables());
    const hasIncompleteJoinDraft = (joinSpec || []).some((join) => {
      if (!(join.rightTable || join.right_table)) return true;
      return getJoinConditions(join).some(
        (condition) =>
          !(condition.leftColumn || condition.left_column) ||
          !(condition.rightColumn || condition.right_column),
      );
    });
    const hasJoinCapacity = (joinSpec || []).length < tables.length - 1;
    const canAddJoinFrom = (tableName) =>
      Boolean(tableName) &&
      activeTables.has(tableName) &&
      hasJoinCapacity &&
      !hasIncompleteJoinDraft;
    const getJoinDepth = (joinIndex) => {
      const tableDepths = new Map([[mainTable, 0]]);
      for (let index = 0; index <= joinIndex; index += 1) {
        const join = (joinSpec || [])[index];
        const leftTable = join?.leftTable || join?.left_table || mainTable;
        const rightTable = join?.rightTable || join?.right_table;
        const parentDepth = tableDepths.get(leftTable) || 0;
        if (index === joinIndex) return parentDepth + 1;
        if (rightTable) tableDepths.set(rightTable, parentDepth + 1);
      }
      return 1;
    };

    const relevantFks = fkRelationships.filter(
      (fk) => {
        const sourceActive = activeTables.has(fk.source_table);
        const targetActive = activeTables.has(fk.target_table);
        const pairAlreadyJoined = (joinSpec || []).some((join) => {
          const left = join.leftTable || join.left_table;
          const right = join.rightTable || join.right_table;
          return (left === fk.source_table && right === fk.target_table)
            || (left === fk.target_table && right === fk.source_table);
        });
        return tables.includes(fk.source_table)
          && tables.includes(fk.target_table)
          && (sourceActive !== targetActive || pairAlreadyJoined);
      },
    );

    return (
      <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-4 py-2.5 bg-(--theme-theme-background) border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              className="w-4 h-4 text-(--theme-primary)"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              />
            </svg>
            <span className="font-bold text-sm text-gray-800">
              Join Configuration
            </span>
          </div>
        </div>

        <div className="p-4 bg-white space-y-4">
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="block text-xs font-bold text-blue-900 uppercase tracking-wider mb-2">
              1. Select Main Dataset (Root)
            </label>
            <select
              data-testid="kpi-join-root"
              value={mainTable}
              disabled={tables.length === 0}
              onChange={(e) => {
                setMainTable(e.target.value);
                onChange([]);
              }}
              className="w-full text-sm font-mono p-2 border border-blue-200 rounded bg-white text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              {tables.length === 0 && (
                <option value="">Select source tables first</option>
              )}
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {tables.length > 1 && hasJoinCapacity && (
              <button
                data-testid="kpi-add-root-join"
                type="button"
                onClick={() => addJoinFrom(mainTable)}
                disabled={!canAddJoinFrom(mainTable)}
                title={
                  canAddJoinFrom(mainTable)
                    ? `Attach another table directly to ${mainTable}`
                    : "Complete the current join draft before adding another branch"
                }
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-[11px] font-bold text-blue-700 transition-colors hover:bg-blue-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white disabled:hover:text-blue-700"
              >
                <span aria-hidden="true">+</span> Add Join From Root
              </button>
            )}
          </div>

          {tables.length > 1 && (!joinSpec || joinSpec.length === 0) && (
            <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg flex items-start gap-2.5">
              <svg
                className="w-4 h-4 text-gray-500 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-[11px] text-gray-600 font-medium">
                Add the first branch from the root. Every later join can be
                attached either to the root or to a joined table, so sibling and
                nested branches stay separate.
              </p>
            </div>
          )}

          {(joinSpec || []).length > 0 && (
            <div className="space-y-4">
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">
                2. Join Tree Branches
              </label>
              {(joinSpec || []).map((j, idx) => {
                const availableLeftTables = getAvailableLeftTables(idx);
                const joinedTables = getAllJoinedTables();
                const availableRightTables = tables.filter(
                  (t) => !joinedTables.includes(t) || t === (j.rightTable || j.right_table)
                );
                const joinDepth = getJoinDepth(idx);
                const leftTable = j.leftTable || j.left_table || "";
                const rightTable = j.rightTable || j.right_table || "";
                const joinIsComplete =
                  Boolean(leftTable && rightTable) &&
                  getJoinConditions(j).every(
                    (condition) =>
                      Boolean(
                        condition.leftColumn || condition.left_column,
                      ) &&
                      Boolean(
                        condition.rightColumn || condition.right_column,
                      ),
                  );

                return (
                  <div
                    key={idx}
                    data-testid={`kpi-join-row-${idx}`}
                    className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 shadow-sm transition-colors hover:border-blue-300"
                    style={{ marginLeft: `${Math.min(joinDepth - 1, 3) * 12}px` }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="font-bold text-[10px] text-gray-400 uppercase tracking-wider bg-white px-1.5 py-0.5 rounded border border-gray-200">
                          Level {joinDepth} &middot; Join {idx + 1}
                        </span>
                        <span
                          className={`ml-1.5 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                            joinIsComplete
                              ? "border-green-200 bg-green-50 text-green-700"
                              : "border-amber-200 bg-amber-50 text-amber-700"
                          }`}
                        >
                          {joinIsComplete ? "Complete" : "Draft"}
                        </span>
                        <p className="mt-1 truncate text-[10px] font-semibold text-gray-500">
                          {leftTable || "Parent table"} &rarr;{" "}
                          {rightTable || "Select a child table"}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeJoin(idx)}
                        className="shrink-0 rounded p-1 text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
                        title={`Remove Join ${idx + 1}`}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
                      <label className="min-w-0">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-500">
                          Join Type
                        </span>
                        <select
                          aria-label={`Join ${idx + 1} type`}
                          value={String(
                            j.type || j.join_type || "INNER",
                          ).toUpperCase()}
                          onChange={(e) =>
                            updateJoin(idx, {
                              ...j,
                              type: e.target.value,
                              join_type: e.target.value,
                            })
                          }
                          className="w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2 pr-8 text-[11px] font-bold text-gray-700 shadow-sm transition-colors hover:border-gray-400 focus:border-(--theme-primary) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40"
                        >
                          <option value="INNER">INNER</option>
                          <option value="LEFT">LEFT</option>
                          <option value="RIGHT">RIGHT</option>
                          <option value="FULL">FULL</option>
                        </select>
                      </label>

                      <label className="min-w-0">
                        <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-500">
                          Right Table
                        </span>
                        <select
                          aria-label={`Join ${idx + 1} right table`}
                          value={j.rightTable || j.right_table || ""}
                          onChange={(e) =>
                            updateJoinRightTable(idx, e.target.value)
                          }
                          className={`${selectCls} bg-white font-bold text-blue-800`}
                        >
                          <option value="" disabled>
                            Select Right Table...
                          </option>
                          {availableRightTables.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="ml-2 space-y-2 border-l-2 border-(--theme-border) pl-4">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[5rem_minmax(0,1fr)] sm:items-center">
                        <span className="text-[10px] font-bold uppercase tracking-wide text-(--theme-text-muted)">
                          Left Table
                        </span>
                        <select
                          aria-label={`Join ${idx + 1} left table`}
                          value={j.leftTable || j.left_table || ""}
                          onChange={(e) =>
                            updateJoin(idx, {
                              ...j,
                              leftTable: e.target.value,
                              left_table: e.target.value,
                              leftColumn: "",
                              left_column: "",
                              conditions: getJoinConditions(j).map((condition) => ({
                                ...condition,
                                leftColumn: "",
                                left_column: "",
                              })),
                            })
                          }
                          className={`${selectCls} bg-(--theme-container-bg) text-(--theme-text)`}
                        >
                          <option value="" disabled>Left Table...</option>
                          {availableLeftTables.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>

                      {getJoinConditions(j).map((condition, conditionIndex) => (
                        <div
                          key={conditionIndex}
                          data-testid={`kpi-join-condition-${idx}-${conditionIndex}`}
                          className="grid grid-cols-1 gap-2 rounded-lg border border-(--theme-border) bg-(--theme-card-bg) p-2 sm:grid-cols-[2rem_minmax(0,1fr)_auto_minmax(0,1fr)_auto] sm:items-center"
                        >
                          <span className="text-[10px] font-bold uppercase text-(--theme-text-muted)">
                            {conditionIndex === 0 ? "ON" : "AND"}
                          </span>
                          <select
                            aria-label={`Join ${idx + 1} left column ${conditionIndex + 1}`}
                            value={condition.leftColumn || condition.left_column || ""}
                            onChange={(e) => updateJoinCondition(idx, conditionIndex, {
                              leftColumn: e.target.value,
                              left_column: e.target.value,
                            })}
                            className={selectCls}
                          >
                            <option value="" disabled>Column...</option>
                            {(findBrowserTableByName(columnBrowserData, j.leftTable || j.left_table)?.columns || []).map((c) => (
                              <option key={c.name} value={c.name}>{c.name}{c.is_primary_key ? " (PK)" : ""}</option>
                            ))}
                          </select>
                          <span className="font-bold text-(--theme-text-muted)">=</span>
                          <select
                            aria-label={`Join ${idx + 1} right column ${conditionIndex + 1}`}
                            value={condition.rightColumn || condition.right_column || ""}
                            onChange={(e) => updateJoinCondition(idx, conditionIndex, {
                              rightColumn: e.target.value,
                              right_column: e.target.value,
                            })}
                            className={selectCls}
                          >
                            <option value="" disabled>Column...</option>
                            {(findBrowserTableByName(columnBrowserData, j.rightTable || j.right_table)?.columns || []).map((c) => (
                              <option key={c.name} value={c.name}>{c.name}{c.is_primary_key ? " (PK)" : ""}</option>
                            ))}
                          </select>
                          {getJoinConditions(j).length > 1 && (
                            <button
                              type="button"
                              onClick={() => removeJoinCondition(idx, conditionIndex)}
                              className="rounded p-1 text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
                              title="Remove join condition"
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}

                      <button
                        data-testid={`kpi-add-join-condition-${idx}`}
                        type="button"
                        onClick={() => addJoinCondition(idx)}
                        className="inline-flex items-center gap-1 rounded-lg border border-(--theme-chip-border) bg-(--theme-chip-bg) px-3 py-1.5 text-[11px] font-bold text-(--theme-primary) transition-colors hover:bg-(--theme-primary) hover:text-white"
                        title={`Add another ON condition to Join ${idx + 1}`}
                      >
                        <span aria-hidden="true">+</span> Add ON Condition
                      </button>
                      <p className="text-[10px] font-medium text-(--theme-text-muted)">
                        All ON conditions in this join are combined with AND.
                      </p>
                    </div>

                    {rightTable && hasJoinCapacity && (
                      <button
                        data-testid={`kpi-add-child-join-${idx}`}
                        type="button"
                        onClick={() => addJoinFrom(rightTable)}
                        disabled={!canAddJoinFrom(rightTable)}
                        title={
                          canAddJoinFrom(rightTable)
                            ? `Attach a child join to ${rightTable}`
                            : "Complete this join and any current draft first"
                        }
                        className="inline-flex w-fit items-center gap-1 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-[11px] font-bold text-purple-700 transition-colors hover:bg-purple-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-purple-50 disabled:hover:text-purple-700"
                      >
                        <span aria-hidden="true">+</span> Add Child Join From{" "}
                        <span className="max-w-36 truncate font-mono">
                          {rightTable}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {hasIncompleteJoinDraft && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[10px] font-semibold text-amber-700">
                The current join is only a draft. Select its right table and
                complete every ON column pair before adding another branch or
                saving the KPI.
              </p>
            </div>
          )}

          {tables.length > 2 && (joinSpec || []).length < tables.length - 1 && (
            <div className="mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-[10px] text-amber-700 font-semibold flex items-center gap-1.5">
                <svg
                  className="w-3 h-3 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                You need exactly {tables.length - 1} complete joins to connect all{" "}
                {tables.length} selected tables.
              </p>
            </div>
          )}

          {relevantFks.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-3">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">
                Detected Foreign Keys
              </p>
              <div className="flex flex-wrap gap-2">
                {relevantFks.map((fk, idx) => {
                  const alreadyUsed = (joinSpec || []).some((join) =>
                    joinMatchesForeignKey(join, fk),
                  );
                  const matchingDraftExists = (joinSpec || []).some((join) => {
                    const left = join.leftTable || join.left_table;
                    const right = join.rightTable || join.right_table;
                    return (
                      (left === fk.source_table && right === fk.target_table) ||
                      (left === fk.target_table && right === fk.source_table)
                    );
                  });
                  const canApplyForeignKey =
                    matchingDraftExists ||
                    (hasJoinCapacity && !hasIncompleteJoinDraft);
                  return (
                    <div
                      key={idx}
                      className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 shadow-sm"
                    >
                      <div className="flex flex-col text-[10px] font-mono text-gray-600">
                        <span>
                          <strong className="text-gray-800">
                            {fk.source_table}
                          </strong>
                          .{fk.source_column}
                        </span>
                        <span className="text-center text-gray-400 leading-none">
                          ⇕
                        </span>
                        <span>
                          <strong className="text-gray-800">
                            {fk.target_table}
                          </strong>
                          .{fk.target_column}
                        </span>
                      </div>
                      <div className="flex-1"></div>
                      {alreadyUsed ? (
                        <span className="text-[10px] font-bold text-green-600 flex items-center gap-1">
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          Applied
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => applyFk(fk)}
                          disabled={!canApplyForeignKey}
                          title={
                            canApplyForeignKey
                              ? "Use this detected relationship"
                              : "Complete the current join draft first"
                          }
                          className="text-[10px] font-bold text-teal-600 hover:text-white bg-teal-50 hover:bg-teal-500 px-2 py-0.5 rounded border border-teal-200 hover:border-teal-500 transition-all disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-teal-50 disabled:hover:text-teal-600"
                        >
                          Add to Tree
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* PK / Schema Info */}
          {activeTables.size > 0 && columnBrowserData.length > 0 && (
            <div className="mt-1 border-t border-gray-100 pt-2">
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1.5">
                Primary Keys for Selected Tables
              </p>
              <div className="flex flex-wrap gap-2">
                {Array.from(activeTables).map((tName) => {
                  const tableMeta = findBrowserTableByName(
                    columnBrowserData,
                    tName,
                  );
                  if (!tableMeta) return null;
                  const pks = tableMeta.columns
                    .filter((c) => c.is_primary_key)
                    .map((c) => ({
                      name: c.name || c.column_name,
                      autoIncrement: Boolean(c.is_auto_increment),
                    }));
                  if (pks.length === 0) return null;

                  return (
                    <div
                      key={tName}
                      className="flex items-center gap-1.5 bg-gray-50 border border-gray-200 px-2 py-1 rounded-md"
                    >
                      <svg
                        className="w-3 h-3 text-amber-500"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" />
                      </svg>
                      <span className="text-[10px] font-mono font-bold text-gray-700">
                        {tName}
                      </span>
                      <span className="text-[10px] text-gray-400">→</span>
                      <span className="text-[10px] font-mono text-amber-700 font-semibold">
                        {pks.map((pk) => `${pk.name}${pk.autoIncrement ? " (AI)" : ""}`).join(", ")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Info: 3+ tables need multiple join rows */}
          {tables.length > 2 && (joinSpec || []).length < tables.length - 1 && (
            <div className="mt-1 px-2.5 py-1.5 bg-(--theme-chip-bg)/30 border border-(--theme-chip-border)/40 rounded-lg">
              <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1.5">
                <svg
                  className="w-3 h-3 text-(--theme-primary) shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                {tables.length} tables detected &mdash; you need exactly{" "}
                {tables.length - 1} complete join(s) to connect them all.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  },
);

// Extract table names from formula for auto scope detection
const getInvolvedTables = (formula, dimensions = "") => {
  const allText = `${formula} ${dimensions}`;
  const matches =
    allText.match(
      /\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\.([a-zA-Z_][a-zA-Z0-9_]*)\b/g,
    ) || [];
  return [
    ...new Set(
      matches.map((m) => {
        // Extract the table prefix (e.g., "rod.GS_SN_CUSTOMERSERVICE_CASE")
        const tablePrefix = m.split(".").slice(0, -1).join(".");
        // Normalize it to "rod_gs_sn_customerservice_case"
        return tablePrefix.toLowerCase().replace(/\./g, "_");
      }),
    ),
  ];
};

const normalizeStringList = (value) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // Fall through to comma-separated parsing.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const QUALIFIED_COLUMN_REF_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;

const isQualifiedColumnRef = (value) =>
  QUALIFIED_COLUMN_REF_PATTERN.test(String(value || "").trim());

const getQualifiedMetricDimensions = (metric) => {
  const dimensions = normalizeStringList(metric?.dimensions);
  const involvedTables = normalizeStringList(metric?.involved_tables);

  // Safely upgrade legacy single-table KPI dimensions in the UI. Multi-table
  // legacy dimensions remain untouched because guessing a table is unsafe.
  if (involvedTables.length !== 1) return dimensions;
  return dimensions.map((dimension) =>
    isQualifiedColumnRef(dimension)
      ? dimension
      : `${involvedTables[0]}.${dimension}`,
  );
};

const qualifyFilterLogic = (node, involvedTables) => {
  if (!node) return node;
  if (node.type === "condition") {
    const field = String(node.field || "").trim();
    return {
      ...node,
      field:
        field && !isQualifiedColumnRef(field) && involvedTables.length === 1
          ? `${involvedTables[0]}.${field}`
          : field,
    };
  }
  if (node.type === "group") {
    return {
      ...node,
      children: (node.children || []).map((child) =>
        qualifyFilterLogic(child, involvedTables),
      ),
    };
  }
  return node;
};

const findUnqualifiedFilterField = (node) => {
  if (!node) return null;
  if (node.type === "condition") {
    const field = String(node.field || "").trim();
    return isQualifiedColumnRef(field) ? null : field || "(empty field)";
  }
  if (node.type === "group") {
    for (const child of node.children || []) {
      const invalidField = findUnqualifiedFilterField(child);
      if (invalidField) return invalidField;
    }
  }
  return null;
};

const isBlankFilterValue = (value) => {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
};

const findIncompleteFilterCondition = (node, path = "Filter") => {
  if (!node) return null;
  if (node.type === "condition") {
    const field = String(node.field || "").trim();
    if (!field) return `${path}: choose a field or remove this condition.`;
    if (filterConditionUsesNoValue(node.op)) return null;
    if (node.op === "between") {
      const start = node.value?.start;
      const end = node.value?.end;
      if (isBlankFilterValue(start) || isBlankFilterValue(end)) {
        return `${path}: BETWEEN requires both a start and an end value.`;
      }
      return null;
    }
    if (isBlankFilterValue(node.value)) {
      return `${path}: enter a value or choose IS NULL / IS NOT NULL.`;
    }
    return null;
  }
  if (node.type === "group") {
    if (!node.children?.length) return `${path}: remove this empty group.`;
    for (let index = 0; index < node.children.length; index += 1) {
      const issue = findIncompleteFilterCondition(
        node.children[index],
        `${path} ${index + 1}`,
      );
      if (issue) return issue;
    }
  }
  return null;
};

// Only complete conditions are serializable. Empty/incomplete draft groups
// collapse to null so the API receives an unambiguous "no filters" value.
const pruneEmptyFilterLogic = (node) => {
  if (!node) return null;
  if (node.type === "condition") {
    const field = String(node.field || "").trim();
    if (!field) return null;
    if (filterConditionUsesNoValue(node.op)) {
      return { type: "condition", field, op: node.op };
    }
    if (node.op === "between") {
      if (
        isBlankFilterValue(node.value?.start) ||
        isBlankFilterValue(node.value?.end)
      ) {
        return null;
      }
      return { ...node, field };
    }
    return isBlankFilterValue(node.value) ? null : { ...node, field };
  }
  if (node.type === "group") {
    const prunedChildren = (node.children || [])
      .map((child) => pruneEmptyFilterLogic(child))
      .filter(Boolean);
    return prunedChildren.length > 0 ? { ...node, children: prunedChildren } : null;
  }
  return node;
};

const getDraggedColumnRef = (event) =>
  event.dataTransfer.getData("application/x-kpi-column") ||
  event.dataTransfer.getData("text/plain");

const DimensionSelectionList = ({ options, selected, onChange, disabled }) => {
  const [draftDimension, setDraftDimension] = useState("");
  const [showInvalidDraft, setShowInvalidDraft] = useState(false);
  const selectedKeys = new Set(selected.map((dimension) => dimension.toLowerCase()));
  const availableOptions = Array.from(
    new Map(
      options
        .filter(Boolean)
        .map((dimension) => [dimension.toLowerCase(), dimension]),
    ).values(),
  );

  const resolveAvailableDimension = (value) => {
    const normalizedValue = String(value || "").trim().toLowerCase();
    if (!normalizedValue) return null;

    const exactMatch = availableOptions.find(
      (dimension) => dimension.toLowerCase() === normalizedValue,
    );
    if (exactMatch) return exactMatch;

    if (!normalizedValue.includes(".")) {
      const leafMatches = availableOptions.filter(
        (dimension) =>
          dimension.slice(dimension.lastIndexOf(".") + 1).toLowerCase() ===
          normalizedValue,
      );
      if (leafMatches.length === 1) return leafMatches[0];
    }
    return null;
  };

  const addDimension = (dimension) => {
    if (!dimension || selectedKeys.has(dimension.toLowerCase())) return;
    onChange([...selected, dimension]);
  };

  const removeDimension = (dimension) => {
    const dimensionKey = dimension.toLowerCase();
    onChange(
      selected.filter((item) => item.toLowerCase() !== dimensionKey),
    );
  };

  const commitTypedDimension = (value, markInvalid = false) => {
    const matchedDimension = resolveAvailableDimension(value);
    if (!matchedDimension) {
      if (markInvalid && String(value || "").trim()) setShowInvalidDraft(true);
      return false;
    }
    addDimension(matchedDimension);
    setDraftDimension("");
    setShowInvalidDraft(false);
    return true;
  };

  return (
    <div
      data-testid="kpi-dimensions-dropzone"
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        const dimensionRef = getDraggedColumnRef(event);
        if (isQualifiedColumnRef(dimensionRef)) addDimension(dimensionRef);
      }}
      className={`min-h-[42px] w-full rounded-xl border border-gray-200 bg-(--theme-theme-background) px-3 py-1.5 text-(--theme-text) transition-all duration-200 focus-within:border-(--theme-primary) focus-within:bg-white focus-within:ring-2 focus-within:ring-(--theme-primary)/40 ${
        disabled ? "cursor-not-allowed opacity-60" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((dimension) => (
          <span
            key={dimension}
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-(--theme-border) bg-(--theme-container-bg) py-1 pl-2.5 pr-1.5 text-xs font-semibold text-(--theme-text)"
          >
            <span className="truncate font-mono" title={dimension}>
              {toSafeText(dimension)}
            </span>
            <button
              type="button"
              onClick={() => removeDimension(dimension)}
              disabled={disabled}
              aria-label={`Remove dimension ${dimension}`}
              title={`Remove ${dimension}`}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-sm leading-none text-(--theme-text-muted) transition-colors hover:bg-(--theme-chip-bg) hover:text-(--theme-primary) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40 disabled:cursor-not-allowed"
            >
              &times;
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draftDimension}
          onChange={(event) => {
            const nextValue = event.target.value;
            setDraftDimension(nextValue);
            setShowInvalidDraft(false);
            commitTypedDimension(nextValue);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== ",") return;
            event.preventDefault();
            commitTypedDimension(draftDimension, true);
          }}
          onBlur={() => commitTypedDimension(draftDimension, true)}
          disabled={disabled}
          aria-label="Type a dimension column"
          placeholder={
            availableOptions.length > 0
              ? "Type a column name or table.column"
              : "Select source tables first"
          }
          className="min-w-56 flex-1 bg-transparent px-0 py-0.5 text-sm text-(--theme-text) outline-none placeholder:text-(--theme-text-muted) disabled:cursor-not-allowed"
        />
      </div>
      {showInvalidDraft && (
        <p className="mt-1.5 px-1 text-xs text-red-600">
          No unique matching column was found. Use the qualified table.column name.
        </p>
      )}
    </div>
  );
};

// Removed deprecated transformers

// Main component
const KpiDefinitions = () => {
  const { globalConnectionId, setGlobalConnectionId } =
    useOutletContext() || {};
  const passedConnectionId = String(globalConnectionId || "");

  const [connections, setConnections] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [initStatus, setInitStatus] = useState(ASYNC_STATUS.IDLE);
  const [initError, setInitError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const { showToast, ToastComponent } = useToast();
  const [confirmingRemoveId, setConfirmingRemoveId] = useState(null);
  const [editingMetricId, setEditingMetricId] = useState(null);

  // Column browser state
  const [columnBrowserTables, setColumnBrowserTables] = useState([]);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [columnsStatus, setColumnsStatus] = useState(ASYNC_STATUS.IDLE);
  const [columnsError, setColumnsError] = useState("");
  const [browserOpen, setBrowserOpen] = useState(true);
  const [expandedTables, setExpandedTables] = useState({});
  const [browserMode, setBrowserMode] = useState("select");
  const [browserSearchQuery, setBrowserSearchQuery] = useState("");
  const [columnSearchQuery, setColumnSearchQuery] = useState("");
  const [committedSelectedTables, setCommittedSelectedTables] = useState([]);
  const [selectedTables, setSelectedTables] = useState([]);
  const formulaRef = useRef(null);
  const tableListRef = useRef(null);
  const previousConnectionIdRef = useRef(passedConnectionId || "");

  const [formData, setFormData] = useState({
    connectionId: passedConnectionId,
    name: "",
    department: "Audit",
    type: "Simple (Direct Measure)",
    formula: "",
    format: "number",
    dimensions: "",
  });

  const [filterLogic, setFilterLogic] = useState(null);
  const [joinSpec, setJoinSpec] = useState([]);
  const [fkRelationships, setFkRelationships] = useState([]);
  const [filterDept, setFilterDept] = useState("All Departments");
  const [currentPage, setCurrentPage] = useState(1);
  const [metricPageSize, setMetricPageSize] = useState(getMetricPageSize);
  const [metricPageSizeOverride, setMetricPageSizeOverride] = useState("auto");
  const handleFilterLogicChange = useCallback((nextFilterLogic) => {
    setFilterLogic(nextFilterLogic);
  }, []);

  const loadInitialData = useCallback(async () => {
    setLoadingInit(true);
    setInitStatus(ASYNC_STATUS.LOADING);
    setInitError("");
    try {
      const [conns, savedMetrics] = await Promise.all([
        getConnections(),
        getKpiMetrics(),
      ]);
      setConnections(
        (conns || []).map((c) => ({
          id: String(c.id),
          name: c.connection_name,
          type: c.db_type,
        })),
      );
      setMetrics(savedMetrics || []);

      const currentPassedId = String(globalConnectionId || "");
      if (!currentPassedId && conns.length > 0 && setGlobalConnectionId) {
        setGlobalConnectionId(String(conns[0].id));
      }
      setInitStatus(ASYNC_STATUS.SUCCESS);
    } catch (err) {
      const detail = getApiErrorMessage(err, "Failed to load KPI data");
      setInitError(detail);
      setInitStatus(ASYNC_STATUS.ERROR);
      showToast(detail, true);
    } finally {
      setLoadingInit(false);
    }
  }, [globalConnectionId, setGlobalConnectionId, showToast]);

  // Initial load
  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Synchronize form connectionId when passedConnectionId changes (M18)
  useEffect(() => {
    if (passedConnectionId) {
      setFormData((prev) => ({ ...prev, connectionId: passedConnectionId }));
    }
  }, [passedConnectionId]);

  useEffect(() => {
    const updatePageSize = () => {
      setMetricPageSize(
        metricPageSizeOverride === "auto"
          ? getMetricPageSize()
          : Number(metricPageSizeOverride),
      );
    };
    updatePageSize();
    window.addEventListener("resize", updatePageSize);
    return () => window.removeEventListener("resize", updatePageSize);
  }, [metricPageSizeOverride]);

  const loadColumns = useCallback(async (connectionId, preserveState = false) => {
    setLoadingColumns(true);
    setColumnsStatus(ASYNC_STATUS.LOADING);
    setColumnsError("");
    try {
      const { tables: colsData, relationships } =
        await getColumnsByConnection(connectionId);
      setColumnBrowserTables(colsData || []);
      setFkRelationships(relationships || []);
      if (!preserveState) {
        setBrowserMode("select");
        setCommittedSelectedTables([]);
        setExpandedTables({});
        setColumnSearchQuery("");
      }
      setColumnsStatus(ASYNC_STATUS.SUCCESS);
    } catch (err) {
      setColumnBrowserTables([]);
      setFkRelationships([]);
      setColumnsError(
        getApiErrorMessage(err, "Failed to load available columns"),
      );
      setColumnsStatus(ASYNC_STATUS.ERROR);
    } finally {
      setLoadingColumns(false);
    }
  }, []);

  // Load columns when connection changes
  useEffect(() => {
    if (!formData.connectionId) {
      setColumnBrowserTables([]);
      setSelectedTables([]);
      setBrowserSearchQuery("");
      setColumnSearchQuery("");
      setColumnsStatus(ASYNC_STATUS.IDLE);
      return;
    }
    const connectionChanged =
      previousConnectionIdRef.current !== formData.connectionId;
    previousConnectionIdRef.current = formData.connectionId;
    if (connectionChanged || columnsStatus === ASYNC_STATUS.IDLE) {
      if (connectionChanged && !editingMetricId) {
        setSelectedTables([]);
        setJoinSpec([]);
      }
      loadColumns(formData.connectionId, !!editingMetricId);
    }
  }, [editingMetricId, formData.connectionId, loadColumns, columnsStatus]);

  // Auto-suggest format based on department
  useEffect(() => {
    if (formData.department === "Audit") {
      setFormData((p) => ({ ...p, format: "number" }));
    }
  }, [formData.department]);

  const insertTextAtCursor = (field, textarea, text, commaSeparated = false) => {
    const currentValue = textarea?.value ?? formData[field] ?? "";
    const start = textarea?.selectionStart ?? currentValue.length;
    const end = textarea?.selectionEnd ?? currentValue.length;
    const before = currentValue.substring(0, start);
    const after = currentValue.substring(end);

    if (
      commaSeparated &&
      currentValue
        .split(",")
        .map((value) => value.trim())
        .includes(text)
    ) {
      textarea?.focus();
      return;
    }

    const prefix =
      commaSeparated && before.trim() && !/,\s*$/.test(before) ? ", " : "";
    const suffix =
      commaSeparated && after.trim() && !/^\s*,/.test(after) ? ", " : "";
    const insertedText = `${prefix}${text}${suffix}`;
    const nextValue = before + insertedText + after;

    setFormData((previous) => ({ ...previous, [field]: nextValue }));
    setTimeout(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(
        start + insertedText.length,
        start + insertedText.length,
      );
    }, 0);
  };

  // Clicking a browser column inserts it into the formula. Dragging allows the
  // user to choose either Formula or Dimensions as the destination.
  const insertColumn = (tableName, colName) => {
    insertTextAtCursor(
      "formula",
      formulaRef.current,
      `${tableName}.${colName}`,
    );
  };

  const handleDimensionsChange = useCallback((nextDimensions) => {
    const uniqueDimensions = Array.from(
      new Map(
        nextDimensions
          .map((dimension) => String(dimension || "").trim())
          .filter(Boolean)
          .map((dimension) => [dimension.toLowerCase(), dimension]),
      ).values(),
    );
    setFormData((previous) => ({
      ...previous,
      dimensions: uniqueDimensions.join(", "),
    }));
    setFormError("");
  }, []);

  const handleCreateOrUpdateMetric = async () => {
    if (isSubmitting) return;
    setFormError("");
    if (!formData.connectionId) {
      setFormError("Please select a connection from the Database Connections tab.");
      return;
    }
    if (!formData.name.trim()) {
      setFormError("Metric name is required.");
      return;
    }
    if (!formData.formula.trim()) {
      setFormError("Calculation formula is required.");
      return;
    }
    if (effectiveInvolvedTables.length === 0) {
      setFormError(
        "Select at least one source table from the column browser or use qualified table.column references.",
      );
      return;
    }

    const dimensionsArr = normalizeStringList(formData.dimensions);
    const invalidDimension = dimensionsArr.find(
      (dimension) => !isQualifiedColumnRef(dimension),
    );
    if (invalidDimension) {
      setFormError(
        `Dimension '${invalidDimension}' must use the qualified table.column format. Drag the column from the browser or enter its table name.`,
      );
      return;
    }
    const incompleteFilter = findIncompleteFilterCondition(filterLogic);
    if (incompleteFilter) {
      setFormError(incompleteFilter);
      return;
    }
    const prunedFilterLogic = pruneEmptyFilterLogic(filterLogic);
    const invalidFilterField = findUnqualifiedFilterField(prunedFilterLogic);
    if (invalidFilterField) {
      setFormError(
        `Filter field '${invalidFilterField}' must use the qualified table.column format. Drag the column into the filter field or choose it from the field list.`,
      );
      return;
    }

    const normalizedJoins = normalizeJoinSpec(joinSpec);
    const joinRoot = normalizedJoins[0]?.leftTable;
    const orderedInvolvedTables = joinRoot
      ? [
          effectiveInvolvedTables.find(
            (tableName) =>
              normalizeDatasetKey(tableName) === normalizeDatasetKey(joinRoot),
          ) || joinRoot,
          ...effectiveInvolvedTables.filter(
            (tableName) =>
              normalizeDatasetKey(tableName) !== normalizeDatasetKey(joinRoot),
          ),
        ]
      : effectiveInvolvedTables;
    const joinsForPayload =
      orderedInvolvedTables.length > 1 ? normalizedJoins : [];
    const joinError = validateJoinTree(
      orderedInvolvedTables,
      joinsForPayload,
    );
    if (joinError) {
      setFormError(joinError);
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        connection_id: Number(formData.connectionId),
        metric_name: formData.name.trim(),
        department: formData.department,
        metric_type: formData.type,
        formula: formData.formula.trim(),
        format: formData.format,
        dimensions: dimensionsArr,
        filter_logic: prunedFilterLogic,
        involved_tables: orderedInvolvedTables,
        join_spec: joinsForPayload,
      };

      if (editingMetricId) {
        const saved = await updateKpiMetric(editingMetricId, payload);
        setMetrics((prev) =>
          prev.map((m) => (m.id === editingMetricId ? saved : m)),
        );
        showToast(`"${saved.metric_name}" updated successfully`);
      } else {
        const saved = await addKpiMetric(payload);
        setMetrics((prev) => [saved, ...prev]);
        showToast(`"${saved.metric_name}" created successfully`);
      }

      setFormData({
        connectionId: passedConnectionId,
        name: "",
        department: "Audit",
        type: "Simple (Direct Measure)",
        formula: "",
        format: "number",
        dimensions: "",
      });
      setFilterLogic(null);
      setJoinSpec([]);
      setSelectedTables([]);
      setEditingMetricId(null);
      setBrowserMode("select");
    } catch (err) {
      const detail = getApiErrorMessage(
        err,
        editingMetricId ? "Failed to update metric" : "Failed to create metric",
      );
      showToast(detail, true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (metric) => {
    const involvedTables = normalizeStringList(metric.involved_tables);
    const qualifiedDimensions = getQualifiedMetricDimensions(metric);
    setEditingMetricId(metric.id);
    setFormData({
      connectionId: String(metric.connection_id),
      name: metric.metric_name,
      department: metric.department || "Audit",
      type: metric.metric_type || "Simple (Direct Measure)",
      formula: metric.formula || "",
      format: metric.format || "number",
      dimensions: qualifiedDimensions.join(", "),
    });
    setFilterLogic(
      metric.filter_logic
        ? qualifyFilterLogic(metric.filter_logic, involvedTables)
        : null,
    );
    setJoinSpec(metric.join_spec || []);
    const fallbackTables = getInvolvedTables(
      metric.formula || "",
      qualifiedDimensions.join(", "),
    );
    const rawNextSelectedTables =
      involvedTables.length > 0 ? involvedTables : fallbackTables;
    let nextSelectedTables = rawNextSelectedTables.map((t) =>
      getLogicalDatasetName(t),
    );
    const editRoot =
      metric.join_spec?.[0]?.leftTable || metric.join_spec?.[0]?.left_table;
    if (editRoot) {
      const normalizedEditRoot = getLogicalDatasetName(editRoot);
      nextSelectedTables = [
        normalizedEditRoot,
        ...nextSelectedTables.filter(
          (tableName) =>
            normalizeDatasetKey(tableName) !==
            normalizeDatasetKey(normalizedEditRoot),
        ),
      ];
    }
    setSelectedTables(nextSelectedTables);
    setExpandedTables(
      Object.fromEntries(
        nextSelectedTables.map((tableName) => [tableName, true]),
      ),
    );
    setCommittedSelectedTables(nextSelectedTables);
    setColumnSearchQuery("");
    setBrowserMode("columns");

    // Scroll to top to see the form
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Scroll the table browser to the top so selected tables are in view
    setTimeout(() => {
      if (tableListRef.current) {
        tableListRef.current.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 0);
  };

  const handleResetForm = () => {
    setFormData({
      connectionId: passedConnectionId,
      name: "",
      department: "Audit",
      type: "Simple (Direct Measure)",
      formula: "",
      format: "number",
      dimensions: "",
    });
    setFilterLogic(null);
    setJoinSpec([]);
    setSelectedTables([]);
    setEditingMetricId(null);
    setCommittedSelectedTables([]);
    setFormError("");
    setBrowserSearchQuery("");
    setColumnSearchQuery("");
    setBrowserMode("select");
  };

  const handleRemove = async (id) => {
    try {
      await removeKpiMetric(id);
      setMetrics((prev) => prev.filter((m) => m.id !== id));
    } catch {
      showToast("Failed to remove metric", true);
    } finally {
      setConfirmingRemoveId(null);
    }
  };

  const dbMetrics = metrics.filter(
    (m) => String(m.connection_id) === passedConnectionId,
  );
  const deptFilteredMetrics =
    filterDept === "All Departments"
      ? dbMetrics
      : dbMetrics.filter((m) => m.department === filterDept);

  const filteredMetrics = deptFilteredMetrics;

  // Recalculate page boundaries after delete transitions (M19)
  useEffect(() => {
    const maxPage = Math.max(
      1,
      Math.ceil(filteredMetrics.length / metricPageSize),
    );
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [filteredMetrics.length, currentPage, metricPageSize]);

  const totalPages = Math.max(
    1,
    Math.ceil(filteredMetrics.length / metricPageSize),
  );
  const pagedMetrics = filteredMetrics.slice(
    (currentPage - 1) * metricPageSize,
    currentPage * metricPageSize,
  );

  const currentConnection = connections.find(
    (c) => c.id === passedConnectionId,
  );

  // Auto-detect tables based on current formula and dimensions
  const autoInvolvedTables = getInvolvedTables(
    formData.formula,
    formData.dimensions,
  );
  const effectiveInvolvedTables =
    selectedTables.length > 0 ? selectedTables : autoInvolvedTables;
  const filterFieldOptions = [
    ...new Set(
      effectiveInvolvedTables.flatMap((tableName) => {
        const table = findBrowserTableByName(columnBrowserTables, tableName);
        if (!table) return [];
        const logicalName = getBrowserDatasetName(table);
        return (table.columns || []).map(
          (column) => `${logicalName}.${column.name}`,
        );
      }),
    ),
  ];
  const selectedDimensions = normalizeStringList(formData.dimensions);
  const normalizedColumnSearchQuery = columnSearchQuery.trim().toLowerCase();
  const selectedTableColumnResults = selectedTables
    .map((tableName) => {
      const table = findBrowserTableByName(columnBrowserTables, tableName);
      if (!table) return null;
      const matchingColumns = normalizedColumnSearchQuery
        ? (table.columns || []).filter((column) =>
            String(column.name || "")
              .toLowerCase()
              .includes(normalizedColumnSearchQuery),
          )
        : table.columns || [];
      if (normalizedColumnSearchQuery && matchingColumns.length === 0) {
        return null;
      }
      return {
        table,
        logicalName: getBrowserDatasetName(table),
        matchingColumns,
      };
    })
    .filter(Boolean);

  return (
    <div className="w-full flex flex-col gap-4 sm:gap-6 relative">
      {/* Toast */}
      <ToastComponent />

      {/* Define new KPI metric form */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 shrink-0">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-base sm:text-xl md:text-2xl font-bold text-gray-900 min-w-0 whitespace-nowrap">
              Define New KPI Metric
            </h2>
            <span className="text-[10px] sm:text-xs font-semibold text-gray-500 bg-gray-50 px-2 py-0.5 rounded border border-gray-200 shadow-sm flex items-center gap-1.5 whitespace-nowrap">
              <svg
                className="w-3 h-3 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
                />
              </svg>
              {currentConnection
                ? currentConnection.name
                : "Please select a connection from the Database Connections tab"}
            </span>
            <button
              onClick={handleResetForm}
              className="text-[10px] sm:text-xs font-bold text-gray-600 bg-white hover:bg-gray-100 hover:text-gray-900 px-2 py-0.5 rounded border border-gray-300 shadow-sm flex items-center gap-1 transition-colors"
              title="Reset all fields"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Reset
            </button>
          </div>
          <div className="flex gap-2 shrink-0">
            {editingMetricId && (
              <button
                data-testid="kpi-cancel-edit"
                onClick={handleResetForm}
                className="btn-bordered shrink-0 text-xs sm:text-sm font-semibold px-4 py-1.5 rounded-[var(--theme-radius-btn)] transition-colors text-[var(--theme-text)] hover:text-[var(--theme-text)]"
              >
                Cancel Edit
              </button>
            )}
            <button
              onClick={handleCreateOrUpdateMetric}
              className="btn-primary shrink-0"
            >
              {isSubmitting
                ? "Saving..."
                : editingMetricId
                  ? "Update Metric"
                  : "+ Create Metric"}
            </button>
          </div>
        </div>

        {formError && (
          <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 sm:gap-x-8 gap-y-4 sm:gap-y-5">
          {/* LEFT COLUMN */}
          <div className="space-y-4 flex flex-col justify-between">
            <div>
              {/* Metric Name */}
              <div className="mb-4">
                <label className={labelCls}>
                  Metric Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Total Revenue"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData((p) => ({ ...p, name: e.target.value }))
                  }
                  className={inputBase}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                {/* Department */}
                <div>
                  <label className={labelCls}>Department</label>
                  <div className="relative">
                    <select
                      value={formData.department}
                      onChange={(e) =>
                        setFormData((p) => ({
                          ...p,
                          department: e.target.value,
                        }))
                      }
                      className={selectCls}
                    >
                      {departments.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </div>

                {/* Metric Type */}
                <div>
                  <label className={labelCls}>Metric Type</label>
                  <div className="relative">
                    <select
                      value={formData.type}
                      onChange={(e) =>
                        setFormData((p) => ({ ...p, type: e.target.value }))
                      }
                      className={selectCls}
                    >
                      {metricTypes.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </div>

                {/* Format */}
                <div>
                  <label className={labelCls}>Format</label>
                  <div className="relative">
                    <select
                      value={formData.format}
                      onChange={(e) =>
                        setFormData((p) => ({ ...p, format: e.target.value }))
                      }
                      className={selectCls}
                    >
                      {formatOptions.map((f) => (
                        <option key={f} value={f}>
                          {FORMAT_LABELS[f]}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                {/* Data Filters Section */}
                <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                  {/* Section header */}
                  <div className="px-4 py-2.5 bg-(--theme-theme-background) border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg
                        className="w-4 h-4 text-(--theme-primary)"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                        />
                      </svg>
                      <label className="text-sm font-bold text-gray-800">
                        Data Filters
                      </label>
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                        Optional
                      </span>
                    </div>
                  </div>

                  {/* Filter body */}
                  <div className="p-3 bg-white">
                    <datalist id="kpi-filter-field-options">
                      {filterFieldOptions.map((field) => (
                        <option key={field} value={field} />
                      ))}
                    </datalist>
                    {!filterLogic ? (
                      <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-center">
                        <p className="text-[11px] font-semibold text-gray-500">
                          No filters applied &mdash; all rows will be used.
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            handleFilterLogicChange({
                              type: "group",
                              operator: "AND",
                              children: [
                                {
                                  type: "condition",
                                  field: "",
                                  op: "eq",
                                  value: "",
                                },
                              ],
                            })
                          }
                          className="mt-2 rounded-lg border border-(--theme-chip-border) bg-(--theme-chip-bg) px-3 py-1.5 text-[11px] font-bold text-(--theme-primary) transition-colors hover:bg-(--theme-primary) hover:text-white"
                        >
                          Create Filters
                        </button>
                      </div>
                    ) : (
                      <FilterGroupCard
                        node={filterLogic}
                        onChange={handleFilterLogicChange}
                        onRemove={() => handleFilterLogicChange(null)}
                      />
                    )}

                    {/* Live summary */}
                    {buildFilterSummary(filterLogic) && (
                        <div className="mt-3 px-3 py-1.5 bg-(--theme-chip-bg)/30 border border-(--theme-chip-border)/40 rounded-lg">
                          <p className="text-[10px] text-gray-500 font-semibold flex items-center gap-1.5">
                            <svg
                              className="w-3 h-3 text-(--theme-primary) shrink-0"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                              />
                            </svg>
                            <span className="font-mono">
                              {buildFilterSummary(filterLogic)}
                            </span>
                          </p>
                        </div>
                    )}
                  </div>
                </div>

                {/* Join Configuration (if multi-table) — placed alongside filters */}
                <JoinBuilder
                  joinSpec={joinSpec}
                  onChange={setJoinSpec}
                  tables={effectiveInvolvedTables}
                  columnBrowserData={columnBrowserTables}
                  fkRelationships={fkRelationships}
                />
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="space-y-4">
            {/* Column Browser Panel */}
            {formData.connectionId && (
              <div className="mb-4 border border-gray-200 rounded-xl overflow-hidden shadow-sm">
                <button
                  onClick={() => setBrowserOpen((p) => !p)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-(--theme-theme-background) hover:bg-gray-100 transition-colors text-sm font-bold text-gray-800"
                >
                  <div className="flex items-center gap-2">
                    <svg
                      className="w-4 h-4 text-(--theme-primary)"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M4 7h16M4 12h16M4 17h7"
                      />
                    </svg>
                    Available Columns Across Tables
                    <span className="text-xs font-medium text-gray-500 ml-1">
                      — search and add tables
                    </span>
                  </div>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${browserOpen ? "" : "-rotate-90"}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>

                {browserOpen && (
                  <div className="bg-white border-t border-gray-100 flex flex-col">
                    {browserMode === "select" ? (
                      <div className="p-4 flex flex-col gap-3">
                        {/* Search Input */}
                        <div className="relative">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <svg
                              className="h-4 w-4 text-gray-400"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                              />
                            </svg>
                          </div>
                          <input
                            type="text"
                            placeholder="Search tables..."
                            value={browserSearchQuery}
                            onChange={(e) => {
                              setBrowserSearchQuery(e.target.value);
                            }}
                            className="block w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm bg-(--theme-theme-background) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40 focus:border-(--theme-primary) focus:bg-white transition-all duration-200"
                          />
                        </div>

                        {/* Tables List with Checkboxes */}
                        <div
                          ref={tableListRef}
                          className="max-h-72 overflow-y-auto pr-1 flex flex-col justify-between"
                        >
                          {loadingColumns ? (
                            <div className="space-y-2">
                              {[...Array(3)].map((_, i) => (
                                <div
                                  key={i}
                                  className="h-6 rounded bg-gray-100 animate-pulse"
                                />
                              ))}
                            </div>
                          ) : columnsStatus === ASYNC_STATUS.ERROR ? (
                            <InlineState
                              type="error"
                              title="Columns unavailable"
                              message={columnsError}
                              actionLabel="Retry"
                              onAction={() =>
                                loadColumns(formData.connectionId)
                              }
                            />
                          ) : columnBrowserTables.length === 0 ? (
                            <p className="text-sm text-gray-400 italic text-center py-2">
                              No tables found.
                            </p>
                          ) : (
                            (() => {
                              const filteredTables = columnBrowserTables.filter(
                                (t) => {
                                  const query =
                                    browserSearchQuery.toLowerCase();
                                  return [
                                    t.table_name,
                                    t.table_schema,
                                    t.logical_name,
                                    t.physical_name,
                                    getBrowserDatasetName(t),
                                  ]
                                    .filter(Boolean)
                                    .some((value) =>
                                      String(value)
                                        .toLowerCase()
                                        .includes(query),
                                    );
                                })
                                .sort((a, b) => {
                                  const nameA = getBrowserDatasetName(a);
                                  const nameB = getBrowserDatasetName(b);
                                  const isSelectedA = committedSelectedTables.includes(nameA);
                                  const isSelectedB = committedSelectedTables.includes(nameB);
                                  if (isSelectedA && !isSelectedB) return -1;
                                  if (!isSelectedA && isSelectedB) return 1;
                                  return nameA.localeCompare(nameB);
                                });

                              return filteredTables.length === 0 ? (
                                <p className="text-sm text-gray-400 italic text-center py-2">
                                  No matches found.
                                </p>
                              ) : (
                                <div className="flex flex-col h-full overflow-x-hidden">
                                  <div className="space-y-1">
                                    {filteredTables.map((t) => {
                                      const logicalName =
                                        getBrowserDatasetName(t);
                                      const isSelected =
                                        selectedTables.includes(logicalName);
                                      return (
                                        <label
                                          key={logicalName}
                                          className={`flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all ${isSelected ? "bg-blue-50/50 border border-blue-200/60 shadow-sm" : "hover:bg-gray-50 border border-transparent"}`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={isSelected}
                                            onChange={(e) => {
                                              if (e.target.checked) {
                                                setSelectedTables([
                                                  ...selectedTables,
                                                  logicalName,
                                                ]);
                                                setExpandedTables((prev) => ({
                                                  ...prev,
                                                  [logicalName]: true,
                                                }));
                                              } else {
                                                setSelectedTables(
                                                  selectedTables.filter(
                                                    (name) =>
                                                      name !== logicalName,
                                                  ),
                                                );
                                              }
                                            }}
                                            className="w-4 h-4 mt-0.5 text-(--theme-primary) border-gray-300 rounded focus:ring-(--theme-primary) focus:ring-offset-0"
                                          />
                                          <div className="flex items-start gap-2 flex-1 min-w-0">
                                            <svg
                                              className={`w-4 h-4 mt-0.5 shrink-0 transition-colors ${isSelected ? "text-blue-500" : "text-gray-400"}`}
                                              fill="none"
                                              viewBox="0 0 24 24"
                                              stroke="currentColor"
                                              strokeWidth={1.5}
                                            >
                                              <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"
                                              />
                                            </svg>
                                            <span
                                              className={`text-sm font-medium transition-colors break-words whitespace-normal min-w-0 flex-1 ${isSelected ? "text-blue-900" : "text-gray-700"}`}
                                            >
                                              {t.table_name}
                                            </span>
                                            <span className="text-xs shrink-0 text-gray-400 ml-auto bg-white px-1.5 py-0.5 rounded border border-gray-100">
                                              {t.columns.length} cols
                                            </span>
                                          </div>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()
                          )}
                        </div>

                        {/* Show Columns Button */}
                        <div className="pt-3 border-t border-gray-100 mt-1">
                          <button
                            type="button"
                            disabled={selectedTables.length === 0}
                            onClick={() => {
                              setCommittedSelectedTables([...selectedTables]);
                              setColumnSearchQuery("");
                              setBrowserMode("columns");
                            }}
                            className="w-full rounded-lg bg-(--theme-primary) py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-(--theme-primary-hover) disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Show Columns ({selectedTables.length} selected)
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 flex flex-col gap-3">
                        {/* Back Button */}
                        <div className="flex items-center gap-2 border-b border-(--theme-border) pb-2">
                          <button
                            type="button"
                            onClick={() => {
                              setColumnSearchQuery("");
                              setBrowserMode("select");
                            }}
                            className="flex items-center gap-1 text-sm font-medium text-(--theme-text-muted) transition-colors hover:text-(--theme-primary)"
                          >
                            <svg
                              className="w-4 h-4"
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
                            Back to Tables
                          </button>
                          <span className="ml-auto text-xs text-(--theme-text-muted)">
                            {selectedTables.length} tables selected
                          </span>
                        </div>

                        {/* Column Search */}
                        <div className="relative">
                          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                            <svg
                              className="h-4 w-4 text-(--theme-text-muted)"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                              />
                            </svg>
                          </div>
                          <input
                            type="text"
                            role="searchbox"
                            value={columnSearchQuery}
                            onChange={(event) =>
                              setColumnSearchQuery(event.target.value)
                            }
                            aria-label="Search selected table columns"
                            placeholder="Search columns by name..."
                            className="block w-full rounded-lg border border-(--theme-input-border) bg-(--theme-input-bg) py-2 pl-9 pr-9 text-sm text-(--theme-text) placeholder:text-(--theme-text-muted) focus:border-(--theme-primary) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/20"
                          />
                          {columnSearchQuery && (
                            <button
                              type="button"
                              onClick={() => setColumnSearchQuery("")}
                              aria-label="Clear column search"
                              className="absolute inset-y-0 right-0 flex items-center px-3 text-(--theme-text-muted) hover:text-(--theme-primary)"
                            >
                              &times;
                            </button>
                          )}
                        </div>

                        {/* Selected Tables and Columns */}
                        <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
                          {selectedTableColumnResults.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-(--theme-border) bg-(--theme-container-bg) px-3 py-5 text-center">
                              <p className="text-sm font-semibold text-(--theme-text)">
                                No matching columns
                              </p>
                              <p className="mt-1 text-xs text-(--theme-text-muted)">
                                Try a different column name.
                              </p>
                            </div>
                          ) : (
                            selectedTableColumnResults.map(
                              ({ table: tbl, logicalName, matchingColumns }) => {
                                const columnsExpanded =
                                  Boolean(normalizedColumnSearchQuery) ||
                                  expandedTables[logicalName];
                                return (
                                  <div
                                    key={logicalName}
                                    className="rounded-lg border border-(--theme-border) bg-(--theme-container-bg) p-2"
                                  >
                                <div className="flex items-center justify-between mb-1.5">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setExpandedTables((p) => ({
                                        ...p,
                                        [logicalName]: !p[logicalName],
                                      }))
                                    }
                                    aria-expanded={Boolean(columnsExpanded)}
                                    className="flex flex-1 items-center gap-1.5 text-xs font-bold text-(--theme-text) transition-colors hover:text-(--theme-primary)"
                                  >
                                    <svg
                                      className={`h-3.5 w-3.5 text-(--theme-text-muted) transition-transform ${columnsExpanded ? "" : "-rotate-90"}`}
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={2}
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M19 9l-7 7-7-7"
                                      />
                                    </svg>
                                    <svg
                                      className="h-4 w-4 text-(--theme-primary)"
                                      fill="none"
                                      viewBox="0 0 24 24"
                                      stroke="currentColor"
                                      strokeWidth={1.5}
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                                      />
                                    </svg>
                                    {tbl.table_name}
                                    <span className="font-normal text-(--theme-text-muted)">
                                      ({matchingColumns.length}
                                      {normalizedColumnSearchQuery
                                        ? ` of ${tbl.columns.length}`
                                        : ""}
                                      )
                                    </span>
                                  </button>
                                </div>
                                {columnsExpanded && (
                                  <div className="flex flex-wrap gap-1.5 ml-6 mt-2">
                                    {matchingColumns.map((col) => (
                                      <button
                                        key={col.name}
                                        type="button"
                                        draggable
                                        onDragStart={(e) => {
                                          const columnRef = `${logicalName}.${col.name}`;
                                          e.dataTransfer.setData(
                                            "application/x-kpi-column",
                                            columnRef,
                                          );
                                          e.dataTransfer.setData(
                                            "text/plain",
                                            columnRef,
                                          );
                                          e.dataTransfer.effectAllowed = "copy";
                                        }}
                                        onClick={() =>
                                          insertColumn(logicalName, col.name)
                                        }
                                        title={`Drag or click to insert: ${logicalName}.${col.name} (${col.data_type})`}
                                        className="group inline-flex cursor-grab items-center gap-1.5 rounded-lg border border-(--theme-border) bg-(--theme-card-bg) px-2.5 py-1 text-xs font-semibold text-(--theme-text) shadow-sm transition-all hover:border-(--theme-primary) hover:text-(--theme-primary) hover:shadow active:scale-95 active:cursor-grabbing"
                                      >
                                        <svg
                                          className="h-3 w-3 text-(--theme-text-muted) transition-colors group-hover:text-(--theme-primary)"
                                          fill="none"
                                          viewBox="0 0 24 24"
                                          stroke="currentColor"
                                        >
                                          <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={2}
                                            d="M4 6h16M4 10h16M4 14h16M4 18h16"
                                          />
                                        </svg>
                                        {col.name}
                                        {col.is_primary_key && (
                                          <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-extrabold text-amber-700">
                                            PK{col.is_auto_increment ? " · AI" : ""}
                                          </span>
                                        )}
                                        <span className="ml-1 font-mono text-[10px] font-normal text-(--theme-text-muted) group-hover:text-(--theme-primary)">
                                          {col.data_type}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                                  </div>
                                );
                              },
                            )
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Formula */}
            <div>
              <label className={labelCls}>
                Calculation Formula <span className="text-red-500">*</span>
              </label>
              <textarea
                ref={formulaRef}
                data-testid="kpi-formula-dropzone"
                rows={5}
                placeholder="e.g. SUM(table_name.column_name) - drag and drop a column here"
                value={formData.formula}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, formula: e.target.value }))
                }
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const columnRef = getDraggedColumnRef(e);
                  if (!columnRef) return;
                  insertTextAtCursor("formula", e.currentTarget, columnRef);
                }}
                className={`${inputBase} font-mono resize-y`}
              />
              {/* Show selected or inferred scope badge if formula is not empty */}
              {formData.formula && effectiveInvolvedTables.length === 1 && (
                <div className="mt-2 inline-block px-2 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded text-xs font-semibold shadow-sm">
                  [Table - {toSafeText(effectiveInvolvedTables[0])}]
                </div>
              )}
              {formData.formula && effectiveInvolvedTables.length > 1 && (
                <div className="mt-2 inline-block px-2 py-1 bg-purple-50 text-purple-700 border border-purple-200 rounded text-xs font-semibold shadow-sm">
                  [Cross-Tables -{" "}
                  {effectiveInvolvedTables
                    .map((table) => toSafeText(table))
                    .join(", ")}
                  ]
                </div>
              )}
            </div>

            {/* Dimensions */}
            <div>
              <label className={labelCls}>
                Dimensions{" "}
                <span className="font-normal text-(--theme-text-muted)">
                  ({selectedDimensions.length} selected)
                </span>
              </label>
              <DimensionSelectionList
                options={filterFieldOptions}
                selected={selectedDimensions}
                onChange={handleDimensionsChange}
                disabled={!formData.connectionId || loadingColumns}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Metrics list */}
      {(metrics.length > 0 ||
        loadingInit ||
        initStatus === ASYNC_STATUS.ERROR ||
        (!loadingInit && metrics.length === 0)) && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4 sm:mb-6">
            <h2 className="text-base sm:text-xl md:text-2xl font-bold text-gray-900 wrap-break-word shrink-0">
              KPI Metrics
            </h2>
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              {metrics.length > 0 && (
                <div className="flex gap-2">
                  <div className="relative">
                    <select
                      value={filterDept}
                      onChange={(e) => {
                        setFilterDept(e.target.value);
                        setCurrentPage(1);
                      }}
                      className={`${selectCls} pr-8 py-1.5 min-h-[36px] text-sm`}
                    >
                      <option value="All Departments">All Departments</option>
                      {departments.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </div>
              )}
              {filteredMetrics.length > 0 && (
                <div className="relative">
                  <select
                    value={metricPageSizeOverride}
                    onChange={(e) => {
                      setMetricPageSizeOverride(e.target.value);
                      setCurrentPage(1);
                    }}
                    className={`${selectCls} pr-8 py-1.5 min-h-[36px] text-sm`}
                  >
                    <option value="auto">Auto page size</option>
                    <option value="4">4 per page</option>
                    <option value="8">8 per page</option>
                    <option value="12">12 per page</option>
                  </select>
                  <ChevronDown />
                </div>
              )}
              {filteredMetrics.length > 0 && (
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
          </div>

          {loadingInit ? (
            <InlineState
              type="loading"
              title="Loading KPI metrics"
              message="Fetching saved metrics and connections."
            />
          ) : initStatus === ASYNC_STATUS.ERROR ? (
            <InlineState
              type="error"
              title="KPI metrics unavailable"
              message={initError}
              actionLabel="Retry"
              onAction={loadInitialData}
            />
          ) : filteredMetrics.length === 0 ? (
            <InlineState
              type="empty"
              title={
                metrics.length === 0
                  ? "No metrics yet"
                  : "No metrics for this department"
              }
              message={
                metrics.length === 0
                  ? "Create one above to start using KPI-driven analytics."
                  : "Change the department filter to see more metrics."
              }
            />
          ) : (
            <div className="space-y-4">
              {pagedMetrics.map((metric) => (
                <div
                  key={metric.id}
                  className="relative border border-gray-200 rounded-xl p-4 bg-(--theme-theme-background) hover:bg-(--theme-scrollbar-thumb) hover:border-gray-300 hover:shadow-sm transition-all duration-200"
                >
                  {/* Header row with flex layout to prevent overlap */}
                  <div className="flex justify-between items-start gap-4 mb-2">
                    <div className="flex flex-wrap items-baseline gap-2 flex-grow min-w-0">
                      <span className="font-semibold text-gray-900 text-sm sm:text-base break-words">
                        {toSafeText(metric.metric_name)}
                      </span>
                      <span className="text-xs text-gray-500 font-mono whitespace-nowrap">
                        ({toSafeText(metric.connection_name)})
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${DEPT_COLORS[metric.department] || "bg-gray-100 text-gray-600"}`}
                      >
                        {toSafeText(metric.department).toLowerCase()}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[metric.metric_type] || "bg-gray-100 text-gray-600"}`}
                      >
                        {toSafeText(
                          TYPE_SHORT[metric.metric_type] || metric.metric_type,
                        )}
                      </span>
                      {/* Render badge for saved metrics based on involved_tables */}
                      {metric.involved_tables &&
                        metric.involved_tables.length === 1 && (
                          <span className="px-2 py-0.5 rounded text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200 font-mono">
                            [Table - {toSafeText(metric.involved_tables[0])}]
                          </span>
                        )}
                      {metric.involved_tables &&
                        metric.involved_tables.length > 1 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="px-2 py-0.5 rounded text-xs font-semibold bg-purple-50 text-purple-700 border border-purple-200 font-mono break-all sm:break-normal">
                              [Cross-Table KPI -{" "}
                              {metric.involved_tables
                                .map((table) => toSafeText(table))
                                .join(", ")}
                              ]
                            </span>
                            {(!metric.join_spec ||
                              metric.join_spec.length === 0) && (
                              <span
                                className="px-2 py-0.5 rounded text-[10px] font-bold bg-chip-bg text-chip-text border border-chip-border shadow-sm flex items-center gap-1"
                                title="AI automatically generates the JOIN schema for this metric"
                              >
                                AI will handle JOIN for this cross table
                              </span>
                            )}
                          </div>
                        )}
                      {metric.format && metric.format !== "number" && (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-100">
                          {toSafeText(metric.format)}
                        </span>
                      )}
                    </div>

                    {editingMetricId === metric.id ? (
                      <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-1 rounded border border-primary/20 shadow-sm animate-pulse">
                        Editing...
                      </span>
                    ) : (
                      <div className="flex-shrink-0 flex gap-1 z-10">
                        {confirmingRemoveId === metric.id ? (
                          <>
                            <button
                              onClick={() => handleRemove(metric.id)}
                              className="text-[10px] font-semibold bg-red-600 text-white rounded-md px-2 py-0.5 hover:bg-red-700 transition-colors shadow-sm"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmingRemoveId(null)}
                              className="text-[10px] font-semibold bg-gray-200 text-gray-700 rounded-md px-2 py-0.5 hover:bg-gray-300 transition-colors shadow-sm"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              data-testid={`kpi-edit-${metric.id}`}
                              disabled={!!editingMetricId}
                              onClick={() => handleEdit(metric)}
                              className={`text-[10px] font-semibold border rounded-md px-2 py-0.5 shadow-sm flex items-center gap-1 transition-colors ${
                                editingMetricId
                                  ? "bg-theme-background text-text-muted border-theme-border cursor-not-allowed opacity-50"
                                  : "bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200 hover:text-gray-900"
                              }`}
                            >
                              <svg
                                className="w-3 h-3"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                                />
                              </svg>
                              Edit
                            </button>
                            <button
                              disabled={!!editingMetricId}
                              onClick={() => setConfirmingRemoveId(metric.id)}
                              className={`text-[10px] font-semibold rounded-md px-2 py-0.5 shadow-sm transition-colors ${
                                editingMetricId
                                  ? "bg-theme-background text-text-muted cursor-not-allowed opacity-50 border border-theme-border"
                                  : "bg-red-500 text-white hover:bg-red-600"
                              }`}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Formula */}
                  <div className="bg-(--theme-scrollbar-thumb) rounded-md px-3 py-2 mb-3 font-mono text-xs text-gray-800 border border-[#DDDBD5] break-words whitespace-pre-wrap">
                    {toSafeText(metric.formula)}
                  </div>

                  {/* Dimensions */}
                  {getQualifiedMetricDimensions(metric).length > 0 && (
                    <div className="mb-2">
                      <span className="text-xs font-semibold text-gray-700">
                        Dimensions:
                      </span>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {getQualifiedMetricDimensions(metric).map((dim) => (
                          <span
                            key={dim}
                            className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-xs font-medium border border-blue-100"
                          >
                            {toSafeText(dim)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Filter Logic AST */}
                  {metric.filter_logic &&
                    metric.filter_logic.children &&
                    metric.filter_logic.children.length > 0 && (
                      <div className="mt-2 p-2 bg-gray-50 border border-gray-100 rounded-lg shadow-inner">
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">
                          Filters
                        </p>
                        {renderAST(
                          qualifyFilterLogic(
                            metric.filter_logic,
                            normalizeStringList(metric.involved_tables),
                          ),
                        )}
                      </div>
                    )}

                  {/* Join Specification */}
                  {metric.join_spec && metric.join_spec.length > 0 && (
                    <div className="mt-2 p-2 bg-amber-50/30 border border-amber-100 rounded-lg">
                      <p className="text-[10px] font-bold text-amber-700/70 uppercase tracking-wider mb-1 flex items-center gap-1">
                        <svg
                          className="w-3 h-3 text-amber-500"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                          />
                        </svg>
                        Join Spec
                      </p>
                      <div className="space-y-1">
                        {metric.join_spec.map((j, idx) => (
                          <div
                            key={idx}
                            className="text-xs font-mono text-gray-700 bg-white px-2 py-1 rounded border border-amber-100/50"
                          >
                            <span className="mb-1 inline-block rounded bg-amber-50 px-1 font-bold text-amber-600">
                              {toSafeText(j.type || j.join_type || "INNER").toUpperCase()} JOIN
                            </span>
                            <div className="space-y-1">
                              {getJoinConditions(j).map((condition, conditionIndex) => (
                                <div key={conditionIndex} className="flex flex-wrap items-center gap-1.5">
                                  <span className="w-8 text-[10px] font-bold text-gray-400">{conditionIndex === 0 ? "ON" : "AND"}</span>
                                  <span className="text-blue-600">
                                    {toSafeText(condition.leftTable || j.leftTable || j.left_table)}.{toSafeText(condition.leftColumn || condition.left_column)}
                                  </span>
                                  <span className="font-bold text-gray-400">=</span>
                                  <span className="text-purple-600">
                                    {toSafeText(condition.rightTable || j.rightTable || j.right_table)}.{toSafeText(condition.rightColumn || condition.right_column)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default KpiDefinitions;
