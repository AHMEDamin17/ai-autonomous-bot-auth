import { Plus, SlidersHorizontal } from "lucide-react";
import { removeTab, setActiveTab } from "../../../reducers/analyticsSlice";
import { useDispatch } from "react-redux";

export function Tab({
  tabs,
  activeTabId,
  setPrompt,
  setIsNewTabPrompt,
  setShowPromptDialog,
  setShowFilters,
}) {
  const dispatch = useDispatch();
  
  return (
    <div
      className="
        flex items-center justify-between
        px-3 py-1
        rounded-t-[22px]
        z-10
        bg-(--theme-container-bg)
        border
        border-(--theme-border-dark)
        border-t border-l border-r
      "
    >
      <div
        className="flex items-center gap-1 overflow-x-auto
         /* Firefox */
        scrollbar-none

        /* Chrome / Edge / Safari */
        [&::-webkit-scrollbar]:hidden
      "
      >
        {tabs.map((t) => {
          const isActive = t.tabId === activeTabId;
          return (
            <div
              key={t.tabId}
              onClick={() => dispatch(setActiveTab(t.tabId))}
              className={`
                flex items-center gap-1
                h-9
                px-3
                m-2
                rounded-xl
                text-xs font-semibold
                cursor-pointer
                whitespace-nowrap
                transition-all
                ${
                  isActive
                    ? "bg-white text-slate-900 shadow-[0_4px_10px_rgba(0,0,0,0.10)] border border-slate-200"
                    : "bg-transparent text-slate-600 hover:bg-white/60"
                }
              `}
            >
              
              <span>{t.prompt}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch(removeTab(t.tabId));
                }}
                className="text-slate-400"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex">
        {/* ADD BUTTON */}
        <button
          onClick={() => {
            setPrompt("");
            setIsNewTabPrompt(true);
            setTimeout(() => setShowPromptDialog(true), 0);
          }}
          className=" text-(--theme-accent) hover:scale-110 transition"
          title="Add new KPI"
        >
          <Plus size={20} strokeWidth={2.5} />
        </button>

        {/* FILTER ICON */}
        <button
          onClick={() => setShowFilters((prev) => !prev)}
          className="
                p-2
                rounded-lg
                border border-(--theme-accent)
                bg-white
                hover:bg-(--theme-chip-bg)
                transition
                relative
                z-50"
          title="Filters"
        >
          <SlidersHorizontal size={18} className="text-(--theme-accent)" />
        </button>
      </div>
    </div>
  );
}
