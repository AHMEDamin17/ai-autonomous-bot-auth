import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import Dashboard from "./components/pages/Dashboard";
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import Footer from "./components/layout/Footer";
import SemanticTab from "./components/pages/semanticLayer/SemanticTab";
import ErrorBoundary from "./components/layout/ErrorBoundary";
import Loading from "./utils/Loading";

const isChunkLoadError = (error) => (
  /Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed/i
    .test(error?.message || "")
);

const lazyWithRetry = (loader, chunkName) => lazy(async () => {
  try {
    const module = await loader();
    sessionStorage.removeItem(`retry-${chunkName}`);
    return module;
  } catch (error) {
    if (isChunkLoadError(error)) {
      console.warn(`Unable to load ${chunkName}. Retrying...`, error);
      const cacheKey = `retry-${chunkName}`;
      if (!sessionStorage.getItem(cacheKey)) {
        sessionStorage.setItem(cacheKey, 'true');
        window.location.reload();
        await new Promise(() => {}); // Wait forever while reloading
      } else {
        sessionStorage.removeItem(cacheKey);
      }
    }
    throw error;
  }
});

const DatabaseConnections = lazyWithRetry(
  () => import("./components/pages/semanticLayer/tabs/DatabaseConnections"),
  "DatabaseConnections",
);
const KpiDefinitions = lazyWithRetry(
  () => import("./components/pages/semanticLayer/tabs/KpiDefinitions"),
  "KpiDefinitions",
);
const SemanticModelManager = lazyWithRetry(
  () => import("./components/pages/semanticLayer/tabs/SemanticModelManager"),
  "SemanticModelManager",
);
// const LLMClassification = lazyWithRetry(
//   () => import("./components/pages/semanticLayer/tabs/LLMClassification"),
//   "LLMClassification",
// );
// const AnalyticsAssistant = lazyWithRetry(
//   () => import("./components/pages/semanticLayer/tabs/AnalyticsAssistant"),
//   "AnalyticsAssistant",
// );
// const ObservabilityDashboard = lazyWithRetry(
//   () => import("./components/pages/semanticLayer/tabs/ObservabilityDashboard"),
//   "ObservabilityDashboard",
// );
const withRouteBoundary = (element) => (
  <ErrorBoundary>
    {element}
  </ErrorBoundary>
);

export default function App() {
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <ErrorBoundary>
      <div className="bg-dashboard min-h-dvh overflow-x-hidden flex flex-col">
        <Sidebar />
        {!isHome && <Header />}
        <main className={`flex-1 overflow-x-hidden overflow-y-auto relative ${isHome ? "pt-16" : ""}`}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={withRouteBoundary(<Dashboard />)} />
              <Route path="/Analytics" element={<Navigate to="/" replace />} />
              <Route path="/Layer" element={withRouteBoundary(<SemanticTab />)}>
                <Route index element={<Navigate to="DBConnections" replace />} />
                <Route path="DBConnections" element={withRouteBoundary(<DatabaseConnections />)} />
                <Route path="SemanticModels" element={withRouteBoundary(<SemanticModelManager />)} />
                <Route path="KPIMetrics" element={withRouteBoundary(<KpiDefinitions />)} />
                {/* <Route path="LLMClassification" element={withRouteBoundary(<LLMClassification />)} /> */}
                {/* <Route path="AnalyticsAI" element={withRouteBoundary(<AnalyticsAssistant />)} /> */}
                {/* <Route path="Observability" element={withRouteBoundary(<ObservabilityDashboard />)} /> */}
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
        <Footer />
      </div>
    </ErrorBoundary>
  );
}
