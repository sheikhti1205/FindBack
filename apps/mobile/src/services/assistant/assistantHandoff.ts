import type {
  GuidedSnapshot,
  LocationChoice,
  PhotoChoice,
} from "./guidedAssistantController";
import type { ReportDraftPatch } from "./reportDraftPatch";

export interface AssistantReportHandoff {
  version: 1;
  source: "assistant";
  patch: ReportDraftPatch;
  photoChoice?: PhotoChoice;
  locationChoice?: LocationChoice;
}

export function buildAssistantReportHandoff(
  snapshot: GuidedSnapshot,
): AssistantReportHandoff | null {
  if (snapshot.flow !== "lost" && snapshot.flow !== "found") return null;
  if (snapshot.state !== "ready") return null;
  return {
    version: 1,
    source: "assistant",
    patch: snapshot.patch,
    ...(snapshot.photoChoice !== undefined ? { photoChoice: snapshot.photoChoice } : null),
    ...(snapshot.locationChoice !== undefined
      ? { locationChoice: snapshot.locationChoice }
      : null),
  };
}

export function isAssistantReportHandoff(value: unknown): value is AssistantReportHandoff {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    version?: unknown;
    source?: unknown;
    patch?: unknown;
    photoChoice?: unknown;
    locationChoice?: unknown;
  };
  if (candidate.version !== 1) return false;
  if (candidate.source !== "assistant") return false;
  if (typeof candidate.patch !== "object" || candidate.patch === null) return false;
  if (
    candidate.photoChoice !== undefined &&
    candidate.photoChoice !== "take" &&
    candidate.photoChoice !== "choose" &&
    candidate.photoChoice !== "none"
  ) {
    return false;
  }
  if (
    candidate.locationChoice !== undefined &&
    candidate.locationChoice !== "map" &&
    candidate.locationChoice !== "current" &&
    candidate.locationChoice !== "typed" &&
    candidate.locationChoice !== "skip"
  ) {
    return false;
  }
  return true;
}
