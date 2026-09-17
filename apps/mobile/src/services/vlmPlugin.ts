import { Capacitor, registerPlugin } from "@capacitor/core";

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

/** GPU self-test state. */
export type GpuSelfTestState =
  | "GPU_AVAILABLE"
  | "GPU_UNAVAILABLE"
  | "GPU_UNSUPPORTED"
  | "ERROR";

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
  gpuRuntimePresent: boolean;
  runtimeVersion: string | null;
}

/** Model state info. */
export interface VlmModelInfo {
  id: VlmModelId;
  state: VlmState;
  sizeBytes?: number;
  error?: string;
}

/** Settings. */
export interface VlmSettings {
  mode: BackendMode;
  wifiOnly?: boolean;
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

/** GPU self-test result. */
export interface GpuSelfTestResult {
  state: GpuSelfTestState;
  error?: string;
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
  getSettings(): Promise<{ mode: BackendMode }>;
  setMode(options: { mode: BackendMode }): Promise<void>;
  getModelStates(): Promise<{ models: VlmModelInfo[] }>;
  downloadModel(options: { modelId: VlmModelId; allowCellular?: boolean }): Promise<void>;
  pauseDownload(options: { modelId: VlmModelId }): Promise<void>;
  resumeDownload(options: { modelId: VlmModelId }): Promise<void>;
  repairModel(options: { modelId: VlmModelId }): Promise<void>;
  cancelDownload(options: { modelId: VlmModelId; removePartial?: boolean }): Promise<void>;
  deleteModel(options: { modelId: VlmModelId }): Promise<void>;
  embedTexts(options: { texts: string[] }): Promise<{ vectors: number[][] }>;
  runGpuSelfTest(options: { modelId: VlmModelId; imageUri?: string }): Promise<{ state: GpuSelfTestState }>;
  analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
  releaseWarmLease(): Promise<void>;
  addListener<T extends InferenceStateEvent | DownloadProgressEvent | VlmModelInfo>(
    eventName: string,
    listener: (event: T) => void
  ): Promise<{ remove: () => void }>;
}

/** Public bridge interface (unwrapped payloads). */
export interface VlmBridge {
  platform: "android" | "web";
  getCapabilities(): Promise<VlmCapabilities>;
  getSettings(): Promise<VlmSettings>;
  setMode(mode: BackendMode): Promise<void>;
  getModelStates(): Promise<VlmModelInfo[]>;
  downloadModel(modelId: VlmModelId, options?: DownloadOptions): Promise<void>;
  pauseDownload(modelId: VlmModelId): Promise<void>;
  resumeDownload(modelId: VlmModelId): Promise<void>;
  repairModel(modelId: VlmModelId): Promise<void>;
  cancelDownload(modelId: VlmModelId, removePartial?: boolean): Promise<void>;
  deleteModel(modelId: VlmModelId): Promise<void>;
  embedTexts(texts: string[]): Promise<number[][]>;
  runGpuSelfTest(modelId: VlmModelId, imageUri?: string): Promise<GpuSelfTestState>;
  analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
  releaseWarmLease(): Promise<void>;
  onInferenceState(listener: (event: InferenceStateEvent) => void): Promise<() => void>;
  onDownloadProgress(listener: (event: DownloadProgressEvent) => void): Promise<() => void>;
  onModelStateChange(listener: (event: VlmModelInfo) => void): Promise<() => void>;
}

/** Web adapter that refuses local AI operations. */
class WebVlmBridge implements VlmBridge {
  platform = "web" as const;
  gpuRuntimePresent = false;
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
      gpuRuntimePresent: false,
      runtimeVersion: null,
    };
  }

  async getSettings(): Promise<VlmSettings> {
    return { mode: "AUTO" };
  }

  async setMode(_mode: BackendMode): Promise<void> {
    this.refuse("setMode");
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    return [];
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

  async runGpuSelfTest(_modelId: VlmModelId, _imageUri?: string): Promise<GpuSelfTestState> {
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

  constructor(native: NativeVlmBridge) {
    this.native = native;
  }

  async getCapabilities(): Promise<VlmCapabilities> {
    const result = await this.native.getCapabilities();
    return result.capabilities;
  }

  async getSettings(): Promise<VlmSettings> {
    const result = await this.native.getSettings();
    return { mode: result.mode };
  }

  async setMode(mode: BackendMode): Promise<void> {
    await this.native.setMode({ mode });
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    const result = await this.native.getModelStates();
    return result.models;
  }

  async downloadModel(modelId: VlmModelId, options?: DownloadOptions): Promise<void> {
    await this.native.downloadModel({ modelId, allowCellular: options?.allowCellular ?? false });
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

  async runGpuSelfTest(modelId: VlmModelId, imageUri?: string): Promise<GpuSelfTestState> {
    if (imageUri?.startsWith("blob:")) throw new Error("blob: URIs cannot be sent to native");
    const result = await this.native.runGpuSelfTest({ modelId, imageUri });
    return result.state;
  }

  async analyzeImage(options: AnalyzeRequest): Promise<AnalyzeResult> {
    // Never send modelId to native; native picks based on mode
    return this.native.analyzeImage(options);
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
