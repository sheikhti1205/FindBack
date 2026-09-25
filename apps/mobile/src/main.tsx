import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { initMonitoring } from "./services/monitoring/sentry";

// Crash reporting first: no-op unless VITE_SENTRY_DSN is configured.
initMonitoring();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
