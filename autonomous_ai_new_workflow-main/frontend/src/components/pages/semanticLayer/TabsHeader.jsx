import { NavLink } from "react-router-dom";

const tabStyle =
  "whitespace-nowrap py-3 sm:py-4 px-1 border-b-2 font-medium text-xs sm:text-sm transition-all duration-200";

const activeStyle =
  "border-(--theme-chip-text) text-(--theme-primary) font-semibold";
const inactiveStyle =
  "border-transparent text-gray-500 hover:text-gray-900 shadow-none";

const tabs = [
  { path: "DBConnections", label: "Database Connections" },
  { path: "SemanticModels", label: "Semantic Models" },
  { path: "KPIMetrics", label: "KPI Definitions" },
  // { path: "LLMClassification", label: "LLM Classification" },
  // { path: "AnalyticsAI", label: "Analytics AI" },
  // { path: "Observability", label: "Observability" },
];

export default function TabsHeader() {
  return (
    <nav
      className="-mb-px flex min-w-0 space-x-4 overflow-x-auto sm:space-x-8"
      aria-label="Tabs"
      style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.path}
          to={tab.path}
          className={({ isActive }) => `${tabStyle} ${isActive ? activeStyle : inactiveStyle}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
