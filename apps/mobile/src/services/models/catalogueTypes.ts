/**
 * Curated Model Library catalogue types (Tasks 26-27, SPEC ONLY).
 *
 * Mirrors docs/specs/model-library/catalogue.schema.json. Types + sentinel
 * constants only — no fetching, no downloading, no enforcement logic.
 * Enforcement (install gate, checksum verification) is a LATER task.
 */

/** Unknown-value sentinel. Never invent numbers; use this instead. */
export const UNKNOWN_NOT_ESTABLISHED = 'UNKNOWN_NOT_ESTABLISHED' as const;

export type ModelCategory = 'vision' | 'text' | 'multimodal' | 'experimental-large';

export type ModelRuntime = 'litert-lm' | 'llama-cpp' | 'tbd';

export type ModelFormat = 'litertlm' | 'gguf' | 'tflite' | 'tbd-litertlm';

export type RamRequirementSource = 'MEASURED' | 'VENDOR' | 'CONSERVATIVE_ESTIMATE';

export type VerificationStatus =
  | 'VERIFIED'
  | 'SUPPORTED_UNVERIFIED'
  | 'EXPERIMENTAL'
  | 'INCOMPATIBLE';

export type ProvenanceKind =
  | 'VENDOR_MODEL_CARD'
  | 'VENDOR_DOCS'
  | 'PAPER'
  | 'REPO_EVIDENCE'
  | 'THIRD_PARTY_CONVERSION'
  | 'GITHUB_DOCS'
  | 'UNKNOWN';

export interface ProvenanceSource {
  kind: ProvenanceKind;
  /** URL, repo path, or citation. */
  ref: string;
  note: string;
}

export interface ModelCatalogueEntry {
  id: string;
  displayName: string;
  category: ModelCategory;
  role: string;
  runtime: ModelRuntime;
  format: ModelFormat;
  /** Pinned upstream revision, or UNKNOWN_NOT_ESTABLISHED. Provenance only; never used to build a download URL. */
  revision: string;
  /** License id as published by the rights holder (apache-2.0, lfm-open-1.0, gemma, …). */
  license: string;
  licenseUrl?: string;
  /** Exact bytes, or null when not established (VERIFIED entries must be non-null). */
  downloadBytes: number | null;
  installedBytes: number | null;
  /** 64-char lowercase hex, or null when not established. */
  sha256: string | null;
  /**
   * Installed-weights artifact hash (64-char lowercase hex), or null when not
   * established. Distinct from `sha256`, which pins the distribution package:
   * packaging changes package bytes/hash by design, while the installed
   * weights must keep matching the qualified pin.
   */
  installedSha256?: string | null;
  /** Immutable raw-weight source; never interpreted as a release package. */
  pinnedRawSource?: {
    repo: string;
    revision: string;
    file: string;
    bytes: number;
    sha256: string;
  } | null;
  minFreeRamMb: number;
  recommendedFreeRamMb: number;
  ramRequirementSource: RamRequirementSource;
  ramNotes?: string;
  verificationStatus: VerificationStatus;
  /** True = reference listing; not distributed via FindBack-Models in v1. */
  catalogOnly?: boolean;
  /** True = running below minimum (or any large-entry run) needs explicit advanced confirmation. */
  requiresAdvancedConfirm?: boolean;
  description: string;
  supportedCapabilities: string[];
  upstreamRepo: string;
  upstreamFile?: string | null;
  /** Pinned asset name(s) in the pinned release, or null. */
  releaseAsset?: string[] | null;
  /** Pinned .fbmodel release asset, or null when not distributed. */
  distribution?: ModelDistribution | null;
  provenance: ProvenanceSource[];
}

export interface DistributionPart {
  asset: string;
  bytes: number;
  sha256: string;
}

/**
 * Shipped publication state of a release asset. UNPUBLISHED = the package
 * is prepared but not published in this build: no network download may be
 * offered and every URL-consumption path fails closed. Flipping an entry to
 * PUBLISHED is an app-release change.
 */
export type DistributionState = 'UNPUBLISHED' | 'PUBLISHED';

/**
 * Pinned GitHub Release asset for one `.fbmodel` package. The runtime
 * builds the download URL from repo/tag/asset only; it never polls the
 * API and never uses latest/main. Upstream repo/revision/file stay as
 * provenance only. `parts` is null for v1 single-asset entries.
 */
export interface ModelDistribution {
  repo: string;
  tag: string;
  asset: string;
  bytes: number;
  sha256: string;
  state: DistributionState;
  parts?: DistributionPart[] | null;
}

export interface PinnedModelsRelease {
  repo: string;
  tag: string;
}

export interface ModelCatalogue {
  catalogueVersion: '1';
  updatedAt: string;
  pinnedModelsRelease: PinnedModelsRelease;
  entries: ModelCatalogueEntry[];
}

/** Category display order for the library UI (design reference, see ram-ui.md). */
export const CATEGORY_ORDER: readonly ModelCategory[] = [
  'vision',
  'text',
  'multimodal',
  'experimental-large',
] as const;
