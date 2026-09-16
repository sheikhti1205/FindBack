import { useEffect, useState } from "react";
import { Download, Trash2, Cpu, AlertTriangle, CheckCircle, XCircle, Loader2, HardDrive } from "lucide-react";
import { getVlmBridge } from "../services/vlmPlugin";
import type { VlmModelId, VlmState, BackendMode, VlmCapabilities, VlmModelInfo, DownloadProgressEvent } from "../services/vlmPlugin";

const MODEL_SPECS: Record<VlmModelId, { label: string; sizeMb: number; revision: string }> = {
  "smolvlm2-500m": { label: "SmolVLM2 500M", sizeMb: 360.8, revision: "a1b2c3d4" },
  "smolvlm-256m": { label: "SmolVLM 256M", sizeMb: 274.9, revision: "e5f6g7h8" },
};

const STATE_LABELS: Record<VlmState, string> = {
  NOT_INSTALLED: "Not installed",
  DOWNLOADING: "Downloading…",
  PAUSED: "Paused",
  VERIFYING_HASH: "Verifying…",
  INSTALLED_UNVERIFIED: "Installed (unverified)",
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

function ModelRow({
  modelId,
  info,
  capabilities,
  _mode,
  onDownload,
  onDelete,
  onRunGpuSelfTest,
  onCancelDownload,
  downloadProgress,
}: {
  modelId: VlmModelId;
  info: VlmModelInfo;
  capabilities: VlmCapabilities | null;
  _mode: BackendMode;
  onDownload: (modelId: VlmModelId) => void;
  onDelete: (modelId: VlmModelId) => void;
  onRunGpuSelfTest: (modelId: VlmModelId, imageUri: string) => void;
  onCancelDownload: (modelId: VlmModelId) => void;
  downloadProgress: DownloadProgressEvent | null;
}) {
  const spec = MODEL_SPECS[modelId];
  const stateLabel = STATE_LABELS[info.state] ?? info.state;
  const isDownloading = info.state === "DOWNLOADING";
  const isInstalled = ["READY_GPU", "GPU_UNAVAILABLE", "INSTALLED_UNVERIFIED"].includes(info.state);
  const canRunSelfTest = info.state === "READY_GPU" || info.state === "GPU_UNAVAILABLE";
  const showProgress = isDownloading && downloadProgress?.modelId === modelId;

  const requiredSpaceMb = spec.sizeMb * 1.2;
  const freeSpaceMb = capabilities?.freeAppStorageMb ?? Number.MAX_SAFE_INTEGER;
  const hasSpace = freeSpaceMb >= requiredSpaceMb;

  return (
    <div className="border border-outline-variant rounded-xl p-4 bg-surface">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-base truncate">{spec.label}</h3>
            <span className="text-xs text-on-surface-variant whitespace-nowrap">{spec.sizeMb} MB</span>
            <span className="text-xs text-on-surface-variant whitespace-nowrap">rev {spec.revision}</span>
          </div>
          <p className="text-xs text-on-surface-variant mt-1">Pinned revision: {spec.revision}</p>

          <div className="mt-2 flex items-center gap-3 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1">
              <HardDrive size={12} aria-hidden />
              Required: {requiredSpaceMb.toFixed(1)} MB free
            </span>
            <span className="flex items-center gap-1">
              {hasSpace ? (
                <>
                  <CheckCircle size={12} className="text-green-500" aria-hidden />
                  {formatBytes(freeSpaceMb * 1024 * 1024)} available
                </>
              ) : (
                <>
                  <AlertTriangle size={12} className="text-amber-500" aria-hidden />
                  Only {formatBytes(freeSpaceMb * 1024 * 1024)} available
                </>
              )}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${
                info.state === "READY_GPU"
                  ? "bg-green-100 text-green-800"
                  : info.state === "GPU_UNAVAILABLE"
                  ? "bg-amber-100 text-amber-800"
                  : info.state === "DOWNLOADING" || info.state === "VERIFYING_HASH" || info.state === "GPU_SELF_TESTING"
                  ? "bg-blue-100 text-blue-800"
                  : info.state === "DOWNLOAD_FAILED" || info.state === "CORRUPT" || info.state === "RUNTIME_ERROR" || info.state === "INSUFFICIENT_STORAGE"
                  ? "bg-red-100 text-red-800"
                  : "bg-surface-variant text-on-surface-variant"
              }`}
            >
              {info.state === "DOWNLOADING" && showProgress && downloadProgress
                ? `Downloading ${Math.round(downloadProgress.progress * 100)}%`
                : stateLabel}
            </span>
            {info.error && info.error !== stateLabel && (
              <span className={`text-xs px-2 py-0.5 rounded-full ${info.state === "GPU_UNAVAILABLE" ? "text-amber-700 bg-amber-50" : "text-red-700 bg-red-50"}`}>
                {info.error}
              </span>
            )}
          </div>

          {showProgress && downloadProgress && (
            <div className="mt-2 h-1.5 bg-surface-variant rounded-full overflow-hidden" role="progressbar" aria-valuenow={Math.round(downloadProgress.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-primary transition-all duration-300" style={{ width: `${downloadProgress.progress * 100}%` }} />
            </div>
          )}

          {info.state === "DOWNLOAD_FAILED" && info.error && (
            <p className="mt-2 text-xs text-red-600">{info.error}</p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {isDownloading ? (
            <button
              onClick={() => onCancelDownload(modelId)}
              className="px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-variant transition-colors"
              disabled={!hasSpace}
            >
              Cancel
            </button>
          ) : !isInstalled ? (
            <button
              onClick={() => onDownload(modelId)}
              className="px-3 py-1.5 text-sm bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1"
              disabled={!hasSpace}
              aria-label={`Download ${spec.label}`}
            >
              <Download size={14} aria-hidden />
              Download
            </button>
          ) : (
            <>
              {canRunSelfTest && (
                <button
                  onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = "image/*";
                    input.capture = "environment";
                    input.onchange = () => {
                      const file = input.files?.[0];
                      if (file) {
                        const url = URL.createObjectURL(file);
                        onRunGpuSelfTest(modelId, url);
                      }
                    };
                    input.click();
                  }}
                  className="px-3 py-1.5 text-sm border border-outline-variant rounded-lg hover:bg-surface-variant transition-colors flex items-center gap-1"
                >
                  <Cpu size={14} aria-hidden />
                  Run GPU self-test
                </button>
              )}
              <button
                onClick={() => onDelete(modelId)}
                className="px-3 py-1.5 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors flex items-center gap-1"
              >
                <Trash2 size={14} aria-hidden />
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function OfflineAi() {
  const bridge = getVlmBridge();
  const [capabilities, setCapabilities] = useState<VlmCapabilities | null>(null);
  const [mode, setModeState] = useState<BackendMode>("AUTO");
  const [modelStates, setModelStates] = useState<VlmModelInfo[]>([]);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressEvent | null>(null);
  const [confirmDownload, setConfirmDownload] = useState<{ modelId: VlmModelId | "both"; sizes: number[] } | null>(null);
  const [gpuSelfTestModel, setGpuSelfTestModel] = useState<VlmModelId | null>(null);
  const [gpuSelfTestState, setGpuSelfTestState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [gpuSelfTestResult, setGpuSelfTestResult] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    bridge.getCapabilities().then((c) => mounted && setCapabilities(c));
    bridge.getSettings().then((s) => mounted && setModeState(s.mode));
    bridge.getModelStates().then((m) => mounted && setModelStates(m));

    const offProgress = bridge.onDownloadProgress((event) => {
      setDownloadProgress(event);
    });
    const offState = bridge.onModelStateChange((info) => {
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
  }, []);

  const handleDownload = (modelId: VlmModelId) => {
    const spec = MODEL_SPECS[modelId];
    setConfirmDownload({ modelId, sizes: [spec.sizeMb] });
  };

  const handleInstallBoth = () => {
    const sizes = ["smolvlm2-500m", "smolvlm-256m"].map((id) => MODEL_SPECS[id as VlmModelId].sizeMb);
    setConfirmDownload({ modelId: "both", sizes });
  };

  const handleConfirmDownload = async () => {
    if (!confirmDownload) return;
    if (confirmDownload.modelId === "both") {
      await bridge.downloadModel("smolvlm2-500m");
      await bridge.downloadModel("smolvlm-256m");
    } else {
      await bridge.downloadModel(confirmDownload.modelId);
    }
    setConfirmDownload(null);
  };

  const handleDelete = async (modelId: VlmModelId) => {
    await bridge.deleteModel(modelId);
  };

  const handleCancelDownload = async (modelId: VlmModelId) => {
    await bridge.cancelDownload(modelId);
  };

  const handleRunGpuSelfTest = async (modelId: VlmModelId, imageUri: string) => {
    setGpuSelfTestModel(modelId);
    setGpuSelfTestState("running");
    setGpuSelfTestResult(null);
    try {
      const result = await bridge.runGpuSelfTest(modelId, imageUri);
      setGpuSelfTestState("done");
      setGpuSelfTestResult(result);
    } catch (e) {
      setGpuSelfTestState("error");
      setGpuSelfTestResult(e instanceof Error ? e.message : "Unknown error");
    }
  };

  const handleModeChange = async (newMode: BackendMode) => {
    await bridge.setMode(newMode);
    setModeState(newMode);
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="px-4 pt-2">
        <h1 className="text-xl font-semibold tracking-tight">Offline AI</h1>
        <p className="text-xs text-on-surface-variant">Manage local models, inference mode, and GPU self-test.</p>
      </header>

      <section className="px-4 space-y-4" aria-labelledby="mode-heading">
        <h2 id="mode-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Inference Mode</h2>
        <div className="flex gap-2" role="radiogroup" aria-label="Inference mode">
          {(["AUTO", "FAST", "QUALITY"] as BackendMode[]).map((m) => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              role="radio"
              aria-checked={mode === m}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                mode === m
                  ? "bg-primary text-on-primary"
                  : "bg-surface-variant text-on-surface-variant hover:bg-surface-variant/80"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-xs text-on-surface-variant">
          AUTO: prefers GPU, falls back to CPU. FAST: CPU only. QUALITY: GPU only.
        </p>
      </section>

      <section className="px-4 space-y-4" aria-labelledby="models-heading">
        <div className="flex items-center justify-between">
          <h2 id="models-heading" className="text-sm font-medium text-on-surface-variant uppercase tracking-wide">Models</h2>
          <button
            onClick={handleInstallBoth}
            className="px-3 py-1.5 text-sm bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1"
            disabled={modelStates.every((m) => ["READY_GPU", "GPU_UNAVAILABLE", "INSTALLED_UNVERIFIED"].includes(m.state))}
          >
            <Download size={14} aria-hidden />
            Install both
          </button>
        </div>

        <div className="space-y-3" role="list" aria-label="Available models">
          {["smolvlm2-500m", "smolvlm-256m"].map((modelId) => {
            const info = modelStates.find((m) => m.id === modelId) ?? { id: modelId as VlmModelId, state: "NOT_INSTALLED" as VlmState };
            return (
              <ModelRow
                key={modelId}
                modelId={modelId as VlmModelId}
                info={info}
                capabilities={capabilities}
                _mode={mode}
                onDownload={handleDownload}
                onDelete={handleDelete}
                onRunGpuSelfTest={handleRunGpuSelfTest}
                onCancelDownload={handleCancelDownload}
                downloadProgress={downloadProgress}
              />
            );
          })}
        </div>
      </section>

      {gpuSelfTestModel && gpuSelfTestState !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="gpu-test-title">
          <div className="w-full max-w-md bg-surface rounded-xl p-6">
            <h3 id="gpu-test-title" className="text-lg font-semibold mb-4">GPU Self-Test</h3>
            <p className="text-sm text-on-surface-variant mb-4">Testing {MODEL_SPECS[gpuSelfTestModel].label} on GPU…</p>
            {gpuSelfTestState === "running" && (
              <div className="flex items-center justify-center gap-3">
                <Loader2 size={24} className="animate-spin text-primary" aria-hidden />
                <span>Running GPU self-test…</span>
              </div>
            )}
            {gpuSelfTestState === "done" && (
              <div className={`flex items-center gap-3 p-4 rounded-lg ${gpuSelfTestResult === "GPU_AVAILABLE" ? "bg-green-50" : "bg-amber-50"}`}>
                {gpuSelfTestResult === "GPU_AVAILABLE" ? (
                  <CheckCircle size={24} className="text-green-600" aria-hidden />
                ) : (
                  <AlertTriangle size={24} className="text-amber-600" aria-hidden />
                )}
                <div>
                  <p className="font-medium">{gpuSelfTestResult === "GPU_AVAILABLE" ? "GPU Available" : "GPU Unavailable"}</p>
                  <p className="text-sm text-on-surface-variant">{gpuSelfTestResult}</p>
                </div>
              </div>
            )}
            {gpuSelfTestState === "error" && (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-red-50">
                <XCircle size={24} className="text-red-600" aria-hidden />
                <div>
                  <p className="font-medium">Test Failed</p>
                  <p className="text-sm text-on-surface-variant">{gpuSelfTestResult}</p>
                </div>
              </div>
            )}
            <button
              onClick={() => {
                setGpuSelfTestModel(null);
                setGpuSelfTestState("idle");
                setGpuSelfTestResult(null);
              }}
              className="mt-4 w-full px-4 py-2 bg-primary text-on-primary rounded-lg"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {confirmDownload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
          <div className="w-full max-w-md bg-surface rounded-xl p-6">
            <h3 id="confirm-title" className="text-lg font-semibold mb-4">Confirm Download</h3>
            <p className="text-sm text-on-surface-variant mb-4">
              {confirmDownload.modelId === "both"
                ? `This will download both models sequentially (${confirmDownload.sizes.map((s) => `${s} MB`).join(" + ")} = ${confirmDownload.sizes.reduce((a, b) => a + b, 0).toFixed(1)} MB total).`
                : `This will download ${confirmDownload.sizes[0]} MB.`}
            </p>
            <p className="text-xs text-on-surface-variant mb-4">
              Required free space: {confirmDownload.sizes.map((s) => (s * 1.2).toFixed(1)).join(" + ")} MB
              {capabilities && ` (${formatBytes((capabilities.freeAppStorageMb ?? Number.MAX_SAFE_INTEGER) * 1024 * 1024)} available)`}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDownload(null)}
                className="px-4 py-2 border border-outline-variant rounded-lg hover:bg-surface-variant"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDownload}
                className="px-4 py-2 bg-primary text-on-primary rounded-lg hover:opacity-90"
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
