import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MsalProvider } from "@azure/msal-react";
import App from "./App.jsx";
import "./index.css";
import { Provider } from "react-redux";
import { store } from "./store/store.js";
import { ThemeProvider } from "./contexts/ThemeContext.jsx";
import { AuthProvider } from "./auth/AuthContext.jsx";
import LoginGate from "./auth/LoginGate.jsx";
import {
  getMsalInstance,
  initializeMsal,
  isAuthPopupWindow,
} from "./auth/msalConfig.js";

/**
 * Popup bridge page only. Full-page loginRedirect mounts the SPA and completes
 * auth via handleRedirectPromise in AuthProvider.
 */
if (isAuthPopupWindow()) {
  document.body.innerHTML =
    "<p style=\"font-family:system-ui;padding:1.5rem\">Completing Microsoft sign-in…</p>";
  import("@azure/msal-browser/redirect-bridge")
    .then(({ broadcastResponseToMainFrame }) => broadcastResponseToMainFrame())
    .catch((error) => {
      console.error("MSAL redirect bridge failed in popup:", error);
      document.body.innerHTML =
        "<p style=\"font-family:system-ui;padding:1.5rem\">Sign-in could not complete in this window. Close it and try again from the main app.</p>";
    });
} else {
  const msalInstance = getMsalInstance();

  initializeMsal().finally(() => {
    createRoot(document.getElementById("root")).render(
      <React.StrictMode>
        <MsalProvider instance={msalInstance}>
          <BrowserRouter>
            <Provider store={store}>
              <ThemeProvider>
                <AuthProvider>
                  <LoginGate>
                    <App />
                  </LoginGate>
                </AuthProvider>
              </ThemeProvider>
            </Provider>
          </BrowserRouter>
        </MsalProvider>
      </React.StrictMode>,
    );
  });
}
