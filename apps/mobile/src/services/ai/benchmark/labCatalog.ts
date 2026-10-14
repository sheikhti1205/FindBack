/**
 * Explicit benchmark catalogue. Acquisition pins come from the canonical
 * descriptor registry; this module must not invent filenames or transplant
 * repository revisions. Verified publisher pins are not acquired-byte or
 * device-measurement evidence. Proposed benchmark roles are not product roles.
 */
import { productionModelRegistry, type ModelDescriptor } from "../modelDescriptors";
import { SUPPLY_CANDIDATES, type ModelArtifact } from "../modelSupply";

export type LabModality = "text" | "vision";
export type LabRuntime = "litert-lm" | "llama-cpp" | "needle-cact" | "cactus-lab";
export type LabFormat = "litertlm" | "gguf" | "cact";
export type LabCapability = "text" | "vision" | "embedding" | "matching";
export type LabTaskRole = "answer-help" | "extract-report-fields" | "extract-search-filters" | "classify-category" | "classify-intent" | "summarize-local-context" | "analyze-image" | "ground-objects";
export type LabMaturity = "baseline" | "lab-unmeasured";
export type LabCatalogueTier = "recommended" | "advanced";
export type LabDistributionChannel = "bundle" | "download" | "benchmark" | "eval";
export type LabCandidateStatus = "integrated-baseline" | "integrated-pending-measurement";

export interface LabDistribution {
  readonly license: string;
  readonly bundleAllowed: boolean;
  readonly downloadAllowed: boolean;
  readonly benchmarkAllowed: boolean;
  readonly note: string;
}
export interface LabCandidate {
  readonly modelId: string;
  readonly displayName: string;
  readonly modality: LabModality;
  readonly upstreamRepo: string;
  readonly fileName: string;
  readonly revision: string;
  readonly sha256: string;
  readonly bytes?: number;
  readonly companions?: readonly ModelArtifact[];
  /** Immutable publisher metadata verified; not proof of a downloaded file. */
  readonly pinsVerified: boolean;
  readonly distribution: LabDistribution;
  readonly runtime: LabRuntime;
  readonly format: LabFormat;
  /** Host estimate only, never a device measurement. */
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
  readonly capabilities: readonly LabCapability[];
  /** Proposed roles for the benchmark lane only. Product roles remain empty. */
  readonly taskRoles: readonly LabTaskRole[];
  readonly maturity: LabMaturity;
  readonly tier: LabCatalogueTier;
  readonly status: LabCandidateStatus;
  readonly baseline: boolean;
  readonly advancedNote: string;
}

function labCandidate(d: ModelDescriptor, baseline = false): LabCandidate {
  const vision = d.capabilities.includes("vision");
  return {
    modelId: d.modelId, displayName: d.displayName, modality: vision ? "vision" : "text",
    upstreamRepo: d.upstreamRepo ?? new URL(d.url).pathname.split("/").slice(1, 3).join("/"),
    fileName: d.fileName, revision: d.revision, sha256: d.sha256, bytes: d.bytes,
    ...(d.companions ? { companions: d.companions } : {}),
    pinsVerified: /^[a-f0-9]{40}$/.test(d.revision) && /^[a-f0-9]{64}$/.test(d.sha256),
    distribution: { license: d.license === "redistributable-apache-2.0" ? "Apache-2.0" : d.license, bundleAllowed: baseline, downloadAllowed: d.downloadable === true, benchmarkAllowed: true, note: d.distributionNote ?? "Subject to the upstream license, attribution and applicable NOTICE." },
    runtime: d.format === "gguf" ? "llama-cpp" : d.format === "cact" ? "needle-cact" : "litert-lm",
    format: d.format as LabFormat, minRamMb: d.minRamMb, recommendedRamMb: d.recommendedRamMb,
    capabilities: d.capabilities.filter((c): c is LabCapability => ["text", "vision", "embedding", "matching"].includes(c)),
    taskRoles: [...(d.capabilities.includes("text") ? ["answer-help" as const] : []), ...(vision ? ["analyze-image" as const] : [])],
    maturity: baseline ? "baseline" : "lab-unmeasured", tier: baseline ? "recommended" : "advanced",
    status: baseline ? "integrated-baseline" : "integrated-pending-measurement", baseline,
    advancedNote: baseline ? "Existing runtime baseline; no new measurement claimed." : "Unmeasured evaluation candidate; not used automatically.",
  };
}

const registry = productionModelRegistry();
export const LAB_CANDIDATES: readonly LabCandidate[] = [
  labCandidate(registry.requireDescriptor("qwen3-0.6b-dynamic-int4"), true),
  labCandidate(registry.requireDescriptor("smolvlm2-500M-vision"), true),
  ...SUPPLY_CANDIDATES.map((d) => labCandidate(d)),
];

export function labCandidateFor(modelId: string): LabCandidate | undefined { return LAB_CANDIDATES.find((d) => d.modelId === modelId); }
export function requireLabCandidate(modelId: string): LabCandidate {
  const d = labCandidateFor(modelId);
  if (!d) throw new Error(`Unknown lab model ${modelId}`);
  return d;
}
export function advancedCatalogue(): readonly LabCandidate[] { return [...LAB_CANDIDATES]; }
/** This benchmark module never promotes a new product choice. */
export function recommendedLabCatalogue(): readonly LabCandidate[] { return []; }
export function getChatCapableLabModels(candidates: readonly LabCandidate[] = LAB_CANDIDATES): readonly LabCandidate[] {
  return candidates.filter((d) => d.capabilities.includes("text") && (d.taskRoles.includes("answer-help") || d.taskRoles.includes("summarize-local-context")));
}
export function getVisionCapableLabModels(candidates: readonly LabCandidate[] = LAB_CANDIDATES): readonly LabCandidate[] {
  return candidates.filter((d) => d.capabilities.includes("vision") && (d.taskRoles.includes("analyze-image") || d.taskRoles.includes("ground-objects")));
}
export function getTextCapableLabModels(candidates: readonly LabCandidate[] = LAB_CANDIDATES): readonly LabCandidate[] { return candidates.filter((d) => d.capabilities.includes("text")); }
export function getBenchmarkCapableLabModels(candidates: readonly LabCandidate[] = LAB_CANDIDATES): readonly LabCandidate[] { return candidates.filter((d) => d.distribution.benchmarkAllowed); }

/** Packaging policy, byte provenance and qualification are separate gates. */
export function labLicenseDecision(candidate: LabCandidate, channel: LabDistributionChannel = "bundle"): { readonly allowed: boolean; readonly reason: string } {
  if (channel === "bundle" || channel === "download") {
    if (!candidate.pinsVerified) return { allowed: false, reason: `${candidate.modelId}: pins pending verification` };
    const allowed = channel === "bundle" ? candidate.distribution.bundleAllowed : candidate.distribution.downloadAllowed;
    return { allowed, reason: allowed
      ? `${candidate.modelId}: ${channel} permitted subject to the upstream license, attribution/NOTICE and commercial eligibility; no product qualification.`
      : `${candidate.modelId}: ${channel} blocked by FindBack packaging policy, not an upstream redistribution prohibition.` };
  }
  return { allowed: candidate.distribution.benchmarkAllowed, reason: `${candidate.modelId}: explicit lab evaluation, subject to upstream license conditions.` };
}
export function isLabDownloadAllowed(candidate: LabCandidate, channel: LabDistributionChannel = "download"): boolean {
  return candidate.pinsVerified && labLicenseDecision(candidate, channel).allowed;
}
