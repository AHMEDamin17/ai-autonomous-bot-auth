/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getCurrentUser,
  loginWithEntra,
  logoutUser,
} from "../api/services";
import {
  beginEntraLoginRedirect,
  clearEntraSession,
  clearMsalUrlResidue,
  establishSessionFromRedirect,
  getEntraConfigError,
  initializeMsal,
  isAuthPopupWindow,
} from "./msalConfig";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => !isAuthPopupWindow());
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    if (isAuthPopupWindow()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    setLoading(true);
    try {
      const current = await getCurrentUser();
      setUser(current);
      setError("");
      return current;
    } catch (requestError) {
      if (requestError?.response?.status === 401) {
        setUser(null);
        setError("");
        return null;
      }
      setError(requestError?.response?.data?.error || requestError?.message || "Unable to check login state.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthPopupWindow()) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        await initializeMsal();
        clearMsalUrlResidue();
        // Exchange redirect tokens once (Strict Mode safe), then reflect in UI.
        const redirectUser = await establishSessionFromRedirect(loginWithEntra);
        if (cancelled) return;
        if (redirectUser) {
          setUser(redirectUser);
          setError("");
          setLoading(false);
          return;
        }
        await refresh();
      } catch (err) {
        console.error("Failed to complete Microsoft redirect sign-in:", err);
        if (!cancelled) {
          setError(err?.response?.data?.error || err?.message || "Unable to complete Microsoft sign-in.");
          setLoading(false);
          await refresh().catch(() => undefined);
        }
      }
    })();

    const handleExpired = () => {
      setUser(null);
      setLoading(false);
      if (typeof window !== "undefined" && (window.location.pathname !== "/" || window.location.search || window.location.hash)) {
        window.location.replace("/");
      }
    };
    window.addEventListener("auth:session-expired", handleExpired);
    return () => {
      cancelled = true;
      window.removeEventListener("auth:session-expired", handleExpired);
    };
  }, [refresh]);

  const loginWithMicrosoft = useCallback(async () => {
    setError("");
    const configError = getEntraConfigError();
    if (configError) {
      setError(configError);
      throw new Error(configError);
    }
    // Full-page redirect — this call navigates away from the SPA.
    await beginEntraLoginRedirect();
  }, []);

  const logout = useCallback(async () => {
    setError("");
    try {
      await logoutUser();
    } catch {
      // Still clear local UI / Entra even if the cookie revoke call fails.
    } finally {
      setUser(null);
      clearMsalUrlResidue();
      try {
        await clearEntraSession();
      } catch {
        clearMsalUrlResidue();
      }
      if (typeof window !== "undefined" && (window.location.pathname !== "/" || window.location.search || window.location.hash)) {
        window.location.replace("/");
      }
    }
  }, []);

  const value = useMemo(() => ({
    user,
    loading,
    error,
    isAdmin: user?.role === "admin",
    loginWithMicrosoft,
    logout,
    refresh,
  }), [user, loading, error, loginWithMicrosoft, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
