import React, { useState, useRef, useCallback, useMemo } from "react";

export function useToast() {
  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  const showToast = useCallback((message, isError = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, isError });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 3000);
  }, []);

  const ToastComponent = useMemo(() => () => {
    if (!toast) return null;
    return (
      <div className="fixed bottom-4 right-4 z-50 animate-fade-in-up">
        <div
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg border text-sm font-medium ${
            toast.isError
              ? "bg-red-50 text-red-600 border-red-100"
              : "bg-white text-slate-700 border-(--theme-border)"
          }`}
        >
          {toast.isError ? (
            <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          {toast.message}
          <button
            onClick={() => setToast(null)}
            className="ml-1 shrink-0 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }, [toast]);

  return { toast, showToast, ToastComponent };
}
