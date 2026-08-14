import React, { useEffect, useRef, useState } from "react";
import PromptDialog from "./PromptDialog";
import Header from "../../layout/Header";
import FilterPanel from "../../layout/FilterPanel";
import BottomPromptBar from "./BottomPromptBar";
import RenderChart from "../../charts/RenderChart";
import UserIcon from "../../../assets/user-icon.png";
import { useDispatch, useSelector } from "react-redux";
import {
  addFollowup,
  addNewTab,
  setActiveTab,
} from "../../../reducers/analyticsSlice";
import { Tab } from "./Tab";
import { useNavigate } from "react-router-dom";
import { getApiErrorMessage, runQueryAPI } from "../../../api/services";

function AnalyticsPage({ tab }) {
  if (!tab || tab.length === 0) return null;

  const summary = tab?.data?.summary || tab?.data?.insight?.answer || "";

  // const sumByKpi = (arr, kpi) => arr.reduce((total, item) => total + (Number(item[kpi]) || 0), 0);
  // const kpi_col = chart_suggestion?.kpi_col || "";

  // const hasData = data.length > 0 || previous_data.length > 0;

  // const currentSum = data.length > 0 ? sumByKpi(data, kpi_col) : 0;
  // const previousSum = previous_data.length > 0 ? sumByKpi(previous_data, kpi_col) : 0;

  // const getPercentageChange = (current, previous) => {
  // if (previous  0) return 0;
  // return ((current - previous) / previous) * 100;
  // };

  // const metricsList = hasData ? [
  // {
  // center: kpi_name,
  // current: Number(currentSum.toFixed(2)),
  // previous: Number(previousSum.toFixed(2)),
  // change: Number(getPercentageChange(currentSum, previousSum).toFixed(2))
  // }
  // ] : [];

  return (
    <div className="px-2 py-2">
      <div
        className={`
        rounded-[22px]
        flex flex-col
        w-full
        gap-2
      `}
      >
        {/* Follow up question */}
        {tab?.data && (
          <div className="flex justify-end px-2 py-1 pb-1">
            <div
              className="
                max-w-[420px]
                bg-white
                border border-(--theme-border)
                rounded-b-2xl
                rounded-tl-2xl
                px-4 py-3
                shadow-sm
                text-right
              "
            >
              <p className="text-[13px] font-medium text-slate-800 leading-snug whitespace-pre-wrap">
                {tab.prompt.trim()}
              </p>
            </div>

            <div className="shrink-0 my-auto ml-3">
              <div className="h-8 w-8 rounded-full overflow-hidden">
                <img
                  src={UserIcon}
                  alt="User-icon"
                  className="h-full w-full object-cover"
                />
              </div>
            </div>
          </div>
        )}

        {/* Chart display */}
        {tab?.error ? (
          <div
            className="
              bg-white
              border border-slate-200
              rounded-xl
              px-4 py-2
              bg-slate-50
            "
          >
            <p className="text-[13px] leading-tight text-slate-700 whitespace-pre-wrap">
              {tab?.errorMessage || ""}
            </p>
          </div>
        ) : (
          <>
            {/* AI summary display */}
            <div
              className="
              bg-white
              border border-slate-200
              rounded-xl
              px-4 py-2
              bg-slate-50
              flex flex-wrap
            "
            >
              <div className="basis-full md:basis-8/12">
                <p className="text-[13px] leading-tight text-slate-700 whitespace-pre-wrap">
                  {summary?.replace(/\n{2,}/g, "\n").trim() ||
                    "Summary data not found."}
                </p>
              </div>
              {/* {
                metricsList.length > 0 && 
                <div className="basis-full md:basis-4/12 my-2 p-4 bg-white shadow-[0_2px_8px_rgba(0,0,0,0.1)] border-l-4 border-(--theme-accent) rounded-md grid  place-content-center gap-4 py-2">
                  {metricsList.map((item, idx) => (
                    <div
                      key={idx}
                      className="text-center"
                    >
                      <p className="mb-2 text-(--theme-text-muted) text-[13px] ">
                        {item.center}
                      </p>

                      <p className="mb-2 text-(--theme-text) text-[13px] font-bold">
                        <span className="text-(--theme-text)">Current:</span> <span className="text-(--theme-text-muted)">{item.current} </span>  
                        <span className="text-(--theme-text-muted)">{" | "}</span> 
                        <span className="text-(--theme-text)">Previous:</span> <span className="text-(--theme-text-muted)">{item.previous}</span>
                      </p>

                      <p
                        className={`m-0 text-[12px] font-bold ${
                          item.change >= 0 ? 'text-(--theme-primary)' : 'text-(--theme-accent)'
                        }`}
                      >
                        {item.change >= 0 ? '↑' : '↓'} {item.change}% Change
                      </p>
                    </div>
                  ))}
                </div>
              } */}
            </div>

            {tab?.data && tab?.data?.data?.rows?.length > 0 && (
              <div
                className="
                rounded-xl
                bg-white
                w-full
                border border-slate-200  
                "
              >
                <RenderChart responseData={tab?.data} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function Analytics() {
  const [showPromptDialog, setShowPromptDialog] = useState(false);
  const [prompt, setPrompt] = useState("");

  const [showFilters, setShowFilters] = useState(false);
  // const [history, setHistory] = useState([]);
  const [isNewTabPrompt, setIsNewTabPrompt] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");

  const [bottomLoading, setBottomLoading] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);
  const [pendingNavigationTabId, setPendingNavigationTabId] = useState(null);

  const { conversations, activeTabId, tabOrder } = useSelector(
    (state) => state.analytics,
  );

  const dispatch = useDispatch();
  const navigate = useNavigate();

  const activeTab = conversations[activeTabId] || [];

  useEffect(() => {
    if (
      pendingNavigationTabId &&
      activeTabId === pendingNavigationTabId &&
      conversations[pendingNavigationTabId]
    ) {
      navigate("/Analytics");
      setPendingNavigationTabId(null);
    }
  }, [activeTabId, conversations, navigate, pendingNavigationTabId]);

  const onGenerate = async (query, options = {}) => {
    const { isFollowUp = false, isFilterApplied = false, filters = [] } = options;
    if (!query.trim() || bottomLoading || tabLoading) return;

    if (isNewTabPrompt) {
      setTabLoading(true);
    } else {
      setBottomLoading(true);
    }
    if (isFilterApplied) {
      setFilterQuery(query);
      scrollToBottom();
    }
    const shouldCreateNewTab = isNewTabPrompt || !activeTabId || !conversations[activeTabId] || !isFollowUp;
    const tabID = shouldCreateNewTab ? `tab-${crypto.randomUUID()}` : activeTabId;
    try {
      const data = await runQueryAPI(query, { filters });

      const message = {
        id: crypto.randomUUID(),
        prompt: query,
        data,
        filters,
      };

      if (shouldCreateNewTab) {
        dispatch(
          addNewTab({
            tabId: tabID,
            message,
          }),
        );
        dispatch(setActiveTab(tabID));
        setPendingNavigationTabId(tabID);
      } else {
        dispatch(
          addFollowup({
            tabId: tabID,
            message,
          }),
        );
      }
      setShowPromptDialog(false);
    } catch (err) {
      console.error("API error", err);
      const message = {
        id: crypto.randomUUID(),
        prompt: query,
        error: true,
        errorMessage: getApiErrorMessage(err, "Unknown error. Please try again."),
        filters,
      };
      if (shouldCreateNewTab) {
        dispatch(
          addNewTab({
            tabId: tabID,
            message,
          }),
        );
        dispatch(setActiveTab(tabID));
        setPendingNavigationTabId(tabID);
      } else {
        dispatch(
          addFollowup({
            tabId: tabID,
            message,
          }),
        );
      }
    } finally {
      setBottomLoading(false);
      setTabLoading(false);
      setShowPromptDialog(false);
      setIsNewTabPrompt(false);
    }
  };

  const scrollRef = useRef(null);

  const scrollToBottom = () => {
    setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }, 50);
  };

  // useEffect(() => {
  // if ((tabOrder.length  0 && Object.keys(conversations).length  0) || activeTab.length  0) {
  // navigate("/");
  // }
  // }, [tabOrder, activeTabId, conversations, activeTab.length, navigate]);

  return (
    <div>
      <div className="analytics-screen relative flex justify-center px-6 py-3">
        <div className="w-full flex flex-col">
          <div className="pointer-events-auto flex flex-col h-[calc(100vh-80px)] mx-8">
            <Tab
              tabs={tabOrder}
              activeTabId={activeTabId}
              setPrompt={setPrompt}
              setIsNewTabPrompt={setIsNewTabPrompt}
              setShowPromptDialog={setShowPromptDialog}
              setShowFilters={setShowFilters}
            />

            <div className="flex-1 overflow-y-auto space-y-6" ref={scrollRef}>
              <div className="border border-(--theme-border-dark) bg-(--theme-container-bg) rounded-b-[22px] py-2 relative">
                {showFilters && (
                  <div className="px-4 pt-3">
                    <FilterPanel
                      open={showFilters}
                      onClose={() => setShowFilters(false)}
                      // history={history}
                      data={activeTab}
                      activeTabId={activeTabId}
                      onGenerate={onGenerate}
                      loading={bottomLoading}
                    />
                  </div>
                )}
                {activeTab.length > 0 &&
                  activeTab.map((item) => (
                    <AnalyticsPage key={item.id} tab={item} />
                  ))}
              </div>

              <div className="flex justify-center">
                <div className="w-full">
                  <BottomPromptBar
                    loading={bottomLoading}
                    filterQuery={filterQuery}
                    onSend={(query, isFollowUp) => {
                      const lastMsg = activeTab[activeTab.length - 1];
                      const currentFilters = lastMsg?.filters || [];
                      onGenerate(query, { isFollowUp, isFilterApplied: currentFilters.length > 0, filters: currentFilters });
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Prompt dialog */}
      <PromptDialog
        open={showPromptDialog}
        prompt={prompt}
        setPrompt={setPrompt}
        onGenerate={onGenerate}
        onClose={() => setShowPromptDialog(false)}
        loading={tabLoading}
      />
    </div>
  );
}
