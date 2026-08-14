/**
 * Self-test for MSAL full-page redirect + optional popup bridge wiring.
 * Run: node scripts/msalPopupSelftest.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const redirectHtmlPath = resolve(root, "redirect.html");
assert(existsSync(redirectHtmlPath), "redirect.html must exist at frontend root");
const redirectHtml = readFileSync(redirectHtmlPath, "utf8");
assert(
  redirectHtml.includes("broadcastResponseToMainFrame"),
  "redirect.html must call broadcastResponseToMainFrame",
);

const msalConfigSource = readFileSync(resolve(root, "src/auth/msalConfig.js"), "utf8");
assert(
  msalConfigSource.includes("loginRedirect") && !msalConfigSource.includes("loginPopup("),
  "msalConfig must use loginRedirect (not loginPopup)",
);
assert(
  msalConfigSource.includes("clearCache") && !msalConfigSource.includes("logoutRedirect({"),
  "msalConfig must use local clearCache logout (not logoutRedirect)",
);
assert(
  msalConfigSource.includes("establishSessionFromRedirect"),
  "msalConfig must expose establishSessionFromRedirect",
);
assert(
  msalConfigSource.includes("clearMsalUrlResidue"),
  "msalConfig must clear OAuth query residue from the URL",
);
assert(
  msalConfigSource.includes('prompt: "select_account"'),
  "loginRedirect must use select_account so users can switch accounts",
);
assert(
  msalConfigSource.includes('cacheLocation: "localStorage"'),
  "msalConfig must use localStorage for MSAL account cache",
);

const authContextSource = readFileSync(resolve(root, "src/auth/AuthContext.jsx"), "utf8");
assert(
  authContextSource.includes("establishSessionFromRedirect"),
  "AuthContext must establish the app session from redirect tokens",
);
assert(
  authContextSource.includes("beginEntraLoginRedirect"),
  "AuthContext login must start full-page loginRedirect",
);
assert(
  authContextSource.includes("clearMsalUrlResidue"),
  "AuthContext must clear URL residue on mount/logout",
);

const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
assert(
  envExample.includes("VITE_AZURE_ENTRA_REDIRECT_URI=http://localhost:5173"),
  ".env.example redirect URI should target the SPA origin for loginRedirect",
);

const bridgeUrl = pathToFileURL(
  resolve(root, "node_modules/@azure/msal-browser/lib/redirect-bridge/msal-redirect-bridge.js"),
).href;
try {
  const bridge = await import(bridgeUrl);
  assert(
    typeof bridge.broadcastResponseToMainFrame === "function",
    "broadcastResponseToMainFrame must be exported from redirect-bridge",
  );
} catch (error) {
  failures.push(`Failed to import redirect-bridge module: ${error.message}`);
}

if (failures.length) {
  console.error("MSAL redirect self-test FAILED:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("MSAL redirect self-test passed: loginRedirect, session bootstrap, and URL cleanup are wired.");
}
