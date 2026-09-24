import { getVlmBridge, type VlmState } from "../vlmPlugin";
import { getCandidateHost, isCandidateResidentReady, type CandidateActiveStatus } from "./candidateHost";
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

/**
 * True only when the vision candidate is genuinely usable: selected,
 * hash-verified on disk, and running as the initialized resident engine.
 * A selection pointer alone (cold restart, deleted bytes, released,
 * verify-evicted) or an unknown legacy shape never counts — AI-04/AI-07.
 */
export function isVisionCandidateGenuinelyActive(
  status: CandidateActiveStatus | null | undefined,
  visionEntryId: string = CANDIDATE_VISION_ENTRY_ID,
): boolean {
  return isCandidateResidentReady(status, visionEntryId);
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
    // A verified, genuinely resident vision candidate powers the same native
    // `analyzeImage` entry point (no modelId is sent), so analysis is
    // available even when the recommended image model is not installed.
    // Residency proof is required: a selection pointer alone (cold restart,
    // deleted bytes, released) never reads READY — AI-04/AI-07.
    const activeCandidate = await readActiveCandidateStatus();
    if (isVisionCandidateGenuinelyActive(activeCandidate)) {
      return { available: true, reason: "READY" };
    }
    if (dedicated != null) return dedicated;
    return { available: false, reason: "NO_MODEL" };
  } catch {
    return { available: false, reason: "UNAVAILABLE" };
  }
}

async function readActiveCandidateStatus(): Promise<CandidateActiveStatus | null> {
  try {
    const host = getCandidateHost();
    if (host == null) return null;
    // Hosts without the residency truth (older builds, legacy doubles) fail
    // closed: a bare pointer is never residency proof.
    if (typeof host.getActiveStatus !== "function") return null;
    return await host.getActiveStatus();
  } catch {
    return null;
  }
}
