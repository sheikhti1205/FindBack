import { Capacitor } from "@capacitor/core";
import { bootProductionAi, type ProductionBoot } from "./production";
import { ITEM_CATEGORIES } from "./ops/classifyCategory";
import { CapacitorNeedleBridge, createNativeNeedleEmbedder } from "./needle/native";
import { NEEDLE_MODEL_ID, type NativeNeedleEmbedder } from "./needle/embedder";
import { CapacitorModelDownloadDriver, runManagedDownload, removeManagedModel, validatedDeviceAbis, type ModelDownloadDriver } from "./download/driver";
import type { AiTaskId } from "./types";
import type { RouteContext } from "./orchestrator/AiOrchestrator";
import type { ProductionTextCompletion } from "./orchestrator/productionRuntimes";
import { cleanupOnlyDescriptor, createModelRegistry, isRetiredGenerativeRuntime, NEEDLE_RUNTIME_ID, productionModelRegistry, RETIRED_MODEL_NOTICE, distributionPolicyOf, modelSupportsAbi, type ModelDescriptor, type ModelRegistry } from "./modelDescriptors";
import { ResidencyCoordinator, ResidencyBusyError } from "./residencyCoordinator";
import { sourcesFor, validateArtifactMirrors, type ArtifactMirrors } from "./modelSupply";
import { runManagedBundle } from "./download/bundle";
import { parseImportedCatalogue } from "./download/import";
import { describeOfflineReadiness } from "./modelReadiness";

/** Map a descriptor runtimeId to the coordinator's residency owner. */
function ownerForRuntime(runtimeId: string): "needle" | "none" {
  return runtimeId === NEEDLE_RUNTIME_ID ? "needle" : "none";
}
/**
 * Consumer download catalogue, derived from the canonical descriptor registry
 * — never edited by hand, never indexed by position in production logic.
 * `label` mirrors the descriptor display name.
 */
export const DOWNLOAD_MODELS = productionModelRegistry().catalogue().map((descriptor) => ({
  modelId: descriptor.modelId,
  label: descriptor.displayName,
  fileName: descriptor.fileName,
  bytes: descriptor.bytes,
  url: descriptor.url,
}));
/** Consumer copy for a device the catalogue does not support. */
export const DEVICE_INCOMPATIBLE_REASON = "Unavailable on this device.";
/**
 * Audit closure: sign-out never waits longer than this for native settlement
 * before finishing. The reset barrier (not the wait) owns safety — an expired
 * wait defers engine unload, never forces it.
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
 * Audit closure: one real native tool schema per advertised structured task.
 * The record_item schema only satisfies report extraction — search filters
 * (query/category/status/dateRangeText) and category classification
 * (category/confidence) each need their own tool, or the advertised roles are
 * false capabilities. A task without a strategy fails closed here instead of
 * borrowing another task's schema.
 *
 * Needle is a tool model, not a chat LLM — it receives the raw user request
 * (see GenerateOptions.localTaskInput) and selects/fills its one declared tool
 * from what the user said. The `system` strings below are environment facts,
 * never model-steering instructions; the tool descriptions name the actual
 * extraction action. Required stays empty for extraction (a required value
 * with no grounding withholds the whole record instead of guessing — partial
 * extraction is the app contract, enforced by validateReportSlots
 * downstream). Category binds the canonical ITEM_CATEGORIES enum; engine
 * confidence arrives as the top-level Needle score, never as a tool argument.
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
 * intersects the descriptor's verified ABIs, and the required native
 * runtime/plugin exists in this build. Unknown ABIs and unknown formats never
 * count. Runtime resolution is descriptor-first (Needle needs the native
 * bridge) with a format fallback for test/custom descriptors. UI disabling is
 * presentation only — `download()` enforces this independently, and it is
 * also re-checked at run time.
 */
export function compatibilityOf(
  descriptor: ModelDescriptor,
  deviceAbis: readonly string[],
  bridges: { readonly needle: boolean },
): DeviceCompatibility {
  const abiOk = deviceAbis.some((abi) => modelSupportsAbi(descriptor, abi));
  if (!abiOk) return { compatible: false, reason: DEVICE_INCOMPATIBLE_REASON };
  const runtimeOk = descriptor.runtimeId === NEEDLE_RUNTIME_ID
    ? bridges.needle
    : descriptor.format === "cact" && bridges.needle;
  if (!runtimeOk) return { compatible: false, reason: DEVICE_INCOMPATIBLE_REASON };
  return { compatible: true };
}
type NeedleBridge = Pick<CapacitorNeedleBridge, "bridgeName" | "isNeedleAvailable" | "embeddingDimension" | "loadModel" | "embedNeedleTexts" | "initTools" | "completeJson" | "unload">;

export class ApplicationAiService {
  readonly boot: ProductionBoot;
  readonly ready: Promise<void>;
  readonly android: boolean;
  /** The descriptor authority behind every model decision. */
  private readonly baseRegistry: ModelRegistry;
  private imported: ModelDescriptor[] = [];
  get registry(): ModelRegistry { return createModelRegistry([...this.baseRegistry.descriptors, ...this.imported]); }
  private root = "";
  private embedder: NativeNeedleEmbedder | undefined;
  private loadingNeedle: Promise<void> | undefined;
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
  /** The single authority for residency, operations, and inference flights. */
  private readonly coordinator = new ResidencyCoordinator();
  private driver?: ModelDownloadDriver;
  private needle?: NeedleBridge;
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

  constructor(options: { android: boolean; driver?: ModelDownloadDriver; needle?: NeedleBridge; descriptors?: readonly ModelDescriptor[] }) {
    this.android = options.android;
    this.baseRegistry = options.descriptors
      ? createModelRegistry(options.descriptors)
      : productionModelRegistry();
    if (this.android) {
      this.driver = options.driver ?? new CapacitorModelDownloadDriver();
      this.needle = options.needle ?? new CapacitorNeedleBridge();
    }
    const dimension = () => this.embedder?.dimension ?? 0;
    // Seam roles come from the same descriptor registry that owns pins and
    // ABIs: a model serves a task only when its descriptor permits the role.
    const needleModel = this.registry.descriptorFor(NEEDLE_MODEL_ID);
    const needleRoles = needleModel?.cleanupOnly ? [] : needleModel?.taskRoles ?? [];
    const hasNeedle = this.needle !== undefined && needleRoles.length > 0;
    this.boot = bootProductionAi({
      pins: this.registry.descriptors.map((model) => ({ modelId: model.modelId, sha256: model.sha256, downloadBytes: model.bytes, minFreeRamMb: model.minRamMb })),
      managerOptions: this.driver ? { storageProbe: this.driver, storageHeadroomBytes: 64 * 1024 * 1024 } : undefined,
      ...(hasNeedle ? {
        text: {
          modelId: NEEDLE_MODEL_ID,
          runtimeId: NEEDLE_RUNTIME_ID,
          taskRoles: needleRoles,
          isReady: () => this.ensureNeedle(),
          // Tool-constrained completion returning the slot envelope string
          // (tasks with JSON contracts). Needle is the proven tool model: each
          // advertised structured task installs its OWN tool schema (see
          // STRUCTURED_STRATEGIES) — never one generic schema borrowed across
          // tasks.
          completeStructured: (taskId: string, input: string, signal?: AbortSignal) => this.completeNeedleStructured(taskId, input, signal),
        },
        embedding: { modelId: NEEDLE_MODEL_ID, runtimeId: NEEDLE_RUNTIME_ID, taskRoles: needleRoles, get dimension() { return dimension(); }, isReady: () => this.ensureNeedle(), embed: (texts: string[]) => this.embedder!.embedNeedleTexts(texts) },
      } : {}),
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
    for (const stored of parseImportedCatalogue(await this.driver.readMetadata?.(`${this.root}/imports.json`) ?? null)) {
      const d = this.storedDescriptor(stored);
      if (!this.registry.descriptorFor(d.modelId)) {
        this.imported.push(d);
        this.manager.registerImportedAsset({ modelId: d.modelId, sha256: d.sha256, downloadBytes: d.bytes, minFreeRamMb: d.minRamMb });
      }
    }
    for (const model of this.registry.descriptors.filter((d) => d.downloadable || d.cleanupOnly || d.trust === "imported")) {
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
        // A present but invalid installed file is not a clean installation.
        // Keep it visible for repair/removal, including after a restart.
        if (actual !== "") this.manager.dispatch(model.modelId, { type: "FAIL", reason: "checksum verification failed" });
      }
    }
  }
  private requireAndroid() { if (!this.android || !this.driver) throw new Error("On-device AI requires the Android app."); }
  private bridges() { return { needle: this.needle !== undefined }; }
  /**
   * Device ABI set from the shared platform/download bridge, not a model
   * runtime that can be retired. Unreadable or absent facts yield an empty
   * set, which no descriptor verifies — fail-closed.
   */
  private async deviceAbis(): Promise<readonly string[]> {
    if (this.deviceAbiCache === undefined) {
      let abis: readonly string[] = [];
      try {
        const raw: unknown = await this.driver?.supportedAbis?.();
        abis = validatedDeviceAbis(raw);
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
    this.requireActive(this.registry.requireDescriptor(modelId));
    if (!describeOfflineReadiness(this.manager, modelId).ready) throw new Error("Model is not installed and verified");
  }
  private requireActive(descriptor: ModelDescriptor): void {
    if (descriptor.cleanupOnly) throw new Error(RETIRED_MODEL_NOTICE);
  }
  /** Imports from retired engines survive only as cleanup records. */
  private storedDescriptor(descriptor: ModelDescriptor): ModelDescriptor {
    const activeRuntime = this.baseRegistry.descriptors.some((d) => d.runtimeId === descriptor.runtimeId && !d.cleanupOnly);
    return isRetiredGenerativeRuntime(descriptor.runtimeId) && !activeRuntime ? cleanupOnlyDescriptor(descriptor) : descriptor;
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
      this.requireActive(model);
      const mirrors = typeof mirror === "string" ? { [model.fileName]: mirror } : mirror ?? {};
      validateArtifactMirrors(model, mirrors);
      // Acquisition eligibility is separate from task qualification.
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
      // Publish the release on EVERY exit, including the ones that never
      // reached the device (aborted signal, invalid mirror, reset, refused
      // compatibility). Without this the row keeps a busy flag the service
      // already reads as false, and no subscriber is told the attempt ended.
      if (this.claiming.delete(modelId)) this.changed();
    }
  }
  async pause(modelId: string) {
    const active = this.active.get(modelId);
    if (!active) return;
    active.abort.abort();
    await this.driver!.cancelDownload(this.paths(modelId).stagingPath);
    await active.work;
  }

  private async saveImported(descriptors: readonly ModelDescriptor[] = this.imported): Promise<void> {
    if (!this.driver?.writeMetadata) throw new Error("Private import metadata storage is unavailable.");
    await this.driver.writeMetadata(`${this.root}/imports.json`, JSON.stringify(descriptors.map((d) => ({ sha256: d.sha256, bytes: d.bytes, format: d.format, modality: d.capabilities.includes("vision") ? "vision" : "text", license: d.license }))));
  }

  /**
   * Re-verify an installed model against its catalogue pin. A match keeps
   * the install with a quiet notice; a missing or mismatched file drops the
   * false-installed claim (DELETE) so readiness fails closed, and the
   * resident is released when it was the Needle engine.
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
          additionalPaths: [
            `${this.root}/models/${modelId}`,
            `${this.root}/bundle-work/models/${modelId}`,
            `${this.root}/bundle-work/staging/${modelId}`,
          ],
        });
        if (descriptor.trust === "imported") {
          const remaining = this.imported.filter((d) => d.modelId !== modelId);
          await this.saveImported(remaining);
          this.imported = remaining;
        }
        this.coordinator.released(ownerForRuntime(descriptor.runtimeId));
        this.notices.delete(modelId);
      } catch (error) {
        this.manager.dispatch(modelId, { type: "DELETE" });
        this.manager.dispatch(modelId, { type: "FAIL", reason: "removal failed" });
        throw error;
      } finally { this.coordinator.endExclusive(label); }
    } finally { this.operating.delete(modelId); this.changed(); }
  }
  /**
   * Runtime-owned unload. Ownership dispatches on the descriptor's runtimeId —
   * never a Needle-vs-else branch — so an unknown runtime fails closed instead
   * of unloading the wrong engine.
   */
  private async unloadDescriptor(descriptor: ModelDescriptor): Promise<void> {
    switch (descriptor.runtimeId) {
      case NEEDLE_RUNTIME_ID:
        await this.needle?.unload(); this.embedder = undefined; this.matching = "use"; return;
      default:
        // A retired runtime is a cleanup identity, not a resident: there is no
        // engine to unload, and its files must stay removable. Anything else is
        // an unknown runtime and fails closed instead of guessing.
        if (descriptor.cleanupOnly) return;
        throw new Error(`No production runtime adapter for ${descriptor.runtimeId}`);
    }
  }
  /** Tool-constrained structured generation stays on Needle (the proven tool model). */
  private async completeNeedleStructured(taskId: string, input: string, _signal?: AbortSignal): Promise<ProductionTextCompletion> {
    if (this.needle === undefined) throw new Error("No qualified on-device structured runtime is installed");
    await this.ensureNeedle();
    return { text: await this.extractTaskFields(taskId, input), modelId: NEEDLE_MODEL_ID, runtimeId: NEEDLE_RUNTIME_ID };
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
        // Single-resident rule via the coordinator: Needle is the only
        // retained local runtime, so a switch has nothing else to evict.
        await this.coordinator.switchTo("needle", {
          evict: async () => { this.embedder = undefined; },
          load: async () => {
            this.embedder = await createNativeNeedleEmbedder(this.needle!, { installedPath: this.paths(NEEDLE_MODEL_ID).installedPath });
          },
        });
      }
    })().finally(() => { this.loadingNeedle = undefined; });
    await this.loadingNeedle; return true;
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

  /**
   * Account/logout cleanup with a reset barrier.
   *
   * Abort the visible flight immediately and invalidate old-account output,
   * then unload engines ONLY after tracked native work settles — a
   * non-cancellable native call is never torn down mid-execution. If the
   * bounded sign-out wait expires first, sign-out still finishes but the
   * barrier stays up (local intelligence, removal, downloads, and switches
   * all refuse) and engine cleanup is deferred until settlement actually
   * occurs. A permanently wedged native call can hold local intelligence
   * unavailable until process restart; that is preferable to unloading
   * underneath live native code. Downloads and pins survive — logout never
   * wipes models.
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
 * Account/logout cleanup entry point for the sign-out wipe
 * (`clearUserScopedLocalState`). No-op before first use; never throws.
 */
export async function resetLocalAiForAccount(): Promise<void> {
  try {
    await applicationAi?.resetForAccount();
  } catch {
    // Best-effort: logout cleanup must never fail sign-out.
  }
}
