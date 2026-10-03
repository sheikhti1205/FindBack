import { Capacitor } from "@capacitor/core";
import { bootProductionAi, type ProductionBoot } from "./production";
import { profileFor } from "./modelProfiles";
import { CapacitorNeedleBridge, createNativeNeedleEmbedder } from "./needle/native";
import { NEEDLE_MODEL_ID, type NativeNeedleEmbedder } from "./needle/embedder";
import { CapacitorSmolVlmBridge } from "./vision/native";
import { CapacitorModelDownloadDriver, runManagedDownload, removeManagedModel, type ModelDownloadDriver } from "./download/driver";
import { createOfflineAdapter, describeOfflineReadiness, type OfflineNativeBridge, type OfflineVisionNativeBridge } from "./providers/offline";
import type { AiTaskId } from "./types";
import type { RouteContext } from "./orchestrator/AiOrchestrator";
import { selectBackend } from "./automaticMode";
import { PROBE_VERSION, validateProbeRecord, type ProbeRecord } from "./deviceProbe";

/** Only redistributable, implemented product runtimes. Lab/LFM arms cannot enter this list. */
export const DOWNLOAD_MODELS = [
  { modelId: NEEDLE_MODEL_ID, label: "Needle · structured text / matching challenger", fileName: "needle3.cact", bytes: 35335380,
    url: "https://huggingface.co/Cactus-Compute/needle3/resolve/c7c415a3d1b3d929014bc6e866d51ebb971f7089/needle3.cact" },
  { modelId: "smolvlm2-500M-vision", label: "SmolVLM2 · image description", fileName: "SmolVLM2-500M.litertlm", bytes: 360822960,
    url: "https://huggingface.co/litert-community/SmolVLM2-500M/resolve/dad030b6e56756201d670cfb4d042736a2ce3a5c/SmolVLM2-500M.litertlm" },
] as const;
export const DEVICE_CORPUS_VERSION = "smol-color-plate-v1";
type NeedleBridge = Pick<CapacitorNeedleBridge, "bridgeName" | "isNeedleAvailable" | "embeddingDimension" | "loadModel" | "embedNeedleTexts" | "initTools" | "completeJson" | "unload">;
type SmolBridge = OfflineVisionNativeBridge & Partial<Pick<CapacitorSmolVlmBridge, "measureBackend" | "collectDeviceFacts">>;

export class ApplicationAiService {
  readonly boot: ProductionBoot;
  readonly ready: Promise<void>;
  readonly android: boolean;
  readonly probeContext = { modelRev: profileFor(DOWNLOAD_MODELS[1].modelId)!.revision, probeVersion: PROBE_VERSION, corpusVersion: DEVICE_CORPUS_VERSION };
  probeRecords: readonly ProbeRecord[] = [];
  private root = "";
  private embedder: NativeNeedleEmbedder | undefined;
  private loadingNeedle: Promise<void> | undefined;
  private active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private listeners = new Set<() => void>();
  private version = 0;
  private notices = new Map<string, string>();
  private operating = new Set<string>();
  private inferenceBusy = false;
  private driver?: ModelDownloadDriver;
  private needle?: NeedleBridge;
  private smol?: SmolBridge;
  private matching: "use" | "needle" = "use";
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  private changed() { this.version++; this.listeners.forEach((listener) => listener()); }
  get manager() { return this.boot.manager; }
  get matchingBackend() { return this.matching; }
  notice(modelId: string) { return this.notices.get(modelId) ?? null; }
  busy(modelId: string) { return this.operating.has(modelId); }

  constructor(options: { android: boolean; driver?: ModelDownloadDriver; needle?: NeedleBridge; smol?: SmolBridge }) {
    this.android = options.android;
    if (this.android) {
      this.driver = options.driver ?? new CapacitorModelDownloadDriver();
      this.needle = options.needle ?? new CapacitorNeedleBridge();
      this.smol = options.smol ?? new CapacitorSmolVlmBridge();
    }
    const dimension = () => this.embedder?.dimension ?? 0;
    this.boot = bootProductionAi({
      pins: DOWNLOAD_MODELS.map((model) => ({ modelId: model.modelId, sha256: profileFor(model.modelId)!.modelSha256, downloadBytes: model.bytes, minFreeRamMb: 1500 })),
      managerOptions: this.driver ? { storageProbe: this.driver, storageHeadroomBytes: 64 * 1024 * 1024 } : undefined,
      ...(this.needle ? {
        text: { modelId: NEEDLE_MODEL_ID, isReady: () => this.ensureNeedle(), completeJson: (input: string) => this.extractFields(input) },
        embedding: { modelId: NEEDLE_MODEL_ID, get dimension() { return dimension(); }, isReady: () => this.ensureNeedle(), embed: (texts: string[]) => this.embedder!.embedNeedleTexts(texts) },
      } : {}),
      ...(this.smol ? { vision: { modelId: DOWNLOAD_MODELS[1].modelId, isAvailable: () => this.ensureVision(), describe: async (prompt: string, imageBase64: string, signal: AbortSignal) => {
        let text = "";
        for await (const chunk of this.smol!.describeImage({ generationId: crypto.randomUUID(), prompt, imageBase64, maxOutputTokens: 256 }, signal)) text += chunk.textDelta;
        return text;
      } } } : {}),
    });
    this.manager.subscribe(() => this.changed());
    this.ready = this.reconcile().catch(() => {
      DOWNLOAD_MODELS.forEach((model) => this.notices.set(model.modelId, "Model storage could not be verified. Retry from AI & Models."));
      this.changed();
    });
  }

  private model(modelId: string) {
    const model = DOWNLOAD_MODELS.find((item) => item.modelId === modelId);
    if (!model) throw new Error("Unknown on-device model");
    return { ...model, revision: profileFor(modelId)!.revision };
  }
  private paths(modelId: string) {
    const model = this.model(modelId);
    return this.manager.stagingPathsFor(this.root, modelId, model.revision, model.fileName);
  }
  private async reconcile() {
    if (!this.driver) return;
    this.root = await this.driver.rootDir();
    for (const model of DOWNLOAD_MODELS) {
      const paths = this.paths(model.modelId);
      const actual = await this.driver.hashFile(paths.installedPath).catch(() => "");
      const matches = this.manager.checksumsMatch(profileFor(model.modelId)!.modelSha256, actual);
      if (matches) {
        this.manager.dispatch(model.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
        this.manager.dispatch(model.modelId, { type: "START" });
        this.manager.dispatch(model.modelId, { type: "VERIFY_START" });
        this.manager.dispatch(model.modelId, { type: "VERIFY_OK", actualSha256: actual });
      } else {
        const staged = await this.driver.stagedSize(paths.stagingPath);
        if (staged > 0) {
          this.manager.dispatch(model.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
          this.manager.dispatch(model.modelId, { type: "START" });
          this.manager.dispatch(model.modelId, { type: "PROGRESS", downloadedBytes: staged });
          this.manager.dispatch(model.modelId, { type: "CANCEL" });
        }
      }
    }
  }
  private requireAndroid() { if (!this.android || !this.driver) throw new Error("Offline AI is not available in this build. On-device AI requires Android."); }
  private requireInstalled(modelId: string) {
    if (!describeOfflineReadiness(this.manager, modelId).ready) throw new Error("Model is not installed and verified");
  }
  async download(modelId: string): Promise<void> {
    this.requireAndroid();
    await this.ready;
    if (this.active.has(modelId) || this.operating.has(modelId)) return;
    const model = this.model(modelId);
    const abort = new AbortController();
    const work = (async () => {
      const result = await runManagedDownload(this.manager, this.driver!, { ...model, maxBytes: model.bytes, userInitiated: true, signal: abort.signal });
      this.notices.set(modelId, result.ok ? "Installed and checksum verified." : result.reason);
    })().catch(() => { this.notices.set(modelId, "Download failed; retry to resume verified staging."); }).finally(() => {
      this.active.delete(modelId); this.changed();
    });
    this.active.set(modelId, { abort, work });
    this.changed();
    await work;
  }
  async pause(modelId: string) {
    const active = this.active.get(modelId);
    if (!active || this.manager.statusOf(modelId)?.download !== "downloading") return;
    active.abort.abort();
    await this.driver!.cancelDownload(this.paths(modelId).stagingPath);
    await active.work;
  }
  async remove(modelId: string) {
    this.requireAndroid(); await this.ready;
    if (this.inferenceBusy || this.operating.size > 0) throw new Error("On-device runtime is busy; stop inference before removing a model");
    this.operating.add(modelId); this.changed();
    try {
      await this.pause(modelId);
      const model = this.model(modelId);
      await removeManagedModel(this.manager, this.driver!, this.root, modelId, model.revision, model.fileName, {
        unload: modelId === NEEDLE_MODEL_ID ? async () => { await this.needle!.unload(); this.embedder = undefined; this.matching = "use"; } : () => this.smol!.unloadVisionModel(),
      });
      this.probeRecords = []; this.notices.delete(modelId);
    } finally { this.operating.delete(modelId); this.changed(); }
  }
  private async ensureNeedle(): Promise<boolean> {
    await this.ready; this.requireInstalled(NEEDLE_MODEL_ID);
    if (!this.needle) return false;
    if (!this.loadingNeedle) this.loadingNeedle = (async () => {
      if (!this.embedder || !(await this.needle!.isNeedleAvailable())) {
        await this.smol!.unloadVisionModel();
        this.embedder = await createNativeNeedleEmbedder(this.needle!, { installedPath: this.paths(NEEDLE_MODEL_ID).installedPath });
      }
    })().finally(() => { this.loadingNeedle = undefined; });
    await this.loadingNeedle; return true;
  }
  private async ensureVision(): Promise<boolean> {
    await this.ready; this.requireInstalled(DOWNLOAD_MODELS[1].modelId);
    if (!this.smol) return false;
    await this.needle!.unload(); this.embedder = undefined;
    const decision = selectBackend(this.probeRecords, this.probeContext);
    const backend = decision.kind === "use" && decision.backend === "gpu" ? "gpu" : "cpu";
    const args = { modelId: DOWNLOAD_MODELS[1].modelId, installedPath: this.paths(DOWNLOAD_MODELS[1].modelId).installedPath, maxOutputTokens: 256 };
    try { await this.smol.loadVisionModel({ ...args, backend }); }
    catch (error) {
      if (backend !== "gpu") throw error;
      this.probeRecords = this.probeRecords.filter((record) => record.backend !== "gpu");
      this.notices.set(args.modelId, "GPU initialization failed; retrying with CPU."); this.changed();
      await this.smol.unloadVisionModel();
      await this.smol.loadVisionModel({ ...args, backend: "cpu" });
    }
    return this.smol.isVisionAvailable();
  }
  private async extractFields(input: string): Promise<string> {
    await this.needle!.initTools("Extract only supplied item details.", JSON.stringify([{ name: "record_item", description: "Record item details", parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, locationNote: { type: "string" } }, required: ["title"] } }]));
    const raw: unknown = JSON.parse(await this.needle!.completeJson(input));
    const calls = (raw as { function_calls?: { name?: string; arguments?: unknown }[] }).function_calls;
    const fields = calls?.find((call) => call.name === "record_item")?.arguments;
    if (!fields || typeof fields !== "object") throw new Error("Needle did not produce a confident item record");
    return JSON.stringify({ fields });
  }
  async route(taskId: AiTaskId, input: unknown, context: RouteContext) {
    await this.ready;
    if (this.inferenceBusy || this.operating.size > 0) throw new Error("On-device runtime is busy");
    this.inferenceBusy = true;
    try { return await this.boot.orchestrator.route(taskId, input, context); }
    finally { this.inferenceBusy = false; }
  }
  async embedNeedle(texts: string[]) {
    this.requireAndroid(); await this.ready; this.requireInstalled(NEEDLE_MODEL_ID);
    const result = await this.route("embed-texts", { texts }, { traceId: crypto.randomUUID() });
    if (!result.ok) throw new Error(result.error);
    return (result.value as { vectors: number[][] }).vectors;
  }
  selectMatchingBackend(backend: "use" | "needle") {
    if (backend === "needle") { this.requireAndroid(); this.requireInstalled(NEEDLE_MODEL_ID); }
    this.matching = backend; this.changed();
  }
  offlineAdapter(resolveApprovedImage?: (id: string) => Promise<string>) {
    this.requireAndroid();
    const generate: OfflineNativeBridge["generate"] = (prompt, signal) => this.generateOffline(prompt.currentText, signal);
    const bridge: OfflineNativeBridge = {
      bridgeName: "needle-cact", isAvailable: () => this.android,
      load: async (id) => { if (id !== NEEDLE_MODEL_ID) throw new Error("This model requires an approved image"); await this.ensureNeedle(); },
      unload: () => this.needle!.unload(),
      generate,
    };
    const visionBridge: OfflineVisionNativeBridge = {
      bridgeName: this.smol!.bridgeName,
      isVisionAvailable: () => this.ensureVision(),
      loadVisionModel: async () => {}, // ensureVision above loads the exact verified path/backend.
      unloadVisionModel: () => this.smol!.unloadVisionModel(),
      cancelGeneration: (id) => this.smol!.cancelGeneration(id),
      describeImage: (request, signal) => this.describeOfflineImage(request, signal),
    };
    const adapter = createOfflineAdapter({ manager: this.manager, bridge, visionBridge, resolveApprovedImage });
    return {
      ...adapter,
      listModels: async () => { await this.ready; return adapter.listModels!(); },
      complete: (request: Parameters<typeof adapter.complete>[0]) => this.completeOffline(adapter, request),
    };
  }
  private async *describeOfflineImage(request: import("./providers/offline").OfflineVisionRequest, signal: AbortSignal) {
    const notice = this.notice(DOWNLOAD_MODELS[1].modelId);
    if (notice?.startsWith("GPU initialization failed")) yield { textDelta: `${notice}\n\n` };
    yield* this.smol!.describeImage(request, signal);
  }
  private async *generateOffline(text: string, signal: AbortSignal) {
    if (signal.aborted) return;
    const result = await this.boot.orchestrator.route("extract-report-fields", { text }, { traceId: crypto.randomUUID() });
    if (signal.aborted) return;
    if (!result.ok) throw new Error(result.error);
    yield { textDelta: JSON.stringify(result.value) };
  }
  private async *completeOffline(adapter: import("./providerContract").ProviderAdapter, request: import("./providerContract").NormalizedRequest) {
    await this.ready;
    if (this.inferenceBusy || this.operating.size > 0) throw new Error("On-device runtime is busy");
    this.inferenceBusy = true;
    try { yield* adapter.complete(request); }
    finally { this.inferenceBusy = false; }
  }
  async measure(backend: "cpu" | "gpu") {
    this.requireAndroid(); await this.ready; this.requireInstalled(DOWNLOAD_MODELS[1].modelId);
    if (this.inferenceBusy || this.operating.size > 0) throw new Error("On-device runtime is busy; stop inference before measuring");
    this.inferenceBusy = true;
    try {
      await this.needle!.unload(); this.embedder = undefined;
      await this.smol!.unloadVisionModel();
      const record = await this.smol!.measureBackend?.({ modelId: DOWNLOAD_MODELS[1].modelId, modelRev: this.probeContext.modelRev, installedPath: this.paths(DOWNLOAD_MODELS[1].modelId).installedPath, backend, corpusVersion: DEVICE_CORPUS_VERSION });
      if (!record || validateProbeRecord(record).length > 0 || record.backend !== backend || record.modelRev !== this.probeContext.modelRev || record.corpusVersion !== DEVICE_CORPUS_VERSION) throw new Error("No valid timing sample; device evidence is still required");
      this.probeRecords = [...this.probeRecords.filter((item) => item.backend !== backend), record];
      this.changed(); return record;
    } finally { this.inferenceBusy = false; }
  }
  async facts() { this.requireAndroid(); return this.smol!.collectDeviceFacts?.(); }
}

let applicationAi: ApplicationAiService | undefined;
/** Application lifetime singleton; tests of platform behavior use the same class with fakes. */
export function getApplicationAi(): ApplicationAiService {
  return applicationAi ??= new ApplicationAiService({ android: Capacitor.isNativePlatform() && Capacitor.getPlatform?.() === "android" });
}
export function initializeApplicationAi(): Promise<void> { return getApplicationAi().ready; }
