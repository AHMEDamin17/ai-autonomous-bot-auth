import { Send } from "lucide-react";

import sendBg from "../../../assets/Ellipse 1.svg";
import sendRing from "../../../assets/Ellipse 2.svg";
import sendIcon from "../../../assets/paper-plane.svg";

export default function PromptDialog({
  open,
  prompt,
  setPrompt,
  onGenerate,
  onClose,
  loading,
}) {
  if (!open) return null;

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-90 bg-black/30 flex items-center justify-center"
        onClick={!loading ? onClose : undefined}
      />

      {/* dialog */}
      <div
        className="fixed z-100 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
      >
        <div className="relative rounded-[26px] p-[1.5px] bg-white/40 shadow-[0_30px_80px_rgba(0,0,0,0.25)]">
          <div className="bg-white/90 backdrop-blur-xl rounded-[24px] border border-white/60 px-6 py-5 w-[520px]">
            {/* INPUT */}
            <div className="relative rounded-xl border border-slate-200 bg-slate-100 p-3  transition">
              <textarea
                value={prompt}
                disabled={loading}
                placeholder={
                  loading
                    ? "Thinking..."
                    : "Ask about KPIs, ticket trends, productivity"
                }
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onGenerate(prompt);
                  }
                }}
                className="
                w-full h-[110px]
                bg-transparent resize-none outline-none
                text-sm text-slate-800
                placeholder:text-slate-400
                pr-16
                disabled:opacity-70
                italic
              "
                autoFocus
              />

              <button
                onClick={() => onGenerate(prompt)}
                disabled={!prompt.trim() || loading}
                className={`
                absolute bottom-3 right-3
                transition
                ${loading ? "cursor-not-allowed opacity-70" : "hover:scale-105"}
              `}
              >
                <div className="flex flex-col items-center gap-[2px]">
                  <div className="relative w-10 h-10 flex items-center justify-center">
                    <img
                      src={sendRing}
                      alt="ring"
                      className="absolute inset-0 w-full h-full pointer-events-none"
                    />

                    <img
                      src={sendBg}
                      alt="bg"
                      className="absolute inset-[3px] w-[calc(100%-6px)] h-[calc(100%-6px)] pointer-events-none"
                    />

                    {loading ? (
                      <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin relative z-10" />
                    ) : (
                      <img
                        src={sendIcon}
                        alt="send"
                        className="w-4 h-4 relative z-10 pointer-events-none"
                      />
                    )}
                  </div>

                  {loading && (
                    <span className="text-[10px] text-slate-500 animate-pulse">
                      Thinking...
                    </span>
                  )}
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
