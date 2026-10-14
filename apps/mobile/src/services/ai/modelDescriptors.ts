/**
 * Phase A (Step 2): canonical model descriptor registry.
 *
 * MODEL != RUNTIME != FORMAT != TASK. Every production fact about an
 * on-device model — display, artifact, pins, capabilities, permitted task
 * roles, maturity, trust, license, memory, ABIs — lives in exactly one
 * descriptor. No production logic may identify a model by list position
 * (`DOWNLOAD_MODELS[0]`/`[1]`); use `descriptorFor`, `visionDescriptor`,
 * capability lookup, or the descriptor's own `runtimeId`.
 *
 * Test-only third descriptors are first-class: build a custom registry with
 * `createModelRegistry([...production, third])` and inject it. Production
 * code paths use the frozen `productionModelRegistry()` singleton.
 */
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import { profileFor } from "./modelProfiles";
import type { AiTaskId } from "./types";
import { SUPPLY_CANDIDATES, type ModelArtifact, type LicenseFacts } from "./modelSupply";

/** Physical runtime ids. `test-*` ids exist only in test registries. */
export const NEEDLE_RUNTIME_ID = "needle-cact" as const;
export const SMOL_VLM_RUNTIME_ID = "smolvlm2-litertlm" as const;
/**
 * LiteRT-LM general text resident (Qwen3 0.6B). Model-specific, never a
 * bare "litertlm" id: text and vision residents arbitrate separately and
 * late callbacks must never address the wrong engine.
 */
export const QWEN_TEXT_RUNTIME_ID = "qwen3-litertlm-text" as const;
/** Canonical llama.cpp text/mtmd evaluation resident; no automatic product roles. */
export const LLAMA_CPP_RUNTIME_ID = "llamacpp-gguf" as const;

export type ModelArtifactFormat = "cact" | "litertlm" | "gguf" | "tflite";

export type ModelCapability = "text" | "vision" | "embedding" | "matching";

export type ModelMaturity = "production" | "lab" | "experimental";

/**
 * Consumer catalogue tier. Recommended rows are verified, distributable,
 * and device-qualified; Advanced rows are visible but truthfully gated
 * (pin-verification-required, license-restricted, or unmeasured). The
 * default derives from maturity so older literals keep their meaning.
 */
export type ModelTier = "recommended" | "advanced";

/**
 * Distribution policy (gates check this, never prose):
 * - `downloadable`: verified pin + redistributable license, offered for download.
 * - `license-restricted`: operational policy only, not an upstream legal claim.
 * - `unavailable`: pending pin verification or measurement — visible with
 *   the consumer reason, no install path of any kind.
 */
export type DistributionPolicy = "downloadable" | "license-restricted" | "unavailable";

export type ModelTrust = "curated" | "imported";

export interface ModelDescriptor {
  readonly sources?: readonly string[];
  readonly companions?: readonly ModelArtifact[];
  readonly licenseFacts?: LicenseFacts;
  readonly minRuntimeVersion?: string;
  readonly deviceQualifiedAbis?: readonly string[];
  readonly modelId: string;
  readonly displayName: string;
  /** Consumer catalogue copy (normal tier: no ids, checksums, or transfer jargon). */
  readonly consumerTitle: string;
  readonly consumerDetail: string;
  /** Physical runtime that executes this model (never an array index). */
  readonly runtimeId: string;
  readonly format: ModelArtifactFormat;
  /** Immutable catalogue revision; doubles as the install path segment. */
  readonly revision: string;
  /** SHA-256 of the exact downloadable bytes. */
  readonly sha256: string;
  readonly fileName: string;
  readonly url: string;
  readonly bytes: number;
  readonly capabilities: readonly ModelCapability[];
  /** FindBack task roles this model may serve in production. */
  readonly taskRoles: readonly AiTaskId[];
  readonly maturity: ModelMaturity;
  readonly trust: ModelTrust;
  /** Distribution/license policy label (gates check this, not prose). */
  readonly license: string;
  readonly minRamMb: number;
  readonly recommendedRamMb: number;
  /** Verified executable ABIs. Empty means unverified everywhere. */
  readonly abis: readonly string[];
  /** Listed on the consumer download catalogue. */
  readonly downloadable: boolean;
  /**
   * Consumer catalogue tier. Omitted means derived from maturity
   * (production → recommended, anything else → advanced).
   */
  readonly tier?: ModelTier;
  /**
   * True when the model's license would permit running a user-supplied local
   * copy (LFM license arms). This is a license fact only: FindBack ships no
   * download or import action for it, so the UI must show the restriction and
   * offer nothing.
   */
  readonly importable?: boolean;
  /**
   * Consumer-facing reason shown when the model cannot be installed
   * (legal restriction, pending verification). Normal tier copy: no ids,
   * hashes, or runtime jargon.
   */
  readonly distributionNote?: string;
  /**
   * Upstream repo (org/name) for Advanced transparency. Pins still live
   * in revision/sha256; this is provenance display only.
   */
  readonly upstreamRepo?: string;
  /**
   * True only for user-supplied files that were never curated/verified as a
   * known pin (identity stays `imported-<sha256>`, trust `imported`). The
   * production task seams refuse these: they are reachable only through the
   * explicit Advanced evaluation path, which runs them as an evaluation load.
   */
  readonly untrustedImport?: boolean;
}

/** Consumer tier of one descriptor (explicit tier wins, else maturity-derived). */
export function tierOf(descriptor: ModelDescriptor): ModelTier {
  if (descriptor.tier !== undefined) return descriptor.tier;
  return descriptor.maturity === "production" ? "recommended" : "advanced";
}

/** Machine-readable distribution policy derived from the descriptor. */
export function distributionPolicyOf(descriptor: ModelDescriptor): DistributionPolicy {
  if (descriptor.downloadable) return "downloadable";
  if (descriptor.importable === true) return "license-restricted";
  return "unavailable";
}

export interface ModelRegistry {
  readonly descriptors: readonly ModelDescriptor[];
  descriptorFor(modelId: string): ModelDescriptor | undefined;
  requireDescriptor(modelId: string): ModelDescriptor;
  /**
   * Audit closure: the default vision model is EXPLICIT registry policy,
   * never catalogue order. Returns the configured default descriptor, or
   * undefined when the registry names none — even if vision-capable
   * entries exist. A future second vision model changes selection by
   * changing this policy, not by reordering the catalogue.
   */
  visionDescriptor(): ModelDescriptor | undefined;
  /** All downloadable catalogue entries, in catalogue order. */
  catalogue(): readonly ModelDescriptor[];
  /**
   * Advanced entries: registered but not downloadable (pending pin,
   * license-restricted, or unmeasured). Rendered in Advanced with their
   * truthful reason — never a second shadow list owned by the UI.
   */
  advancedCatalogue(): readonly ModelDescriptor[];
}

export interface ModelRegistryOptions {
  /** Model id selected by visionDescriptor(); required for vision features. */
  readonly defaultVisionModelId?: string;
}

function profilePin(modelId: string): { revision: string; sha256: string } {
  const profile = profileFor(modelId);
  if (profile === undefined) throw new Error(`No model profile for ${modelId}`);
  return { revision: profile.revision, sha256: profile.modelSha256 };
}

const NEEDLE_PIN = profilePin(NEEDLE_MODEL_ID);
export const SMOL_VISION_MODEL_ID = "smolvlm2-500M-vision";
const SMOL_PIN = profilePin(SMOL_VISION_MODEL_ID);

const SMOL_TASK_ROLES: readonly AiTaskId[] = ["analyze-image", "ground-objects"];
/**
 * Audit closure: Needle's advertised roles are exactly what its native
 * path genuinely satisfies today — the record_item tool-constrained
 * structured path (slot extraction with strict validators) and the
 * embedding path (validated vectors). Prose tasks (answer-help,
 * summarize-local-context) and intent tasks (classify-intent,
 * route-intent) have explicit interpreters and fail closed on the model
 * path, but the tool schema is report-shaped and free prose is unproven
 * on device — so they are NOT advertised until device evidence proves
 * them. Roles expand with evidence, never with hope.
 */
const NEEDLE_TEXT_ROLES: readonly AiTaskId[] = [
  "extract-report-fields",
  "extract-search-filters",
  "classify-category",
  "embed-texts",
];

export const NEEDLE_DESCRIPTOR: ModelDescriptor = {
  modelId: NEEDLE_MODEL_ID,
  displayName: "Needle · structured text / matching challenger",
  consumerTitle: "Local text tools",
  consumerDetail: "Needle3",
  runtimeId: NEEDLE_RUNTIME_ID,
  format: "cact",
  revision: NEEDLE_PIN.revision,
  sha256: NEEDLE_PIN.sha256,
  fileName: "needle3.cact",
  url: "https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089/needle3.cact",
  bytes: 35335380,
  capabilities: ["text", "embedding", "matching"],
  taskRoles: NEEDLE_TEXT_ROLES,
  maturity: "production",
  trust: "curated",
  license: "redistributable-cactus",
  // Current effective assumption (was the coarse 1500 for every model).
  // A lower Needle-specific bound needs same-device measurement first.
  minRamMb: 1500,
  recommendedRamMb: 2048,
  // Verified: native needle target builds arm64-v8a only (CMake lab gate).
  abis: ["arm64-v8a"],
  downloadable: true,
};

export const SMOL_VISION_DESCRIPTOR: ModelDescriptor = {
  modelId: SMOL_VISION_MODEL_ID,
  displayName: "SmolVLM2 · image description",
  consumerTitle: "Photo analysis",
  consumerDetail: "SmolVLM2",
  runtimeId: SMOL_VLM_RUNTIME_ID,
  format: "litertlm",
  revision: SMOL_PIN.revision,
  sha256: SMOL_PIN.sha256,
  fileName: "SmolVLM2-500M.litertlm",
  url: "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/dad030b6e56756201d670cfb4d042736a2ce3a5c/SmolVLM2-500M.litertlm",
  bytes: 360822960,
  capabilities: ["vision"],
  taskRoles: SMOL_TASK_ROLES,
  maturity: "production",
  trust: "curated",
  license: "redistributable-apache-2.0",
  minRamMb: 1500,
  recommendedRamMb: 2048,
  // ARM64 physical devices are the validated target. x86_64 emulator AI has
  // no device evidence, so it stays unlisted (fail-closed) until measured.
  abis: ["arm64-v8a"],
  downloadable: true,
};

/**
 * Qwen3 0.6B dynamic INT4 — first-class on-device assistant text.
 * Pins are REUSED from the lab profile (profilePin), never duplicated:
 * revision a3c5d805 + sha 03e7da1e live in modelProfiles.ts. Bytes
 * (344,671,744) and the upstream repo/file come from the lab lane records
 * (docs/runbooks/native-model-run.md, benchmark/labCatalog.ts). The URL
 * follows the same Hugging Face resolve scheme as the SmolVLM2 descriptor.
 * Chat qualification (answer-help) derives from the same authority as
 * routing; see QWEN_TASK_ROLES for why the lab profile's extraction roles
 * are deliberately NOT advertised in production.
 */
export const QWEN_TEXT_MODEL_ID = "qwen3-0.6b-dynamic-int4";
const QWEN_PIN = profilePin(QWEN_TEXT_MODEL_ID);
/**
 * Qwen3 0.6B is the prose assistant. It advertises ONLY `answer-help`.
 *
 * The extraction/classification roles are STRUCTURED (tool-constrained)
 * tasks served by Needle's `record_item`/`search_filters`/`item_category`
 * schemas — the production seam wires `completeStructured` to Needle, and
 * Qwen runs prose completion. Advertising those roles here made a Qwen-only
 * install claim "Fills in reports" while the route actually needed Needle,
 * so the claim was removed. Roles expand with evidence, never with hope.
 */
const QWEN_TASK_ROLES: readonly AiTaskId[] = ["answer-help"];

export const QWEN_TEXT_DESCRIPTOR: ModelDescriptor = {
  modelId: QWEN_TEXT_MODEL_ID,
  displayName: "Qwen3 · on-device assistant text",
  consumerTitle: "On-device assistant",
  consumerDetail: "Qwen3",
  runtimeId: QWEN_TEXT_RUNTIME_ID,
  format: "litertlm",
  revision: QWEN_PIN.revision,
  sha256: QWEN_PIN.sha256,
  fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
  url: `https://huggingface.co/litert-community/Qwen3-0.6B/resolve/${QWEN_PIN.revision}/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm`,
  bytes: 344671744,
  capabilities: ["text"],
  taskRoles: QWEN_TASK_ROLES,
  maturity: "production",
  tier: "recommended",
  trust: "curated",
  license: "redistributable-apache-2.0",
  minRamMb: 1500,
  recommendedRamMb: 2048,
  abis: ["arm64-v8a"],
  downloadable: true,
  upstreamRepo: "litert-community/Qwen3-0.6B",
};

/**
 * Advanced acquisition and evaluation are independent of task qualification.
 * Immutable upstream evidence and bundle identities live in modelSupply.
 */
export const ADVANCED_DESCRIPTORS: readonly ModelDescriptor[] = SUPPLY_CANDIDATES;

const ALL_DESCRIPTORS: readonly ModelDescriptor[] = [
  NEEDLE_DESCRIPTOR,
  SMOL_VISION_DESCRIPTOR,
  QWEN_TEXT_DESCRIPTOR,
  ...ADVANCED_DESCRIPTORS,
];

/** True when the descriptor verifies this ABI. Unknown ABI never counts. */
export function modelSupportsAbi(descriptor: ModelDescriptor, abi: string): boolean {
  return abi !== "" && descriptor.abis.includes(abi);
}

export function createModelRegistry(
  descriptors: readonly ModelDescriptor[],
  options?: ModelRegistryOptions,
): ModelRegistry {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.modelId)) throw new Error(`Duplicate model descriptor ${descriptor.modelId}`);
    seen.add(descriptor.modelId);
  }
  const frozen = Object.freeze([...descriptors]);
  const defaultVisionModelId = options?.defaultVisionModelId;
  if (defaultVisionModelId !== undefined && !seen.has(defaultVisionModelId)) {
    throw new Error(`Default vision model ${defaultVisionModelId} is not registered`);
  }
  return {
    descriptors: frozen,
    descriptorFor: (modelId: string) => frozen.find((item) => item.modelId === modelId),
    requireDescriptor: (modelId: string) => {
      const found = frozen.find((item) => item.modelId === modelId);
      if (found === undefined) throw new Error("Unknown on-device model");
      return found;
    },
    visionDescriptor: () =>
      defaultVisionModelId === undefined ? undefined : frozen.find((item) => item.modelId === defaultVisionModelId),
    catalogue: () => frozen.filter((item) => item.downloadable && tierOf(item) === "recommended"),
    advancedCatalogue: () => frozen.filter((item) => tierOf(item) === "advanced"),
  };
}

let production: ModelRegistry | undefined;

/**
 * Frozen production singleton: the canonical descriptor authority — every
 * product-visible model. The downloadable catalogue is Needle + SmolVLM2
 * vision + Qwen3 text; Advanced candidates are registered but never
 * downloadable until their pin/license/measurement gates clear.
 */
export function productionModelRegistry(): ModelRegistry {
   return (production ??= createModelRegistry([...ALL_DESCRIPTORS.filter((d) => d.maturity === "production"), ...SUPPLY_CANDIDATES], { defaultVisionModelId: SMOL_VISION_MODEL_ID }));
}
