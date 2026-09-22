import { Capacitor, registerPlugin } from "@capacitor/core";
import type { FbmodelManifest } from "./models/fbmodelSeam";
import type {
  GenerateTextRequest,
  GenerateTextResult,
  TextBridgeModelId,
} from "./models/textRuntime";
import type {
  ExportStreamResult,
  ImportResult,
  NativePackageHost,
  TransferErrorCode,
} from "./models/modelTransfers";

/** VLM model identifiers. */
export type VlmModelId =
  | "smolvlm-256m"
  | "smolvlm2-500m";

/** VLM inference backend mode. */
export type BackendMode = "AUTO" | "FAST" | "QUALITY";

/** VLM backend type. */
export type VlmBackend = "cpu" | "gpu";

/** Model state. */
export type VlmState =
  | "NOT_INSTALLED"
  | "QUEUED"
  | "WAITING_FOR_NETWORK"
  | "WAITING_FOR_WIFI"
  | "DOWNLOADING"
  | "PAUSING"
  | "PAUSED"
  | "PAUSED_ERROR"
  | "VERIFYING_CHUNK"
  | "VERIFYING_HASH"
  | "VERIFYING_FILE"
  | "REPAIR_NEEDED"
  | "REPAIRING"
  | "MANIFEST_MISMATCH"
  | "INSTALLED_UNVERIFIED"
  | "GPU_SELF_TESTING"
  | "READY_GPU"
  | "GPU_UNAVAILABLE"
  | "CORRUPT"
  | "INSUFFICIENT_STORAGE"
  | "DOWNLOAD_FAILED"
  | "RUNTIME_ERROR";

/** VLM error codes. */
export type VlmErrorCode =
  | "GPU_UNAVAILABLE_ON_CURRENT_RUNTIME"
  | "DOWNLOAD_FAILED"
  | "HASH_MISMATCH"
  | "INSUFFICIENT_STORAGE"
  | "RUNTIME_ERROR";

/** GPU self-test state. Legacy states plus the canonical self-test bridge
 * taxonomy (MODEL_MISSING | RUNTIME_ERROR | INPUT_ERROR | GENERATION_ERROR |
 * CANCELLED | GPU_AVAILABLE). Unknown strings fall back to the legacy display. */
export type GpuSelfTestState =
  | "GPU_AVAILABLE"
  | "GPU_UNAVAILABLE"
  | "GPU_UNSUPPORTED"
  | "ERROR"
  | "MODEL_MISSING"
  | "RUNTIME_ERROR"
  | "INPUT_ERROR"
  | "GENERATION_ERROR"
  | "CANCELLED";

/** Device category. */
export type DeviceCategory = "physical" | "emulator" | "web";

/** Capabilities reported by the native plugin. */
export interface VlmCapabilities {
  abi: string;
  androidVersion: string;
  apiLevel: number;
  hardware: string;
  deviceCategory: DeviceCategory;
  gpuVendor: string | null;
  gpuRenderer: string | null;
  memoryClassMb: number;
  freeAppStorageMb: number;
  /** Whether the litert-gpu delegate class ships in the APK (class presence only, never runtime availability). */
  gpuDelegateClassPresent: boolean;
  runtimeVersion: string | null;
  /** Installed APK identity, used to prove screenshots/tests came from the expected build. */
  appVersion?: string | null;
  buildGitSha?: string | null;
  versionCode?: number | null;
}

/** Model state info. */
export interface VlmModelInfo {
  id: VlmModelId;
  state: VlmState;
  sizeBytes?: number;
  /** Native-computed install requirement (model + headroom). Authoritative. */
  requiredBytes?: number;
  error?: string;
}

/** Settings. */
export interface VlmSettings {
  mode: BackendMode;
  wifiOnly?: boolean;
  /** Explicit 500M CPU compatibility permission. Provisional default true. */
  allowCpuFallback?: boolean;
}

/** Typed inference phases only — never fake 10/30/90% progress. */
export type VlmInferencePhase =
  | "PREPARING_IMAGE"
  | "LOADING_MODEL"
  | "RUNNING"
  | "POSTPROCESSING";

/** Inference state event. */
export interface InferenceStateEvent {
  modelId: VlmModelId;
  state: VlmState;
  phase?: VlmInferencePhase;
  progress?: number;
  error?: string;
}

/** Download progress event: progress is real bytes/totalBytes, never faked. */
export interface DownloadProgressEvent {
  modelId: VlmModelId;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
}

/** Download scheduling options. */
export interface DownloadOptions {
  allowCellular?: boolean;
}

/**
 * States where a transfer/verify/settle step is still running. A state is
 * "settled" when it is not in this set, which is the signal used to sequence
 * one heavyweight transfer after another.
 */
const IN_PROGRESS_STATES: VlmState[] = [
  "QUEUED",
  "WAITING_FOR_NETWORK",
  "WAITING_FOR_WIFI",
  "DOWNLOADING",
  "PAUSING",
  "VERIFYING_CHUNK",
  "VERIFYING_HASH",
  "VERIFYING_FILE",
  "REPAIRING",
  "GPU_SELF_TESTING",
];

/** A model is usable/installed once it reaches one of these settled states. */
const INSTALLED_STATES: VlmState[] = [
  "INSTALLED_UNVERIFIED",
  "READY_GPU",
  "GPU_UNAVAILABLE",
];

export function isSettledState(state: VlmState): boolean {
  return !IN_PROGRESS_STATES.includes(state);
}

export function isInstalledState(state: VlmState): boolean {
  return INSTALLED_STATES.includes(state);
}

/**
 * Canonical transfer states: every active download/verify/repair step that is
 * non-downloadable. GPU_SELF_TESTING is inference, never a download state, so
 * it is deliberately excluded here (it stays in IN_PROGRESS_STATES only for
 * transfer sequencing).
 */
export const TRANSFER_ACTIVE_STATES: VlmState[] = [
  "QUEUED",
  "WAITING_FOR_NETWORK",
  "WAITING_FOR_WIFI",
  "DOWNLOADING",
  "PAUSING",
  "VERIFYING_CHUNK",
  "VERIFYING_HASH",
  "VERIFYING_FILE",
  "REPAIRING",
];

export function isTransferActive(state: VlmState): boolean {
  return TRANSFER_ACTIVE_STATES.includes(state);
}

/** Explicit per-state action availability; every VlmState is covered. */
export interface ModelActionAvailability {
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canRepair: boolean;
  canDownload: boolean;
  canDelete: boolean;
  canSelfTest: boolean;
  isTransferActive: boolean;
}

/**
 * One canonical helper shared by UI. Active transfer states never fall
 * through to Download; GPU_SELF_TESTING exposes no download actions.
 */
export function getModelAction(state: VlmState): ModelActionAvailability {
  switch (state) {
    case "QUEUED":
    case "DOWNLOADING":
      return { canPause: true, canResume: false, canCancel: true, canRepair: false, canDownload: false, canDelete: false, canSelfTest: false, isTransferActive: true };
    case "WAITING_FOR_NETWORK":
    case "WAITING_FOR_WIFI":
    case "PAUSING":
    case "VERIFYING_CHUNK":
    case "VERIFYING_HASH":
    case "VERIFYING_FILE":
    case "REPAIRING":
      return { canPause: false, canResume: false, canCancel: true, canRepair: false, canDownload: false, canDelete: false, canSelfTest: false, isTransferActive: true };
    case "PAUSED":
    case "PAUSED_ERROR":
    case "INSUFFICIENT_STORAGE":
    case "DOWNLOAD_FAILED":
      return { canPause: false, canResume: true, canCancel: true, canRepair: false, canDownload: false, canDelete: false, canSelfTest: false, isTransferActive: false };
    case "CORRUPT":
    case "REPAIR_NEEDED":
    case "MANIFEST_MISMATCH":
      return { canPause: false, canResume: false, canCancel: false, canRepair: true, canDownload: false, canDelete: false, canSelfTest: false, isTransferActive: false };
    case "NOT_INSTALLED":
      return { canPause: false, canResume: false, canCancel: false, canRepair: false, canDownload: true, canDelete: false, canSelfTest: false, isTransferActive: false };
    case "INSTALLED_UNVERIFIED":
    case "READY_GPU":
    case "GPU_UNAVAILABLE":
    case "RUNTIME_ERROR":
      return { canPause: false, canResume: false, canCancel: false, canRepair: false, canDownload: false, canDelete: true, canSelfTest: true, isTransferActive: false };
    case "GPU_SELF_TESTING":
      return { canPause: false, canResume: false, canCancel: false, canRepair: false, canDownload: false, canDelete: false, canSelfTest: false, isTransferActive: false };
  }
}

/** Options for awaiting a model's settled state. */
export interface WaitForSettledOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Analyze image request. */
export interface AnalyzeRequest {
  mode: BackendMode;
  imageUri: string;
  instruction: string;
  maxOutputTokens: number;
  temperature: number;
}

/** Analyze image result. */
export interface AnalyzeResult {
  text: string;
  modelId: VlmModelId;
  backend: string;
  runtime: string;
  diagnostics: string[];
}

/** Embed texts result. */
export interface EmbedTextsResult {
  vectors: number[][];
}

/** Wire result for native `generateText` (explicit-modelId text generation). */
export interface NativeGenerateTextResult {
  text: string;
  modelId: string;
  backend?: string;
  runtime?: string;
}

/** Wire result for native `runTextSelfTest` (readiness probe, real init plus a small generation). */
export interface TextSelfTestResult {
  modelId: string;
  ready: boolean;
  state: string;
  failure?: string;
  diagnostics: string[];
}

/**
 * Wire result for native `getTextRuntimeStatus` (diagnostics read only —
 * readiness, native activity, backend, model-file presence; never
 * initializes the runtime and never means lifecycle-installed).
 *
 * `installed` is lifecycle-validated (verified record + pinned file);
 * `modelFilePresent` is diagnostic file observation only and never implies
 * `installed`. `textReady` is observed TEXT_READY proof, never persisted.
 */
export interface NativeTextRuntimeStatus {
  modelId: string;
  ready: boolean;
  nativeRunning: boolean;
  backend: string;
  modelFilePresent: boolean;
  installed: boolean;
  textReady: boolean;
  residentModelId?: string | null;
}

/**
 * Maps a native text-runtime status read to assistant install/readiness
 * seams. Fail closed: a missing or unreadable status yields installed=false
 * and textReady=false, keeping the assistant on the grounded fallback.
 */
export function textSeamsFromStatus(
  status: NativeTextRuntimeStatus | null | undefined,
): { textInstalled: boolean; textReady: boolean } {
  if (status == null) return { textInstalled: false, textReady: false };
  return {
    textInstalled: status.installed === true,
    textReady: status.textReady === true,
  };
}

/** GPU self-test failure classification (mirrors native SelfTestFailure).
 * RUNTIME_ERROR and MODEL_MISSING/CANCELLED are accepted for the canonical
 * bridge taxonomy; legacy MODEL_RUNTIME_ERROR keeps working. */
export type GpuSelfTestFailure =
  | "INPUT_ERROR"
  | "MODEL_RUNTIME_ERROR"
  | "RUNTIME_ERROR"
  | "GENERATION_ERROR"
  | "MODEL_MISSING"
  | "CANCELLED";

/** GPU self-test result. */
export interface GpuSelfTestResult {
  state: GpuSelfTestState;
  error?: string;
  failure?: GpuSelfTestFailure;
}

/** Model error. */
export interface ModelError {
  code: VlmErrorCode;
  message: string;
}

/** Model file spec. */
export interface ModelFileSpec {
  path: string;
  expectedBytes: number;
  sha256: string;
}

/** Model manifest. */
export interface ModelManifest {
  id: string;
  sourceRepo: string;
  revision: string;
  files: ModelFileSpec[];
  runtime: string;
}

/** Installed file record. */
export interface InstalledFileRecord {
  path: string;
  expectedBytes: number;
  installedBytes: number;
  expectedSha256: string;
  installedSha256: string;
}

/** Model state record. */
export interface ModelStateRecord {
  modelId: VlmModelId;
  state: VlmState;
  files: InstalledFileRecord[];
  installedBytes: number;
  installTimestamp: number;
  runtimeVersion: string;
  appVersion: string;
  fingerprint: string;
  abi: string;
  gpuVendor: string | null;
  gpuRenderer: string | null;
  revision: string;
  sha256: string;
  lastGpuSelfTest: number | null;
  lastError: ModelError | null;
}

/** Native plugin interface (wrapped payloads). */
interface NativeVlmBridge {
  getCapabilities(): Promise<{ capabilities: VlmCapabilities }>;
  getSettings(): Promise<{ mode: BackendMode; allowCpuFallback?: boolean }>;
  setMode(options: { mode: BackendMode }): Promise<void>;
  setCpuFallback(options: { allowed: boolean }): Promise<void>;
  getModelStates(): Promise<{ models: VlmModelInfo[] }>;
  downloadModel(options: { modelId: VlmModelId; allowCellular?: boolean }): Promise<void>;
  pauseDownload(options: { modelId: VlmModelId }): Promise<void>;
  resumeDownload(options: { modelId: VlmModelId }): Promise<void>;
  repairModel(options: { modelId: VlmModelId }): Promise<void>;
  cancelDownload(options: { modelId: VlmModelId; removePartial?: boolean }): Promise<void>;
  deleteModel(options: { modelId: VlmModelId }): Promise<void>;
  embedTexts(options: { texts: string[] }): Promise<{ vectors: number[][] }>;
  runGpuSelfTest(options: { modelId: VlmModelId; imageUri?: string }): Promise<GpuSelfTestResult>;
  analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult>;
  generateText(options: { modelId: TextBridgeModelId; prompt: string; maxOutputTokens: number; temperature: number; traceId?: string }): Promise<NativeGenerateTextResult>;
  runTextSelfTest(options: { modelId: TextBridgeModelId }): Promise<TextSelfTestResult>;
  getTextRuntimeStatus(): Promise<NativeTextRuntimeStatus>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
  releaseWarmLease(): Promise<void>;
  importPackageFromUri(options: { entryId: string; sourceUri: string; expectedSha256: string }): Promise<NativePackageResult>;
  exportPackageToUri(options: { entryId: string; destUri: string }): Promise<NativeExportResult>;
  addListener<T extends InferenceStateEvent | DownloadProgressEvent | VlmModelInfo>(
    eventName: string,
    listener: (event: T) => void
  ): Promise<{ remove: () => void }>;
}

/** Observed package manifest resolved by the Android platform installer. */
export interface NativePackageResult {
  ok: boolean;
  manifest?: FbmodelManifest;
}

/** Observed export product resolved by the Android platform installer. */
export interface NativeExportResult {
  ok: boolean;
  manifest?: FbmodelManifest;
  checksumsJson?: string;
}

/** Narrow native surface the package-host adapter needs (subset of `NativeVlmBridge`). */
export interface NativePackageHostBridge {
  importPackageFromUri(options: { entryId: string; sourceUri: string; expectedSha256: string }): Promise<NativePackageResult>;
  exportPackageToUri(options: { entryId: string; destUri: string }): Promise<NativeExportResult>;
}

const PACKAGE_HOST_ERROR_CODES: readonly TransferErrorCode[] = [
  "NOT_INSTALLABLE", "NEEDS_ADVANCED_CONFIRM", "MISSING_PIN", "TRANSPORT_ERROR",
  "CANCELLED", "SIZE_MISMATCH", "HASH_MISMATCH", "WHOLE_HASH_MISMATCH",
  "MANIFEST_MISSING", "MANIFEST_INVALID", "ENTRY_MISMATCH", "MISSING_FILE",
  "EXTRA_FILE", "UNSAFE_PATH", "DENIED_FILE", "PACKAGE_TOO_LARGE",
  "MISSING_WEIGHTS", "NO_FILES", "INSUFFICIENT_STORAGE", "CORRUPT_ARCHIVE",
];

function packageHostFailure(error: unknown, fallbackReason: string): { code: TransferErrorCode; reason: string } {
  const message = error instanceof Error && error.message ? error.message : fallbackReason;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (PACKAGE_HOST_ERROR_CODES as readonly string[]).includes(code)) {
    return { code: code as TransferErrorCode, reason: message };
  }
  return { code: "CORRUPT_ARCHIVE", reason: message };
}

function isObservedManifest(value: unknown): value is FbmodelManifest {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as { entryId?: unknown; files?: unknown };
  return typeof manifest.entryId === "string" && Array.isArray(manifest.files);
}

/**
 * Adapts the Android platform installer (`LocalVlm` import/export bridge
 * methods) to the `NativePackageHost` seam consumed by the import/export
 * UI. Success carries the installer-observed manifest; rejections map to
 * the shared transfer failure codes (unknown errors fail closed as
 * `CORRUPT_ARCHIVE`). SAF document URIs still come from a document
 * picker — wiring that picker is a separate UI step.
 */
export function nativePackageHostFrom(native: NativePackageHostBridge): NativePackageHost {
  return {
    importPackageFromUri: async ({ entryId, sourceUri, expectedSha256 }): Promise<ImportResult> => {
      try {
        const result = await native.importPackageFromUri({ entryId, sourceUri, expectedSha256 });
        if (result?.ok === true && isObservedManifest(result.manifest)) {
          return { ok: true, manifest: result.manifest };
        }
        return {
          ok: false,
          code: "CORRUPT_ARCHIVE",
          reason: "The platform installer returned an unreadable import result. Nothing installed.",
        };
      } catch (error) {
        const failure = packageHostFailure(error, "The package file could not be read. Nothing installed.");
        return { ok: false, code: failure.code, reason: failure.reason };
      }
    },
    exportPackageToUri: async ({ entryId, destUri }): Promise<ExportStreamResult> => {
      try {
        const result = await native.exportPackageToUri({ entryId, destUri });
        if (result?.ok === true && isObservedManifest(result.manifest) && typeof result.checksumsJson === "string") {
          return { ok: true, manifest: result.manifest, checksumsJson: result.checksumsJson };
        }
        return {
          ok: false,
          code: "CORRUPT_ARCHIVE",
          reason: "The platform installer returned an unreadable export result. Nothing written.",
        };
      } catch (error) {
        const failure = packageHostFailure(error, "Export packaging runs in the platform installer and failed. Nothing written.");
        return { ok: false, code: failure.code, reason: failure.reason };
      }
    },
  };
}

/** Public bridge interface (unwrapped payloads). */
export interface VlmBridge {
  platform: "android" | "web";
  getCapabilities(): Promise<VlmCapabilities>;
  getSettings(): Promise<VlmSettings>;
  setMode(mode: BackendMode): Promise<void>;
  setCpuFallback(allowed: boolean): Promise<void>;
  /**
   * Notice from the most recent successful analyzeImage, or null. Set to the
   * CPU compatibility message when native ran on the CPU backend so the UI
   * can show it explicitly — fallback is never silent.
   */
  getLastBackendNotice(): string | null;
  getModelStates(): Promise<VlmModelInfo[]>;
  downloadModel(modelId: VlmModelId, options?: DownloadOptions): Promise<void>;
  waitForSettled(modelId: VlmModelId, options?: WaitForSettledOptions): Promise<VlmModelInfo>;
  pauseDownload(modelId: VlmModelId): Promise<void>;
  resumeDownload(modelId: VlmModelId): Promise<void>;
  repairModel(modelId: VlmModelId): Promise<void>;
  cancelDownload(modelId: VlmModelId, removePartial?: boolean): Promise<void>;
  deleteModel(modelId: VlmModelId): Promise<void>;
  embedTexts(texts: string[]): Promise<number[][]>;
  runGpuSelfTest(modelId: VlmModelId, imageUri?: string): Promise<GpuSelfTestResult>;
  analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult>;
  /**
   * Explicit-modelId text generation. Optional: present on Android, absent
   * on web (refusal by absence keeps the `isTextRuntimePresent` probe false
   * off-device). Unlike `analyzeImage` — where native picks by mode and
   * never takes a modelId — the requested model always travels with the
   * call: native rejects modelId-less calls, so the request carries a
   * required `modelId` and the bridge never substitutes another model.
   */
  generateText?(request: GenerateTextRequest): Promise<GenerateTextResult>;
  /** Readiness probe for the text runtime (real init plus a small generation). */
  runTextSelfTest?(modelId: TextBridgeModelId): Promise<TextSelfTestResult>;
  /** Diagnostics read for the text runtime (never initializes, never means installed). */
  getTextRuntimeStatus?(): Promise<NativeTextRuntimeStatus>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
  releaseWarmLease(): Promise<void>;
  onInferenceState(listener: (event: InferenceStateEvent) => void): Promise<() => void>;
  onDownloadProgress(listener: (event: DownloadProgressEvent) => void): Promise<() => void>;
  onModelStateChange(listener: (event: VlmModelInfo) => void): Promise<() => void>;
}

/** Production text surface: the VlmBridge text methods, all present together. */
export type TextCapableVlmBridge = VlmBridge &
  Required<Pick<VlmBridge, "generateText" | "runTextSelfTest" | "getTextRuntimeStatus">>;

/**
 * Narrows a bridge to the production text surface without casting. Null on
 * web (methods absent) or any native build without the text methods.
 */
export function isTextBridge(bridge: VlmBridge): bridge is TextCapableVlmBridge {
  return (
    bridge.generateText !== undefined &&
    bridge.runTextSelfTest !== undefined &&
    bridge.getTextRuntimeStatus !== undefined
  );
}

/** Web adapter that refuses local AI operations. The text methods stay absent
 * (refusal by absence) so the real-bridge probe stays false off-device. */
class WebVlmBridge implements VlmBridge {
  platform = "web" as const;
  gpuDelegateClassPresent = false;
  runtimeVersion = null;

  private refuse(_method: string): never {
    throw new Error(`Local AI is only available on Android.`);
  }

  async getCapabilities(): Promise<VlmCapabilities> {
    return {
      abi: "web",
      androidVersion: "web",
      apiLevel: 0,
      hardware: "web",
      deviceCategory: "web",
      gpuVendor: null,
      gpuRenderer: null,
      memoryClassMb: 0,
      freeAppStorageMb: 0,
      gpuDelegateClassPresent: false,
      runtimeVersion: null,
    };
  }

  async getSettings(): Promise<VlmSettings> {
    return { mode: "AUTO", allowCpuFallback: true };
  }

  async setMode(_mode: BackendMode): Promise<void> {
    this.refuse("setMode");
  }

  async setCpuFallback(_allowed: boolean): Promise<void> {
    this.refuse("setCpuFallback");
  }

  getLastBackendNotice(): string | null {
    return null;
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    return [];
  }

  async waitForSettled(_modelId: VlmModelId, _options?: WaitForSettledOptions): Promise<VlmModelInfo> {
    this.refuse("waitForSettled");
  }

  async downloadModel(_modelId: VlmModelId, _options?: DownloadOptions): Promise<void> {
    this.refuse("downloadModel");
  }

  async cancelDownload(_modelId: VlmModelId): Promise<void> {
    this.refuse("cancelDownload");
  }

  async pauseDownload(_modelId: VlmModelId): Promise<void> {
    this.refuse("pauseDownload");
  }

  async resumeDownload(_modelId: VlmModelId): Promise<void> {
    this.refuse("resumeDownload");
  }

  async repairModel(_modelId: VlmModelId): Promise<void> {
    this.refuse("repairModel");
  }

  async deleteModel(_modelId: VlmModelId): Promise<void> {
    this.refuse("deleteModel");
  }

  async embedTexts(_texts: string[]): Promise<number[][]> {
    this.refuse("embedTexts");
  }

  async runGpuSelfTest(_modelId: VlmModelId, _imageUri?: string): Promise<GpuSelfTestResult> {
    this.refuse("runGpuSelfTest");
  }

  async analyzeImage(_options: AnalyzeRequest): Promise<AnalyzeResult> {
    this.refuse("analyzeImage");
  }

  async cancelInference(): Promise<void> {
    this.refuse("cancelInference");
  }

  async release(): Promise<void> {
    this.refuse("release");
  }

  async releaseWarmLease(): Promise<void> {
    this.refuse("releaseWarmLease");
  }

  async onInferenceState(_listener: (event: InferenceStateEvent) => void): Promise<() => void> {
    return () => {};
  }

  async onDownloadProgress(_listener: (event: DownloadProgressEvent) => void): Promise<() => void> {
    return () => {};
  }

  async onModelStateChange(_listener: (event: VlmModelInfo) => void): Promise<() => void> {
    return () => {};
  }
}

/** Android adapter that unwraps native payloads. */
class AndroidVlmBridge implements VlmBridge {
  platform = "android" as const;
  private native: NativeVlmBridge;
  private lastBackendNotice: string | null = null;

  constructor(native: NativeVlmBridge) {
    this.native = native;
  }

  async getCapabilities(): Promise<VlmCapabilities> {
    const result = await this.native.getCapabilities();
    return result.capabilities;
  }

  async getSettings(): Promise<VlmSettings> {
    const result = await this.native.getSettings();
    return { mode: result.mode, allowCpuFallback: result.allowCpuFallback ?? true };
  }

  async setMode(mode: BackendMode): Promise<void> {
    await this.native.setMode({ mode });
  }

  async setCpuFallback(allowed: boolean): Promise<void> {
    await this.native.setCpuFallback({ allowed });
  }

  getLastBackendNotice(): string | null {
    return this.lastBackendNotice;
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    const result = await this.native.getModelStates();
    return result.models;
  }

  async downloadModel(modelId: VlmModelId, options?: DownloadOptions): Promise<void> {
    await this.native.downloadModel({ modelId, allowCellular: options?.allowCellular ?? false });
  }

  /**
   * Resolves once [modelId] leaves every in-progress state (or rejects on
   * timeout). Native scheduling resolves immediately when a job is merely
   * enqueued, so real sequencing must await the settled state, not the call.
   */
  async waitForSettled(modelId: VlmModelId, options?: WaitForSettledOptions): Promise<VlmModelInfo> {
    const timeoutMs = options?.timeoutMs ?? 6 * 60 * 60 * 1000;
    const intervalMs = options?.intervalMs ?? 1500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const states = await this.getModelStates();
      const info = states.find((m) => m.id === modelId);
      if (info && isSettledState(info.state)) return info;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${modelId} to settle`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async cancelDownload(modelId: VlmModelId, removePartial?: boolean): Promise<void> {
    await this.native.cancelDownload({ modelId, removePartial });
  }

  async pauseDownload(modelId: VlmModelId): Promise<void> {
    await this.native.pauseDownload({ modelId });
  }

  async resumeDownload(modelId: VlmModelId): Promise<void> {
    await this.native.resumeDownload({ modelId });
  }

  async repairModel(modelId: VlmModelId): Promise<void> {
    await this.native.repairModel({ modelId });
  }

  async deleteModel(modelId: VlmModelId): Promise<void> {
    await this.native.deleteModel({ modelId });
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const result = await this.native.embedTexts({ texts });
    return result.vectors;
  }

  async runGpuSelfTest(modelId: VlmModelId, imageUri?: string): Promise<GpuSelfTestResult> {
    if (imageUri?.startsWith("blob:")) throw new Error("blob: URIs cannot be sent to native");
    const result = await this.native.runGpuSelfTest({ modelId, imageUri });
    return result;
  }

  async analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult> {
    // Never send modelId to native; native picks based on mode
    const result = await this.native.analyzeImage(options);
    // Record an explicit compatibility notice when native ran on CPU so the
    // UI can display it. Cleared on every call: a GPU run leaves no notice.
    const cpuDiagnostic = (result.diagnostics ?? []).find((d) => /cpu compatibility mode/i.test(d)) ?? null;
    this.lastBackendNotice = result.backend === "cpu"
      ? (cpuDiagnostic ?? "GPU unavailable. Using CPU compatibility mode.")
      : null;
    return result;
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    // The requested model always travels with the call; native rejects
    // modelId-less calls and any id other than the qualified text model.
    const result = await this.native.generateText({
      modelId: request.modelId,
      prompt: request.prompt,
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
    });
    return { text: result.text, modelId: request.modelId };
  }

  async runTextSelfTest(modelId: TextBridgeModelId): Promise<TextSelfTestResult> {
    return this.native.runTextSelfTest({ modelId });
  }

  async getTextRuntimeStatus(): Promise<NativeTextRuntimeStatus> {
    return this.native.getTextRuntimeStatus();
  }

  async cancelInference(): Promise<void> {
    await this.native.cancelInference();
  }

  async release(): Promise<void> {
    await this.native.release();
  }

  async releaseWarmLease(): Promise<void> {
    await this.native.releaseWarmLease();
  }

  async onInferenceState(listener: (event: InferenceStateEvent) => void): Promise<() => void> {
    const { remove } = await this.native.addListener("inferenceState", listener);
    return remove;
  }

  async onDownloadProgress(listener: (event: DownloadProgressEvent) => void): Promise<() => void> {
    const { remove } = await this.native.addListener("downloadProgress", listener);
    return remove;
  }

  async onModelStateChange(listener: (event: VlmModelInfo) => void): Promise<() => void> {
    const { remove } = await this.native.addListener("modelStateChange", listener);
    return remove;
  }
}

let bridgeCache: VlmBridge | null = null;

/**
 * Get the VLM bridge instance. Returns a native bridge on Android,
 * or a web adapter that refuses local AI operations.
 */
export function getVlmBridge(): VlmBridge {
  if (bridgeCache) return bridgeCache;

  if (Capacitor.isNativePlatform()) {
    const native = registerPlugin<NativeVlmBridge>("LocalVlm");
    bridgeCache = new AndroidVlmBridge(native);
  } else {
    bridgeCache = new WebVlmBridge();
  }

  return bridgeCache;
}

/** Reset the bridge cache (for testing). */
export function resetVlmBridgeCache(): void {
  bridgeCache = null;
}
