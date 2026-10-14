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

/** Physical runtime ids. `test-*` ids exist only in test registries. */
export const NEEDLE_RUNTIME_ID = "needle-cact" as const;
export const SMOL_VLM_RUNTIME_ID = "smolvlm2-litertlm" as const;
/**
 * LiteRT-LM general text resident (Qwen3 0.6B). Model-specific, never a
 * bare "litertlm" id: text and vision residents arbitrate separately and
 * late callbacks must never address the wrong engine.
 */
export const QWEN_TEXT_RUNTIME_ID = "qwen3-litertlm-text" as const;
/** llama.cpp/GGUF lab resident. No production GGUF download or import action exists. */
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
 * - `license-restricted`: license forbids redistribution (LFM arms). Shown so
 *   the restriction stays visible; this build ships no download AND no import
 *   action, so nothing is offered.
 * - `unavailable`: pending pin verification or measurement — visible with
 *   the consumer reason, no install path of any kind.
 */
export type DistributionPolicy = "downloadable" | "license-restricted" | "unavailable";

export type ModelTrust = "curated" | "imported";

export interface ModelDescriptor {
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
 * Qwen3 0.6B dynamic INT4 — first-class on-device text/chat/extraction.
 * Pins are REUSED from the lab profile (profilePin), never duplicated:
 * revision a3c5d805 + sha 03e7da1e live in modelProfiles.ts. Bytes
 * (344,671,744) and the upstream repo/file come from the lab lane records
 * (docs/runbooks/native-model-run.md, benchmark/labCatalog.ts). The URL
 * follows the same Hugging Face resolve scheme as the SmolVLM2 descriptor.
 * Task roles mirror the lab catalogue's evidence-backed set, so Chat
 * qualification (answer-help) derives from the same authority as routing.
 */
export const QWEN_TEXT_MODEL_ID = "qwen3-0.6b-dynamic-int4";
const QWEN_PIN = profilePin(QWEN_TEXT_MODEL_ID);
const QWEN_TASK_ROLES: readonly AiTaskId[] = [
  "answer-help",
  "extract-report-fields",
  "extract-search-filters",
  "classify-intent",
];

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
 * Advanced candidates (spec §A + lab benchmark matrix). Every entry is
 * registered so Advanced shows the complete intended set with a truthful
 * state — but none is downloadable:
 * - pending-pin arms (Qwen3 1.7B, Granite, Qwen3-VL) carry the literal
 *   `pending-verification` marker, never a fabricated pin; the manager's
 *   MISSING_PIN gate refuses them even if reached.
 * - LFM arms carry the LFM-1.0 eval-only license: not redistributable, so
 *   no download and no import action ships for them.
 * - taskRoles stay EMPTY until device measurement qualifies them: an
 *   unmeasured model routes to no product task. Capabilities name the
 *   modality only. RAM figures are the lab lane's host estimates for
 *   planning, never device measurements.
 * Facts (repos, files, RAM, license) mirror benchmark/labCatalog.ts and
 * docs/runbooks/model-benchmark-matrix.md; ids match the lab catalogue so
 * one model never gains two identities.
 */
function advancedText(
  modelId: string,
  displayName: string,
  consumerTitle: string,
  consumerDetail: string,
  runtimeId: string,
  format: ModelArtifactFormat,
  fileName: string,
  upstreamRepo: string,
  license: string,
  minRamMb: number,
  recommendedRamMb: number,
  capabilities: readonly ModelCapability[],
  distributionNote: string,
  importable: boolean,
): ModelDescriptor {
  return {
    modelId,
    displayName,
    consumerTitle,
    consumerDetail,
    runtimeId,
    format,
    revision: "pending-verification",
    sha256: "pending-verification",
    fileName,
    url: "",
    bytes: 0,
    capabilities,
    taskRoles: [],
    maturity: "lab",
    tier: "advanced",
    trust: "curated",
    license,
    minRamMb,
    recommendedRamMb,
    abis: [],
    downloadable: false,
    importable,
    distributionNote,
    upstreamRepo,
  };
}

const PENDING_PIN_NOTE = "Needs verification before it can be offered. Check back later.";
// Truthful state, not an offered action: this build has no import/evaluation
// affordance, so the copy must never imply one is available. It only records
// the license restriction that blocks hosted redistribution.
const LFM_IMPORT_NOTE =
  "License restricts redistribution, so FindBack does not host or download it. Listed to keep the restriction visible.";

export const ADVANCED_DESCRIPTORS: readonly ModelDescriptor[] = [
  advancedText(
    "qwen3-1.7b-dynamic-int4",
    "Qwen3 1.7B · larger assistant candidate (unverified)",
    "Large assistant (evaluation)",
    "Qwen3 1.7B",
    QWEN_TEXT_RUNTIME_ID,
    "litertlm",
    "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm",
    "litert-community/Qwen3-1.7B",
    "apache-2.0-pending-pin",
    2200,
    3072,
    ["text"],
    PENDING_PIN_NOTE,
    false,
  ),
  advancedText(
    "lfm2-350m-q4_0",
    "LFM2 350M · compact candidate (license-restricted)",
    "Compact assistant",
    "LFM2 350M",
    LLAMA_CPP_RUNTIME_ID,
    "gguf",
    "LFM2-350M-Q4_0.gguf",
    "LiquidAI/LFM2-350M",
    "lfm-1.0-eval-only",
    1200,
    1800,
    ["text"],
    LFM_IMPORT_NOTE,
    true,
  ),
  advancedText(
    "lfm2-700m-q4_0",
    "LFM2 700M · balanced candidate (license-restricted)",
    "Balanced assistant",
    "LFM2 700M",
    LLAMA_CPP_RUNTIME_ID,
    "gguf",
    "LFM2-700M-Q4_0.gguf",
    "LiquidAI/LFM2-700M",
    "lfm-1.0-eval-only",
    1500,
    2200,
    ["text"],
    LFM_IMPORT_NOTE,
    true,
  ),
  advancedText(
    "lfm2-1.2b-q4_0",
    "LFM2 1.2B · capable candidate (license-restricted)",
    "Capable assistant",
    "LFM2 1.2B",
    LLAMA_CPP_RUNTIME_ID,
    "gguf",
    "LFM2-1.2B-Q4_0.gguf",
    "LiquidAI/LFM2-1.2B",
    "lfm-1.0-eval-only",
    1800,
    2600,
    ["text"],
    LFM_IMPORT_NOTE,
    true,
  ),
  advancedText(
    "granite-3.3-2b-instruct-q4_0",
    "Granite 3.3 2B Instruct · candidate (unverified)",
    "Instruction assistant",
    "Granite 3.3 2B",
    LLAMA_CPP_RUNTIME_ID,
    "gguf",
    "granite-3.3-2b-instruct-Q4_0.gguf",
    "ibm-granite/granite-3.3-2b-instruct",
    "apache-2.0-pending-pin",
    2300,
    3200,
    ["text"],
    PENDING_PIN_NOTE,
    false,
  ),
  advancedText(
    "lfm2-vl-450m-int4",
    "LFM2-VL 450M · compact photo candidate (license-restricted)",
    "Compact photo helper (evaluation)",
    "LFM2-VL 450M",
    SMOL_VLM_RUNTIME_ID,
    "litertlm",
    "LFM2-VL-450M-int4.litertlm",
    "LiquidAI/LFM2-VL-450M",
    "lfm-1.0-eval-only",
    1600,
    2300,
    ["vision"],
    LFM_IMPORT_NOTE,
    true,
  ),
  advancedText(
    "lfm2-vl-1.6b-int4",
    "LFM2-VL 1.6B · photo candidate (license-restricted)",
    "Detailed photo helper (evaluation)",
    "LFM2-VL 1.6B",
    SMOL_VLM_RUNTIME_ID,
    "litertlm",
    "LFM2-VL-1.6B-int4.litertlm",
    "LiquidAI/LFM2-VL-1.6B",
    "lfm-1.0-eval-only",
    2400,
    3400,
    ["vision"],
    LFM_IMPORT_NOTE,
    true,
  ),
  advancedText(
    "qwen3-vl-2b-instruct-int4",
    "Qwen3-VL 2B Instruct · photo candidate (unverified)",
    "Advanced photo helper (evaluation)",
    "Qwen3-VL 2B",
    SMOL_VLM_RUNTIME_ID,
    "litertlm",
    "Qwen3-VL-2B-Instruct-int4.litertlm",
    "Qwen/Qwen3-VL-2B-Instruct",
    "apache-2.0-pending-pin",
    2400,
    3400,
    ["vision"],
    PENDING_PIN_NOTE,
    false,
  ),
];

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
    catalogue: () => frozen.filter((item) => item.downloadable),
    advancedCatalogue: () => frozen.filter((item) => !item.downloadable),
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
  return (production ??= createModelRegistry(ALL_DESCRIPTORS, { defaultVisionModelId: SMOL_VISION_MODEL_ID }));
}
