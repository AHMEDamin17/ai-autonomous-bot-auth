import { useState, useEffect } from "react";

import { Loader2 } from "lucide-react";
import sendBg from "../../../assets/Ellipse 1.svg";
import sendRing from "../../../assets/Ellipse 2.svg";
import sendIcon from "../../../assets/paper-plane.svg";

export default function BottomPromptBar({ onSend, loading, filterQuery }) {
  const [text, setText] = useState("");

  useEffect(() => {
    if(filterQuery) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(filterQuery)
    }
  }, [filterQuery]);

  const handleSend = async () => {
    if (!text.trim() || loading) return;
    const submittedText = text;
    setText("");
    await onSend(submittedText, true);
  };

  return (
    <div
      className="
        bg-(--theme-container-bg)
        border border-(--theme-container-bg)
        rounded-2xl
        px-3 pt-2 pb-1
        shadow-[0_4px_10px_rgba(0,0,0,0.1)]
        mt-1
      "
    >
      {/* INPUT */}
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
          placeholder="Ask a follow-up question..."
          className="
            w-full
            h-[55px]
            resize-none
            rounded-xl
            bg-white
            px-4 py-3
            text-sm
            border border-slate-200
            outline-none
            pr-14
          "
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />

        {/* SEND BUTTON */}
        <button
          onClick={handleSend}
          disabled={loading}
          className="absolute right-4 top-1/2 -translate-y-1/2 transition hover:scale-105 disabled:opacity-50"
        >
          <div className="relative w-10 h-10 flex items-center justify-center">
            <img src={sendRing} className="absolute inset-0 w-full h-full" alt="ring" />
            <img
              src={sendBg}
              className="absolute inset-[3px] w-[calc(100%-6px)] h-[calc(100%-6px)]"
              alt="send-bg"
            />
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin text-white relative z-10" />
            ) : (
              <img src={sendIcon} className="w-4 h-4 relative z-10" alt="send-icon" />
            )}
          </div>
        </button>
      </div>

      {/* THINKING BELOW */}
      {loading && (
        <div className="flex items-center gap-2 mt-2 text-xs text-slate-600 px-2">
          <Loader2 className="w-4 h-4 animate-spin text-(--theme-primary)" />
          Thinking...
        </div>
      )}
    </div>
  );
}
