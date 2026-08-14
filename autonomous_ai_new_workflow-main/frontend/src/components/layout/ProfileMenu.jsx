import { useEffect, useRef, useState } from "react";
import avatarIcon from "../../assets/user-icon.png";
import { useAuth } from "../../auth/AuthContext";

export default function ProfileMenu({ mobile = false }) {
  const { user, loading, loginWithMicrosoft, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!open) setMessage("");
  }, [open]);

  const submitMicrosoftLogin = async () => {
    setSubmitting(true);
    setMessage("");
    try {
      await loginWithMicrosoft();
    } catch (error) {
      setMessage(error?.response?.data?.error || error?.message || "Unable to sign in with Microsoft.");
      setSubmitting(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={user ? `Profile for ${user.username}` : "Open login"}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="w-9 h-9 rounded-full bg-(--theme-surface) border border-(--theme-border-dark) shadow flex items-center justify-center transition-all duration-150 hover:bg-(--theme-container-bg) hover:scale-105"
      >
        <img src={avatarIcon} className={mobile ? "w-4 h-4" : "w-5 h-5 lg:w-6 lg:h-6"} alt="" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="User profile"
          className={`absolute z-[10000] w-72 rounded-[var(--theme-radius-card)] border border-(--theme-border) bg-(--theme-surface) p-4 text-left shadow-[var(--theme-card-shadow)] ${mobile ? "left-12 bottom-0" : "left-12 bottom-0"}`}
        >
          <div className="mb-3 border-b border-(--theme-border) pb-3">
            <p className="text-sm font-bold text-(--theme-text)">
              {loading ? "Checking session..." : user ? user.username : "Sign in"}
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-(--theme-text-muted)">
              {user ? `${user.role} access` : "Use Microsoft Entra ID to continue"}
            </p>
          </div>

          {!user ? (
            <div className="space-y-3">
              {message && <p className="text-[11px] font-semibold text-red-600">{message}</p>}
              <button
                type="button"
                onClick={submitMicrosoftLogin}
                disabled={submitting || loading}
                className="btn-primary flex w-full items-center justify-center gap-2"
              >
                <MicrosoftMark />
                {submitting ? "Signing in..." : "Sign in with Microsoft"}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {message && <p className="text-[11px] font-semibold text-(--theme-primary)">{message}</p>}
              <button
                type="button"
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    await logout();
                    setOpen(false);
                  } finally {
                    setSubmitting(false);
                  }
                }}
                disabled={submitting}
                className="w-full rounded-[var(--theme-radius-btn)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
