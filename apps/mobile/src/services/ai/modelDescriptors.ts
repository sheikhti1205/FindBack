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

export type ModelArtifactFormat = "cact" | "litertlm" | "gguf" | "tflite";

export type ModelCapability = "text" | "vision" | "embedding" | "matching";

export type ModelMaturity = "production" | "lab" | "experimental";

export type ModelTrust = "curated" | "imported";

export interface ModelDescriptor {
  readonly modelId: string;
  readonly displayName: string;
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
}

export interface ModelRegistry {
  readonly descriptors: readonly ModelDescriptor[];
  descriptorFor(modelId: string): ModelDescriptor | undefined;
  requireDescriptor(modelId: string): ModelDescriptor;
  /** Names the vision model without any positional assumption. */
  visionDescriptor(): ModelDescriptor | undefined;
  /** All downloadable catalogue entries, in catalogue order. */
  catalogue(): readonly ModelDescriptor[];
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

const PRODUCTION_DESCRIPTORS: readonly ModelDescriptor[] = [NEEDLE_DESCRIPTOR, SMOL_VISION_DESCRIPTOR];

/** True when the descriptor verifies this ABI. Unknown ABI never counts. */
export function modelSupportsAbi(descriptor: ModelDescriptor, abi: string): boolean {
  return abi !== "" && descriptor.abis.includes(abi);
}

export function createModelRegistry(descriptors: readonly ModelDescriptor[]): ModelRegistry {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.modelId)) throw new Error(`Duplicate model descriptor ${descriptor.modelId}`);
    seen.add(descriptor.modelId);
  }
  const frozen = Object.freeze([...descriptors]);
  return {
    descriptors: frozen,
    descriptorFor: (modelId: string) => frozen.find((item) => item.modelId === modelId),
    requireDescriptor: (modelId: string) => {
      const found = frozen.find((item) => item.modelId === modelId);
      if (found === undefined) throw new Error("Unknown on-device model");
      return found;
    },
    visionDescriptor: () => frozen.find((item) => item.capabilities.includes("vision")),
    catalogue: () => frozen.filter((item) => item.downloadable),
  };
}

let production: ModelRegistry | undefined;

/** Frozen production singleton: Needle + SmolVLM2 vision, nothing else. */
export function productionModelRegistry(): ModelRegistry {
  return (production ??= createModelRegistry(PRODUCTION_DESCRIPTORS));
}
