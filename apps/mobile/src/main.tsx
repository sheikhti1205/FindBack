import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initMonitoring } from "./services/monitoring/sentry";
import { initializeApplicationAi } from "./services/ai/applicationAi";

// Crash reporting first: no-op unless VITE_SENTRY_DSN is configured.
initMonitoring();
// Boots the shared ledger/runtimes. Rehashes installed pins; never downloads or probes at launch.
void initializeApplicationAi();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
