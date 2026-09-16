import { Capacitor, registerPlugin } from "@capacitor/core";

/** VLM model identifiers. */
export type VlmModelId =
  | "smolvlm-256m"
  | "smolvlm2-500m"
  | "smolvlm2-2b"
  | "gemma-3n-2b"
  | "gemma-3n-4b";

/** VLM inference mode. */
export type VlmMode = "AUTO" | "QUALITY" | "SPEED";

/** VLM backend type. */
export type VlmBackend = "cpu" | "gpu";

/** Model state. */
export type VlmModelState =
  | "NOT_DOWNLOADED"
  | "DOWNLOADING"
  | "READY_CPU"
  | "READY_GPU"
  | "ERROR";

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
  state: VlmModelState;
  sizeBytes?: number;
  error?: string;
}

/** Settings. */
export interface VlmSettings {
  mode: VlmMode;
}

/** Inference state event. */
export interface InferenceStateEvent {
  modelId: VlmModelId;
  state: VlmModelState;
  progress?: number;
  error?: string;
}

/** Download progress event. */
export interface DownloadProgressEvent {
  modelId: VlmModelId;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
}

/** Analyze image result. */
export interface AnalyzeImageResult {
  text: string;
  modelId: VlmModelId;
  backend: VlmBackend;
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

/** Native plugin interface (wrapped payloads). */
interface NativeVlmBridge {
  getCapabilities(): Promise<{ capabilities: VlmCapabilities }>;
  getSettings(): Promise<{ mode: VlmMode }>;
  setMode(options: { mode: VlmMode }): Promise<void>;
  getModelStates(): Promise<{ models: VlmModelInfo[] }>;
  downloadModel(options: { modelId: VlmModelId }): Promise<void>;
  cancelDownload(options: { modelId: VlmModelId }): Promise<void>;
  deleteModel(options: { modelId: VlmModelId }): Promise<void>;
  embedTexts(options: { texts: string[] }): Promise<{ vectors: number[][] }>;
  runGpuSelfTest(options: { modelId: VlmModelId }): Promise<{ state: GpuSelfTestState }>;
  analyzeImage(options: {
    mode: VlmMode;
    imageUri: string;
    instruction: string;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<AnalyzeImageResult>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
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
  setMode(mode: VlmMode): Promise<void>;
  getModelStates(): Promise<VlmModelInfo[]>;
  downloadModel(modelId: VlmModelId): Promise<void>;
  cancelDownload(modelId: VlmModelId): Promise<void>;
  deleteModel(modelId: VlmModelId): Promise<void>;
  embedTexts(texts: string[]): Promise<number[][]>;
  runGpuSelfTest(modelId: VlmModelId): Promise<GpuSelfTestState>;
  analyzeImage(options: {
    mode: VlmMode;
    imageUri: string;
    instruction: string;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<AnalyzeImageResult>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
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

  async setMode(_mode: VlmMode): Promise<void> {
    this.refuse("setMode");
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    return [];
  }

  async downloadModel(_modelId: VlmModelId): Promise<void> {
    this.refuse("downloadModel");
  }

  async cancelDownload(_modelId: VlmModelId): Promise<void> {
    this.refuse("cancelDownload");
  }

  async deleteModel(_modelId: VlmModelId): Promise<void> {
    this.refuse("deleteModel");
  }

  async embedTexts(_texts: string[]): Promise<number[][]> {
    this.refuse("embedTexts");
  }

  async runGpuSelfTest(_modelId: VlmModelId): Promise<GpuSelfTestState> {
    this.refuse("runGpuSelfTest");
  }

  async analyzeImage(_options: {
    mode: VlmMode;
    imageUri: string;
    instruction: string;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<AnalyzeImageResult> {
    this.refuse("analyzeImage");
  }

  async cancelInference(): Promise<void> {
    this.refuse("cancelInference");
  }

  async release(): Promise<void> {
    this.refuse("release");
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

  async setMode(mode: VlmMode): Promise<void> {
    await this.native.setMode({ mode });
  }

  async getModelStates(): Promise<VlmModelInfo[]> {
    const result = await this.native.getModelStates();
    return result.models;
  }

  async downloadModel(modelId: VlmModelId): Promise<void> {
    await this.native.downloadModel({ modelId });
  }

  async cancelDownload(modelId: VlmModelId): Promise<void> {
    await this.native.cancelDownload({ modelId });
  }

  async deleteModel(modelId: VlmModelId): Promise<void> {
    await this.native.deleteModel({ modelId });
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const result = await this.native.embedTexts({ texts });
    return result.vectors;
  }

  async runGpuSelfTest(modelId: VlmModelId): Promise<GpuSelfTestState> {
    const result = await this.native.runGpuSelfTest({ modelId });
    return result.state;
  }

  async analyzeImage(options: {
    mode: VlmMode;
    imageUri: string;
    instruction: string;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<AnalyzeImageResult> {
    // Never send modelId to native; native picks based on mode
    return this.native.analyzeImage(options);
  }

  async cancelInference(): Promise<void> {
    await this.native.cancelInference();
  }

  async release(): Promise<void> {
    await this.native.release();
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