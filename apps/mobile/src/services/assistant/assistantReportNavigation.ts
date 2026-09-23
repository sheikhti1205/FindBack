import {
  isAssistantReportHandoff,
  type AssistantReportHandoff,
} from "./assistantHandoff";

/** Ordinary report route for an assistant handoff. The form owns intake. */
export const ASSISTANT_REPORT_ROUTE = "/report";

const HANDOFF_EVENT = "findback:assistant-handoff";

/**
 * Versioned navigation seam for Review report. Returns the ordinary report
 * route only for the frozen handoff shape; otherwise null. Never publishes.
 */
export function assistantReportNavigationTarget(handoff: unknown): string | null {
  return isAssistantReportHandoff(handoff) ? ASSISTANT_REPORT_ROUTE : null;
}

let staged: AssistantReportHandoff | null = null;

function copyHandoff(handoff: AssistantReportHandoff): AssistantReportHandoff {
  return { ...handoff, patch: { ...handoff.patch } };
}

/**
 * Stage a validated handoff for the report form to consume. Invalid payloads
 * are ignored. Emits a window event so a mounted form can apply live.
 */
export function stageAssistantReportHandoff(handoff: AssistantReportHandoff): void {
  if (!isAssistantReportHandoff(handoff)) return;
  staged = copyHandoff(handoff);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(HANDOFF_EVENT, { detail: copyHandoff(handoff) }));
  }
}

/** Peek without consuming (tests/diagnostics). */
export function peekStagedAssistantReportHandoff(): AssistantReportHandoff | null {
  return staged ? copyHandoff(staged) : null;
}

/** Consume the staged handoff once. */
export function takeStagedAssistantReportHandoff(): AssistantReportHandoff | null {
  const next = staged;
  staged = null;
  return next;
}

export function clearStagedAssistantReportHandoff(): void {
  staged = null;
}

/** Live subscription for a mounted report form. */
export function subscribeStagedAssistantReportHandoff(
  listener: (handoff: AssistantReportHandoff) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => {};
  }
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AssistantReportHandoff>).detail;
    if (isAssistantReportHandoff(detail)) listener(copyHandoff(detail));
  };
  window.addEventListener(HANDOFF_EVENT, handler);
  return () => window.removeEventListener(HANDOFF_EVENT, handler);
}
