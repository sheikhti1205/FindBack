import { useState } from "react";

/**
 * WS-E provenance badge (UI only).
 *
 * Badge line reads `Local/Cloud · model · backend`; tapping it reveals the
 * detail region with the requested backend, the actual backend served, and
 * the reason for any mismatch. All values render verbatim — nothing is
 * inferred here. Provenance comes from the caller (orchestrator/selection
 * output); this component never probes, downloads, or selects.
 */

/** Where the answer was produced. */
export type AiProvenanceScope = "Local" | "Cloud";

export interface AiProvenanceProps {
  /** Local (on-device) or Cloud (provider) answer. */
  readonly scope: AiProvenanceScope;
  /** Model id served (e.g. "smolvlm2-500m", "openrouter/free"). */
  readonly model: string;
  /** Effective backend served (e.g. "cpu", "gpu", "cloud"). */
  readonly backend: string;
  /** Backend that was requested, when known. */
  readonly requested?: string | null;
  /** Backend actually served, when known (defaults to `backend`). */
  readonly actual?: string | null;
  /** Why requested differs from actual (e.g. "no-evidence"), when known. */
  readonly reason?: string | null;
}

/**
 * Tappable provenance badge. Collapsed by default so transcripts stay
 * compact; the detail region is hidden until the user taps the badge.
 */
export function AiProvenance({
  scope,
  model,
  backend,
  requested,
  actual,
  reason,
}: AiProvenanceProps) {
  const [open, setOpen] = useState(false);
  const requestedText = requested ?? null;
  const actualText = actual ?? backend;
  const reasonText = reason ?? null;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="ai-provenance-badge"
        aria-expanded={open}
        aria-label={`${scope} provenance: ${model} on ${backend}. ${open ? "Hide" : "Show"} details.`}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-[48px] items-center gap-2 self-start rounded-full border border-outline-variant px-3 text-xs font-medium text-on-surface-variant hover:bg-surface-container"
      >
        <span>{scope}</span>
        <span aria-hidden="true">·</span>
        <span>{model}</span>
        <span aria-hidden="true">·</span>
        <span>{backend}</span>
      </button>
      {open ? (
        <dl
          data-testid="ai-provenance-detail"
          className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant p-3 text-xs"
        >
          <div className="flex gap-2">
            <dt className="font-semibold">Requested:</dt>
            <dd data-testid="ai-provenance-requested">
              {requestedText ?? "unknown"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Actual:</dt>
            <dd data-testid="ai-provenance-actual">{actualText}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-semibold">Reason:</dt>
            <dd data-testid="ai-provenance-reason">
              {reasonText ?? "unknown"}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}
