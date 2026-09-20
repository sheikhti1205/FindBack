import { useEffect, useRef, useState } from "react";
import { Download, Trash2, Cpu, AlertTriangle, CheckCircle, XCircle, Loader2, HardDrive } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { getModelAction, getVlmBridge, isInstalledState } from "../services/vlmPlugin";
import { chooseFromGallery, isCancellation, isNativeCameraAvailable, takePhoto, toNativeImageUri } from "../services/photo";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import type { VlmModelId, VlmState, VlmCapabilities, VlmModelInfo, DownloadProgressEvent, GpuSelfTestResult } from "../services/vlmPlugin";

const MODEL_SPECS: Record<VlmModelId, { label: string; sizeMb: number; revision: string; sourceRepo: string; runtime: string }> = {
  "smolvlm2-500m": {
    label: "SmolVLM2 500M",
    sizeMb: 360.8,
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    sourceRepo: "litert-community/SmolVLM2-500M",
    runtime: "com.google.ai.edge.litertlm:litertlm-android:0.16.0",
  },
  "smolvlm-256m": {
    label: "SmolVLM 256M",
    sizeMb: 274.9,
    revision: "dc16f6046d86c646bcc5dfe249c879d028f8b2f2",
    sourceRepo: "litert-community/SmolVLM-256M-Instruct",
    runtime: "com.google.ai.edge.litert:litert:1.4.2+litert-gpu:1.4.2",
  },
};

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
function fallbackRequiredBytes(sizeMb: number): number {
  const bytes = sizeMb * 1024 * 1024;
  return bytes + Math.max(INSTALL_HEADROOM_BYTES, bytes * INSTALL_HEADROOM_FRACTION);
}

/** Only models that can actually generate a report are downloadable. */
const EXPOSED_MODELS: VlmModelId[] = ["smolvlm2-500m"];

/**
 * Experimental candidates: visible and registered, but with no proven
 * complete generation path in this beta — hence no download/verify actions.
 * Storage management appears only when files already exist on-device.
 */
const EXPERIMENTAL_MODELS: VlmModelId[] = ["smolvlm-256m"];

function ExperimentalModelCard({
  modelId,
  info,
  onDelete,
}: {
  modelId: VlmModelId;
  info: VlmModelInfo;
  onDelete: (modelId: VlmModelId) => void;
}) {
  const spec = MODEL_SPECS[modelId];
  const installed = isInstalledState(info.state);
  return (
    <div role="listitem" aria-label={`${spec.label} (experimental)`} className="w-full min-w-0 overflow-x-hidden border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="min-w-0">
          <h3 className="min-w-0 break-words font-medium text-base">{spec.label}</h3>
          <p className="min-w-0 break-words text-xs text-on-surface-variant">Fast-model candidate</p>
        </div>
        <p className="min-w-0 break-words text-sm">Current status: Not available for report generation in this beta.</p>
        <p className="min-w-0 break-words text-sm text-on-surface-variant">NPU test on this device: current graph incompatible.</p>
        <details className="min-w-0 break-words text-xs text-on-surface-variant">
          <summary className="cursor-pointer">Technical details</summary>
          <dl className="mt-1 min-w-0 space-y-0.5 break-words">
            <div className="min-w-0"><dt className="inline font-medium">Source: </dt><dd className="inline min-w-0 break-all">{spec.sourceRepo}</dd></div>
            <div className="min-w-0"><dt className="inline font-medium">Revision: </dt><dd className="inline min-w-0 break-all">{spec.revision}</dd></div>
            <div className="min-w-0"><dt className="inline font-medium">Runtime: </dt><dd className="inline min-w-0 break-all">{spec.runtime}</dd></div>
            <div className="min-w-0"><dt className="inline font-medium">NPU probe: </dt><dd className="inline min-w-0 break-words">FAIL — unsupported RSQRT/REDUCE_SUM ops; KV-cache allocation failure during Neuron compilation.</dd></div>
          </dl>
        </details>
        {installed ? (
          <div className="flex min-w-0 flex-col gap-2">
            {typeof info.sizeBytes === "number" && (
              <p className="min-w-0 break-words text-xs text-on-surface-variant">On-device data: {formatBytes(info.sizeBytes)}</p>
            )}
            <button
              onClick={() => onDelete(modelId)}
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

function ModelRow({
  modelId,
  info,
  capabilities,
  onDownload,
  onDelete,
  onPickSelfTest,
  onCancelDownload,
  onPauseDownload,
  onResumeDownload,
  onRepair,
  downloadProgress,
}: {
  modelId: VlmModelId;
  info: VlmModelInfo;
  capabilities: VlmCapabilities | null;
  onDownload: (modelId: VlmModelId) => void;
  onDelete: (modelId: VlmModelId) => void;
  onPickSelfTest: (modelId: VlmModelId, source: "camera" | "gallery") => void;
  onCancelDownload: (modelId: VlmModelId) => void;
  onPauseDownload: (modelId: VlmModelId) => void;
  onResumeDownload: (modelId: VlmModelId) => void;
  onRepair: (modelId: VlmModelId) => void;
  downloadProgress: DownloadProgressEvent | null;
}) {
  const spec = MODEL_SPECS[modelId];
  const stateLabel = STATE_LABELS[info.state] ?? info.state;
  const action = getModelAction(info.state);
  // gpuDelegateClassPresent is diagnostic only: readiness comes only from the
  // real image-bearing GPU self-test, never from class presence.
  const canOfferSelfTest = action.canSelfTest && isNativeCameraAvailable();
  const showProgress = (info.state === "DOWNLOADING") && downloadProgress?.modelId === modelId;
  const [showSourcePicker, setShowSourcePicker] = useState(false);

  // The native requiredBytes is authoritative; the fallback mirrors the native
  // policy (model + max(256 MiB, 25%)) so the button never lies.
  const requiredBytes = info.requiredBytes ?? fallbackRequiredBytes(spec.sizeMb);
  // Unknown storage is never treated as sufficient: Download stays disabled
  // until native reports free space.
  const freeBytes =
    capabilities != null && Number.isFinite(capabilities.freeAppStorageMb)
      ? capabilities.freeAppStorageMb * 1024 * 1024
      : null;
  const isStorageUnknown = freeBytes === null;
  const hasSpace = !isStorageUnknown && (freeBytes as number) >= requiredBytes;

  return (
    <div role="listitem" aria-label={spec.label} className="w-full min-w-0 overflow-x-hidden border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-medium text-base">{spec.label}</h3>
            <span className="min-w-0 break-words text-xs text-on-surface-variant">{spec.sizeMb} MB download</span>
          </div>

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
              <div className="min-w-0"><dt className="inline font-medium">Source: </dt><dd className="inline min-w-0 break-all">{spec.sourceRepo}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Revision: </dt><dd className="inline min-w-0 break-all">{spec.revision}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">Runtime: </dt><dd className="inline min-w-0 break-all">{spec.runtime}</dd></div>
              <div className="min-w-0"><dt className="inline font-medium">GPU delegate class: </dt><dd className="inline min-w-0 break-words">{capabilities ? (capabilities.gpuDelegateClassPresent ? "present" : "missing") : "unknown"} (diagnostic only)</dd></div>
            </dl>
          </details>

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`inline-flex max-w-full items-center whitespace-normal break-words px-2 py-0.5 rounded-full text-left text-xs border ${
                info.state === "READY_GPU"
                  ? "bg-on-surface text-surface border-on-surface"
                  : info.state === "GPU_UNAVAILABLE" || info.state === "INSTALLED_UNVERIFIED"
                  ? "border-outline-variant text-on-surface"
                  : info.state === "DOWNLOADING" || info.state === "QUEUED" || info.state === "VERIFYING_HASH" || info.state === "VERIFYING_FILE" || info.state === "VERIFYING_CHUNK" || info.state === "GPU_SELF_TESTING" || info.state === "REPAIRING"
                  ? "bg-surface-container text-on-surface border-outline-variant"
                  : info.state === "DOWNLOAD_FAILED" || info.state === "CORRUPT" || info.state === "RUNTIME_ERROR" || info.state === "INSUFFICIENT_STORAGE" || info.state === "MANIFEST_MISMATCH" || info.state === "PAUSED_ERROR" || info.state === "REPAIR_NEEDED"
                  ? "border-error text-error"
                  : "bg-surface-container text-on-surface-variant border-outline-variant"
              }`}
            >
              {info.state === "DOWNLOADING" && showProgress && downloadProgress
                ? `Downloading ${formatBytes(downloadProgress.downloadedBytes)} / ${formatBytes(downloadProgress.totalBytes)} (${Math.round(downloadProgress.progress * 100)}%)`
                : stateLabel}
            </span>
            {friendlyError(info.error) && (
              <span className={`max-w-full whitespace-normal break-words text-left text-xs px-2 py-0.5 rounded-full border ${info.state === "GPU_UNAVAILABLE" ? "border-outline-variant text-on-surface-variant" : "border-error text-error"}`}>
                {friendlyError(info.error)}
              </span>
            )}
          </div>

          {showProgress && downloadProgress && (
            <div className="mt-2 h-1.5 bg-surface-container rounded-full overflow-hidden" role="progressbar" aria-valuenow={Math.round(downloadProgress.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-on-surface transition-all duration-300" style={{ width: `${downloadProgress.progress * 100}%` }} />
            </div>
          )}

          {action.canRepair && (
            <p className="mt-2 text-xs text-error">
              Integrity check found damaged data. Repair re-downloads only the damaged parts — verified chunks will be kept.
            </p>
          )}

          {info.state === "DOWNLOAD_FAILED" && info.error && (
            <p className="mt-2 text-xs text-error">{friendlyError(info.error)}</p>
          )}
          {info.state === "PAUSED_ERROR" && (
            <p className="mt-2 text-xs text-on-surface-variant">Paused after repeated network errors. Your verified progress is kept — resume to continue.</p>
          )}
          {info.state === "MANIFEST_MISMATCH" && (
            <p className="mt-2 text-xs text-error">The downloaded bytes do not match the pinned source manifest. Automatic retry is stopped; nothing was deleted.</p>
          )}
        </div>

        <div className="flex w-full min-w-0 flex-col gap-2">
          {action.isTransferActive ? (
            <>
              {action.canPause && (
                <button
                  onClick={() => onPauseDownload(modelId)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Pause ${spec.label}`}
                >
                  Pause
                </button>
              )}
              {action.canCancel && (
                <button
                  onClick={() => onCancelDownload(modelId)}
                  className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Cancel ${spec.label}`}
                >
                  Cancel
                </button>
              )}
            </>
          ) : action.canResume && action.canCancel ? (
            <>
              <button
                onClick={() => onResumeDownload(modelId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
                aria-label={`Resume ${spec.label}`}
              >
                Resume
              </button>
              <button
                onClick={() => onCancelDownload(modelId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                aria-label={`Cancel ${spec.label}`}
              >
                Cancel
              </button>
            </>
          ) : action.canRepair ? (
            <button
              onClick={() => onRepair(modelId)}
              className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
              aria-label={`Repair ${spec.label}`}
            >
              Repair
            </button>
          ) : action.canDownload ? (
            <button
              onClick={() => onDownload(modelId)}
              className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              disabled={!hasSpace}
              aria-label={`Download ${spec.label}`}
            >
              <Download size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0 break-words">Download</span>
            </button>
          ) : action.canSelfTest && action.canDelete ? (
            <>
              {canOfferSelfTest && (
                <div className="flex w-full min-w-0 flex-col gap-2">
                  <button
                    onClick={() => setShowSourcePicker(true)}
                    className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                    aria-label={`Verify ${spec.label} accelerator`}
                  >
                    <Cpu size={14} aria-hidden className="shrink-0" />
                    <span className="min-w-0 break-words">Verify accelerator</span>
                  </button>
                  {showSourcePicker && (
                    <div role="group" aria-label={`Verification source for ${spec.label}`} className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-outline-variant p-2">
                      <button
                        onClick={() => {
                          setShowSourcePicker(false);
                          onPickSelfTest(modelId, "camera");
                        }}
                        className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                      >
                        Use camera
                      </button>
                      <button
                        onClick={() => {
                          setShowSourcePicker(false);
                          onPickSelfTest(modelId, "gallery");
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
              <button
                onClick={() => onDelete(modelId)}
                className="min-h-[48px] w-full min-w-0 justify-center whitespace-normal break-words px-3 py-1.5 text-center text-sm border border-error text-error rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
              >
                <Trash2 size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 break-words">Delete</span>
              </button>
            </>
          ) : (
            <span className="min-w-0 break-words text-xs text-on-surface-variant">Verification running…</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function OfflineAi() {
  const bridge = getVlmBridge();
  const [capabilities, setCapabilities] = useState<VlmCapabilities | null>(null);
  const [wifiOnly, setWifiOnly] = useState(loadWifiOnly);
  const [allowCpuFallback, setAllowCpuFallback] = useState(true);
  const [modelStates, setModelStates] = useState<VlmModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressEvent | null>(null);
  const [confirmDownload, setConfirmDownload] = useState<{ modelId: VlmModelId; downloadBytes: number; requiredBytes: number } | null>(null);
  const [gpuSelfTestModel, setGpuSelfTestModel] = useState<VlmModelId | null>(null);
  const [gpuSelfTestSource, setGpuSelfTestSource] = useState<"camera" | "gallery" | null>(null);
  const [gpuSelfTestState, setGpuSelfTestState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [gpuSelfTestResult, setGpuSelfTestResult] = useState<GpuSelfTestResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const gpuSelfTestRef = useRef<HTMLDivElement>(null);
  const confirmDownloadRef = useRef<HTMLDivElement>(null);

    // Guards async action errors against setState-after-unmount (WP10 #21).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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

  const handleDownload = (modelId: VlmModelId) => {
    const info = modelStates.find((m) => m.id === modelId);
    const downloadBytes = info?.sizeBytes ?? Math.round(MODEL_SPECS[modelId].sizeMb * 1024 * 1024);
    const required = info?.requiredBytes ?? fallbackRequiredBytes(MODEL_SPECS[modelId].sizeMb);
    setConfirmDownload({ modelId, downloadBytes, requiredBytes: required });
  };

  const handleConfirmDownload = () => {
    if (!confirmDownload) return;
    const target = confirmDownload.modelId;
    const allowCellular = !wifiOnly;
    // Close the dialog immediately after scheduling so progress and
    // pause/cancel UI stay visible; the transfer runs in the background.
    setConfirmDownload(null);
    void (async () => {
      const opts = allowCellular ? { allowCellular: true } : undefined;
      try {
        if (opts) await bridge.downloadModel(target, opts);
        else await bridge.downloadModel(target);
      } catch (err) {
        if (mountedRef.current) setActionError(actionErrorMessage(err));
      }
    })();
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

  const handleDelete = async (modelId: VlmModelId) => {
    if (!window.confirm(`Delete ${MODEL_SPECS[modelId].label}? This stops inference, unloads the engine, and removes only this model. The other model is unaffected.`)) {
      return;
    }
    await runAction(() => bridge.deleteModel(modelId));
  };

  const handleCancelDownload = async (modelId: VlmModelId) => {
    await runAction(() => bridge.cancelDownload(modelId));
  };

  const handlePauseDownload = async (modelId: VlmModelId) => {
    await runAction(() => bridge.pauseDownload(modelId));
  };

  const handleResumeDownload = async (modelId: VlmModelId) => {
    await runAction(() => bridge.resumeDownload(modelId));
  };

  const handleRepair = async (modelId: VlmModelId) => {
    await runAction(() => bridge.repairModel(modelId));
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
          runs on CPU with an explicit on-screen notice — never silently. The
          SmolVLM2 500M model is the only downloadable model.
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

        <div className="space-y-3" role="list" aria-label="Available models">
          {EXPOSED_MODELS.map((modelId) => {
            const info = modelStates.find((m) => m.id === modelId) ?? { id: modelId, state: "NOT_INSTALLED" as VlmState };
            return (
              <ModelRow
                key={modelId}
                modelId={modelId}
                info={info}
                capabilities={capabilities}
                onDownload={handleDownload}
                onDelete={handleDelete}
                onPickSelfTest={handlePickSelfTest}
                onCancelDownload={handleCancelDownload}
                onPauseDownload={handlePauseDownload}
                onResumeDownload={handleResumeDownload}
                onRepair={handleRepair}
                downloadProgress={downloadProgress}
              />
            );
          })}
        </div>
      </section>

      <section className="px-4 space-y-4" aria-labelledby="experimental-heading">
        <div className="min-w-0">
          <h2 id="experimental-heading" className="break-words text-sm font-medium text-on-surface-variant uppercase tracking-wide">Experimental models</h2>
          <p className="mt-1 min-w-0 break-words text-xs text-on-surface-variant">Candidates under evaluation — not report backends in this beta.</p>
        </div>
        <div className="space-y-3" role="list" aria-label="Experimental models">
          {EXPERIMENTAL_MODELS.map((modelId) => {
            const info = modelStates.find((m) => m.id === modelId) ?? { id: modelId, state: "NOT_INSTALLED" as VlmState };
            return (
              <ExperimentalModelCard
                key={modelId}
                modelId={modelId}
                info={info}
                onDelete={handleDelete}
              />
            );
          })}
        </div>
      </section>

      {gpuSelfTestModel && gpuSelfTestState !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="gpu-test-title" aria-describedby="gpu-test-desc">
          <div ref={gpuSelfTestRef} tabIndex={-1} className="w-[min(28rem,calc(100vw-2rem))] min-w-0 max-h-[calc(100dvh-2rem)] overflow-y-auto bg-surface rounded-xl p-4 sm:p-6">
            <h3 id="gpu-test-title" className="mb-2 min-w-0 break-words text-lg font-semibold">Accelerator verification</h3>
            <p id="gpu-test-desc" className="mb-4 min-w-0 break-words text-sm text-on-surface-variant">Checking {MODEL_SPECS[gpuSelfTestModel].label}{gpuSelfTestSource ? ` with a ${gpuSelfTestSource === "camera" ? "camera photo" : "gallery photo"}` : ""}…</p>
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
                <XCircle size={24} className="shrink-0 text-error" aria-hidden />
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
          </div>
        </div>
      )}
    </div>
  );
}
