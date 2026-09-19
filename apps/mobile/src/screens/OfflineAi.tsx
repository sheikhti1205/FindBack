import { useEffect, useRef, useState } from "react";
import { Download, Trash2, Cpu, AlertTriangle, CheckCircle, XCircle, Loader2, HardDrive } from "lucide-react";
import { BackButton } from "../components/BackButton";
import { getModelAction, getVlmBridge } from "../services/vlmPlugin";
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

/** Turns native error codes into plain language; raw enums must never reach users. */
const ERROR_LABELS: Record<string, string> = {
  GPU_UNAVAILABLE_ON_CURRENT_RUNTIME:
    "This phone's GPU can't run this model, and the app won't fall back to the CPU.",
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
    <div className="border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="font-medium text-base">{spec.label}</h3>
            <span className="text-xs text-on-surface-variant whitespace-nowrap">{spec.sizeMb} MB download</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1 whitespace-nowrap">
              <HardDrive size={12} aria-hidden />
              Needs {formatBytes(requiredBytes)} free
            </span>
            <span className="flex items-center gap-1 whitespace-nowrap">
              {isStorageUnknown ? (
                <>Checking storage…</>
              ) : hasSpace ? (
                <>
                  <CheckCircle size={12} className="text-on-surface" aria-hidden />
                  {formatBytes(freeBytes as number)} available
                </>
              ) : (
                <>
                  <AlertTriangle size={12} className="text-error" aria-hidden />
                  Only {formatBytes(freeBytes as number)} available
                </>
              )}
            </span>
          </div>

          <details className="mt-2 text-xs text-on-surface-variant">
            <summary className="cursor-pointer">Technical details</summary>
            <dl className="mt-1 space-y-0.5">
              <div><dt className="inline font-medium">Source: </dt><dd className="inline break-all">{spec.sourceRepo}</dd></div>
              <div><dt className="inline font-medium">Revision: </dt><dd className="inline break-all">{spec.revision}</dd></div>
              <div><dt className="inline font-medium">Runtime: </dt><dd className="inline break-all">{spec.runtime}</dd></div>
              <div><dt className="inline font-medium">GPU delegate class: </dt><dd className="inline">{capabilities ? (capabilities.gpuDelegateClassPresent ? "present" : "missing") : "unknown"} (diagnostic only)</dd></div>
            </dl>
          </details>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
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
              <span className={`text-xs px-2 py-0.5 rounded-full border break-words ${info.state === "GPU_UNAVAILABLE" ? "border-outline-variant text-on-surface-variant" : "border-error text-error"}`}>
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

        <div className="flex flex-col items-end gap-2 shrink-0">
          {action.isTransferActive ? (
            <>
              {action.canPause && (
                <button
                  onClick={() => onPauseDownload(modelId)}
                  className="min-h-[48px] px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                  aria-label={`Pause ${spec.label}`}
                >
                  Pause
                </button>
              )}
              {action.canCancel && (
                <button
                  onClick={() => onCancelDownload(modelId)}
                  className="min-h-[48px] px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
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
                className="min-h-[48px] px-3 py-1.5 text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
                aria-label={`Resume ${spec.label}`}
              >
                Resume
              </button>
              <button
                onClick={() => onCancelDownload(modelId)}
                className="min-h-[48px] px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors"
                aria-label={`Cancel ${spec.label}`}
              >
                Cancel
              </button>
            </>
          ) : action.canRepair ? (
            <button
              onClick={() => onRepair(modelId)}
              className="min-h-[48px] px-3 py-1.5 text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity"
              aria-label={`Repair ${spec.label}`}
            >
              Repair
            </button>
          ) : action.canDownload ? (
            <button
              onClick={() => onDownload(modelId)}
              className="min-h-[48px] px-3 py-1.5 text-sm bg-on-surface text-surface rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              disabled={!hasSpace}
              aria-label={`Download ${spec.label}`}
            >
              <Download size={14} aria-hidden />
              Download
            </button>
          ) : action.canSelfTest && action.canDelete ? (
            <>
              {canOfferSelfTest && (
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => onPickSelfTest(modelId, "camera")}
                    className="min-h-[48px] px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                  >
                    <Cpu size={14} aria-hidden />
                    Run GPU self-test (camera)
                  </button>
                  <button
                    onClick={() => onPickSelfTest(modelId, "gallery")}
                    className="min-h-[48px] px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
                  >
                    <Cpu size={14} aria-hidden />
                    Run GPU self-test (gallery)
                  </button>
                </div>
              )}
            <button
              onClick={() => onDelete(modelId)}
              className="min-h-[48px] px-3 py-1.5 text-sm border border-error text-error rounded-lg hover:bg-surface-container transition-colors flex items-center gap-1"
            >
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
            </>
          ) : (
            <span className="text-xs text-on-surface-variant">Self-test running…</span>
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
  const [modelStates, setModelStates] = useState<VlmModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressEvent | null>(null);
  const [confirmDownload, setConfirmDownload] = useState<{ modelId: VlmModelId; downloadBytes: number; requiredBytes: number } | null>(null);
  const [gpuSelfTestModel, setGpuSelfTestModel] = useState<VlmModelId | null>(null);
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

  // Closing while the self-test is RUNNING must stop native inference first.
  const closeGpuSelfTest = () => {
    if (gpuSelfTestState === "running") {
      void bridge.cancelInference().catch(() => undefined);
    }
    setGpuSelfTestModel(null);
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
      const [caps, states] = await Promise.allSettled([
        bridge.getCapabilities(),
        bridge.getModelStates(),
      ]);
      if (!mounted) return;
      if (caps.status === "fulfilled") setCapabilities(caps.value);
      if (states.status === "fulfilled") setModelStates(states.value);
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
    try {
      const picked = source === "camera" ? await takePhoto() : await chooseFromGallery();
      const uri = toNativeImageUri(picked);
      if (uri) await handleRunGpuSelfTest(modelId, uri);
    } catch (err) {
      if (isCancellation(err) || isSelfTestCancellation(err)) return;
      if (mountedRef.current) setActionError(actionErrorMessage(err));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 overflow-x-hidden">
      <header className="flex items-center gap-2 px-4 pt-2">
        <BackButton fallbackTo="/profile" label="Back to profile" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Offline AI</h1>
          <p className="text-xs text-on-surface-variant">Manage local models, inference mode, and GPU self-test.</p>
        </div>
      </header>

      <section className="px-4 space-y-4" aria-labelledby="network-heading">
        <h2 id="network-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Downloads</h2>
        <p className="text-xs text-on-surface-variant">
          Only a GPU-verified model runs analysis — there is no silent CPU fallback. The
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

      <section className="px-4 space-y-4" aria-labelledby="models-heading">
        <div className="flex items-center justify-between">
          <h2 id="models-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Models</h2>
        </div>

        {actionError && (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 rounded-lg border border-error px-3 py-2"
          >
            <span className="text-sm text-error break-words">{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="min-h-[48px] shrink-0 px-2 text-xs text-error underline"
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

      {gpuSelfTestModel && gpuSelfTestState !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="gpu-test-title" aria-describedby="gpu-test-desc">
          <div ref={gpuSelfTestRef} tabIndex={-1} className="w-full max-w-md bg-surface rounded-xl p-6">
            <h3 id="gpu-test-title" className="text-lg font-semibold mb-4">GPU Self-Test</h3>
            <p id="gpu-test-desc" className="text-sm text-on-surface-variant mb-4">Testing {MODEL_SPECS[gpuSelfTestModel].label} on GPU…</p>
            {gpuSelfTestState === "running" && (
              <div className="flex items-center justify-center gap-3">
                <Loader2 size={24} className="animate-spin text-on-surface" aria-hidden />
                <span>Running GPU self-test…</span>
              </div>
            )}
            {gpuSelfTestState === "done" && (
              <div className={`flex items-center gap-3 p-4 rounded-lg border ${gpuSelfTestResult?.state === "GPU_AVAILABLE" ? "bg-on-surface text-surface border-on-surface" : "border-outline-variant"}`}>
                {gpuSelfTestResult?.state === "GPU_AVAILABLE" ? (
                  <CheckCircle size={24} aria-hidden />
                ) : (
                  <AlertTriangle size={24} aria-hidden />
                )}
                <div>
                  <p className="font-medium">{getSelfTestPresentation(gpuSelfTestResult).title}</p>
                  <p className="text-sm text-on-surface-variant break-words">
                    {getSelfTestPresentation(gpuSelfTestResult).message}
                  </p>
                </div>
              </div>
            )}
            {gpuSelfTestState === "error" && (
              <div className="flex items-center gap-3 p-4 rounded-lg border border-error">
                <XCircle size={24} className="text-error" aria-hidden />
                <div>
                  <p className="font-medium">{getSelfTestPresentation(gpuSelfTestResult).title}</p>
                  <p className="text-sm text-on-surface-variant">{getSelfTestPresentation(gpuSelfTestResult).message}</p>
                </div>
              </div>
            )}
            <button
              onClick={() => {
                closeGpuSelfTest();
              }}
              className="mt-4 min-h-[48px] w-full px-4 py-2 bg-on-surface text-surface rounded-lg"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {confirmDownload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
          <div ref={confirmDownloadRef} tabIndex={-1} className="w-full max-w-md bg-surface rounded-xl p-6">
            <h3 id="confirm-title" className="text-lg font-semibold mb-4">Confirm Download</h3>
            <p id="confirm-desc" className="text-sm text-on-surface-variant mb-4 break-words">
              Download size: {formatBytes(confirmDownload.downloadBytes)}.
            </p>
            <p className="text-xs text-on-surface-variant mb-4 break-words">
              Required free space: {formatBytes(confirmDownload.requiredBytes)}
              {capabilities && ` (${formatBytes((capabilities.freeAppStorageMb ?? Number.MAX_SAFE_INTEGER) * 1024 * 1024)} available)`}
            </p>
            <div className="flex flex-wrap gap-3 justify-end">
              <button
                onClick={() => setConfirmDownload(null)}
                className="min-h-[48px] px-4 py-2 border border-outline-variant rounded-lg hover:bg-surface-container"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDownload}
                autoFocus
                className="min-h-[48px] px-4 py-2 bg-on-surface text-surface rounded-lg hover:opacity-90 whitespace-nowrap"
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
