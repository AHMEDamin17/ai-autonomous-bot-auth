import { useState } from "react";
import { useAuth } from "./AuthContext";
import { getEntraConfigError } from "./msalConfig";

export default function LoginGate({ children }) {
  const { user, loading, error: sessionError, loginWithMicrosoft } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const configError = getEntraConfigError();

  if (loading) {
    return (
      <div className="bg-dashboard flex min-h-dvh items-center justify-center px-4">
        <div className="rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-8 shadow-[var(--theme-card-shadow)]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-(--theme-border) border-b-(--theme-primary)" aria-label="Checking login session" />
        </div>
      </div>
    );
  }

  if (user) return children;

  const submit = async () => {
    setSubmitting(true);
    setMessage("");
    try {
      await loginWithMicrosoft();
      // loginRedirect navigates away; if it returns, keep the button busy.
    } catch (requestError) {
      setMessage(
        requestError?.response?.data?.detail
        || requestError?.response?.data?.error
        || requestError?.message
        || "Unable to sign in with Microsoft.",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="bg-dashboard flex min-h-dvh items-center justify-center px-4 py-6 sm:py-8">
      <section className="w-full max-w-sm rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-5 shadow-[var(--theme-card-shadow)] sm:p-6">
        <img src="/srm-title-logo.png" alt="SRMTech" className="mx-auto h-auto w-24" />
        <div className="mt-4 text-center">
          <h1 className="text-xl! leading-tight! font-bold text-(--theme-text)">Welcome Back</h1>
          <p className="mt-1.5 text-sm font-medium text-(--theme-text-muted)">
            Please sign in with your Microsoft account to continue.
          </p>
        </div>

        <div className="mt-5 space-y-3">
          {(message || sessionError || configError) && (
            <p role="alert" className="rounded-[var(--theme-radius-btn)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {message || sessionError || configError}
            </p>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={submitting || Boolean(configError)}
            className="btn-primary flex w-full items-center justify-center gap-2 py-2.5!"
          >
            <MicrosoftMark />
            {submitting ? "Signing in..." : "Sign in with Microsoft"}
          </button>
        </div>
      </section>
    </main>
  );
}

function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
