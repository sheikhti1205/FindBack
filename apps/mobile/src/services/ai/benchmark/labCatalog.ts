/**
 * Model-lab benchmark catalogue (benchmark lane, never production).
 *
 * Separate axes, per findback-ai-runtime: MODEL != RUNTIME != FORMAT !=
 * ROLE != MATURITY. Every lab candidate records upstream revision, artifact
 * hash, license/distribution decision, runtime/format, and a RAM *estimate*
 * (host estimate, never a device measurement). Device measurement lands
 * later through the benchmark harness on a reachable phone.
 *
 * Promotion invariant: NO lab candidate here is Recommended. The production
 * Recommended set stays exactly Needle + SmolVLM2 vision in
 * `modelDescriptors.ts` (production registry, curated, downloadable). This
 * module is the Advanced catalogue: every new candidate is
 * `integrated-pending-measurement`, clearly labeled unmeasured, and the
 * owner hand-picks from measured data before anything moves toward
 * production. Nothing here registers with the orchestrator, router, probe,
 * Needle, UI picker, or packer — the benchmark harness wires it explicitly.
 *
 * Baselines (already integrated): Qwen3 0.6B text and SmolVLM2 500M vision
 * reference the verified pins in `modelProfiles.ts`. All other candidates
 * carry `pinsVerified: false` with `revision`/`sha256` set to
 * `pending-verification`: the download gate blocks bundle/download until
 * the upstream pin is verified, while benchmark/eval fixture runs stay
 * allowed (no weights needed for fixture scoring).
 *
 * DEVICE UNAVAILABLE (2026-10-10): adb 192.168.2.100:37399 refuses (10061)
 * from all environments. No measured runs are claimed here; every new
 * candidate is pending-measurement by construction.
 */

export type LabModality = "text" | "vision";

/** Physical runtimes the lab may benchmark. `cactus-lab` is the unified challenger seam. */
export type LabRuntime = "litert-lm" | "llama-cpp" | "needle-cact" | "cactus-lab";

export type LabFormat = "litertlm" | "gguf" | "cact";

export type LabCapability = "text" | "vision" | "embedding" | "matching";

export type LabTaskRole =
  | "answer-help"
  | "extract-report-fields"
  | "extract-search-filters"
  | "classify-category"
  | "classify-intent"
  | "summarize-local-context"
  | "analyze-image"
  | "ground-objects";

/** Lab maturity: baselines keep their production maturity; everything new is unmeasured. */
export type LabMaturity = "baseline" | "lab-unmeasured";

export type LabCatalogueTier = "recommended" | "advanced";

export type LabDistributionChannel = "bundle" | "download" | "benchmark" | "eval";

export type LabCandidateStatus = "integrated-baseline" | "integrated-pending-measurement";

export interface LabDistribution {
  /** Human-readable license id (e.g. "Apache-2.0", "LFM-1.0"). */
  readonly license: string;
  /** True when bundle shipment is permitted (never for LFM or pending pins). */
  readonly bundleAllowed: boolean;
  /** True when a redistributable download is permitted (never for LFM or pending pins). */
  readonly downloadAllowed: boolean;
  /** Benchmark/eval lab runs are the only allowed channel for unmeasured arms. */
  readonly benchmarkAllowed: boolean;
  readonly note: string;
}

export interface LabCandidate {
  readonly modelId: string;
  readonly displayName: string;
  readonly modality: LabModality;
  /** Upstream repo (org/name) the artifact is sourced from. */
  readonly upstreamRepo: string;
  readonly fileName: string;
  /** Upstream revision (commit/tag). `pending-verification` until verified. */
  readonly revision: string;
  /** SHA-256 of the exact downloadable bytes. `pending-verification` until verified. */
  readonly sha256: string;
  /** True only when revision+sha were verified against upstream (baselines only). */
  readonly pinsVerified: boolean;
  readonly distribution: LabDistribution;
  readonly runtime: LabRuntime;
  readonly format: LabFormat;
  /** Host RAM *estimate* in MiB (never a device measurement). */
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
  readonly capabilities: readonly LabCapability[];
  readonly taskRoles: readonly LabTaskRole[];
  readonly maturity: LabMaturity;
  readonly tier: LabCatalogueTier;
  readonly status: LabCandidateStatus;
  readonly baseline: boolean;
  /** Consumer-safe one-line note for the Advanced catalogue (no ids/hashes). */
  readonly advancedNote: string;
}

function apacheDistribution(note: string, pinsVerified: boolean): LabDistribution {
  return {
    license: "Apache-2.0",
    bundleAllowed: pinsVerified,
    downloadAllowed: pinsVerified,
    benchmarkAllowed: true,
    note,
  };
}

function lfmDistribution(note: string): LabDistribution {
  return {
    license: "LFM-1.0",
    bundleAllowed: false,
    downloadAllowed: false,
    benchmarkAllowed: true,
    note,
  };
}

export const LAB_CANDIDATES: readonly LabCandidate[] = [
  {
    modelId: "qwen3-0.6b-dynamic-int4",
    displayName: "Qwen3 0.6B (text baseline, keep)",
    modality: "text",
    upstreamRepo: "litert-community/Qwen3-0.6B",
    fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    pinsVerified: true,
    distribution: apacheDistribution(
      "Redistributable Apache-2.0; baseline pins mirror modelProfiles.ts.",
      true,
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 1500,
    recommendedRamMb: 2048,
    capabilities: ["text"],
    taskRoles: ["answer-help", "extract-report-fields", "extract-search-filters", "classify-intent"],
    maturity: "baseline",
    tier: "recommended",
    status: "integrated-baseline",
    baseline: true,
    advancedNote: "Baseline text model (measured path).",
  },
  {
    modelId: "qwen3-1.7b-dynamic-int4",
    displayName: "Qwen3 1.7B (text candidate, unmeasured)",
    modality: "text",
    upstreamRepo: "litert-community/Qwen3-1.7B",
    fileName: "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: apacheDistribution(
      "Apache-2.0 pending upstream pin verification; no bundle/download until verified. Benchmark fixture runs only.",
      false,
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 2200,
    recommendedRamMb: 3072,
    capabilities: ["text"],
    taskRoles: ["answer-help", "extract-report-fields", "extract-search-filters", "classify-intent"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured text candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "lfm2-350m-q4_0",
    displayName: "LFM2 350M (text candidate, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-350M",
    fileName: "LFM2-350M-Q4_0.gguf",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: lfmDistribution(
      "LFM Open License v1.0: benchmark/eval-only, catalogOnly; no bundling or redistributable download.",
    ),
    runtime: "llama-cpp",
    format: "gguf",
    minRamMb: 1200,
    recommendedRamMb: 1800,
    capabilities: ["text"],
    taskRoles: ["answer-help"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured text candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "lfm2-700m-q4_0",
    displayName: "LFM2 700M (text candidate, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-700M",
    fileName: "LFM2-700M-Q4_0.gguf",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: lfmDistribution(
      "LFM Open License v1.0: benchmark/eval-only, catalogOnly; no bundling or redistributable download.",
    ),
    runtime: "llama-cpp",
    format: "gguf",
    minRamMb: 1500,
    recommendedRamMb: 2200,
    capabilities: ["text"],
    taskRoles: ["answer-help"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured text candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "lfm2-1.2b-q4_0",
    displayName: "LFM2 1.2B (text candidate, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-1.2B",
    fileName: "LFM2-1.2B-Q4_0.gguf",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: lfmDistribution(
      "LFM Open License v1.0: benchmark/eval-only, catalogOnly; no bundling or redistributable download.",
    ),
    runtime: "llama-cpp",
    format: "gguf",
    minRamMb: 1800,
    recommendedRamMb: 2600,
    capabilities: ["text"],
    taskRoles: ["answer-help"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured text candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "granite-3.3-2b-instruct-q4_0",
    displayName: "Granite 3.3 2B Instruct (text candidate, unmeasured)",
    modality: "text",
    upstreamRepo: "ibm-granite/granite-3.3-2b-instruct",
    fileName: "granite-3.3-2b-instruct-Q4_0.gguf",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: apacheDistribution(
      "Apache-2.0 pending upstream pin verification; no bundle/download until verified. Benchmark fixture runs only.",
      false,
    ),
    runtime: "llama-cpp",
    format: "gguf",
    minRamMb: 2300,
    recommendedRamMb: 3200,
    capabilities: ["text"],
    taskRoles: ["answer-help", "extract-report-fields", "extract-search-filters"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured text candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "smolvlm2-500M-vision",
    displayName: "SmolVLM2 500M (vision baseline, keep)",
    modality: "vision",
    upstreamRepo: "litert-community/SmolVLM2-500M",
    fileName: "SmolVLM2-500M.litertlm",
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    pinsVerified: true,
    distribution: apacheDistribution(
      "Redistributable Apache-2.0; baseline pins mirror modelProfiles.ts.",
      true,
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 1500,
    recommendedRamMb: 2048,
    capabilities: ["vision"],
    taskRoles: ["analyze-image", "ground-objects"],
    maturity: "baseline",
    tier: "recommended",
    status: "integrated-baseline",
    baseline: true,
    advancedNote: "Baseline vision model (measured path).",
  },
  {
    modelId: "lfm2-vl-450m-int4",
    displayName: "LFM2-VL 450M (vision candidate, unmeasured)",
    modality: "vision",
    upstreamRepo: "LiquidAI/LFM2-VL-450M",
    fileName: "LFM2-VL-450M-int4.litertlm",
    revision: "1abed04b6fe71314d8c446a1371c03d7c332266d",
    sha256: "45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797",
    pinsVerified: false,
    distribution: lfmDistribution(
      "LFM Open License v1.0: benchmark/eval-only, catalogOnly; no bundling or redistributable download. " +
        "Revision mirrors the evaluated litert-lm arm; fixB variant (6854cd96…) recorded in the runbook. " +
        "On-device re-measurement required before any pick.",
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 1600,
    recommendedRamMb: 2300,
    capabilities: ["vision"],
    taskRoles: ["analyze-image"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured vision candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "lfm2-vl-1.6b-int4",
    displayName: "LFM2-VL 1.6B (vision candidate, unmeasured)",
    modality: "vision",
    upstreamRepo: "LiquidAI/LFM2-VL-1.6B",
    fileName: "LFM2-VL-1.6B-int4.litertlm",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: lfmDistribution(
      "LFM Open License v1.0: benchmark/eval-only, catalogOnly; no bundling or redistributable download.",
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 2400,
    recommendedRamMb: 3400,
    capabilities: ["vision"],
    taskRoles: ["analyze-image"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured vision candidate — needs phone measurement before any pick.",
  },
  {
    modelId: "qwen3-vl-2b-instruct-int4",
    displayName: "Qwen3-VL 2B Instruct (vision candidate, unmeasured)",
    modality: "vision",
    upstreamRepo: "Qwen/Qwen3-VL-2B-Instruct",
    fileName: "Qwen3-VL-2B-Instruct-int4.litertlm",
    revision: "pending-verification",
    sha256: "pending-verification",
    pinsVerified: false,
    distribution: apacheDistribution(
      "Apache-2.0 pending upstream pin verification; no bundle/download until verified. Benchmark fixture runs only.",
      false,
    ),
    runtime: "litert-lm",
    format: "litertlm",
    minRamMb: 2400,
    recommendedRamMb: 3400,
    capabilities: ["vision"],
    taskRoles: ["analyze-image"],
    maturity: "lab-unmeasured",
    tier: "advanced",
    status: "integrated-pending-measurement",
    baseline: false,
    advancedNote: "Unmeasured vision candidate — needs phone measurement before any pick.",
  },
];

export function labCandidateFor(modelId: string): LabCandidate | undefined {
  return LAB_CANDIDATES.find((candidate) => candidate.modelId === modelId);
}

export function requireLabCandidate(modelId: string): LabCandidate {
  const found = labCandidateFor(modelId);
  if (found === undefined) throw new Error(`Unknown lab model ${modelId}`);
  return found;
}

/** Advanced catalogue: every lab candidate, in catalogue order. */
export function advancedCatalogue(): readonly LabCandidate[] {
  return [...LAB_CANDIDATES];
}

/**
 * Recommended lab set: always empty. No lab candidate is Recommended until
 * measured evidence lands AND the owner hand-picks from the matrix. The
 * production Recommended set lives in `modelDescriptors.ts` and is
 * untouched by this module.
 */
export function recommendedLabCatalogue(): readonly LabCandidate[] {
  return [];
}

/**
 * Capability-driven selectors (UI contract): derive from capabilities and
 * task roles, never from hardcoded model-id switches. A future candidate
 * with the same capability/role shape appears automatically.
 */
export function getChatCapableLabModels(
  candidates: readonly LabCandidate[] = LAB_CANDIDATES,
): readonly LabCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.capabilities.includes("text") &&
      (candidate.taskRoles.includes("answer-help") ||
        candidate.taskRoles.includes("summarize-local-context")),
  );
}

export function getVisionCapableLabModels(
  candidates: readonly LabCandidate[] = LAB_CANDIDATES,
): readonly LabCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.capabilities.includes("vision") &&
      (candidate.taskRoles.includes("analyze-image") ||
        candidate.taskRoles.includes("ground-objects")),
  );
}

export function getTextCapableLabModels(
  candidates: readonly LabCandidate[] = LAB_CANDIDATES,
): readonly LabCandidate[] {
  return candidates.filter((candidate) => candidate.capabilities.includes("text"));
}

export function getBenchmarkCapableLabModels(
  candidates: readonly LabCandidate[] = LAB_CANDIDATES,
): readonly LabCandidate[] {
  return candidates.filter((candidate) => candidate.distribution.benchmarkAllowed);
}

/**
 * Lab distribution gate for one candidate + channel. Mirrors the production
 * `licenseGate.enforce` shape without importing it (no production coupling):
 * - LFM-1.0 + bundle/download → blocked (benchmark/eval-only).
 * - pending pins + bundle/download → blocked (no verified bytes to ship).
 * - benchmark/eval → allowed for every lab candidate (fixture runs need no weights).
 * Defaults to the strictest channel ("bundle").
 */
export function labLicenseDecision(
  candidate: LabCandidate,
  channel: LabDistributionChannel = "bundle",
): { readonly allowed: boolean; readonly reason: string } {
  const isLfm = candidate.distribution.license === "LFM-1.0";
  if (channel === "bundle" || channel === "download") {
    if (isLfm) {
      return {
        allowed: false,
        reason:
          `LFM Open License v1.0 (${candidate.modelId}): ${channel} blocked — ` +
          "benchmark/eval-only; no bundling or redistributable download",
      };
    }
    if (!candidate.pinsVerified) {
      return {
        allowed: false,
        reason:
          `${candidate.modelId}: ${channel} blocked — pins pending verification, ` +
          "no bundle/download until revision+sha are verified",
      };
    }
    return {
      allowed: candidate.distribution.downloadAllowed,
      reason: `${candidate.modelId}: ${channel} ${candidate.distribution.downloadAllowed ? "allowed" : "blocked"} per lab distribution`,
    };
  }
  return {
    allowed: true,
    reason: `${candidate.modelId}: ${channel} allowed for lab evaluation only`,
  };
}

/** True when the candidate may be downloaded on the given channel (fail-closed). */
export function isLabDownloadAllowed(
  candidate: LabCandidate,
  channel: LabDistributionChannel = "download",
): boolean {
  return labLicenseDecision(candidate, channel).allowed === true && candidate.pinsVerified === true;
}
