import { Capacitor } from "@capacitor/core";
import { bootProductionAi, type ProductionBoot } from "./production";
import { ITEM_CATEGORIES } from "./ops/classifyCategory";
import { CapacitorNeedleBridge, createNativeNeedleEmbedder } from "./needle/native";
import { NEEDLE_MODEL_ID, type NativeNeedleEmbedder } from "./needle/embedder";
import { CapacitorSmolVlmBridge } from "./vision/native";
import {
  CapacitorQwenTextBridge,
  QWEN_SESSION_MIN_TOKENS,
  QWEN_TEXT_BRIDGE_NAME,
  createEnvelopeStreamingFilter,
  stripThoughtEnvelope,
  type QwenTextNativeBridge,
} from "./text/litertLmText";
import { profileFor } from "./modelProfiles";
import { CapacitorModelDownloadDriver, runManagedDownload, removeManagedModel, type ModelDownloadDriver } from "./download/driver";
import { createOfflineAdapter, describeOfflineReadiness, type OfflineNativeBridge, type OfflineVisionNativeBridge } from "./providers/offline";
import type { AiTaskId } from "./types";
import type { RouteContext } from "./orchestrator/AiOrchestrator";
import type { ProductionTextCompletion } from "./orchestrator/productionRuntimes";
import { createModelRegistry, NEEDLE_RUNTIME_ID, productionModelRegistry, SMOL_VLM_RUNTIME_ID, QWEN_TEXT_MODEL_ID, QWEN_TEXT_RUNTIME_ID, LLAMA_CPP_RUNTIME_ID, distributionPolicyOf, modelSupportsAbi, type ModelDescriptor, type ModelRegistry, type ModelRegistryOptions } from "./modelDescriptors";
import { ResidencyCoordinator, ResidencyBusyError } from "./residencyCoordinator";
import { selectBackend } from "./automaticMode";
import { PROBE_VERSION, validateProbeRecord, type ProbeRecord } from "./deviceProbe";
import { CapacitorLlamaBridge, type LlamaNativeBridge } from "./llama/adapter";
import { acquisitionArtifacts, acquisitionBytes, sourcesFor, validateArtifactMirrors, type ArtifactMirrors } from "./modelSupply";
import { runManagedBundle } from "./download/bundle";
import { importedDescriptor, parseImportedCatalogue, validateImportSpec, type ImportSpec } from "./download/import";
import { journalPathFor } from "./download/journal";

/** Map a descriptor runtimeId to the coordinator's residency owner. */
function ownerForRuntime(runtimeId: string): "needle" | "smol-vision" | "qwen-text" | "llama" | "none" {
  if (runtimeId === NEEDLE_RUNTIME_ID) return "needle";
  if (runtimeId === SMOL_VLM_RUNTIME_ID) return "smol-vision";
  if (runtimeId === QWEN_TEXT_RUNTIME_ID) return "qwen-text";
  if (runtimeId === LLAMA_CPP_RUNTIME_ID) return "llama";
  return "none";
}
/**
 * Consumer download catalogue, derived from the canonical descriptor
 * registry (Step 2) — never edited by hand, never indexed by position in
 * production logic. `label` mirrors the descriptor display name.
 */
export const DOWNLOAD_MODELS = productionModelRegistry().catalogue().map((descriptor) => ({
  modelId: descriptor.modelId,
  label: descriptor.displayName,
  fileName: descriptor.fileName,
  bytes: descriptor.bytes,
  url: descriptor.url,
}));
export const DEVICE_CORPUS_VERSION = "smol-color-plate-v1";
/** Consumer copy for a device the catalogue does not support. */
export const DEVICE_INCOMPATIBLE_REASON = "Unavailable on this device.";
/**
 * Audit closure: sign-out never waits longer than this for native
 * settlement before finishing. The reset barrier (not the wait) owns
 * safety — an expired wait defers engine unload, never forces it.
 */
export const RESET_SIGNOUT_WAIT_MS = 10_000;

interface StructuredToolSchema {
  readonly type: string;
  readonly properties: Record<string, { readonly type: string; readonly description?: string; readonly enum?: readonly string[] }>;
  readonly required: readonly string[];
}

interface StructuredStrategy {
  readonly toolName: string;
  readonly system: string;
  readonly toolDescription: string;
  readonly schema: StructuredToolSchema;
}

/**
 * Audit closure: one real native tool schema per advertised structured
 * task. The record_item schema only satisfies report extraction — search
 * filters (query/category/status/dateRangeText) and category
 * classification (category/confidence) each need their own tool, or the
 * advertised roles are false capabilities. A task without a strategy
 * fails closed here instead of borrowing another task's schema.
 *
 * Phase A.4 (Needle contract): Needle is a tool model, not a chat LLM —
 * it receives the raw user request (see GenerateOptions.localTaskInput)
 * and selects/fills its one declared tool from what the user said. The
 * `system` strings below are environment facts, never model-steering
 * instructions; the tool descriptions name the actual extraction action.
 * Required stays empty for extraction (a required value with no grounding
 * withholds the whole record instead of guessing — partial extraction is
 * the app contract, enforced by validateReportSlots downstream). Category
 * binds the canonical ITEM_CATEGORIES enum; engine confidence arrives as
 * the top-level Needle score, never as a tool argument.
 */
const STRUCTURED_STRATEGIES: Readonly<Record<string, StructuredStrategy>> = {
  "extract-report-fields": {
    toolName: "record_item",
    system: "Lost-and-found item report details.",
    toolDescription: "Extract details explicitly stated about a lost or found item.",
    schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short item title as stated by the user" },
        description: { type: "string", description: "Longer item description as stated by the user" },
        category: { type: "string", description: "Item category as stated by the user" },
        dateText: { type: "string", description: "When the item was lost or found, as stated by the user" },
        locationNote: { type: "string", description: "Where the item was lost or found, as stated by the user" },
      },
      required: [],
    },
  },
  "extract-search-filters": {
    toolName: "search_filters",
    system: "Lost-and-found search request.",
    toolDescription: "Extract lost-and-found search terms and filters explicitly stated by the user.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms as stated by the user" },
        category: { type: "string", description: "Item category filter as stated by the user" },
        status: { type: "string", description: "Report status filter as stated by the user (open, matched, recovered, closed)" },
        // The LOST/FOUND type has its own slot: the status enum has no "lost",
        // so a type that arrives in `status` is a type the reader can never
        // filter by.
        postType: { type: "string", description: "Whether the reader lost the item or found it", enum: ["LOST", "FOUND"] },
        // A place NAME. Never coordinates — the client has no geo filter and
        // must never be handed one.
        place: { type: "string", description: "Place name as stated by the user (a name, never coordinates)" },
        dateRangeText: { type: "string", description: "Date range filter as stated by the user" },
      },
      required: [],
    },
  },
  "classify-category": {
    toolName: "item_category",
    system: "Lost-and-found item description for classification.",
    toolDescription: "Classify the described lost-or-found item into one FindBack category.",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The single FindBack category for the described item", enum: ITEM_CATEGORIES },
      },
      required: ["category"],
    },
  },
};

export interface DeviceCompatibility {
  readonly compatible: boolean;
  readonly reason?: string;
}

/**
 * Audit closure: the real device-eligibility contract. A model is
 * downloadable/runnable only when Android runs, the device's ABI set
 * intersects the descriptor's verified ABIs, the required native
 * runtime/plugin exists in this build, and the artifact/runtime format
 * pair is supported. Unknown ABIs and unknown formats never count.
 * Runtime resolution is descriptor-first (Qwen text needs the LiteRT-LM
 * text bridge, Smol vision needs the vision bridge) with a format
 * fallback for test/custom descriptors. UI disabling is presentation
 * only — `download()` enforces this independently, and it is also
 * re-checked at run time.
 */
export function compatibilityOf(
  descriptor: ModelDescriptor,
  deviceAbis: readonly string[],
  bridges: { readonly needle: boolean; readonly smol: boolean; readonly qwenText?: boolean; readonly llama?: boolean },
): DeviceCompatibility {
  const abiOk = deviceAbis.some((abi) => modelSupportsAbi(descriptor, abi));
  if (!abiOk) return { compatible: false, reason: DEVICE_INCOMPATIBLE_REASON };
  let runtimeOk: boolean;
  switch (descriptor.runtimeId) {
    case NEEDLE_RUNTIME_ID:
      runtimeOk = bridges.needle;
      break;
    case SMOL_VLM_RUNTIME_ID:
      runtimeOk = bridges.smol;
      break;
    case QWEN_TEXT_RUNTIME_ID:
      runtimeOk = bridges.qwenText === true;
      break;
    case LLAMA_CPP_RUNTIME_ID:
      runtimeOk = bridges.llama === true;
      break;
    default:
      runtimeOk =
        (descriptor.format === "cact" && bridges.needle) ||
        (descriptor.format === "litertlm" && (bridges.smol || bridges.qwenText === true)) ||
        (descriptor.format === "gguf" && bridges.llama === true);
      break;
  }
  if (!runtimeOk) return { compatible: false, reason: DEVICE_INCOMPATIBLE_REASON };
  return { compatible: true };
}
type NeedleBridge = Pick<CapacitorNeedleBridge, "bridgeName" | "isNeedleAvailable" | "embeddingDimension" | "loadModel" | "embedNeedleTexts" | "initTools" | "completeJson" | "unload">;
type SmolBridge = OfflineVisionNativeBridge & Partial<Pick<CapacitorSmolVlmBridge, "measureBackend" | "collectDeviceFacts">>;
/**
 * W-A LiteRT-LM text seam (Qwen). The structural shape mirrors the Smol
 * vision bridge; the native `FindbackQwenText` plugin behind it is the W-B
 * lane. Absent on builds without the plugin — every Qwen path fails
 * closed then, never half-wired.
 */
export type QwenTextBridge = QwenTextNativeBridge;

export class ApplicationAiService {
  readonly boot: ProductionBoot;
  readonly ready: Promise<void>;
  readonly android: boolean;
  /** Phase A (Step 2): the descriptor authority behind every model decision. */
  private readonly baseRegistry: ModelRegistry;
  private imported: ModelDescriptor[] = [];
  get registry(): ModelRegistry { return createModelRegistry([...this.baseRegistry.descriptors, ...this.imported], { defaultVisionModelId: this.baseRegistry.visionDescriptor()?.modelId }); }
  readonly probeContext: { modelRev: string; probeVersion: number; corpusVersion: string };
  probeRecords: readonly ProbeRecord[] = [];
  private root = "";
  private embedder: NativeNeedleEmbedder | undefined;
  private loadingNeedle: Promise<void> | undefined;
  private loadingQwenText: Promise<void> | undefined;
  /** True while the Qwen resident is loaded (mirrors `embedder` for Needle). */
  private qwenResident = false;
  /**
   * Generation epoch guard: incremented on every Qwen resident switch and
   * unload. Streaming/collection loops capture the epoch and drop late
   * chunks once it moves, so a switched-away generation can never mutate
   * the new session.
   */
  private textEpoch = 0;
  private active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private listeners = new Set<() => void>();
  private version = 0;
  private notices = new Map<string, string>();
  private operating = new Set<string>();
  /**
   * Models with a download REQUEST in flight that has not registered its
   * transfer yet. The device registers a transfer a tick after the click, so
   * this is the window in which a second tap could start a second transfer.
   */
  private claiming = new Set<string>();
  /** Cached device ABI set (from native facts); undefined until first read. */
  private deviceAbiCache: readonly string[] | undefined;
  /** Per-model compatibility snapshot for the UI; refreshed by ensureCompatibility. */
  private compatCache = new Map<string, DeviceCompatibility>();
  /** Phase A (Step 8): the single authority for residency, operations, and inference flights. */
  private readonly coordinator = new ResidencyCoordinator();
  private driver?: ModelDownloadDriver;
  private needle?: NeedleBridge;
  private smol?: SmolBridge;
  private qwenText?: QwenTextBridge;
  private llama?: LlamaNativeBridge;
  private matching: "use" | "needle" = "use";
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly snapshot = () => this.version;
  private changed() { this.version++; this.listeners.forEach((listener) => listener()); }
  get manager() { return this.boot.manager; }
  get matchingBackend() { return this.matching; }
  /** Residency/operation snapshot for diagnostics (owner, exclusive claim, flights). */
  get residency() { return this.coordinator.snapshot(); }
  notice(modelId: string) { return this.notices.get(modelId) ?? null; }
  busy(modelId: string) { return this.operating.has(modelId) || this.claiming.has(modelId); }

  constructor(options: { android: boolean; driver?: ModelDownloadDriver; needle?: NeedleBridge; smol?: SmolBridge; qwenText?: QwenTextBridge; llama?: LlamaNativeBridge; descriptors?: readonly ModelDescriptor[]; defaultVisionModelId?: string }) {
    this.android = options.android;
    this.baseRegistry = options.descriptors
      ? createModelRegistry(options.descriptors, { defaultVisionModelId: options.defaultVisionModelId } satisfies ModelRegistryOptions)
      : productionModelRegistry();
    const vision = this.registry.visionDescriptor();
    this.probeContext = { modelRev: vision?.revision ?? "", probeVersion: PROBE_VERSION, corpusVersion: DEVICE_CORPUS_VERSION };
    if (this.android) {
      this.driver = options.driver ?? new CapacitorModelDownloadDriver();
      this.needle = options.needle ?? new CapacitorNeedleBridge();
      this.smol = options.smol ?? new CapacitorSmolVlmBridge();
      this.qwenText = options.qwenText ?? new CapacitorQwenTextBridge();
      this.llama = options.llama ?? new CapacitorLlamaBridge();
    } else {
      this.qwenText = options.qwenText;
    }
    const dimension = () => this.embedder?.dimension ?? 0;
    // Seam roles come from the same descriptor registry that owns pins and
    // ABIs: a model serves a task only when its descriptor permits the role.
    const needleRoles = this.registry.descriptorFor(NEEDLE_MODEL_ID)?.taskRoles ?? [];
    const qwenRoles = this.registry.descriptorFor(QWEN_TEXT_MODEL_ID)?.taskRoles ?? [];
    const textRoles = [...new Set([...needleRoles, ...qwenRoles])];
    const hasTextEngine = this.needle !== undefined || this.qwenText !== undefined;
    this.boot = bootProductionAi({
      pins: this.registry.descriptors.map((model) => ({ modelId: model.modelId, sha256: model.sha256, downloadBytes: model.bytes, minFreeRamMb: model.minRamMb })),
      managerOptions: this.driver ? { storageProbe: this.driver, storageHeadroomBytes: 64 * 1024 * 1024 } : undefined,
      ...(hasTextEngine ? {
        text: {
          modelId: QWEN_TEXT_MODEL_ID,
          modelIds: [QWEN_TEXT_MODEL_ID, NEEDLE_MODEL_ID],
          runtimeId: QWEN_TEXT_RUNTIME_ID,
          taskRoles: textRoles,
          isReady: () => this.ensureAnyText(),
          // Prose tasks use the qualified LiteRT-LM text resident. A tool
          // model is never a substitute for an uninstalled prose model.
          completeText: (input: string, signal?: AbortSignal) => this.completeProseText(input, signal),
          // Tool-constrained completion returning the slot envelope string
          // (tasks with JSON contracts). Needle is the proven tool model:
          // each advertised structured task installs its OWN tool schema
          // (see STRUCTURED_STRATEGIES) — never one generic schema borrowed
          // across tasks.
          completeStructured: (taskId: string, input: string, signal?: AbortSignal) => this.completeNeedleStructured(taskId, input, signal),
          // Structured (tool-constrained) roles are served ONLY by Needle:
          // gating their availability on Needle keeps a Qwen-only install
          // from advertising report/search/classification it cannot serve.
          structuredModelId: NEEDLE_MODEL_ID,
          proseModelId: QWEN_TEXT_MODEL_ID,
        },
        embedding: this.needle ? { modelId: NEEDLE_MODEL_ID, runtimeId: NEEDLE_RUNTIME_ID, taskRoles: needleRoles, get dimension() { return dimension(); }, isReady: () => this.ensureNeedle(), embed: (texts: string[]) => this.embedder!.embedNeedleTexts(texts) } : undefined,
      } : {}),
      ...(this.smol && vision ? { vision: { modelId: vision.modelId, runtimeId: vision.runtimeId, taskRoles: vision.taskRoles, isAvailable: () => this.ensureVision(), describe: async (prompt: string, imageBase64: string, signal: AbortSignal) => {
        let text = "";
        for await (const chunk of this.smol!.describeImage({ generationId: crypto.randomUUID(), prompt, imageBase64, maxOutputTokens: 256 }, signal)) text += chunk.textDelta;
        return text;
      } } } : {}),
    });
    this.manager.subscribe(() => this.changed());
    this.ready = this.reconcile().catch(() => {
      this.registry.catalogue().forEach((model) => this.notices.set(model.modelId, "Model storage could not be verified. Retry from AI & Models."));
      this.changed();
    });
  }

  private model(modelId: string) {
    const descriptor = this.registry.requireDescriptor(modelId);
    return { ...descriptor };
  }
  private paths(modelId: string) {
    const model = this.model(modelId);
    return this.manager.stagingPathsFor(this.root, modelId, model.revision, model.fileName);
  }
  private async reconcile() {
    if (!this.driver) return;
    this.root = await this.driver.rootDir();
    for (const d of parseImportedCatalogue(await this.driver.readMetadata?.(`${this.root}/imports.json`) ?? null)) {
      if (!this.registry.descriptorFor(d.modelId)) {
        this.imported.push(d);
        this.manager.registerImportedAsset({ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: d.minRamMb });
      }
    }
    for (const model of this.registry.descriptors.filter((d) => d.downloadable || d.trust === "imported")) {
      const paths = this.paths(model.modelId);
      const actual = await this.driver.hashFile(paths.installedPath).catch(() => "");
      let matches = this.manager.checksumsMatch(model.sha256, actual);
      for (const file of model.companions ?? []) {
        const path = this.manager.stagingPathsFor(this.root, model.modelId, model.revision, file.fileName).installedPath;
        matches &&= this.manager.checksumsMatch(file.sha256, await this.driver.hashFile(path).catch(() => ""));
      }
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
  private requireAndroid() { if (!this.android || !this.driver) throw new Error("On-device AI requires the Android app."); }
  private bridges() { return { needle: this.needle !== undefined, smol: this.smol !== undefined, qwenText: this.qwenText !== undefined, llama: this.llama !== undefined }; }
  /**
   * Device ABI set from the native facts bridge. Unreadable or absent
   * facts yield an empty set, which no descriptor verifies — fail-closed.
   */
  private async deviceAbis(): Promise<readonly string[]> {
    if (this.deviceAbiCache === undefined) {
      let abis: readonly string[] = [];
      try {
        const facts = (await this.smol?.collectDeviceFacts?.()) as Record<string, unknown> | undefined;
        const raw = facts?.["supportedAbis"];
        if (Array.isArray(raw)) abis = raw.filter((entry): entry is string => typeof entry === "string");
      } catch {
        abis = [];
      }
      this.deviceAbiCache = abis;
    }
    return this.deviceAbiCache;
  }
  /** Sync compatibility snapshot for the UI (unknown until ensureCompatibility runs). */
  compatibility(modelId: string): DeviceCompatibility {
    const cached = this.compatCache.get(modelId);
    if (cached !== undefined) return cached;
    if (!this.android) return { compatible: false, reason: "On-device downloads need the Android app." };
    return { compatible: true };
  }
  /** Refresh every descriptor compatibility snapshot from live device facts. */
  async ensureCompatibility(): Promise<void> {
    if (!this.android) return;
    const abis = await this.deviceAbis();
    let changed = false;
    for (const descriptor of this.registry.descriptors) {
      const next = compatibilityOf(descriptor, abis, this.bridges());
      const prev = this.compatCache.get(descriptor.modelId);
      if (prev?.compatible !== next.compatible || prev?.reason !== next.reason) {
        this.compatCache.set(descriptor.modelId, next);
        changed = true;
      }
    }
    if (changed) this.changed();
  }
  /**
   * Enforcement boundary: refuses the download/run when the device is
   * incompatible and records the consumer notice. UI disabling never
   * substitutes for this check.
   */
  private async requireCompatible(descriptor: ModelDescriptor): Promise<void> {
    const compat = compatibilityOf(descriptor, await this.deviceAbis(), this.bridges());
    this.compatCache.set(descriptor.modelId, compat);
    this.changed();
    if (!compat.compatible) {
      const reason = compat.reason ?? DEVICE_INCOMPATIBLE_REASON;
      this.notices.set(descriptor.modelId, reason);
      throw new Error(reason);
    }
  }
  private requireInstalled(modelId: string) {
    if (!describeOfflineReadiness(this.manager, modelId).ready) throw new Error("Model is not installed and verified");
  }
  async download(modelId: string, mirror?: string | ArtifactMirrors, signal?: AbortSignal): Promise<void> {
    this.requireAndroid();
    // Claim the model BEFORE the first await.
    //
    // The device registers a transfer a tick AFTER the click (the readiness
    // and compatibility probes run first), so two taps inside that window
    // used to reach the ownership checks together and could both register a
    // transfer against the same staging path. The claim makes the second
    // request a no-op, and `busy()` reports it so the surface that owns the
    // button can disable it while the request is in flight. The claim is
    // released as soon as the transfer owns the model, and released again if
    // the attempt fails — so a retry after a failure is never refused.
    if (this.claiming.has(modelId) || this.active.has(modelId) || this.operating.has(modelId)) return;
    this.claiming.add(modelId);
    this.changed();
    try {
      const resetVersion = this.coordinator.resetVersion;
      await this.ready;
      if (signal?.aborted) throw new Error("Download cancelled.");
      // Model files back the resident engines: no download may cross the
      // reset barrier while cleanup is pending.
      if (this.coordinator.resetPending) throw new Error("On-device runtime is busy");
      if (this.active.has(modelId) || this.operating.has(modelId)) return;
      const model = this.model(modelId);
      const mirrors = typeof mirror === "string" ? { [model.fileName]: mirror } : mirror ?? {};
      validateArtifactMirrors(model, mirrors);
      // Acquisition eligibility is separate from task qualification. Advanced
      // models with immutable byte pins may be acquired without product roles.
      if (model.downloadable !== true || distributionPolicyOf(model) !== "downloadable") {
        const reason = (model.distributionNote ?? "").trim() !== ""
          ? (model.distributionNote as string)
          : "This model is not offered as a download.";
        this.notices.set(modelId, reason);
        this.changed();
        throw new Error(reason);
      }
      await this.requireCompatible(model);
      if (signal?.aborted || resetVersion !== this.coordinator.resetVersion) throw new Error("Download cancelled.");
      // Compatibility awaits native facts. Recheck ownership synchronously
      // before registering work: a racing duplicate must not replace the first
      // transfer's cancellation owner (even if its own manager gate refuses it).
      if (this.coordinator.resetPending) throw new Error("On-device runtime is busy");
      if (this.active.has(modelId) || this.operating.has(modelId)) return;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const work = (async () => {
        const result = model.companions?.length
          ? await runManagedBundle(this.manager, this.driver!, model, abort.signal, mirrors)
          : await runManagedDownload(this.manager, this.driver!, { ...model, sources: sourcesFor(model, mirrors[model.fileName]), maxBytes: model.bytes, userInitiated: true, signal: abort.signal });
        this.notices.set(modelId, result.ok ? "Installed and checksum verified." : result.reason);
      })().catch(() => { this.notices.set(modelId, "Download failed; retry to resume verified staging."); }).finally(() => {
        signal?.removeEventListener("abort", cancel);
        this.active.delete(modelId); this.changed();
      });
      this.active.set(modelId, { abort, work });
      // The transfer owns the model from here; the claim is done.
      this.claiming.delete(modelId);
      this.changed();
      await work;
    } finally {
      this.claiming.delete(modelId);
    }
  }
  async pause(modelId: string) {
    const active = this.active.get(modelId);
    if (!active) return;
    active.abort.abort();
    await this.driver!.cancelDownload(this.paths(modelId).stagingPath);
    await active.work;
  }

  private async saveImported(): Promise<void> {
    if (!this.driver?.writeMetadata) throw new Error("Private import metadata storage is unavailable.");
    await this.driver.writeMetadata(`${this.root}/imports.json`, JSON.stringify(this.imported.map((d) => ({ sha256: d.sha256, bytes: d.bytes, format: d.format, modality: d.capabilities.includes("vision") ? "vision" : "text", license: d.license }))));
  }
  private registerImported(d: ModelDescriptor): void {
    const existing = this.registry.descriptorFor(d.modelId);
    if (existing) {
      if (existing.format !== d.format || existing.bytes !== d.bytes || existing.runtimeId !== d.runtimeId || existing.license !== d.license) {
        throw new Error("Import metadata conflicts with an existing artifact identity.");
      }
      return;
    }
    this.imported.push(d);
    this.manager.registerImportedAsset({ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: d.minRamMb });
  }

  /** URL imports require an explicit immutable byte identity, never infer trust from a filename. */
  async importUrl(input: ImportSpec, options: { signal?: AbortSignal } = {}): Promise<string> {
    this.requireAndroid(); await this.ready;
    if (options.signal?.aborted) throw new Error("Import cancelled.");
    const spec = validateImportSpec(input);
    if (!spec.url) throw new Error("An HTTPS URL is required.");
    if (!this.driver?.writeMetadata) throw new Error("Private import metadata storage is unavailable.");
    if (this.coordinator.inferenceBlocked || this.operating.size || this.active.size) throw new Error("On-device runtime is busy.");
    const d = importedDescriptor(spec);
    const previousImports = [...this.imported];
    this.registerImported(d);
    if (this.manager.statusOf(d.modelId)?.download === "installed") return d.modelId;
    // Use the source only during this transaction. Neither persistence failure
    // nor acquisition failure may leave ready files or a live source behind.
    const existing = this.imported.findIndex((v) => v.modelId === d.modelId);
    this.operating.add("import"); this.changed();
    let metadataWritten = false;
    try {
      this.imported[existing] = d;
      await this.download(d.modelId, undefined, options.signal);
      if (options.signal?.aborted) throw new Error("Import cancelled.");
      if (this.manager.statusOf(d.modelId)?.download !== "installed") throw new Error(this.notice(d.modelId) ?? "Import failed.");
      this.imported[existing] = importedDescriptor({ ...spec, url: undefined });
      await this.saveImported(); metadataWritten = true;
      if (options.signal?.aborted) throw new Error("Import cancelled.");
      return d.modelId;
    } catch (error) {
      this.manager.dispatch(d.modelId, { type: "DELETE" });
      this.imported = previousImports;
      const paths = this.manager.stagingPathsFor(this.root, d.modelId, d.revision, d.fileName);
      await this.driver.removeFile(`${this.root}/models/${d.modelId}`);
      await this.driver.removeFile(paths.stagingPath);
      await this.driver.removeFile(journalPathFor(paths.stagingPath));
      if (metadataWritten) await this.saveImported();
      throw error;
    } finally { this.operating.delete("import"); this.changed(); }
  }

  /** SAF streams directly into native private staging. No model bytes or content URI cross JS. */
  async importLocal(options: { modelId?: string; format?: "gguf" | "litertlm" | "cact"; modality?: "text" | "vision"; license?: string; maxBytes?: number; signal?: AbortSignal }): Promise<string> {
    this.requireAndroid(); await this.ready;
    if (!this.driver?.pickAndStage || !this.driver.writeMetadata) throw new Error("Native document import is unavailable.");
    if (this.coordinator.inferenceBlocked || this.operating.size || this.active.size) throw new Error("On-device runtime is busy.");
    const known = options.modelId ? this.model(options.modelId) : undefined;
    if (known && await this.driver.freeBytes() < acquisitionBytes(known) + 64 * 1024 ** 2) throw new Error("Needs more storage.");
    const stagingRoot = `${this.root}/import-work/${crypto.randomUUID()}`;
    const label = known?.modelId ?? "import";
    this.operating.add(label); this.changed();
    let promoted: string | undefined;
    let installedId: string | undefined;
    let metadataWritten = false;
    const previousImports = [...this.imported];
    try {
      const files = known ? acquisitionArtifacts(known) : [{ fileName: `model.${options.format ?? "gguf"}`, bytes: options.maxBytes ?? 4 * 1024 ** 3, sha256: "", url: "" }];
      let descriptor = known;
      for (const file of files) {
        const stagingPath = `${stagingRoot}/${file.fileName}`;
        const abort = () => { void this.driver!.cancelDownload(stagingPath); };
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          if (options.signal?.aborted) throw new Error("Import cancelled.");
          const result = await this.driver.pickAndStage({ stagingPath, maxBytes: file.bytes, format: known?.format ?? options.format ?? "gguf", ...(known ? { expectedBytes: file.bytes, expectedSha256: file.sha256 } : {}) });
          if (options.signal?.aborted) throw new Error("Import cancelled.");
          if (known && (result.bytes !== file.bytes || !this.manager.checksumsMatch(file.sha256, result.actualHex))) throw new Error("Imported document does not match the catalogue pin.");
          if (!known) descriptor = importedDescriptor({ sha256: result.actualHex, bytes: result.bytes, format: options.format ?? "gguf", modality: options.modality, license: options.license ?? "" });
        } finally { options.signal?.removeEventListener("abort", abort); }
      }
      const d = descriptor!;
      await this.requireCompatible(d);
      if (!known) this.registerImported(d);
      if (this.manager.statusOf(d.modelId)?.download === "installed") throw new Error("Already installed.");
      const target = `${this.root}/models/${d.modelId}/${d.revision}`;
      if (options.signal?.aborted) throw new Error("Import cancelled.");
      await this.driver.promoteFile(stagingRoot, target); promoted = target;
      if (options.signal?.aborted) throw new Error("Import cancelled.");
      // Finish fallible staging cleanup inside the transaction, before any
      // durable import record or ready state is committed.
      await this.driver.removeFile(stagingRoot);
      this.manager.dispatch(d.modelId, { type: "DELETE" });
      installedId = d.modelId;
      this.manager.dispatch(d.modelId, { type: "QUEUE_DOWNLOAD", userInitiated: true });
      this.manager.dispatch(d.modelId, { type: "START" });
      this.manager.dispatch(d.modelId, { type: "VERIFY_START" });
      this.manager.dispatch(d.modelId, { type: "VERIFY_OK", actualSha256: d.sha256 });
      if (!known) { await this.saveImported(); metadataWritten = true; }
      if (options.signal?.aborted) throw new Error("Import cancelled.");
      this.notices.set(d.modelId, "Installed and checksum verified."); return d.modelId;
    } catch (error) {
      if (installedId) this.manager.dispatch(installedId, { type: "DELETE" });
      this.imported = previousImports;
      // Try both rollback actions; a file removal failure must not skip
      // restoring the catalogue, and neither failure may keep readiness true.
      const rollback = await Promise.allSettled([
        ...(promoted ? [this.driver.removeFile(promoted)] : []),
        ...(metadataWritten ? [this.saveImported()] : []),
      ]);
      if (rollback.some((result) => result.status === "rejected")) throw new Error("Import failed; private storage cleanup could not finish.");
      throw error;
    } finally {
      try { await this.driver.removeFile(stagingRoot); }
      finally { this.operating.delete(label); this.changed(); }
    }
  }

  /** Explicit Advanced evaluation uses the same residency/cancellation owner as product inference. */
  async evaluate(modelId: string, options: { optIn: boolean; prompt: string; imageBase64?: string; signal?: AbortSignal }): Promise<string> {
    if (!options.optIn) throw new Error("Evaluation requires explicit opt-in.");
    this.requireAndroid(); await this.ready;
    const d = this.model(modelId); this.requireInstalled(modelId); await this.requireCompatible(d);
    if (this.operating.size || this.active.has(modelId)) throw new Error("On-device runtime is busy.");
    if (!options.prompt.trim() || options.prompt.length > 16000) throw new Error("Enter a bounded evaluation prompt.");
    if (d.capabilities.includes("vision") && !options.imageBase64) throw new Error("Choose an evaluation image.");
    const lease = this.coordinator.beginInference("model-evaluation");
    const abort = () => lease.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) lease.abort();
    const owner = ownerForRuntime(d.runtimeId);
    const generationId = crypto.randomUUID();
    try {
      if (owner === "none") throw new Error("Unsupported runtime.");
      await this.coordinator.switchTo(owner, {
        evict: async () => {
          const resident = this.coordinator.current;
          if (resident === "needle") { await this.needle?.unload(); this.embedder = undefined; }
          if (resident === "smol-vision") await this.smol?.unloadVisionModel();
          if (resident === "qwen-text") await this.unloadQwenText();
          if (resident === "llama") await this.llama?.unloadLlamaModel();
        },
        load: async () => {
          if (lease.signal.aborted) throw new Error("Evaluation cancelled.");
          if (owner === "llama") await this.llama!.loadLlamaModel({ modelId, ggufPath: this.paths(modelId).installedPath, projectorPath: d.companions?.[0] ? this.manager.stagingPathsFor(this.root, modelId, d.revision, d.companions[0].fileName).installedPath : undefined });
          else if (owner === "qwen-text") await this.qwenText!.loadTextModel({ modelId, installedPath: this.paths(modelId).installedPath, maxTokens: 1024, evaluation: true });
          else if (owner === "smol-vision") await this.smol!.loadVisionModel({ modelId, installedPath: this.paths(modelId).installedPath, backend: "cpu", maxOutputTokens: 256, evaluation: true });
          else await this.needle!.loadModel({ modelId, installedPath: this.paths(modelId).installedPath });
        },
      });
      let text = "";
      if (owner === "needle") {
        // Needle is a tool/embedding model, never a general-chat alias.
        const vectors = await this.needle!.embedNeedleTexts([options.prompt]);
        text = `Embedding self-test: ${vectors[0]?.length ?? 0} dimensions`;
      } else {
        const chunks = owner === "llama" ? this.llama!.inferLlama({ generationId, prompt: options.prompt, maxTokens: 256, imageBase64: options.imageBase64 }, lease.signal)
          : owner === "qwen-text" ? this.qwenText!.generateText({ generationId, prompt: options.prompt, maxOutputTokens: 256 }, lease.signal)
            : this.smol!.describeImage({ generationId, prompt: options.prompt, imageBase64: options.imageBase64!, maxOutputTokens: 256 }, lease.signal);
        for await (const chunk of chunks) { if (!lease.signal.aborted) text += chunk.textDelta; if (text.length > 32000) throw new Error("Evaluation output limit exceeded."); }
      }
      if (lease.signal.aborted) throw new Error("Evaluation cancelled.");
      text = stripThoughtEnvelope(stripThoughtEnvelope(text, profileFor(modelId)?.thoughtEnvelope), { openMarker: "<think>", closeMarker: "</think>" }).trim();
      if (!text) throw new Error("Evaluation returned no answer text. Reasoning channels are not displayed.");
      return text;
    } finally {
      try { await this.unloadDescriptor(d); this.coordinator.released(owner); }
      finally { options.signal?.removeEventListener("abort", abort); lease.requestSettled(); }
    }
  }
  /**
   * Re-verify an installed model against its catalogue pin. A match keeps
   * the install with a quiet notice; a missing or mismatched file drops
   * the false-installed claim (DELETE) so readiness fails closed, and the
   * resident is released when it was the Qwen/Needle/vision engine.
   */
  async verify(modelId: string): Promise<void> {
    this.requireAndroid();
    await this.ready;
    if (this.coordinator.inferenceBlocked || this.operating.size > 0) throw new Error("On-device runtime is busy; try again when idle");
    if (this.operating.has(modelId)) return;
    const descriptor = this.model(modelId);
    this.operating.add(modelId); this.changed();
    try {
      if (this.manager.statusOf(modelId)?.download !== "installed") {
        this.notices.set(modelId, "Not installed yet.");
        return;
      }
      const actual = await this.driver!.hashFile(this.paths(modelId).installedPath).catch(() => "");
      let bundleMatches = true;
      for (const f of descriptor.companions ?? []) bundleMatches &&= this.manager.checksumsMatch(f.sha256, await this.driver!.hashFile(this.manager.stagingPathsFor(this.root, modelId, descriptor.revision, f.fileName).installedPath).catch(() => ""));
      if (actual !== "" && this.manager.checksumsMatch(descriptor.sha256, actual) && bundleMatches) {
        this.notices.set(modelId, "Installed and checksum verified.");
      } else {
        try {
          await this.unloadDescriptor(descriptor);
        } catch {
          // Unload is best effort here; the install claim is dropped anyway.
        }
        try {
          this.manager.dispatch(modelId, { type: "DELETE" });
        } catch {
          // Already absent: the notice below still explains the state.
        }
        this.coordinator.released(ownerForRuntime(descriptor.runtimeId));
        this.notices.set(
          modelId,
          actual === ""
            ? "The installed file is missing. Download it again."
            : "The installed file didn't pass verification and was removed. Download it again.",
        );
      }
    } finally { this.operating.delete(modelId); this.changed(); }
  }
  async remove(modelId: string) {
    this.requireAndroid(); await this.ready;
    if (this.coordinator.inferenceBlocked || this.operating.size > 0) throw new Error("On-device runtime is busy; stop inference before removing a model");
    this.operating.add(modelId); this.changed();
    const label = `remove:${modelId}`;
    try {
      await this.pause(modelId);
      try {
        this.coordinator.beginExclusive(label);
      } catch (error) {
        if (error instanceof ResidencyBusyError) throw new Error("On-device runtime is busy; stop inference before removing a model");
        throw error;
      }
      try {
        const descriptor = this.model(modelId);
        await removeManagedModel(this.manager, this.driver!, this.root, modelId, descriptor.revision, descriptor.fileName, {
          unload: () => this.unloadDescriptor(descriptor),
        });
        await this.driver!.removeFile(`${this.root}/models/${modelId}`);
        await this.driver!.removeFile(`${this.root}/bundle-work/models/${modelId}`);
        await this.driver!.removeFile(`${this.root}/bundle-work/staging/${modelId}`);
        if (descriptor.trust === "imported") { this.imported = this.imported.filter((d) => d.modelId !== modelId); await this.saveImported(); }
        this.coordinator.released(ownerForRuntime(descriptor.runtimeId));
        this.probeRecords = []; this.notices.delete(modelId);
      } finally { this.coordinator.endExclusive(label); }
    } finally { this.operating.delete(modelId); this.changed(); }
  }
  /**
   * Phase A (Step 3): runtime-owned unload. Ownership dispatches on the
   * descriptor's runtimeId — never a Needle-vs-else branch, so an unknown
   * third runtime fails closed instead of unloading the wrong engine.
   */
  private async unloadDescriptor(descriptor: ModelDescriptor): Promise<void> {
    switch (descriptor.runtimeId) {
      case NEEDLE_RUNTIME_ID:
        await this.needle!.unload(); this.embedder = undefined; this.matching = "use"; return;
      case SMOL_VLM_RUNTIME_ID:
        await this.smol!.unloadVisionModel(); return;
      case QWEN_TEXT_RUNTIME_ID:
        await this.unloadQwenText(); return;
      case LLAMA_CPP_RUNTIME_ID:
        await this.llama?.unloadLlamaModel(); return;
      default:
        throw new Error(`No production runtime adapter for ${descriptor.runtimeId}`);
    }
  }
  /** Release the Qwen text resident and invalidate its generation epoch. */
  private async unloadQwenText(): Promise<void> {
    this.textEpoch++;
    this.qwenResident = false;
    await this.qwenText?.unloadTextModel();
  }
  /** The Qwen profile's thought envelope, if it defines one. */
  private qwenEnvelope() {
    return profileFor(QWEN_TEXT_MODEL_ID)?.thoughtEnvelope;
  }
  /**
   * Text readiness across engines: Qwen prose OR Needle structured. The
   * per-mode entry points (completeProseText / completeNeedleStructured)
   * enforce their own engine, so a task never runs on an engine that is
   * merely "the other one is ready".
   */
  private async ensureAnyText(): Promise<boolean> {
    await this.ready;
    const qwen = await this.ensureQwenText().catch(() => false);
    if (qwen) return true;
    if (this.needle === undefined) return false;
    return this.ensureNeedle().catch(() => false);
  }
  /**
    * Prose generation uses the qualified LiteRT-LM text resident with
    * thought-stripping and the epoch guard. Needle is tool-only.
   * Provenance always names the real producer.
   */
  private async completeProseText(input: string, signal?: AbortSignal): Promise<ProductionTextCompletion> {
    const text = await this.collectQwenText(input, signal, 256);
    return { text, modelId: QWEN_TEXT_MODEL_ID, runtimeId: QWEN_TEXT_RUNTIME_ID };
  }
  /** Tool-constrained structured generation stays on Needle (the proven tool model). */
  private async completeNeedleStructured(taskId: string, input: string, _signal?: AbortSignal): Promise<ProductionTextCompletion> {
    if (this.needle === undefined) throw new Error("No qualified on-device structured runtime is installed");
    await this.ensureNeedle();
    return { text: await this.extractTaskFields(taskId, input), modelId: NEEDLE_MODEL_ID, runtimeId: NEEDLE_RUNTIME_ID };
  }
  /**
   * One-shot Qwen collection for the route path: epoch-guarded, natively
   * cancellable via the route signal, thought-stripped before return.
   */
  private async collectQwenText(prompt: string, signal: AbortSignal | undefined, maxOutputTokens: number): Promise<string> {
    await this.ensureQwenText();
    const bridge = this.qwenText;
    if (bridge === undefined) throw new Error("Qwen text runtime is not available on this build");
    const generationId = crypto.randomUUID();
    const epoch = this.textEpoch;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let text = "";
      for await (const chunk of bridge.generateText({ generationId, prompt, maxOutputTokens }, controller.signal)) {
        if (controller.signal.aborted) break;
        if (epoch !== this.textEpoch) {
          await bridge.cancelGeneration(generationId).catch(() => undefined);
          throw new Error("On-device text resident switched; generation discarded");
        }
        text += chunk.textDelta;
      }
      return stripThoughtEnvelope(text, this.qwenEnvelope()).trim();
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  /**
   * Streaming Qwen generation for the offline chat adapter: honest deltas
   * through the envelope filter (no reasoning leakage, no fake streaming),
   * epoch-guarded against late callbacks after a switch/unload.
   */
  private async *streamQwenText(
    prompt: import("./providers/offline").OfflinePrompt,
    signal: AbortSignal,
  ): AsyncGenerator<import("./providers/offline").OfflineGenerationChunk> {
    await this.ensureQwenText();
    const bridge = this.qwenText;
    if (bridge === undefined) throw new Error("Qwen text runtime is not available on this build");
    const generationId = crypto.randomUUID();
    const epoch = this.textEpoch;
    const filter = createEnvelopeStreamingFilter(this.qwenEnvelope());
    const textPrompt = [prompt.systemText, prompt.summaryText, ...prompt.recentTurns.map((turn) => `${turn.role}: ${turn.text}`), prompt.currentText]
      .filter((part) => part !== undefined && part.trim() !== "")
      .join("\n\n");
    try {
      for await (const chunk of bridge.generateText(
        { generationId, prompt: textPrompt, maxOutputTokens: prompt.maxOutputTokens },
        signal,
      )) {
        if (signal.aborted) return;
        if (epoch !== this.textEpoch) {
          await bridge.cancelGeneration(generationId).catch(() => undefined);
          throw new Error("On-device text resident switched; generation discarded");
        }
        const delta = filter.push(chunk.textDelta);
        if (delta !== "") yield { textDelta: delta };
      }
      const tail = filter.flush();
      if (tail !== "" && !signal.aborted && epoch === this.textEpoch) yield { textDelta: tail };
    } finally {
      if (signal.aborted) await bridge.cancelGeneration(generationId).catch(() => undefined);
    }
  }
  private async ensureQwenText(): Promise<boolean> {
    await this.ready; this.requireInstalled(QWEN_TEXT_MODEL_ID);
    const bridge = this.qwenText;
    if (bridge === undefined) return false;
    // Run-time re-check, same as ensureNeedle: incompatible devices fail
    // closed here even if a model file is somehow present.
    const descriptor = this.registry.descriptorFor(QWEN_TEXT_MODEL_ID);
    if (descriptor === undefined) return false;
    if (!compatibilityOf(descriptor, await this.deviceAbis(), this.bridges()).compatible) return false;
    if (!this.loadingQwenText) this.loadingQwenText = (async () => {
      if (!this.qwenResident || !(await bridge.isTextAvailable())) {
        // Single-resident rule via the coordinator: evict Needle AND vision,
        // then load. The epoch moves before load so any orphaned stream from
        // a previous resident is discarded on its next chunk.
        this.textEpoch++;
        await this.coordinator.switchTo("qwen-text", {
          evict: async () => {
            await this.needle?.unload().catch(() => undefined); this.embedder = undefined;
            await this.smol?.unloadVisionModel().catch(() => undefined);
          },
          load: () => bridge.loadTextModel({
            modelId: QWEN_TEXT_MODEL_ID,
            installedPath: this.paths(QWEN_TEXT_MODEL_ID).installedPath,
            maxTokens: QWEN_SESSION_MIN_TOKENS,
          }),
        });
        this.qwenResident = true;
      }
    })().finally(() => { this.loadingQwenText = undefined; });
    await this.loadingQwenText; return true;
  }
  private async ensureNeedle(): Promise<boolean> {
    await this.ready; this.requireInstalled(NEEDLE_MODEL_ID);
    if (!this.needle) return false;
    // Run-time re-check: an install that predates compatibility
    // enforcement (or a device whose facts changed) must not run.
    const needleDescriptor = this.registry.descriptorFor(NEEDLE_MODEL_ID);
    if (needleDescriptor === undefined) return false;
    if (!compatibilityOf(needleDescriptor, await this.deviceAbis(), this.bridges()).compatible) return false;
    if (!this.loadingNeedle) this.loadingNeedle = (async () => {
      if (!this.embedder || !(await this.needle!.isNeedleAvailable())) {
        // Single-resident rule via the coordinator: evict vision AND Qwen
        // text, then load. Every switch evicts all other residents, so two
        // large engines are never alive together.
        await this.coordinator.switchTo("needle", {
          evict: async () => {
            await this.smol?.unloadVisionModel().catch(() => undefined);
            await this.unloadQwenText().catch(() => undefined);
          },
          load: async () => {
            this.embedder = await createNativeNeedleEmbedder(this.needle!, { installedPath: this.paths(NEEDLE_MODEL_ID).installedPath });
          },
        });
      }
    })().finally(() => { this.loadingNeedle = undefined; });
    await this.loadingNeedle; return true;
  }
  private async ensureVision(): Promise<boolean> {
    await this.ready;
    const vision = this.registry.visionDescriptor();
    if (!vision) return false;
    // Readiness is a fact, not a load failure: an absent/unverified model
    // resolves false so the offline adapter keeps `vision_unsupported`.
    // Once the model is installed, a throwing native load propagates so the
    // adapter can report the honest `runtime_load_failed` class instead of
    // collapsing a GPU/OOM/init failure into "vision not proven".
    if (!describeOfflineReadiness(this.manager, vision.modelId).ready) return false;
    const smol = this.smol;
    if (!smol) return false;
    // Run-time re-check, same as ensureNeedle: incompatible devices fail
    // closed here even if a model file is somehow present.
    if (!compatibilityOf(vision, await this.deviceAbis(), this.bridges()).compatible) return false;
    // Single-resident rule via the coordinator: evict Needle AND Qwen
    // text, then load.
    // A failed load leaves ownership at "none" (coordinator rule), so a
    // half-loaded engine is never claimed as resident.
    await this.coordinator.switchTo("smol-vision", {
      evict: async () => {
        await this.needle?.unload().catch(() => undefined); this.embedder = undefined;
        await this.unloadQwenText().catch(() => undefined);
      },
      load: () => this.loadVisionModel(smol, vision.modelId),
    });
    return smol.isVisionAvailable();
  }
  private async loadVisionModel(smol: SmolBridge, modelId: string): Promise<void> {
    const decision = selectBackend(this.probeRecords, this.probeContext);
    const backend = decision.kind === "use" && decision.backend === "gpu" ? "gpu" : "cpu";
    const args = { modelId, installedPath: this.paths(modelId).installedPath, maxOutputTokens: 256 };
    try { await smol.loadVisionModel({ ...args, backend }); }
    catch (error) {
      if (backend !== "gpu") throw error;
      this.probeRecords = this.probeRecords.filter((record) => record.backend !== "gpu");
      this.notices.set(args.modelId, "GPU initialization failed; retrying with CPU."); this.changed();
      await smol.unloadVisionModel();
      await smol.loadVisionModel({ ...args, backend: "cpu" });
    }
  }
  private async extractTaskFields(taskId: string, input: string): Promise<string> {
    const strategy = STRUCTURED_STRATEGIES[taskId];
    if (strategy === undefined) throw new Error(`No structured generation strategy for task "${taskId}"`);
    await this.needle!.initTools(strategy.system, JSON.stringify([{
      name: strategy.toolName,
      description: strategy.toolDescription,
      parameters: strategy.schema,
    }]));
    const raw: unknown = JSON.parse(await this.needle!.completeJson(input));
    const envelope = raw as {
      function_calls?: { name?: string; arguments?: unknown }[];
      suppressed_calls?: { name?: string; arguments?: unknown }[];
    };
    const calls =
      envelope.function_calls !== undefined && envelope.function_calls.length > 0
        ? envelope.function_calls
        : envelope.suppressed_calls;
    const fields = calls?.find((call) => call.name === strategy.toolName)?.arguments;
    if (!fields || typeof fields !== "object") throw new Error(`Needle did not produce a confident ${strategy.toolName} record`);
    return JSON.stringify({ fields });
  }
  async route(taskId: AiTaskId, input: unknown, context: RouteContext) {
    await this.ready;
    if (this.operating.size > 0) throw new Error("On-device runtime is busy");
    // One production lease owns this flight: exclusion, the ACTUAL route
    // signal, and native settlement. Logout/account-switch aborts this
    // exact signal via coordinator.reset(); the lease stays busy until
    // tracked native work settles, so no new flight can start in the
    // unsafe interval.
    let lease: import("./residencyCoordinator").InferenceLease;
    try {
      lease = this.coordinator.beginInference("route");
    } catch (error) {
      if (error instanceof ResidencyBusyError) throw new Error("On-device runtime is busy");
      throw error;
    }
    if (context.signal !== undefined) {
      if (context.signal.aborted) lease.abort();
      else context.signal.addEventListener("abort", () => lease.abort(), { once: true });
    }
    try {
      return await this.boot.orchestrator.route(taskId, input, {
        ...context,
        signal: lease.signal,
        trackSettlement: (work) => lease.trackNative(work),
      });
    }
    finally { lease.requestSettled(); }
  }
  async embedNeedle(texts: string[]) {
    this.requireAndroid(); await this.ready;
    // Removal revokes readiness before native unload settles. Preserve the
    // canonical busy contract until that owner releases its operation gate.
    if (this.coordinator.inferenceBlocked || this.operating.size > 0) throw new Error("On-device runtime is busy");
    this.requireInstalled(NEEDLE_MODEL_ID);
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
    // On-device chat runs on the Qwen LiteRT-LM text resident: explicit
    // model id, load/unload, chunked generation with the epoch guard, and
    // native cancellation (providers/offline.ts seam). Without an installed
    // Qwen or the text plugin the adapter fails closed — never cloud.
    const bridge: OfflineNativeBridge = {
      bridgeName: QWEN_TEXT_BRIDGE_NAME,
      isAvailable: () => this.qwenText !== undefined,
      load: async (modelId: string) => {
        if (modelId !== QWEN_TEXT_MODEL_ID) throw new Error(`unknown model ${modelId}`);
        if (!(await this.ensureQwenText())) throw new Error("No qualified on-device chat runtime is installed");
      },
      unload: () => this.unloadQwenText(),
      generate: (prompt, signal) => this.streamQwenText(prompt, signal),
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
    const vision = this.registry.visionDescriptor();
    const notice = vision ? this.notice(vision.modelId) : undefined;
    if (notice?.startsWith("GPU initialization failed")) yield { textDelta: `${notice}\n\n` };
    yield* this.smol!.describeImage(request, signal);
  }
  private async *completeOffline(adapter: import("./providerContract").ProviderAdapter, request: import("./providerContract").NormalizedRequest) {
    await this.ready;
    if (this.operating.size > 0) throw new Error("On-device runtime is busy");
    // Holds the single inference lease for the request lifetime
    // (exclusion + logout abort + native-settlement tracking).
    let lease: import("./residencyCoordinator").InferenceLease;
    try {
      lease = this.coordinator.beginInference("complete");
    } catch (error) {
      if (error instanceof ResidencyBusyError) throw new Error("On-device runtime is busy");
      throw error;
    }
    // Audit closure: the adapter only knows request.signal, so logout
    // would never cancel the real provider stream. Compose caller cancel
    // with the lease signal and hand the adapter the combination; after
    // either fires, no further event is delivered to the old consumer.
    const combined = new AbortController();
    const forward = () => combined.abort();
    if (request.signal.aborted || lease.signal.aborted) combined.abort();
    else {
      request.signal.addEventListener("abort", forward, { once: true });
      lease.signal.addEventListener("abort", forward, { once: true });
    }
    try {
      for await (const event of adapter.complete({ ...request, signal: combined.signal })) {
        if (combined.signal.aborted) return;
        yield event;
      }
    }
    finally {
      request.signal.removeEventListener("abort", forward);
      lease.signal.removeEventListener("abort", forward);
      lease.requestSettled();
    }
  }
  async measure(backend: "cpu" | "gpu") {
    const vision = this.registry.visionDescriptor();
    if (!vision) throw new Error("No vision model registered");
    this.requireAndroid(); await this.ready; this.requireInstalled(vision.modelId);
    if (this.coordinator.inferenceBlocked || this.operating.size > 0) throw new Error("On-device runtime is busy; stop inference before measuring");
    const label = `measure:${backend}`;
    try {
      this.coordinator.beginExclusive(label);
    } catch (error) {
      if (error instanceof ResidencyBusyError) throw new Error("On-device runtime is busy; stop inference before measuring");
      throw error;
    }
    try {
      await this.needle!.unload(); this.embedder = undefined;
      await this.smol!.unloadVisionModel();
      await this.unloadQwenText();
      this.coordinator.released("needle");
      this.coordinator.released("smol-vision");
      this.coordinator.released("qwen-text");
      let record: ProbeRecord | null | undefined;
      try {
        record = await this.smol!.measureBackend?.({ modelId: vision.modelId, modelRev: this.probeContext.modelRev, installedPath: this.paths(vision.modelId).installedPath, backend, corpusVersion: DEVICE_CORPUS_VERSION });
      } catch (error) {
        // Phase A (Step 9): discriminated native codes. Measurement failing
        // never makes CPU inference unusable — it only withholds GPU
        // auto-selection, which requires valid measured evidence.
        const code = (error as { code?: unknown })?.code;
        const tag = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : ""}`;
        if (/benchmark_unavailable|device_facts_unavailable/.test(tag)) {
          this.notices.set(vision.modelId, "On-device measurement is unavailable; CPU inference remains usable.");
          this.changed();
        }
        throw new Error(`Measurement failed (${tag.trim() || "unknown"}); device evidence is still required`);
      }
      if (!record || validateProbeRecord(record).length > 0 || record.backend !== backend || record.modelRev !== this.probeContext.modelRev || record.corpusVersion !== DEVICE_CORPUS_VERSION) throw new Error("No valid timing sample; device evidence is still required");
      this.probeRecords = [...this.probeRecords.filter((item) => item.backend !== backend), record];
      this.changed(); return record;
    } finally { this.coordinator.endExclusive(label); }
  }
  async facts() { this.requireAndroid(); return this.smol!.collectDeviceFacts?.(); }

  /**
   * Account/logout cleanup with a reset barrier.
   *
   * Abort the visible flight immediately and invalidate old-account
   * output, then unload engines ONLY after tracked native work settles —
   * a non-cancellable native call is never torn down mid-execution. If
   * the bounded sign-out wait expires first, sign-out still finishes but
   * the barrier stays up (local AI, removal, measurement, downloads, and
   * switches all refuse) and engine cleanup is deferred until settlement
   * actually occurs. A permanently wedged native call can hold local AI
   * unavailable until process restart; that is preferable to unloading
   * underneath live native code. Downloads, pins, and probe records
   * survive — logout never wipes models.
   */
  private accountResetCleanup: Promise<void> | undefined;

  async resetForAccount(timeoutMs = RESET_SIGNOUT_WAIT_MS): Promise<void> {
    this.coordinator.reset();
    // Rapid SDK replacements share one engine cleanup. Independent unloads
    // would let the first reset lower the barrier while another is still
    // tearing down engines beneath the next account's inference.
    const cleanup = this.accountResetCleanup ??= this.deferredResetCleanup().then(() => {
      // Retire the shared operation before releasing the gate or notifying
      // subscribers, so a reset queued by completion starts fresh cleanup.
      this.accountResetCleanup = undefined;
      this.coordinator.completeReset();
      this.changed();
    }, (error: unknown) => {
      this.accountResetCleanup = undefined;
      throw error; // Unexpected cleanup failure leaves the gate closed.
    });
    void cleanup.catch(() => {});
    if (await this.coordinator.whenNativeIdle(timeoutMs)) {
      await cleanup;
    }
  }

  private async finishResetCleanup(): Promise<void> {
    this.embedder = undefined;
    this.matching = "use";
    await this.needle?.unload().catch(() => {});
    await this.smol?.unloadVisionModel().catch(() => {});
    await this.unloadQwenText().catch(() => {});
  }

  private async deferredResetCleanup(): Promise<void> {
    let settled = false;
    while (!settled) settled = await this.coordinator.whenNativeIdle(RESET_SIGNOUT_WAIT_MS);
    await this.finishResetCleanup();
  }
}

let applicationAi: ApplicationAiService | undefined;
/** Application lifetime singleton; tests of platform behavior use the same class with fakes. */
export function getApplicationAi(): ApplicationAiService {
  return applicationAi ??= new ApplicationAiService({ android: Capacitor.isNativePlatform() && Capacitor.getPlatform?.() === "android" });
}
export function initializeApplicationAi(): Promise<void> { return getApplicationAi().ready; }

/**
 * Phase A (Step 8): account/logout cleanup entry point for the sign-out
 * wipe (`clearUserScopedLocalState`). No-op before first use; never throws.
 */
export async function resetLocalAiForAccount(): Promise<void> {
  try {
    await applicationAi?.resetForAccount();
  } catch {
    // Best-effort: logout cleanup must never fail sign-out.
  }
}
