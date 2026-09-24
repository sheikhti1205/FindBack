import { getVlmBridge, type VlmState } from "../vlmPlugin";
import { getCandidateHost } from "./candidateHost";
import { CANDIDATE_VISION_ENTRY_ID } from "./shippedCatalogue";

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
    const dedicated = info == null ? null : readinessFromImageState(info.state, false);
    if (dedicated?.available) return dedicated;
    // A verified, resident vision candidate powers the same native
    // `analyzeImage` entry point (no modelId is sent), so analysis is
    // available even when the recommended image model is not installed.
    const activeCandidate = await readActiveCandidateEntryId();
    if (activeCandidate === CANDIDATE_VISION_ENTRY_ID) {
      return { available: true, reason: "READY" };
    }
    if (dedicated != null) return dedicated;
    return { available: false, reason: "NO_MODEL" };
  } catch {
    return { available: false, reason: "UNAVAILABLE" };
  }
}

async function readActiveCandidateEntryId(): Promise<string | null> {
  try {
    const host = getCandidateHost();
    if (host == null) return null;
    return await host.getActive();
  } catch {
    return null;
  }
}
