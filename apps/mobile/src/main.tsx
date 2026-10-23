import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App, createAppRouter } from "./App";
import { initMonitoring } from "./services/monitoring/sentry";
import { recordOperation } from "./services/monitoring/operations";
import { initializeApplicationAi } from "./services/ai/applicationAi";
import { captureExternalAuthEntryFromWindow } from "./utils/externalAuthEntry";

// X3: the OAuth/recovery callback lands on a real path outside the hash. Capture
// it BEFORE the router mounts and strip the credential-bearing query from the
// address bar immediately (no-op on any other route).
captureExternalAuthEntryFromWindow();
// Crash reporting first: no-op unless VITE_SENTRY_DSN is configured.
initMonitoring();
// Boot signal via the allowlisted seam (counts/codes/booleans only).
recordOperation({ name: "app.boot", fields: { ok: true } });
// Boots the shared ledger/runtimes. Rehashes installed pins; never downloads or probes at launch.
void initializeApplicationAi();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
const router = createAppRouter();

createRoot(root).render(
  <StrictMode>
    <App router={router} />
  </StrictMode>,
);
