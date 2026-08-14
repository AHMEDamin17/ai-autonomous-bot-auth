import { useToast } from "../../../../hooks/useToast";
import { useState, useEffect } from "react";
import { getConnections, getKpiMetrics } from "../../../../api/services";

const DEPT_COLORS = {
  Audit: "bg-slate-100 text-slate-700",
  Finance: "bg-blue-100 text-blue-700",
  Sales: "bg-green-100 text-green-700",
  Marketing: "bg-pink-100 text-pink-700",
  Operations: "bg-orange-100 text-orange-700",
  "Human Resources": "bg-purple-100 text-purple-700",
  Engineering: "bg-cyan-100 text-cyan-700",
};

const DEPARTMENTS = [
  "Audit",
  "Finance",
  "Sales",
  "Marketing",
  "Operations",
  "Human Resources",
  "Engineering",
];

const labelCls = "block text-sm font-semibold text-gray-700 mb-1";
const inputCls =
  "w-full px-3 py-2 border border-gray-200 rounded-xl text-sm bg-(--theme-theme-background) focus:outline-none focus:ring-2 focus:ring-(--theme-primary)/40 focus:border-(--theme-primary) focus:bg-white transition-all duration-200";
const btnPrimary =
  "px-3 py-1.5 rounded-md !bg-(--theme-primary) text-white text-sm font-medium hover:!bg-(--theme-primary-hover) transition-colors duration-200 shrink-0 whitespace-nowrap";
const btnSecondary =
  "px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-sm font-medium bg-(--theme-theme-background) hover:bg-(--theme-scrollbar-thumb) transition-colors duration-200 shrink-0 whitespace-nowrap";

const Chevron = () => (
  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
    <svg
      className="h-4 w-4 text-gray-500"
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

const LLMClassification = () => {
  const [query, setQuery] = useState("");
  const [selectedConn, setSelectedConn] = useState("");
  const [recDept, setRecDept] = useState("Audit");
  const [connections, setConnections] = useState([]);
  const [allMetrics, setAllMetrics] = useState([]);
  const [recommendedMetrics, setRecommendedMetrics] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [isClassifying, setIsClassifying] = useState(false);
  const [isTagging, setIsTagging] = useState(false);
  const { showToast, ToastComponent } = useToast();

  

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [conns, metrics] = await Promise.all([
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
        setAllMetrics(metrics);
      } catch (err) {
        console.error("Failed to fetch data", err);
        showToast("Failed to load connections or metrics", true);
      }
    };
    fetchData();
  }, [showToast]);

  const handleClassify = () => {
    if (isClassifying || !query.trim()) return;
    setIsClassifying(true);
    // ⚠️ MOCK IMPLEMENTATION: TODO: Replace with `/api/llm/classify` endpoint when backend is ready.
    setTimeout(() => {
      setIsClassifying(false);
      showToast("Classification complete. No matching objects found.");
    }, 800);
  };

  const handleTagging = () => {
    if (isTagging || !selectedConn) {
      if (!selectedConn) showToast("Please select a connection first.", true);
      return;
    }
    setIsTagging(true);
    setTimeout(() => {
      setIsTagging(false);
      showToast("Auto-tagging complete.");
    }, 1200);
  };

  const handleGenerateRecommendations = () => {
    if (isGenerating) return;
    setIsGenerating(true);
    setHasGenerated(true);
    // Simulate AI thinking then pull from allMetrics
    setTimeout(() => {
      const filtered = allMetrics.filter((m) => m.department === recDept);
      setRecommendedMetrics(filtered.map(m => ({
        id: m.id,
        name: m.metric_name,
        department: m.department,
        formula: m.formula
      })));
      setIsGenerating(false);
    }, 600);
  };

  return (
    <div className="w-full relative">
      <ToastComponent />
      <div className="flex flex-col gap-4 sm:gap-6 pb-6 max-w-7xl mx-auto">
        {/* Discovery query section */}
        <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 shrink-0">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-base sm:text-xl md:text-2xl font-bold text-gray-900">
                LLM-Powered Classification & Discovery
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 mt-1">
                Use natural language to discover metrics, tables, and semantic
                objects across your data
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className={labelCls}>Natural Language Query</label>
              <textarea
                rows={3}
                placeholder="e.g. Find metrics related to a catalog concept"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={`${inputCls} resize-y font-mono`}
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <button className={btnPrimary} onClick={handleClassify}>
                {isClassifying ? "Classifying..." : "Classify & Discover"}
              </button>
              <button className={btnSecondary} onClick={() => setQuery("")}>
                Clear Results
              </button>
            </div>
          </div>
        </div>

        {/* Tagging and recommendations section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 md:gap-8 items-start">
          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <div className="mb-5">
              <h2 className="text-base sm:text-xl font-bold text-gray-900 mb-1">
                Auto-Tag Tables & Columns
              </h2>
              <p className="text-xs sm:text-sm text-gray-500">
                Use LLM to automatically classify and tag database objects with
                business context
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className={labelCls}>Connection</label>
                <div className="relative">
                  <select
                    value={selectedConn}
                    onChange={(e) => setSelectedConn(e.target.value)}
                    className={`${inputCls} appearance-none cursor-pointer`}
                  >
                    <option value="">Select Connection</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>

              <button className={btnPrimary} onClick={handleTagging}>
                {isTagging ? "Tagging..." : "Start Auto-Tagging"}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <div className="mb-5">
              <h2 className="text-base sm:text-xl font-bold text-gray-900 mb-1">
                Metric Recommendations
              </h2>
              <p className="text-xs sm:text-sm text-gray-500">
                Get AI-powered suggestions for new KPIs based on your data
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className={labelCls}>Department</label>
                <div className="relative">
                  <select
                    value={recDept}
                    onChange={(e) => setRecDept(e.target.value)}
                    className={`${inputCls} appearance-none cursor-pointer`}
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  <Chevron />
                </div>
              </div>

              <button
                className={btnPrimary}
                onClick={handleGenerateRecommendations}
              >
                {isGenerating ? "Generating..." : "Generate Recommendations"}
              </button>

              {recommendedMetrics.length > 0 ? (
                <div className="mt-6 pt-6 border-t border-gray-100 space-y-3">
                  <h3 className="text-sm font-bold text-gray-800 mb-2">
                    Recommended Metrics for {recDept}
                  </h3>
                  {recommendedMetrics.map((m) => (
                    <div
                      key={m.id}
                      className="p-3 rounded-lg bg-(--theme-theme-background) border border-gray-200 hover:border-(--theme-primary) transition-all duration-200"
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-sm font-bold text-gray-900">
                          {m.name}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${DEPT_COLORS[m.department]}`}
                        >
                          {m.department}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 line-clamp-2 italic">
                        {m.formula}
                      </p>
                    </div>
                  ))}
                </div>
              ) : hasGenerated && !isGenerating ? (
                <div className="mt-6 pt-6 border-t border-gray-100 flex flex-col items-center text-center">
                  <p className="text-sm text-gray-400 italic">
                    No recommended metrics found for {recDept}.
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LLMClassification;
