import { useEffect, useRef, useState } from "react";
import { Download, Trash2, Cpu, AlertTriangle, CheckCircle, XCircle, Loader2, HardDrive, Upload, PackageOpen } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { ModelAdvancedConfirmGate } from "../components/ModelAdvancedConfirmGate";
import { getModelAction, getVlmBridge, isInstalledState } from "../services/vlmPlugin";
import { chooseFromGallery, isCancellation, isNativeCameraAvailable, takePhoto, toNativeImageUri } from "../services/photo";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import type { VlmModelId, VlmState, VlmCapabilities, VlmModelInfo, DownloadProgressEvent, GpuSelfTestResult } from "../services/vlmPlugin";
import {
  catalogueWarnings,
  isInstallable,
  listByCategory,
  needsOnDeviceWarning,
  NOT_VERIFIED_ON_DEVICE_WARNING,
  verificationLabel,
} from "../services/models/modelCatalogue";
import {
  describeRamFigures,
  getRamBand,
  ramBandNote,
  ramSourceChip,
  type AvailableFreeRamMb,
} from "../services/models/ramPolicy";
import { checkDownloadGate } from "../services/models/modelTransfers";
import { activateModel } from "../services/models/modelActivation";
import {
  loadResidentEntryId,
  saveResidentEntryId,
} from "../services/models/roleSelection";
import {
  availabilityForEntry,
  availabilityLabel,
  canOfferActivation,
  runtimeCapabilityForEntry,
} from "../services/models/runtimeCapability";
import {
  bridgeModelIdForEntry,
  LEGACY_BRIDGE_MODELS,
  SHIPPED_CATALOGUE_ENTRIES,
} from "../services/models/shippedCatalogue";
import type { ModelCatalogueEntry } from "../services/models/catalogueTypes";
import type { InstalledFileReader, NativePackageHost, PackageWriter } from "../services/models/modelTransfers";
import { exportPackageStream, hashWebFile } from "../services/models/modelTransfers";

/**
 * Injectable seams for the library UI. The download/pause/resume/delete
 * paths run through the native bridge (which streams Range → temp → hash →
 * journal on-device); import/export run through the streaming transfer
 * layer. `availableFreeRamMb` has no native source yet, so it defaults to
 * null ("unknown", never gating on its own); export needs a platform
 * archive writer, so it stays disabled until one is injected. The Android
 * production import/export path runs through `nativePackageHost` (SAF
 * content URI → native streaming validation/extraction/install); the web
 * fallback only stream-hashes the picked file against the shipped pin and
 * never buffers it.
 */
export interface OfflineAiSeams {
  availableFreeRamMb?: AvailableFreeRamMb;
  exportReaderFor?: (entryId: string) => InstalledFileReader | null;
  makePackageWriter?: () => PackageWriter;
  nativePackageHost?: NativePackageHost | null;
  importSourceUriForFile?: (file: File) => string | null;
  exportDestUriForEntry?: (entryId: string) => string | null;
}

const STATE_LABELS: Record<VlmState, string> = {
  NOT_INSTALLED: "Not installed",
  QUEUED: "Queued",
  WAITING_FOR_NETWORK: "Waiting for network",
  WAITING_FOR_WIFI: "Waiting for Wi-Fi",
  DOWNLOADING: "Downloading…",
  PAUSING: "Pausing…",
  PAUSED: "Paused",
  PAUSED_ERROR: "Paused (error)",
  VERIFYING_CHUNK: "Verifying…",
  VERIFYING_HASH: "Verifying…",
  VERIFYING_FILE: "Verifying…",
  REPAIR_NEEDED: "Repair needed",
  REPAIRING: "Repairing…",
  MANIFEST_MISMATCH: "Source mismatch",
  INSTALLED_UNVERIFIED: "Installed — GPU test required",
  GPU_SELF_TESTING: "GPU self-test…",
  READY_GPU: "Ready (GPU)",
  GPU_UNAVAILABLE: "GPU unavailable on this runtime",
  CORRUPT: "Corrupt",
  INSUFFICIENT_STORAGE: "Insufficient storage",
  DOWNLOAD_FAILED: "Download failed",
  RUNTIME_ERROR: "Runtime error",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function shortBuildSha(sha: string | null | undefined): string | null {
  if (!sha || sha === "unknown") return null;
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/** Turns native error codes into plain language; raw enums must never reach users. */
const ERROR_LABELS: Record<string, string> = {
  GPU_UNAVAILABLE_ON_CURRENT_RUNTIME:
    "This phone's GPU can't run this model. If CPU compatibility mode is allowed, analysis may still run on CPU with an explicit on-screen notice.",
  DOWNLOAD_FAILED: "The download failed. Resume to continue.",
  HASH_MISMATCH: "The downloaded data didn't match the expected file.",
  INSUFFICIENT_STORAGE: "Not enough free storage.",
  RUNTIME_ERROR: "The model stopped with a runtime error.",
  MODEL_RUNTIME_ERROR: "The model stopped with a runtime error.",
  MODEL_MISSING: "Model files are missing. Download the model again.",
  INPUT_ERROR: "The test image couldn't be read. Try a different photo.",
  GENERATION_ERROR: "The model ran but produced no usable output.",
};

function friendlyError(code: string | undefined | null): string | null {
  if (!code) return null;
  return ERROR_LABELS[code] ?? code.replace(/_/g, " ").toLowerCase();
}

/** Plain-language message for a rejected bridge action; raw errors stay readable. */
function actionErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return ERROR_LABELS[err.message] ?? err.message;
  if (typeof err === "string" && err) return ERROR_LABELS[err] ?? err;
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && code) return ERROR_LABELS[code] ?? code;
  return "Something went wrong. Please try again.";
}

/** True when a bridge rejection is just a cancellation (quiet, never an error). */
function isSelfTestCancellation(err: unknown): boolean {
  if (isCancellation(err)) return true;
  const code = (err as { code?: string } | null)?.code;
  if (typeof code === "string" && code === "CANCELLED") return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message === "CANCELLED" || /cancelled/i.test(message);
}

/** Honest self-test taxonomy: bad photos, missing models and runtime
 * failures each get their own title; legacy strings fall back gracefully. */
function getSelfTestPresentation(result: GpuSelfTestResult | null): { title: string; message: string | null } {
  if (!result) return { title: "GPU test unavailable", message: null };
  if (result.state === "GPU_AVAILABLE") {
    return { title: "GPU Available", message: "GPU-backed inference completed successfully." };
  }
  const failure = result.failure ?? null;
  const state = result.state;
  const error = result.error ?? "";
  const mentionsMissing = /not installed|files not found/i.test(error);
  if (failure === "INPUT_ERROR" || state === "INPUT_ERROR") {
    return { title: "Photo couldn't be read", message: friendlyError("INPUT_ERROR") };
  }
  if (failure === "MODEL_MISSING" || state === "MODEL_MISSING" || mentionsMissing) {
    return { title: "GPU test unavailable", message: friendlyError("MODEL_MISSING") };
  }
  if (
    failure === "MODEL_RUNTIME_ERROR" ||
    failure === "RUNTIME_ERROR" ||
    failure === "GENERATION_ERROR" ||
    state === "RUNTIME_ERROR" ||
    state === "GENERATION_ERROR" ||
    state === "ERROR"
  ) {
    return { title: "Model runtime failed", message: friendlyError(error) ?? friendlyError(failure) ?? friendlyError("RUNTIME_ERROR") };
  }
  return {
    title: "GPU test unavailable",
    message: friendlyError(error) ?? friendlyError(failure) ?? friendlyError(state),
  };
}

const INSTALL_HEADROOM_BYTES = 256 * 1024 * 1024;
const INSTALL_HEADROOM_FRACTION = 0.25;

/** Mirrors the native install policy when native hasn't reported requiredBytes. */
function fallbackRequiredBytes(sizeBytes: number): number {
  return sizeBytes + Math.max(INSTALL_HEADROOM_BYTES, sizeBytes * INSTALL_HEADROOM_FRACTION);
}

function formatCatalogueBytes(bytes: number | null, kind: "download" | "installed"): string {
  if (bytes == null) return `${kind === "download" ? "Download" : "Installed"} size not established`;
  return `${formatBytes(bytes)} ${kind}`;
}

/**
 * Resident generative-model record, shared with role selection
 * (`roleSelection.RESIDENT_ENTRY_KEY`): the catalogue id persisted on
 * verified activation, or null when idle. Single owner of the key value;
 * the helpers are the only readers/writers.
 */
function loadActiveModel(): string | null {
  return loadResidentEntryId();
}

function saveActiveModel(id: string): void {
  saveResidentEntryId(id);
}

/**
 * Bridge-reported models with no catalogue entry: storage management only,
 * never downloadable. A row renders only when the bridge reports that id.
 */
function LegacyModelCard({
  modelId,
  info,
  onDelete,
}: {
  modelId: string;
  info: VlmModelInfo;
  onDelete: (modelId: VlmModelId) => void;
}) {
  const legacy = LEGACY_BRIDGE_MODELS[modelId];
  const label = legacy?.label ?? modelId;
  const installed = isInstalledState(info.state);
  return (
    <div role="listitem" aria-label={`${label} (experimental)`} className="w-full min-w-0 overflow-x-hidden border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="min-w-0">
          <h3 className="min-w-0 break-words font-medium text-base">{label}</h3>
          <p className="min-w-0 break-words text-xs text-on-surface-variant">{legacy?.kindNote ?? "Not listed in the v1 catalogue"}</p>
        </div>
        <p className="min-w-0 break-words text-sm">Current status: Not available for report generation in this beta.</p>
        <p className="min-w-0 break-words text-sm text-on-surface-variant">NPU test on this device: current graph incompatible.</p>
        {legacy ? (
          <details className="min-w-0 break-words text-xs text-on-surface-variant">
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-1 min-w-0 space-y-0.5 break-words">
              <div className="min-w-0"><dt className="inline font-medium">Source: </dt><dd className="inline min-w-0 break-all">{legacy.sourceRepo}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Revision: </dt><dd className="inline min-w-0 break-all">{legacy.revision}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Runtime: </dt><dd className="inline min-w-0 break-all">{legacy.runtime}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">NPU probe: </dt><dd className="inline min-w-0 break-words">{legacy.probeNote}</dd></div>
            </dl>
          </details>
        ) : null}
        {installed ? (
          <div className="flex min-w-0 flex-col gap-2">
            {typeof info.sizeBytes === "number" && (
              <p className="min-w-0 break-words text-xs text-on-surface-variant">On-device data: {formatBytes(info.sizeBytes)}</p>
            )}
            <button
              onClick={() => onDelete(info.id)}
              className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-error text-error rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
            >
              <Trash2 size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0 break-words">Delete on-device data</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const WIFI_PREF_KEY = "findback:offline-ai:wifi-only";

function loadWifiOnly(): boolean {
  try {
    const raw = localStorage.getItem(WIFI_PREF_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function saveWifiOnly(value: boolean): void {
  try {
    localStorage.setItem(WIFI_PREF_KEY, String(value));
  } catch {
    /* private mode / storage disabled */
  }
}

function CatalogueModelCard({
  entry,
  bridgeId,
  info,
  capabilities,
  availableFreeRamMb,
  isActive,
  importMessage,
  exportMessage,
  onDownload,
  onDelete,
  onPickSelfTest,
  onCancelDownload,
  onPauseDownload,
  onResumeDownload,
  onRepair,
  onSetActive,
  onImport,
  onExport,
  downloadProgress,
}: {
  entry: ModelCatalogueEntry;
  bridgeId: VlmModelId | null;
  info: VlmModelInfo | null;
  capabilities: VlmCapabilities | null;
  availableFreeRamMb: AvailableFreeRamMb;
  isActive: boolean;
  importMessage: string | null;
  exportMessage: string | null;
  onDownload: (entry: ModelCatalogueEntry, bridgeId: VlmModelId) => void;
  onDelete: (entry: ModelCatalogueEntry, bridgeId: VlmModelId) => void;
  onPickSelfTest: (bridgeId: VlmModelId, source: "camera" | "gallery") => void;
  onCancelDownload: (bridgeId: VlmModelId) => void;
  onPauseDownload: (bridgeId: VlmModelId) => void;
  onResumeDownload: (bridgeId: VlmModelId) => void;
  onRepair: (bridgeId: VlmModelId) => void;
  onSetActive: (entry: ModelCatalogueEntry) => void;
  onImport: (entry: ModelCatalogueEntry) => void;
  onExport: (entry: ModelCatalogueEntry) => void;
  downloadProgress: DownloadProgressEvent | null;
}) {
  const state = info?.state ?? "NOT_INSTALLED";
  const stateLabel = STATE_LABELS[state] ?? state;
  const action = getModelAction(state);
  // gpuDelegateClassPresent is diagnostic only: readiness comes only from the
  // real image-bearing GPU self-test, never from class presence.
  const canOfferSelfTest = bridgeId != null && action.canSelfTest && isNativeCameraAvailable();
  const showProgress = bridgeId != null && state === "DOWNLOADING" && downloadProgress?.modelId === bridgeId;
  const [showSourcePicker, setShowSourcePicker] = useState(false);

  const figures = describeRamFigures(entry, availableFreeRamMb);
  const band = getRamBand(entry, availableFreeRamMb);
  const bandNote = ramBandNote(band);
  const warnings = catalogueWarnings(entry);
  const showDeviceWarning = needsOnDeviceWarning(entry);
  const installable = isInstallable(entry);
  // Catalogue membership, installation, and executable runtime support are
  // separate facts: the card states its availability explicitly and never
  // offers activation where this build has no wired runtime path.
  const availability = availabilityForEntry(entry, {
    bridgeId,
    installed: info != null && isInstalledState(info.state),
    isActive,
  });
  const canActivate = canOfferActivation(runtimeCapabilityForEntry(entry.id));

  // The native requiredBytes is authoritative; the fallback mirrors the native
  // policy (model + max(256 MiB, 25%)) so the button never lies.
  const catalogueSize = entry.downloadBytes ?? entry.installedBytes ?? 0;
  const requiredBytes = info?.requiredBytes ?? fallbackRequiredBytes(catalogueSize);
  // Unknown storage is never treated as sufficient: Download stays disabled
  // until native reports free space.
  const freeBytes =
    capabilities != null && Number.isFinite(capabilities.freeAppStorageMb)
      ? capabilities.freeAppStorageMb * 1024 * 1024
      : null;
  const isStorageUnknown = freeBytes === null;
  const hasSpace = !isStorageUnknown && (freeBytes as number) >= requiredBytes;
  const canDownloadHere = bridgeId != null && installable;

  return (
    <div role="listitem" aria-label={entry.displayName} className="w-full min-w-0 overflow-x-hidden border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-medium text-base">{entry.displayName}</h3>
            <span className="min-w-0 break-words text-xs text-on-surface-variant">{formatCatalogueBytes(entry.downloadBytes, "download")}</span>
          </div>
          <p className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">
            <span>{entry.role}</span>
            {" · "}
            <span>{entry.runtime}</span>
            {" · "}
            <span>{verificationLabel(entry.verificationStatus)}</span>
          </p>
          <p className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">
            Library status: {availabilityLabel(availability)}
          </p>
          <p className="min-w-0 break-words text-xs text-on-surface-variant">{formatCatalogueBytes(entry.installedBytes, "installed")}</p>

          <ul className="mt-2 space-y-0.5 text-xs text-on-surface-variant" aria-label="Memory requirements">
            <li>{figures.minimumLabel}</li>
            <li>{figures.recommendedLabel}</li>
            <li>{figures.deviceNowLabel}</li>
          </ul>
          <p className="mt-1">
            <span className="rounded-full bg-surface-container px-2 py-0.5 text-xs text-on-surface-variant">
              {ramSourceChip(entry.ramRequirementSource)}
            </span>
          </p>
          {bandNote ? (
            <p role="status" className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">{bandNote}</p>
          ) : null}
          {warnings.map((warning) => (
            <p key={warning} role="note" className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">
              {warning}
            </p>
          ))}
          {showDeviceWarning ? (
            <p role="note" className="mt-1 min-w-0 break-words text-xs text-error">
              {NOT_VERIFIED_ON_DEVICE_WARNING}
            </p>
          ) : null}
          {isActive ? (
            <p className="mt-1 min-w-0 break-words text-xs text-on-surface">Active for analysis</p>
          ) : null}

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
            <span className="flex min-w-0 items-center gap-1 break-words">
              <HardDrive size={12} aria-hidden className="shrink-0" />
              <span className="min-w-0 break-words">Needs {formatBytes(requiredBytes)} free</span>
            </span>
            <span className="flex min-w-0 items-center gap-1 break-words">
              {isStorageUnknown ? (
                <span className="min-w-0 break-words">Checking storage…</span>
              ) : hasSpace ? (
                <>
                  <CheckCircle size={12} className="shrink-0 text-on-surface" aria-hidden />
                  <span className="min-w-0 break-words">{formatBytes(freeBytes as number)} available</span>
                </>
              ) : (
                <>
                  <AlertTriangle size={12} className="shrink-0 text-error" aria-hidden />
                  <span className="min-w-0 break-words">Only {formatBytes(freeBytes as number)} available</span>
                </>
              )}
            </span>
          </div>

          <details className="mt-2 min-w-0 break-words text-xs text-on-surface-variant">
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-1 min-w-0 space-y-0.5 break-words">
              <div className="min-w-0"><dt className="inline font-medium">Source: </dt><dd className="inline min-w-0 break-all">{entry.upstreamRepo}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Revision: </dt><dd className="inline min-w-0 break-all">{entry.revision}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Runtime: </dt><dd className="inline min-w-0 break-all">{entry.runtime}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">GPU delegate class: </dt><dd className="inline min-w-0 break-words">{capabilities ? (capabilities.gpuDelegateClassPresent ? "present" : "missing") : "unknown"} (diagnostic only)</dd></div>
            </dl>
          </details>

          {bridgeId != null && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={`inline-flex max-w-full items-center whitespace-normal break-words px-2 py-0.5 rounded-full text-left text-xs border ${
                  state === "READY_GPU"
                    ? "bg-on-surface text-surface border-on-surface"
                    : state === "GPU_UNAVAILABLE" || state === "INSTALLED_UNVERIFIED"
                    ? "border-outline-variant text-on-surface"
                    : state === "DOWNLOADING" || state === "QUEUED" || state === "VERIFYING_HASH" || state === "VERIFYING_FILE" || state === "VERIFYING_CHUNK" || state === "GPU_SELF_TESTING" || state === "REPAIRING"
                    ? "bg-surface-container text-on-surface border-outline-variant"
                    : state === "DOWNLOAD_FAILED" || state === "CORRUPT" || state === "RUNTIME_ERROR" || state === "INSUFFICIENT_STORAGE" || state === "MANIFEST_MISMATCH" || state === "PAUSED_ERROR" || state === "REPAIR_NEEDED"
                    ? "border-error text-error"
                    : "bg-surface-container text-on-surface-variant border-outline-variant"
                }`}
              >
                {state === "DOWNLOADING" && showProgress && downloadProgress
                  ? `Downloading ${formatBytes(downloadProgress.downloadedBytes)} / ${formatBytes(downloadProgress.totalBytes)} (${Math.round(downloadProgress.progress * 100)}%)`
                  : stateLabel}
              </span>
              {friendlyError(info?.error) && (
                <span className={`max-w-full whitespace-normal break-words text-left text-xs px-2 py-0.5 rounded-full border ${state === "GPU_UNAVAILABLE" ? "border-outline-variant text-on-surface-variant" : "border-error text-error"}`}>
                  {friendlyError(info?.error)}
                </span>
              )}
            </div>
          )}

          {showProgress && downloadProgress && (
            <div className="mt-2 h-1.5 bg-surface-container rounded-full overflow-hidden" role="progressbar" aria-valuenow={Math.round(downloadProgress.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-on-surface transition-all duration-300" style={{ width: `${downloadProgress.progress * 100}%` }} />
            </div>
          )}

          {bridgeId != null && action.canRepair && (
            <p className="mt-2 text-xs text-error">
              Integrity check found damaged data. Repair re-downloads only the damaged parts — verified chunks will be kept.
            </p>
          )}

          {bridgeId != null && state === "DOWNLOAD_FAILED" && info?.error && (
            <p className="mt-2 text-xs text-error">{friendlyError(info.error)}</p>
          )}
          {bridgeId != null && state === "PAUSED_ERROR" && (
            <p className="mt-2 text-xs text-on-surface-variant">Paused after repeated network errors. Your verified progress is kept — resume to continue.</p>
          )}
          {bridgeId != null && state === "MANIFEST_MISMATCH" && (
            <p className="mt-2 text-xs text-error">The downloaded bytes do not match the pinned source manifest. Automatic retry is stopped; nothing was deleted.</p>
          )}
          {!canDownloadHere && (
            <p className="mt-2 min-w-0 break-words text-xs text-on-surface-variant">
              {entry.catalogOnly === true
                ? "Catalog reference only — not distributed in this build."
                : "No on-device runtime is wired for this entry in this build, so it cannot download here."}
            </p>
          )}
          {importMessage ? (
            <p role="status" className="mt-2 min-w-0 break-words text-xs text-on-surface-variant">{importMessage}</p>
          ) : null}
          {exportMessage ? (
            <p role="status" className="mt-2 min-w-0 break-words text-xs text-on-surface-variant">{exportMessage}</p>
          ) : null}
        </div>

        <div className="flex w-full min-w-0 flex-col gap-2">
          {bridgeId != null && action.isTransferActive ? (
            <>
              {action.canPause && (
                <button
                  onClick={() => onPauseDownload(bridgeId)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Pause ${entry.displayName}`}
                >
                  Pause
                </button>
              )}
              {action.canCancel && (
                <button
                  onClick={() => onCancelDownload(bridgeId)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Cancel ${entry.displayName}`}
                >
                  Cancel
                </button>
              )}
            </>
          ) : bridgeId != null && action.canResume && action.canCancel ? (
            <>
              <button
                onClick={() => onResumeDownload(bridgeId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
                aria-label={`Resume ${entry.displayName}`}
              >
                Resume
              </button>
              <button
                onClick={() => onCancelDownload(bridgeId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                aria-label={`Cancel ${entry.displayName}`}
              >
                Cancel
              </button>
            </>
          ) : bridgeId != null && action.canRepair ? (
            <button
              onClick={() => onRepair(bridgeId)}
              className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
              aria-label={`Repair ${entry.displayName}`}
            >
              Repair
            </button>
          ) : canDownloadHere && action.canDownload ? (
            <button
              onClick={() => onDownload(entry, bridgeId)}
              className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              disabled={!hasSpace}
              aria-label={`Download ${entry.displayName}`}
            >
              <Download size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0 break-words">Download</span>
            </button>
          ) : bridgeId != null && action.canSelfTest && action.canDelete ? (
            <>
              {canOfferSelfTest && (
                <div className="flex w-full min-w-0 flex-col gap-2">
                  <button
                    onClick={() => setShowSourcePicker(true)}
                    className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                    aria-label={`Verify ${entry.displayName} accelerator`}
                  >
                    <Cpu size={14} aria-hidden className="shrink-0" />
                    <span className="min-w-0 break-words">Verify accelerator</span>
                  </button>
                  {showSourcePicker && (
                    <div role="group" aria-label={`Verification source for ${entry.displayName}`} className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-outline-variant p-2">
                      <button
                        onClick={() => {
                          setShowSourcePicker(false);
                          onPickSelfTest(bridgeId, "camera");
                        }}
                        className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                      >
                        Use camera
                      </button>
                      <button
                        onClick={() => {
                          setShowSourcePicker(false);
                          onPickSelfTest(bridgeId, "gallery");
                        }}
                        className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                      >
                        Choose from gallery
                      </button>
                      <button
                        onClick={() => setShowSourcePicker(false)}
                        className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!isActive && canActivate && (
                <button
                  onClick={() => onSetActive(entry)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Set ${entry.displayName} as active model`}
                >
                  Set as active model
                </button>
              )}
              <button
                onClick={() => onDelete(entry, bridgeId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-error text-error rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
              >
                <Trash2 size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 break-words">Delete</span>
              </button>
            </>
          ) : bridgeId != null ? (
            <span className="min-w-0 break-words text-xs text-on-surface-variant">Verification running…</span>
          ) : null}
          {entry.catalogOnly !== true && bridgeId != null && (
            <div className="flex w-full min-w-0 flex-col gap-2">
              <button
                onClick={() => onImport(entry)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                aria-label={`Import ${entry.displayName} package`}
              >
                <Upload size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 break-words">Import</span>
              </button>
              <button
                onClick={() => onExport(entry)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                aria-label={`Export ${entry.displayName} package`}
              >
                <PackageOpen size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 break-words">Export</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OfflineAi(seams?: OfflineAiSeams) {
  const bridge = getVlmBridge();
  const availableFreeRamMb = seams?.availableFreeRamMb ?? null;
  const [capabilities, setCapabilities] = useState<VlmCapabilities | null>(null);
  const [wifiOnly, setWifiOnly] = useState(loadWifiOnly);
  const [allowCpuFallback, setAllowCpuFallback] = useState(true);
  const [modelStates, setModelStates] = useState<VlmModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressEvent | null>(null);
  const [confirmDownload, setConfirmDownload] = useState<{
    entry: ModelCatalogueEntry;
    bridgeId: VlmModelId;
    downloadBytes: number;
    requiredBytes: number;
    needsConfirm: boolean;
    largeSecondConfirm: boolean;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [secondConfirmed, setSecondConfirmed] = useState(false);
  const [confirmedEntries, setConfirmedEntries] = useState<readonly string[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [importMessages, setImportMessages] = useState<Record<string, string>>({});
  const [exportMessages, setExportMessages] = useState<Record<string, string>>({});
  const [gpuSelfTestModel, setGpuSelfTestModel] = useState<VlmModelId | null>(null);
  const [gpuSelfTestSource, setGpuSelfTestSource] = useState<"camera" | "gallery" | null>(null);
  const [gpuSelfTestState, setGpuSelfTestState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [gpuSelfTestResult, setGpuSelfTestResult] = useState<GpuSelfTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const gpuSelfTestRef = useRef<HTMLDivElement>(null);
  const confirmDownloadRef = useRef<HTMLDivElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);
  const pendingImportRef = useRef<ModelCatalogueEntry | null>(null);

    // Guards async action errors against setState-after-unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setActiveModelId(loadActiveModel());
  }, []);

  // Closing while verification is RUNNING must stop native inference first.
  const closeGpuSelfTest = () => {
    if (gpuSelfTestState === "running") {
      void bridge.cancelInference().catch(() => undefined);
    }
    setGpuSelfTestModel(null);
    setGpuSelfTestSource(null);
    setGpuSelfTestState("idle");
    setGpuSelfTestResult(null);
  };

  useFocusTrap(gpuSelfTestRef, () => { closeGpuSelfTest(); });
  useFocusTrap(confirmDownloadRef, () => setConfirmDownload(null));

  // Hardware Back dismisses an open dialog before navigating away.
  useModalBack(gpuSelfTestModel !== null && gpuSelfTestState !== "idle", () => {
    closeGpuSelfTest();
  });
  useModalBack(confirmDownload !== null, () => setConfirmDownload(null));

  useEffect(() => {
    let mounted = true;
    // Capabilities and model states fail independently (process death, storage).
    // allSettled: one rejection must neither blank the row nor wipe the other.
    void (async () => {
      const [caps, states, settings] = await Promise.allSettled([
        bridge.getCapabilities(),
        bridge.getModelStates(),
        bridge.getSettings(),
      ]);
      if (!mounted) return;
      if (caps.status === "fulfilled") setCapabilities(caps.value);
      if (states.status === "fulfilled") setModelStates(states.value);
      if (settings.status === "fulfilled") setAllowCpuFallback(settings.value.allowCpuFallback ?? true);
    })();

    const offProgress = bridge.onDownloadProgress((event) => {
      if (mounted) setDownloadProgress(event);
    });
    const offState = bridge.onModelStateChange((info) => {
      if (!mounted) return;
      setModelStates((prev) => {
        const idx = prev.findIndex((m) => m.id === info.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = info;
          return next;
        }
        return [...prev, info];
      });
    });

    return () => {
      mounted = false;
      offProgress.then((f) => f());
      offState.then((f) => f());
    };
  }, [bridge]);

  const handleDownload = (entry: ModelCatalogueEntry, bridgeId: VlmModelId) => {
    const info = modelStates.find((m) => m.id === bridgeId);
    const downloadBytes = info?.sizeBytes ?? entry.downloadBytes ?? 0;
    const required = info?.requiredBytes ?? fallbackRequiredBytes(entry.installedBytes ?? entry.downloadBytes ?? 0);
    const gate = checkDownloadGate(entry, { availableFreeRamMb, advancedConfirmed: false });
    if (!gate.allowed && gate.code !== "NEEDS_ADVANCED_CONFIRM") {
      setActionError(gate.reason);
      return;
    }
    const needsConfirm = needsOnDeviceWarning(entry) || !gate.allowed;
    setAcknowledged(false);
    setSecondConfirmed(false);
    setConfirmDownload({
      entry,
      bridgeId,
      downloadBytes,
      requiredBytes: required,
      needsConfirm,
      largeSecondConfirm: entry.catalogOnly === true || entry.category === "experimental-large",
    });
  };

  const startBridgeDownload = (entry: ModelCatalogueEntry, bridgeId: VlmModelId) => {
    const allowCellular = !wifiOnly;
    // Close the dialog immediately after scheduling so progress and
    // pause/cancel UI stay visible; the transfer runs in the background.
    setConfirmDownload(null);
    void (async () => {
      const opts = allowCellular ? { allowCellular: true } : undefined;
      try {
        if (opts) await bridge.downloadModel(bridgeId, opts);
        else await bridge.downloadModel(bridgeId);
        if (mountedRef.current) {
          setConfirmedEntries((prev) => (prev.includes(entry.id) ? prev : [...prev, entry.id]));
        }
      } catch (err) {
        if (mountedRef.current) setActionError(actionErrorMessage(err));
      }
    })();
  };

  const handleConfirmDownload = () => {
    if (!confirmDownload) return;
    startBridgeDownload(confirmDownload.entry, confirmDownload.bridgeId);
  };

  // Every bridge action can reject (process death, storage, native failure).
  // Catch it so the UI never dies with an unhandled rejection and the user
  // gets a readable reason.
  const runAction = async (fn: () => Promise<unknown>) => {
    if (!mountedRef.current) return;
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      if (mountedRef.current) setActionError(actionErrorMessage(err));
    }
  };

  const handleToggleCpuFallback = async () => {
    const next = !allowCpuFallback;
    setAllowCpuFallback(next);
    try {
      await bridge.setCpuFallback(next);
    } catch (err) {
      if (mountedRef.current) {
        setAllowCpuFallback(!next);
        setActionError(actionErrorMessage(err));
      }
    }
  };

  const handleDelete = async (entry: ModelCatalogueEntry, bridgeId: VlmModelId) => {
    if (!window.confirm(`Delete ${entry.displayName}? This stops inference, unloads the engine, and removes only this model. The other model is unaffected.`)) {
      return;
    }
    await runAction(() => bridge.deleteModel(bridgeId));
  };

  const handleLegacyDelete = async (modelId: VlmModelId) => {
    const label = LEGACY_BRIDGE_MODELS[modelId]?.label ?? modelId;
    if (!window.confirm(`Delete ${label}? This stops inference, unloads the engine, and removes only this model. The other model is unaffected.`)) {
      return;
    }
    await runAction(() => bridge.deleteModel(modelId));
  };

  const handleCancelDownload = async (bridgeId: VlmModelId) => {
    await runAction(() => bridge.cancelDownload(bridgeId));
  };

  const handlePauseDownload = async (bridgeId: VlmModelId) => {
    await runAction(() => bridge.pauseDownload(bridgeId));
  };

  const handleResumeDownload = async (bridgeId: VlmModelId) => {
    await runAction(() => bridge.resumeDownload(bridgeId));
  };

  const handleRepair = async (bridgeId: VlmModelId) => {
    await runAction(() => bridge.repairModel(bridgeId));
  };

  /** Single-resident switch: real activation — persists only on runtime proof. */
  const handleSetActive = async (entry: ModelCatalogueEntry) => {
    if (!mountedRef.current) return;
    setActionError(null);
    try {
      const result = await activateModel(bridge, entry, {
        currentResidentId: activeModelId,
        availableFreeRamMb,
        advancedConfirmed: confirmedEntries.includes(entry.id),
        runtimeCapability: runtimeCapabilityForEntry(entry.id),
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setActionError(result.reason);
        return;
      }
      if (!result.alreadyActive) {
        setActiveModelId(entry.id);
        saveActiveModel(entry.id);
      }
    } catch (err) {
      if (mountedRef.current) setActionError(actionErrorMessage(err));
    }
  };

  /**
   * Import entry point. The Android production path resolves the picked
   * file to a SAF content URI and hands it to the platform installer
   * (`NativePackageHost`: native stream → incremental package hash →
   * archive entry validation → streaming extraction → per-entry hash →
   * temp sandbox → atomic install). The web fallback stream-hashes the
   * picked file against the shipped catalogue pin without buffering it;
   * full interior validation + extraction still run in the platform
   * installer, so the web UI verifies without claiming an install.
   */
  const handleImportFile = async (entry: ModelCatalogueEntry, file: File) => {
    if (entry.sha256 == null) {
      setImportMessages((prev) => ({
        ...prev,
        [entry.id]: "No shipped hash pin for this entry: the package cannot be verified, so import is refused.",
      }));
      return;
    }
    try {
      const sourceUri = seams?.importSourceUriForFile?.(file) ?? null;
      if (seams?.nativePackageHost != null && sourceUri != null) {
        const installed = await seams.nativePackageHost.importPackageFromUri({
          entryId: entry.id,
          sourceUri,
          expectedSha256: entry.sha256,
        });
        setImportMessages((prev) => ({
          ...prev,
          [entry.id]: installed.ok
            ? "Package verified against the shipped catalogue pin and installed by the platform installer."
            : `Package rejected: ${installed.reason} Nothing installed.`,
        }));
        return;
      }
      const digest = await hashWebFile(file);
      setImportMessages((prev) => ({
        ...prev,
        [entry.id]:
          digest === entry.sha256
            ? "Package verified against the shipped catalogue pin. Extraction to the runtime runs in the platform installer."
            : "Package does not match the shipped catalogue pin — discarded, nothing installed.",
      }));
    } catch {
      setImportMessages((prev) => ({
        ...prev,
        [entry.id]: "The package file could not be read. Nothing installed.",
      }));
    }
  };

  const handleImport = (entry: ModelCatalogueEntry) => {
    pendingImportRef.current = entry;
    importFileRef.current?.click();
  };

  const handleExport = async (entry: ModelCatalogueEntry) => {
    const destUri = seams?.exportDestUriForEntry?.(entry.id) ?? null;
    if (seams?.nativePackageHost != null && destUri != null) {
      const native = await seams.nativePackageHost.exportPackageToUri({
        entryId: entry.id,
        destUri,
      });
      setExportMessages((prev) => ({
        ...prev,
        [entry.id]: native.ok
          ? `Packaged ${native.manifest.files.length} files for ${native.manifest.entryId}.`
          : `Export refused: ${native.reason}`,
      }));
      return;
    }
    const reader = seams?.exportReaderFor?.(entry.id) ?? null;
    const writer = seams?.makePackageWriter?.() ?? null;
    if (reader == null || writer == null) {
      setExportMessages((prev) => ({
        ...prev,
        [entry.id]: "Export packaging runs in the platform installer: no staged package files are available here.",
      }));
      return;
    }
    const result = await exportPackageStream(entry, reader, writer);
    setExportMessages((prev) => ({
      ...prev,
      [entry.id]: result.ok
        ? `Packaged ${result.manifest.files.length} files for ${result.manifest.entryId}.`
        : `Export refused: ${result.reason}`,
    }));
  };

  const handleRunGpuSelfTest = async (modelId: VlmModelId, imageUri: string) => {
    if (!imageUri || imageUri.startsWith("blob:")) return;
    setGpuSelfTestModel(modelId);
    setGpuSelfTestState("running");
    setGpuSelfTestResult(null);
    try {
      const result = await bridge.runGpuSelfTest(modelId, imageUri);
      if (!mountedRef.current) return;
      if (result?.state === "CANCELLED") {
        setGpuSelfTestModel(null);
        setGpuSelfTestSource(null);
        setGpuSelfTestState("idle");
        setGpuSelfTestResult(null);
        return;
      }
      setGpuSelfTestState("done");
      setGpuSelfTestResult(result);
    } catch (e) {
      if (!mountedRef.current) return;
      if (isSelfTestCancellation(e)) {
        setGpuSelfTestModel(null);
        setGpuSelfTestSource(null);
        setGpuSelfTestState("idle");
        setGpuSelfTestResult(null);
        return;
      }
      const message = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
      if (message === "MODEL_MISSING" || /not installed|files not found/i.test(message)) {
        setGpuSelfTestState("done");
        setGpuSelfTestResult({ state: "MODEL_MISSING", error: message });
        return;
      }
      if (message === "INPUT_ERROR") {
        setGpuSelfTestState("done");
        setGpuSelfTestResult({ state: "INPUT_ERROR", error: message, failure: "INPUT_ERROR" });
        return;
      }
      if (message === "RUNTIME_ERROR" || message === "GENERATION_ERROR") {
        setGpuSelfTestState("done");
        setGpuSelfTestResult({ state: message, error: message, failure: message });
        return;
      }
      setGpuSelfTestState("error");
      setGpuSelfTestResult({ state: "ERROR", error: message });
    }
  };

  // Camera/gallery picks get their own capture-error handling: user
  // cancellation stays quiet, real failures surface via the alert.
  const handlePickSelfTest = async (modelId: VlmModelId, source: "camera" | "gallery") => {
    setGpuSelfTestSource(source);
    try {
      const picked = source === "camera" ? await takePhoto() : await chooseFromGallery();
      const uri = toNativeImageUri(picked);
      if (uri) await handleRunGpuSelfTest(modelId, uri);
    } catch (err) {
      if (isCancellation(err) || isSelfTestCancellation(err)) return;
      if (mountedRef.current) setActionError(actionErrorMessage(err));
    }
  };

  const buildDetails = capabilities
    ? [
        capabilities.appVersion ? `App ${capabilities.appVersion}` : null,
        shortBuildSha(capabilities.buildGitSha) ? `Build ${shortBuildSha(capabilities.buildGitSha)}` : null,
      ].filter((part): part is string => Boolean(part))
    : [];

  const orderedEntries = listByCategory(SHIPPED_CATALOGUE_ENTRIES);
  const mappedBridgeIds = new Set(
    orderedEntries
      .map((entry) => bridgeModelIdForEntry(entry.id))
      .filter((id): id is VlmModelId => id != null),
  );
  const legacyStates = modelStates.filter((m) => !mappedBridgeIds.has(m.id));
  const confirmGateBlocked =
    confirmDownload != null &&
    confirmDownload.needsConfirm &&
    !(acknowledged && (!confirmDownload.largeSecondConfirm || secondConfirmed));

  return (
    <div className="flex flex-col gap-4 p-4 overflow-x-hidden">
      <header className="flex min-w-0 items-center gap-2 px-4 pt-2">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <div className="min-w-0">
          <h1 className="break-words text-xl font-semibold tracking-tight">Offline AI</h1>
          <p className="break-words text-xs text-on-surface-variant">Manage local models and accelerator verification.</p>
        </div>
      </header>

      <section className="px-4 space-y-4" aria-labelledby="network-heading">
        <h2 id="network-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Downloads</h2>
        <p className="text-xs text-on-surface-variant">
          Only a GPU-verified model runs analysis. GPU is preferred; if GPU
          initialization fails and CPU compatibility mode is allowed, analysis
          runs on CPU with an explicit on-screen notice — never silently. Only
          entries with a wired on-device runtime can download here.
        </p>
        <div className="flex gap-2" role="radiogroup" aria-label="Download network">
          {(["wifi-only", "wifi-or-cellular"] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => {
                const next = opt === "wifi-only";
                setWifiOnly(next);
                saveWifiOnly(next);
              }}
              role="radio"
              aria-checked={wifiOnly === (opt === "wifi-only")}
              className={`min-h-[48px] flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                wifiOnly === (opt === "wifi-only")
                  ? "bg-on-surface text-surface"
                  : "bg-surface-container text-on-surface-variant hover:bg-surface-container/80"
              }`}
            >
              {opt === "wifi-only" ? "Wi-Fi only" : "Wi-Fi or cellular"}
            </button>
          ))}
        </div>
        <p className="text-xs text-on-surface-variant">Wi-Fi only is the default; cellular needs explicit opt-in. Your choice is kept.</p>
      </section>

      <section className="px-4 space-y-2" aria-labelledby="inference-heading">
        <h2 id="inference-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Inference</h2>
        <button
          type="button"
          role="switch"
          aria-checked={allowCpuFallback}
          aria-label="Allow CPU compatibility mode"
          onClick={() => void handleToggleCpuFallback()}
          className="flex min-h-[48px] w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-outline-variant px-3 py-2 text-left"
        >
          <span className="min-w-0">
            <span className="block min-w-0 break-words text-sm font-medium">Allow CPU compatibility mode</span>
            <span className="block min-w-0 break-words text-xs text-on-surface-variant">
              {allowCpuFallback
                ? "On: if the GPU can't start, analysis may run on CPU with an explicit notice."
                : "Off: if the GPU can't start, analysis is unavailable and manual reporting remains."}
            </span>
          </span>
          <span aria-hidden className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${allowCpuFallback ? "bg-on-surface text-surface" : "border border-outline-variant text-on-surface-variant"}`}>
            {allowCpuFallback ? "On" : "Off"}
          </span>
        </button>
      </section>

      <section className="px-4 space-y-4" aria-labelledby="models-heading">
        <div className="min-w-0">
          <h2 id="models-heading" className="break-words text-sm font-medium text-on-surface-variant uppercase tracking-wide">Models</h2>
          {capabilities && (
            <p data-testid="build-info" title={capabilities.buildGitSha ?? undefined} className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">
              {buildDetails.length > 0 ? buildDetails.join(" • ") : "Build details unavailable."}
            </p>
          )}
        </div>

        {actionError && (
          <div
            role="alert"
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-error px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
          >
            <span className="min-w-0 break-words text-sm text-error">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="min-h-[48px] w-full px-2 text-xs text-error underline sm:w-auto sm:shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        <input
          ref={importFileRef}
          type="file"
          accept=".fbmodel"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const pending = pendingImportRef.current;
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            pendingImportRef.current = null;
            if (pending != null && file != null) void handleImportFile(pending, file);
          }}
        />

        <div className="space-y-3" role="list" aria-label="Available models">
          {orderedEntries.map((entry) => {
            const bridgeId = bridgeModelIdForEntry(entry.id);
            const info =
              (bridgeId != null ? modelStates.find((m) => m.id === bridgeId) : undefined) ??
              null;
            return (
              <CatalogueModelCard
                key={entry.id}
                entry={entry}
                bridgeId={bridgeId}
                info={info}
                capabilities={capabilities}
                availableFreeRamMb={availableFreeRamMb}
                isActive={activeModelId === entry.id}
                importMessage={importMessages[entry.id] ?? null}
                exportMessage={exportMessages[entry.id] ?? null}
                onDownload={handleDownload}
                onDelete={handleDelete}
                onPickSelfTest={handlePickSelfTest}
                onCancelDownload={handleCancelDownload}
                onPauseDownload={handlePauseDownload}
                onResumeDownload={handleResumeDownload}
                onRepair={handleRepair}
                onSetActive={(target) => void handleSetActive(target)}
                onImport={handleImport}
                onExport={(target) => void handleExport(target)}
                downloadProgress={downloadProgress}
              />
            );
          })}
        </div>
      </section>

      {legacyStates.length > 0 && (
        <section className="px-4 space-y-4" aria-labelledby="legacy-heading">
          <div className="min-w-0">
            <h2 id="legacy-heading" className="break-words text-sm font-medium text-on-surface-variant uppercase tracking-wide">On-device models outside the catalogue</h2>
            <p className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">Present from earlier installs — storage management only, never downloadable.</p>
          </div>
          <div className="space-y-3" role="list" aria-label="On-device models outside the catalogue">
            {legacyStates.map((info) => (
              <LegacyModelCard
                key={info.id}
                modelId={info.id}
                info={info}
                onDelete={handleLegacyDelete}
              />
            ))}
          </div>
        </section>
      )}

      {gpuSelfTestModel && gpuSelfTestState !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="gpu-test-title" aria-describedby="gpu-test-desc">
          <div ref={gpuSelfTestRef} tabIndex={-1} className="w-[min(28rem,calc(100vw-2rem))] min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto bg-surface rounded-xl p-4 sm:p-6">
            <h3 id="gpu-test-title" className="mb-2 min-w-0 break-words text-lg font-semibold">Accelerator verification</h3>
            <p id="gpu-test-desc" className="mb-4 min-w-0 break-words text-sm text-on-surface-variant">Checking {gpuSelfTestModel}{gpuSelfTestSource ? ` with a ${gpuSelfTestSource === "camera" ? "camera photo" : "gallery photo"}` : ""}…</p>
            {gpuSelfTestState === "running" && (
              <div role="status" className="flex min-w-0 items-center justify-center gap-3">
                <Loader2 size={24} className="shrink-0 animate-spin text-on-surface" aria-hidden />
                <span className="min-w-0 break-words">Verifying accelerator…</span>
              </div>
            )}
            {gpuSelfTestState === "done" && (
              <div className={`flex min-w-0 items-start gap-3 p-4 rounded-lg border ${gpuSelfTestResult?.state === "GPU_AVAILABLE" ? "bg-on-surface text-surface border-on-surface" : "border-outline-variant"}`}>
                {gpuSelfTestResult?.state === "GPU_AVAILABLE" ? (
                  <CheckCircle size={24} aria-hidden className="shrink-0" />
                ) : (
                  <AlertTriangle size={24} aria-hidden className="shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="break-words font-medium">{getSelfTestPresentation(gpuSelfTestResult).title}</p>
                  <p className="break-words text-sm text-on-surface-variant">
                    {getSelfTestPresentation(gpuSelfTestResult).message}
                  </p>
                </div>
              </div>
            )}
            {gpuSelfTestState === "error" && (
              <div className="flex min-w-0 items-start gap-3 p-4 rounded-lg border border-error">
                <XCircle size={24} aria-hidden className="shrink-0 text-error" />
                <div className="min-w-0">
                  <p className="break-words font-medium">{getSelfTestPresentation(gpuSelfTestResult).title}</p>
                  <p className="break-words text-sm text-on-surface-variant">{getSelfTestPresentation(gpuSelfTestResult).message}</p>
                </div>
              </div>
            )}
            {gpuSelfTestState === "running" ? (
              <button
                onClick={() => {
                  closeGpuSelfTest();
                }}
                className="mt-4 min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-4 py-2 text-center bg-on-surface text-surface rounded-lg"
              >
                Cancel test
              </button>
            ) : (
              <button
                onClick={() => {
                  closeGpuSelfTest();
                }}
                className="mt-4 min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-4 py-2 text-center bg-on-surface text-surface rounded-lg"
              >
                Close
              </button>
            )}
          </div>
        </div>
      )}

      {confirmDownload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
          <div ref={confirmDownloadRef} tabIndex={-1} className="w-[min(28rem,calc(100vw-2rem))] min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto bg-surface rounded-xl p-4 sm:p-6">
            <h3 id="confirm-title" className="mb-4 min-w-0 break-words text-lg font-semibold">Confirm Download</h3>
            <p id="confirm-desc" className="text-sm text-on-surface-variant mb-4 break-words">
              Download size: {formatBytes(confirmDownload.downloadBytes)}.
            </p>
            <p className="text-xs text-on-surface-variant mb-4 break-words">
              Required free space: {formatBytes(confirmDownload.requiredBytes)}
              {capabilities && ` (${formatBytes((capabilities.freeAppStorageMb ?? Number.MAX_SAFE_INTEGER) * 1024 * 1024)} available)`}
            </p>
            {confirmDownload.needsConfirm ? (
              <ModelAdvancedConfirmGate
                entry={confirmDownload.entry}
                availableFreeRamMb={availableFreeRamMb}
                acknowledged={acknowledged}
                onAcknowledgedChange={setAcknowledged}
                secondConfirmed={secondConfirmed}
                onSecondConfirmedChange={setSecondConfirmed}
                requireSecondConfirm={confirmDownload.largeSecondConfirm}
                onConfirm={handleConfirmDownload}
                onCancel={() => setConfirmDownload(null)}
              />
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-end">
                <button
                  onClick={() => setConfirmDownload(null)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-4 py-2 text-center border border-outline-variant rounded-lg hover:bg-surface-container sm:w-auto"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDownload}
                  autoFocus
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-4 py-2 text-center bg-on-surface text-surface rounded-lg hover:opacity-90 sm:w-auto"
                >
                  Confirm download
                </button>
              </div>
            )}
            {confirmGateBlocked && (
              <p className="mt-2 text-xs text-on-surface-variant">Confirm remains disabled until the acknowledgement is recorded.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
