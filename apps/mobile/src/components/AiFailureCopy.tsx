/**
 * WS-E per-backend failure copy (UI only).
 *
 * Pure presentational strings for on-device AI failure states. No probe,
 * download, orchestration, or model-profile logic lives here — callers pass
 * the stable `kind` and this module renders the honest user-facing copy.
 * Every string keeps the safe CPU fallback visible and never claims a send.
 */

/** Stable failure states surfaced by the on-device AI UI. */
export type AiFailureKind =
  | "preparing-image"
  | "loading-local-model"
  | "gpu-could-not-start"
  | "vision_unsupported"
  | "no-probe";

export interface AiFailureCopyText {
  readonly title: string;
  readonly body: string;
}

/** Exact user-facing copy per failure state (stable wording). */
export const AI_FAILURE_COPY: Record<AiFailureKind, AiFailureCopyText> = {
  "preparing-image": {
    title: "Preparing the photo…",
    body: "Getting the image ready on this device. Nothing has been sent anywhere yet.",
  },
  "loading-local-model": {
    title: "Loading the on-device model…",
    body: "The verified on-device model is loading into memory. This stays on this device.",
  },
  "gpu-could-not-start": {
    title: "GPU could not start — using CPU instead.",
    body: "The GPU path did not start on this device, so the safe CPU fallback is serving this request. Nothing was sent anywhere.",
  },
  vision_unsupported: {
    title: "This on-device model cannot read photos.",
    body: "Vision is not supported by the installed model. Ask a text question or pick a cloud model with vision.",
  },
  "no-probe": {
    title: "No fresh measurement yet — using the safe CPU fallback.",
    body: "Automatic choice stays hidden until a fresh on-device measurement passes its correctness check. The safe CPU fallback is serving this request.",
  },
};

export interface AiFailureCopyProps {
  /** Which failure state to render. */
  readonly kind: AiFailureKind;
}

/**
 * Renders the failure title + body for one backend state.
 * `role="alert"` so assistive tech announces the failure once rendered.
 */
export function AiFailureCopy({ kind }: AiFailureCopyProps) {
  const copy = AI_FAILURE_COPY[kind];
  return (
    <div
      role="alert"
      data-testid={`ai-failure-${kind}`}
      className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant p-3"
    >
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="text-sm text-on-surface-variant">{copy.body}</p>
    </div>
  );
}
