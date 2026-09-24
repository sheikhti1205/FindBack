/**
 * Compact six-model manager catalogue mapping (revision 03).
 *
 * Pure mapping from the shipped catalogue to the compact `ManagerModel`
 * descriptors the `ModelManagerView` renders: exactly six entries, no
 * Gemma, Recommended 2 + Experimental 4, user-imported models appended by
 * the screen controller (never guessed labels). Display sizes are rounded
 * MiB labels only; transfer byte counts stay authoritative in the
 * catalogue JSON.
 */

import { SHIPPED_CATALOGUE_ENTRIES } from "./shippedCatalogue";
import type { ManagerModel, ManagerStatus } from "../../components/ModelManagerView";
import type { ImportedModelRecord } from "./packageTransferHost";

export const COMPACT_ORDER: readonly string[] = [
  "smolvlm2-500m-litert-int4",
  "qwen3-0.6b-litert-dynamic-int4",
  "qwen3-0.6b-litert-mixed-int4",
  "qwen3-0.6b-litert-int8",
  "lfm2.5-1.2b-instruct-litert-int4-gpu",
  "lfm2.5-vl-450m",
] as const;

export const COMPACT_LABELS: Readonly<Record<string, string>> = {
  "smolvlm2-500m-litert-int4": "SmolVLM2 500M",
  "qwen3-0.6b-litert-dynamic-int4": "Qwen3 0.6B",
  "qwen3-0.6b-litert-mixed-int4": "Qwen3 0.6B Mixed INT4",
  "qwen3-0.6b-litert-int8": "Qwen3 0.6B INT8",
  "lfm2.5-1.2b-instruct-litert-int4-gpu": "LFM2.5 1.2B",
  "lfm2.5-vl-450m": "LFM2.5 VL 450M",
};

export const COMPACT_ROLES: Readonly<Record<string, "Vision" | "Text">> = {
  "smolvlm2-500m-litert-int4": "Vision",
  "qwen3-0.6b-litert-dynamic-int4": "Text",
  "qwen3-0.6b-litert-mixed-int4": "Text",
  "qwen3-0.6b-litert-int8": "Text",
  "lfm2.5-1.2b-instruct-litert-int4-gpu": "Text",
  "lfm2.5-vl-450m": "Vision",
};

export const COMPACT_QUANTIZATION: Readonly<Record<string, string>> = {
  "smolvlm2-500m-litert-int4": "INT4",
  "qwen3-0.6b-litert-dynamic-int4": "Dynamic INT4",
  "qwen3-0.6b-litert-mixed-int4": "Mixed INT4",
  "qwen3-0.6b-litert-int8": "INT8",
  "lfm2.5-1.2b-instruct-litert-int4-gpu": "INT4 GPU",
  "lfm2.5-vl-450m": "INT4 fixB",
};

/**
 * Canonical compact descriptors: catalogue truth (bytes, source,
 * revision, license, format) with the short plan-03 display labels.
 * Throws when the shipped catalogue drifts from the six-entry contract.
 */
export function compactDescriptors(): ManagerModel[] {
  return COMPACT_ORDER.map((id, index) => {
    const entry = SHIPPED_CATALOGUE_ENTRIES.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Compact catalogue drift: missing entry ${id}`);
    return {
      entryId: entry.id,
      label: COMPACT_LABELS[id] ?? entry.displayName,
      role: COMPACT_ROLES[id] ?? "Text",
      bytes: entry.installedBytes ?? entry.downloadBytes ?? 0,
      category: index < 2 ? "RECOMMENDED" : "EXPERIMENTAL",
      state: "NOT_INSTALLED" as ManagerStatus,
      canDownload: false,
      deviceFit: "Not tested on this device",
      source: entry.upstreamRepo,
      revision: entry.revision,
      license: entry.license,
      format: "LiteRT-LM",
      quantization: COMPACT_QUANTIZATION[id] ?? "See source",
      runtimeId: entry.id,
    };
  });
}

/** Maps a native lifecycle wire string to the compact manager status. */
export function managerStatusFrom(nativeState: string | null | undefined): ManagerStatus {
  switch (nativeState) {
    case "DOWNLOADING":
    case "VERIFYING_CHUNK":
    case "VERIFYING_HASH":
    case "VERIFYING_FILE":
      return "DOWNLOADING";
    case "PAUSED":
    case "PAUSED_ERROR":
    case "QUEUED":
    case "WAITING_FOR_NETWORK":
    case "WAITING_FOR_WIFI":
    case "PAUSING":
      return "PAUSED";
    case "READY":
    case "READY_GPU":
    case "TEXT_READY":
      return "READY";
    case "LOW_MEMORY":
      return "LOW_MEMORY";
    case "INCOMPATIBLE":
    case "GPU_UNAVAILABLE":
      return "INCOMPATIBLE";
    case "INSTALLED_UNVERIFIED":
    case "INSTALLED":
    case "GPU_SELF_TESTING":
    case "REPAIR_NEEDED":
    case "REPAIRING":
    case "CORRUPT":
    case "DOWNLOAD_FAILED":
    case "RUNTIME_ERROR":
    case "INSUFFICIENT_STORAGE":
    case "MANIFEST_MISMATCH":
      return "INSTALLED_UNVERIFIED";
    case "UNPUBLISHED":
    case "UNAVAILABLE":
      return "UNAVAILABLE";
    case "NOT_INSTALLED":
    case null:
    case undefined:
      return "NOT_INSTALLED";
    default:
      return "INSTALLED_UNVERIFIED";
  }
}

/**
 * Device-fit summary. `Good fit` only when measured free RAM meets the
 * catalogue minimum; never a device-run result. Unknown RAM stays honest.
 */
export function deviceFitFor(minFreeRamMb: number | null | undefined, availableFreeRamMb: number | null | undefined): string {
  if (availableFreeRamMb == null) return "Not tested on this device";
  if (minFreeRamMb == null) return "Needs device verification";
  return availableFreeRamMb >= minFreeRamMb ? "Good fit" : "Needs device verification";
}

function catalogueMinRam(entryId: string): number | null {
  const entry = SHIPPED_CATALOGUE_ENTRIES.find((candidate) => candidate.id === entryId);
  return entry?.minFreeRamMb ?? null;
}

/** Applies live native state to the compact descriptors. */
export function applyLiveState(
  base: readonly ManagerModel[],
  opts: {
    vlmStates?: ReadonlyArray<{ id: string; state: string; sizeBytes?: number | null }>;
    bridgeIdFor?: (entryId: string) => string | null;
    textStatus?: { textInstalled: boolean; textReady: boolean } | null;
    textEntryId?: string;
    candidateStates?: ReadonlyArray<{ entryId: string; state: string; sizeBytes?: number; downloadedBytes?: number; error?: string }>;
    candidateProgress?: Readonly<Record<string, { downloadedBytes: number; totalBytes: number }>>;
    downloadedBytesByBridgeId?: Readonly<Record<string, number>>;
    availableFreeRamMb?: number | null;
    canDownloadFor?: (entryId: string) => boolean;
  } = {},
): ManagerModel[] {
  return base.map((model) => {
    const bridgeId = opts.bridgeIdFor?.(model.entryId) ?? null;
    const vlm = bridgeId != null ? opts.vlmStates?.find((s) => s.id === bridgeId) : undefined;
    const candidate = opts.candidateStates?.find((s) => s.entryId === model.entryId);
    let state: ManagerStatus = model.state;
    let error: string | undefined;
    let downloadedBytes: number | undefined;
    if (model.entryId === (opts.textEntryId ?? "qwen3-0.6b-litert-dynamic-int4") && opts.textStatus) {
      state = opts.textStatus.textReady ? "READY" : opts.textStatus.textInstalled ? "INSTALLED_UNVERIFIED" : "NOT_INSTALLED";
    } else if (vlm) {
      state = managerStatusFrom(vlm.state);
      if (bridgeId && opts.downloadedBytesByBridgeId?.[bridgeId] != null) {
        downloadedBytes = opts.downloadedBytesByBridgeId[bridgeId];
      }
    } else if (candidate) {
      state = managerStatusFrom(candidate.state);
      error = candidate.error;
      const progress = opts.candidateProgress?.[model.entryId];
      downloadedBytes =
        progress?.downloadedBytes ?? ((candidate.downloadedBytes ?? 0) > 0 ? candidate.downloadedBytes : undefined);
    }
    return {
      ...model,
      state,
      error: error ?? model.error,
      downloadedBytes: downloadedBytes ?? model.downloadedBytes,
      canDownload: opts.canDownloadFor ? opts.canDownloadFor(model.entryId) : model.canDownload,
      deviceFit: deviceFitFor(catalogueMinRam(model.entryId), opts.availableFreeRamMb),
    };
  });
}

/** Maps user-confirmed imported records to IMPORTED manager rows. */
export function importedToManagerModels(records: readonly ImportedModelRecord[]): ManagerModel[] {
  return records.map((record) => ({
    entryId: record.entryId,
    label: record.label,
    role: record.role === "Vision" ? "Vision" : "Text",
    bytes: record.bytes,
    category: "IMPORTED" as const,
    state: managerStatusFrom(record.state),
    canDownload: false,
    deviceFit: record.state === "READY" ? "Verified on this device" : "Not verified on this device",
    source: "Local import",
    revision: "Local package",
    license: "See package provenance",
    format: "LiteRT-LM",
    quantization: "See source",
    runtimeId: record.entryId,
    error: record.error ?? undefined,
    loadMs: record.loadMs ?? undefined,
    inferenceMs: record.inferenceMs ?? undefined,
    memoryBeforeMb: record.memoryBeforeMb ?? undefined,
    observedPeakMb: record.observedPeakMb ?? undefined,
  }));
}
