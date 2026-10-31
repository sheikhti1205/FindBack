/**
 * Installed-model readiness and storage facts.
 *
 * One authority for the question "is this model installed AND checksum
 * verified?" — the download lifecycle (`offlineModelManager`) owns the state,
 * this module owns the consumer-safe reading of it. File presence alone never
 * counts as ready.
 */
import type { OfflineModelManager } from "./offlineModelManager";

export type OfflineReadiness =
  | { readonly ready: true; readonly modelId: string }
  | {
      readonly ready: false;
      readonly modelId: string;
      readonly code: "unknown_model" | "model_not_installed" | "checksum_unverified";
      readonly reason: string;
    };

export interface OfflineAssetFacts {
  /** Total bytes on disk for the installed artifact. */
  readonly bytes: number;
  /** Resident memory the runtime needs to run this artifact. */
  readonly minRamMb: number;
}

export interface OfflineStorageEstimate {
  readonly requiredBytes: number;
  readonly availableBytes: number;
  readonly sufficient: boolean;
}

/** Installed + checksum-verified, or a specific reason it is not. */
export function describeOfflineReadiness(
  manager: OfflineModelManager,
  modelId: string,
): OfflineReadiness {
  const status = manager.statusOf(modelId);
  if (status === undefined) {
    return {
      ready: false,
      modelId,
      code: "unknown_model",
      reason: `unknown model ${modelId}`,
    };
  }
  if (status.download !== "installed") {
    return {
      ready: false,
      modelId,
      code: "model_not_installed",
      reason: `model ${modelId} is ${status.download}, not installed`,
    };
  }
  if (status.checksumVerified !== true) {
    return {
      ready: false,
      modelId,
      code: "checksum_unverified",
      reason: `model ${modelId} is installed but its checksum is unverified`,
    };
  }
  return { ready: true, modelId };
}

/** Free-space check with explicit headroom; never silently rounds down. */
export function estimateOfflineStorage(
  asset: OfflineAssetFacts,
  freeBytes: number,
  headroomBytes = 64 * 1024 * 1024,
): OfflineStorageEstimate {
  const requiredBytes = asset.bytes + headroomBytes;
  return { requiredBytes, availableBytes: freeBytes, sufficient: freeBytes >= requiredBytes };
}

/** Resident memory the runtime needs, with the artifact bytes as a floor. */
export function estimateOfflineMemoryMb(asset: OfflineAssetFacts): number {
  const fromBytes = Math.ceil(asset.bytes / (1024 * 1024));
  return Math.max(asset.minRamMb, fromBytes);
}
