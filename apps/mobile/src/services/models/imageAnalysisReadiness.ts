import { getVlmBridge, type VlmState } from "../vlmPlugin";

export interface ImageAnalysisReadiness {
  available: boolean;
  reason: "CHECKING" | "NO_MODEL" | "VERIFY_REQUIRED" | "READY" | "UNAVAILABLE";
}

export function readinessFromImageState(
  state: VlmState | null,
  checking: boolean,
): ImageAnalysisReadiness {
  if (checking) return { available: false, reason: "CHECKING" };
  if (state == null) return { available: false, reason: "NO_MODEL" };
  switch (state) {
    case "READY_GPU":
      return { available: true, reason: "READY" };
    case "NOT_INSTALLED":
      return { available: false, reason: "NO_MODEL" };
    case "INSTALLED_UNVERIFIED":
      return { available: false, reason: "VERIFY_REQUIRED" };
    default:
      return { available: false, reason: "UNAVAILABLE" };
  }
}

export function deriveImageAnalysisReadiness(signals: {
  checking: boolean;
  state: VlmState | null;
}): ImageAnalysisReadiness {
  return readinessFromImageState(signals.state, signals.checking);
}

export async function readImageAnalysisReadiness(): Promise<ImageAnalysisReadiness> {
  const bridge = getVlmBridge();
  try {
    const states = await bridge.getModelStates();
    const info =
      states.find((m) => m.id === "smolvlm2-500m") ??
      states.find((m) => m.state === "READY_GPU") ??
      null;
    if (info == null) return { available: false, reason: "NO_MODEL" };
    return readinessFromImageState(info.state, false);
  } catch {
    return { available: false, reason: "CHECKING" };
  }
}
