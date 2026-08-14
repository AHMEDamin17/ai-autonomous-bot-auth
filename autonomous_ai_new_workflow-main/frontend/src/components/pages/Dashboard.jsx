import React, { useCallback, useRef, useState } from "react";
import { BarChart3, Brain, History, Zap } from "lucide-react";
import SRMLogo from "../../assets/logo.png";
import DashboardAssistantOverlay from "./DashboardAssistantOverlay";

const AttachFileIcon = (props) => (
  <svg {...props} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

const KeyboardVoiceIcon = (props) => (
  <svg {...props} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
  </svg>
);

import sendBg from "../../assets/Ellipse 1.svg";
import sendRing from "../../assets/Ellipse 2.svg";
import sendIcon from "../../assets/paper-plane.svg";

const chipList = [
  "Which product has passed gxp?",
  "volume resolved for nov 2025 ?",
  "average processing time for nov 2025 by service line",
  "accuracy for the December -2025 by bp name and subcategory",
  "Accuracy KPI for Nov 2025",
];

export default function Dashboard() {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantRequest, setAssistantRequest] = useState(null);
  const requestCounterRef = useRef(0);

  const handleLoadingChange = useCallback((isLoading) => {
    setLoading(isLoading);
  }, []);

  const onGenerate = () => {
    const query = prompt.trim();
    if (!query || loading) return;

    requestCounterRef.current += 1;
    setAssistantOpen(true);
    setAssistantRequest({
      id: requestCounterRef.current,
      question: query,
    });
    setPrompt("");
  };

  return (
    <div>
      <div className="mx-auto px-6 w-full text-center mt-10">
        <div className=" flex flex-col items-center justify-center text-center gap-3">
          <img src={SRMLogo} alt="SRM Logo" className="h-10 object-contain" />
          <h3 className="text-2xl font-bold text-(--theme-primary)">Hello, User</h3>

          {/* Hello section */}
          <h2 className="font-bold text-2xl text-slate-900 text-(--theme-chip-text) mb-2">
            How can I help you today?
          </h2>
        </div>

        {/* User prompt input */}
        <div className="mx-auto 2xl:max-w-3/4 xl:w-7/12 lg:max-w-3/4 md:max-w-2xl  sm:w-full">
          <div
            className="
            relative
            rounded-2xl
            bg-(--theme-container-bg)
            border border-(--theme-border)
            px-1
            pt-1
            pb-10
            shadow-[0_4px_10px_rgba(0,0,0,0.08)]
          "
          >
            <textarea
              value={prompt}
              disabled={loading}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                loading
                  ? "Generating response…"
                  : "Curious? Ask and dive into scholarly insights!"
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onGenerate();
                }
              }}
              className="w-full h-[110px] resize-none rounded-xl bg-white px-4 py-3 text-sm border border-slate-200 outline-none disabled:opacity-60 shadow-sm"
            />

            <div className="absolute bottom-1.5 left-4 flex items-center gap-3">
              <button type="button" className="icon-circle" title="Attach File">
                <AttachFileIcon aria-hidden="true" />
              </button>

              <button type="button" className="icon-circle" title="Voice Input">
                <KeyboardVoiceIcon aria-hidden="true" />
              </button>

              <button
                type="button"
                className="icon-circle"
                title="Conversation History"
                onClick={() => setAssistantOpen(true)}
              >
                <History aria-hidden="true" />
              </button>
            </div>

            <button
              onClick={onGenerate}
              disabled={!prompt.trim() || loading}
              className={`
              absolute right-2 bottom-1.5
              z-10
              transition
              ${loading ? "cursor-not-allowed opacity-70" : "hover:scale-105"}
            `}
            >
              <div className="flex flex-col items-center gap-[2px]">
                <div className="relative w-8 h-8 flex items-center justify-center">
                  <img
                    src={sendRing}
                    alt="ring"
                    className="absolute inset-0 w-full h-full pointer-events-none"
                  />
                  <img
                    src={sendBg}
                    alt=""
                    className="absolute inset-[3px] w-[calc(100%-6px)] h-[calc(100%-6px)]"
                  />
                  {loading ? (
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin relative z-10" />
                  ) : (
                    <img
                      src={sendIcon}
                      alt="send"
                      className="w-3.5 h-3.5 relative z-10 pointer-events-none"
                    />
                  )}
                </div>
                {loading && (
                  <span className="text-[10px] absolute -bottom-4 text-slate-600 animate-pulse whitespace-nowrap">
                    Thinking...
                  </span>
                )}
              </div>
            </button>
          </div>
        </div>

        <div className="w-full flex justify-center">
          <div className="2xl:w-3/4 xl:w-3/4 lg:w-3/4 md:w-4/5 gap-4 flex flex-wrap justify-center my-4">
            {chipList.map((text) => (
              <button
                key={text}
                onClick={() => setPrompt(text)}
                className={`prompt-chip ${prompt === text ? "active" : ""}`}
              >
                {text}
              </button>
            ))}
          </div>
        </div>

        {/* Product features statistics */}
        <div className="flex flex-wrap justify-center gap-5 py-4">
          <StatCard
            icon={<Brain />}
            title="AI Insights"
            text="Ask questions in natural language and instantly receive governed KPI insights and trends."
          />
          <StatCard
            icon={<BarChart3 />}
            title="Smart Analytics"
            text="Explore performance metrics using interactive charts, tables, and month-over-month comparisons."
          />
          <StatCard
            icon={<Zap />}
            title="Faster Decisions"
            text="Identify issues, improvements, and opportunities faster with AI-driven recommendations."
          />
        </div>
      </div>

      <DashboardAssistantOverlay
        open={assistantOpen}
        request={assistantRequest}
        onClose={() => setAssistantOpen(false)}
        onLoadingChange={handleLoadingChange}
      />
    </div>
  );
}

function StatCard({ icon, title, text }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{React.cloneElement(icon)}</div>

      <div className="stat-title">{title}</div>

      <div className="stat-text">{text}</div>
    </div>
  );
}
