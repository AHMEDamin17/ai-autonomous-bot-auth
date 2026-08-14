import { PublicClientApplication, LogLevel } from "@azure/msal-browser";
function trimEnv(value) {
  return typeof value === "string" ? value.trim() : "";
}
const tenantId = trimEnv(import.meta.env.VITE_AZURE_ENTRA_TENANT_ID);
const clientId = trimEnv(import.meta.env.VITE_AZURE_ENTRA_CLIENT_ID);
const authorityFromEnv = trimEnv(import.meta.env.VITE_AZURE_ENTRA_AUTHORITY);
const apiScope = trimEnv(import.meta.env.VITE_AZURE_ENTRA_API_SCOPE);
const enabledFlag = trimEnv(import.meta.env.VITE_AZURE_ENTRA_ENABLED).toLowerCase();
const AUTH_QUERY_KEYS = [
  "code",
  "state",
  "session_state",
  "error",
  "error_description",
  "client_info",
  "iss",
];

function resolveRedirectUri() {
  const configured = trimEnv(import.meta.env.VITE_AZURE_ENTRA_REDIRECT_URI);
  if (!configured) {
    return window.location.origin;
  }
  // Preserve the configured string exactly — Azure matches redirect URIs
  // character-for-character (trailing slash included).
  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }
  try {
    return new URL(configured, window.location.origin).href.replace(/\/$/, "") === window.location.origin
      ? window.location.origin
      : new URL(configured, window.location.origin).href;
  } catch {
    return window.location.origin;
  }
}

const redirectUri = resolveRedirectUri();
const postLogoutRedirectUri = trimEnv(import.meta.env.VITE_AZURE_ENTRA_REDIRECT_URI) || window.location.origin;

const entraEnabled = enabledFlag === "" ? true : enabledFlag === "true";

const entraAuthority = authorityFromEnv
  || (tenantId ? `https://login.microsoftonline.com/${tenantId}` : "");

const entraLoginScopes = apiScope
  ? [apiScope, "openid", "profile", "email"]
  : ["openid", "profile", "email"];

export function getEntraConfigError() {
  if (!entraEnabled) {
    return "Microsoft Entra ID sign-in is disabled. Set VITE_AZURE_ENTRA_ENABLED=true.";
  }
  if (!clientId) {
    return "Missing VITE_AZURE_ENTRA_CLIENT_ID. Add it to frontend/.env.";
  }
  if (!entraAuthority) {
    return "Missing VITE_AZURE_ENTRA_AUTHORITY or VITE_AZURE_ENTRA_TENANT_ID. Add them to frontend/.env.";
  }
  return "";
}

/** True only for the dedicated popup bridge page or an auth popup child window. */
export function isAuthPopupWindow() {
  try {
    if (typeof window === "undefined") return false;
    if (window.location.pathname.endsWith(DEFAULT_ENTRA_REDIRECT_PATH)) return true;
    return Boolean(window.opener && window.opener !== window);
  } catch {
    return false;
  }
}

/** Strip MSAL OAuth residue (?state=, ?code=, hash) from the address bar. */
export function clearMsalUrlResidue() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of AUTH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (url.hash && /(code|state|error|client_info)=/.test(url.hash)) {
    url.hash = "";
    changed = true;
  }
  if (changed) {
    const next = `${url.pathname}${url.search}${url.hash}` || "/";
    window.history.replaceState({}, document.title, next);
  }
}

const msalConfig = {
  auth: {
    clientId: clientId || "missing-client-id",
    authority: entraAuthority || "https://login.microsoftonline.com/common",
    redirectUri,
    postLogoutRedirectUri,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    // Persist MSAL accounts across tab refreshes so SSO can resume after local logout.
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
    },
  },
};

const loginRequest = {
  scopes: entraLoginScopes,
};

let msalInstance;
let initializePromise;
let pendingRedirectResult = null;
let pendingRedirectConsumed = false;

export function getMsalInstance() {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
  }
  return msalInstance;
}

function pickEntraToken(result) {
  if (!apiScope && result?.idToken) return result.idToken;
  return result?.accessToken || result?.idToken || "";
}

/**
 * Initialize MSAL once and process any inbound redirect response.
 * Safe to call from main.jsx and AuthProvider (Strict Mode friendly).
 */
export async function initializeMsal() {
  if (getEntraConfigError()) return getMsalInstance();
  if (!initializePromise) {
    initializePromise = (async () => {
      const instance = getMsalInstance();
      await instance.initialize();
      try {
        const result = await instance.handleRedirectPromise();
        clearMsalUrlResidue();
        if (result) {
          pendingRedirectResult = result;
          pendingRedirectConsumed = false;
          if (result.account) instance.setActiveAccount(result.account);
        } else {
          const accounts = instance.getAllAccounts();
          if (accounts.length > 0) instance.setActiveAccount(accounts[0]);
        }
      } catch (error) {
        clearMsalUrlResidue();
        console.error("MSAL handleRedirectPromise failed:", error);
      }
      return instance;
    })();
  }
  return initializePromise;
}

/** One-shot access to the AuthenticationResult from the latest redirect. */
function consumeRedirectAuthResult() {
  if (pendingRedirectConsumed) return null;
  pendingRedirectConsumed = true;
  const result = pendingRedirectResult;
  pendingRedirectResult = null;
  return result;
}

/**
 * Full-page loginRedirect with account picker.
 * - Remembered / Stay-signed-in account: user picks it → Entra SSO continues (no password).
 * - Different / new account: user picks "Use another account" → regular auth path.
 * Sign-out stays local-only (no federated logout).
 */
export async function beginEntraLoginRedirect() {
  const configError = getEntraConfigError();
  if (configError) throw new Error(configError);
  if (isAuthPopupWindow()) {
    throw new Error("Sign-in must start from the main application window.");
  }
  const instance = await initializeMsal();
  clearMsalUrlResidue();
  await instance.loginRedirect({
    ...loginRequest,
    prompt: "select_account",
  });
}

/**
 * After Microsoft returns to the SPA, exchange the redirect token for an app session.
 * Idempotent across React Strict Mode double-mounts.
 */
let redirectSessionPromise = null;

export async function establishSessionFromRedirect(loginWithEntra) {
  if (!redirectSessionPromise) {
    redirectSessionPromise = (async () => {
      await initializeMsal();
      const result = consumeRedirectAuthResult();
      if (!result) return null;
      const token = pickEntraToken(result);
      if (!token) {
        throw new Error("Microsoft sign-in returned no token.");
      }
      return loginWithEntra(token);
    })();
  }
  return redirectSessionPromise;
}

export async function clearEntraSession() {
  clearMsalUrlResidue();
  if (getEntraConfigError()) return;
  const instance = await initializeMsal();
  const account = instance.getActiveAccount() || instance.getAllAccounts()[0];
  // Local app logout only: clear MSAL cache without federated Entra logout.
  // logoutRedirect would ask "which account?" and wipe Stay-signed-in SSO.
  try {
    if (account) {
      await instance.clearCache({ account });
    } else {
      await instance.clearCache();
    }
  } catch {
    // ignore cache clear failures; app cookie is already revoked
  }
  instance.setActiveAccount(null);
  clearMsalUrlResidue();
}
