/**
 * Offline on-device provider adapter (AI-023, LiteRT path).
 *
 * Pure TypeScript over two injected seams — `OfflineModelManager` (which
 * model is in what install state) and `OfflineNativeBridge` (the native
 * generate/load/unload surface). There is deliberately NO network code
 * here: no fetch, no endpoint strings, no model URLs, no silent downloads.
 * Every failure is fail-closed with a non-retryable contract error unless
 * stated otherwise.
 *
 * Archive lineage (tag `local-ai-final-2026-09-25`, study only, nothing
 * cherry-picked):
 * - `services/models/modelTransfers.ts` -> gate/verify/commit: explicit
 *   user gating, resume-by-offset, incremental hash against a catalogue
 *   pin, partial bytes staged for resume and never reported as installed.
 *   Maps to `OfflineModelManager` (`../offlineModelManager.ts`).
 * - `services/models/qwenLifecycle.ts` -> `installed` means
 *   transfer-verified + checksum-pinned, never mere file presence; a
 *   TEXT_READY-style proof gates serving. Maps to the
 *   installed+checksumVerified readiness gate below.
 * - `services/models/textRuntime.ts` -> explicit-modelId text surface
 *   (`generateText({modelId, prompt, ...})`) and the honest admission that
 *   streaming has no bridge method yet (bridge-backed engine reports
 *   `supportsStreaming: false`). Maps to `OfflineNativeBridge.generate`
 *   being an async-iterator seam, now bound by ApplicationAiService.
 * - `android/.../vlm/GenerativeResidencyArbiter.kt` -> single-resident
 *   invariant, residency as runtime-only state. Maps to LOAD/LOADED/UNLOAD
 *   handling that never persists residency (see manager `snapshot`).
 * - `services/models/candidateHost.ts` -> Capacitor plugin shape
 *   (`downloadCandidateModel` / `useCandidateModel` /
 *   `releaseCandidateModel` + state listeners). Maps to the NATIVE SEAM
 *   note below.
 *
 * NATIVE SEAM (bound by ApplicationAiService, with test fakes):
 * Needle supplies structured text; SmolVLM2 supplies approved image streaming.
 * The following archive notes describe the interface rationale:
 * - `isAvailable()` -> plugin presence probe (cf. archive
 *   `isTextRuntimePresent` in `textRuntime.ts`): resolves false on web and
 *   on builds without the LiteRT-LM native module, so the adapter fails
 *   closed with `runtime_unavailable` instead of throwing.
 * - `load(modelId)` -> resident-switch: evict any resident engine first
 *   (archive `GenerativeResidencyArbiter` single-resident rule), mmap the
 *   verified `.litertlm` weights for `modelId`, run the model self-test,
 *   resolve only on READY. Must reject unknown/unverified ids fail-closed.
 * - `generate(prompt, signal)` -> chunked inference as an async iterator
 *   of `{ textDelta }`. The archive bridge has no streaming method yet, so
 *   the native worker must add one: LiteRT-LM `LlmInference` async partial
 *   results (JNI callback) forwarded as Capacitor listener events keyed by
 *   a generation id (cf. archive `candidateInferenceState` listener keyed
 *   by entryId, real stage transitions only, never fabricated
 *   percentages), with `signal` wired to the archive-noted missing
 *   cancellation token (`cancelInference`). Each emitted chunk becomes one
 *   `text` stream event; token counts stay unreported (unknown, never
 *   zero-filled).
 * - `unload()` -> release the resident engine (cf. archive
 *   `releaseCandidateModel`); residency is runtime-only and never
 *   persisted, so process death always restarts `unloaded` (see manager
 *   `snapshot`/`restore`).
 *
 * Provider identity note: identifies as `"offline"` (IF-002). The registry
 * reaches the application-owned Android service without a BYOK vault slot;
 * web fails closed. Selection checks compare against
 * `OFFLINE_PROVIDER_ID`, never a bare string.
 */

import type {
  ModelRecord,
  NormalizedRequest,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderId,
  StreamEvent,
} from "../providerContract";
import { hasNoInlineImageBytesOrKeys } from "../providerContract";
import type { OfflineModelManager } from "../offlineModelManager";
import { profileFor } from "../modelProfiles";

/**
 * Provider id this adapter serves.
 */
export const OFFLINE_PROVIDER_ID: ProviderId = "offline";

const ATTEMPT = 1;

/** Machine-readable offline failure codes (advisory data, never UI). */
export type OfflineErrorCode =
  | "invalid_provider"
  | "request_not_allowed"
  | "no_messages"
  | "invalid_max_output_tokens"
  | "unknown_model"
  | "model_not_installed"
  | "vision_unsupported"
  | "runtime_unavailable"
  | "runtime_busy"
  | "runtime_load_failed"
  | "generation_failed";

/**
 * Prompt handed to the native bridge. Id references only — never image
 * bytes or key material, mirroring the `NormalizedRequest` boundary.
 */
export interface OfflinePrompt {
  readonly modelId: string;
  readonly task: string;
  readonly systemText?: string;
  readonly summaryText?: string;
  readonly recentTurns: readonly { readonly role: string; readonly text: string }[];
  readonly currentText: string;
  readonly maxOutputTokens: number;
}

/** One native generation chunk: a text delta, nothing else. */
export interface OfflineGenerationChunk {
  readonly textDelta: string;
}

/**
 * Native text seam bound by ApplicationAiService to Needle; faked in tests.
 */
export interface OfflineNativeBridge {
  /** Human-readable bridge name for diagnostics (e.g. "litert-lm"). */
  readonly bridgeName: string;
  /** False on web / builds without the native module (fail closed). */
  isAvailable(): boolean;
  /** Make `modelId` resident (evict-then-load, self-test, resolve on READY). */
  load(modelId: string): Promise<void>;
  /** Release the resident engine, if any. */
  unload(): Promise<void>;
  /** Chunked inference; must honor `signal` (cancelInference). */
  generate(
    prompt: OfflinePrompt,
    signal: AbortSignal,
  ): AsyncGenerator<OfflineGenerationChunk>;
}

export interface OfflineAdapterDeps {
  readonly manager: OfflineModelManager;
  readonly bridge: OfflineNativeBridge;
  /** App-controlled immutable instructions; never invented by the adapter. */
  readonly buildSystemText?: (request: NormalizedRequest) => string;
  /**
   * Image-capable vision seam (SmolVLM2-500M native plugin). Optional:
   * absent on web / builds without the native module, where image
   * requests fail closed with `vision_unsupported`. Never inferred from
   * the text bridge — text availability proves nothing about vision.
   */
  readonly visionBridge?: OfflineVisionNativeBridge;
  /**
   * Compute backend for the vision resident, already resolved against
   * probe evidence by `vision/backendSelector`. Defaults to CPU-first when
   * no selector is injected (safe fallback, never GPU by guess).
   */
  readonly resolveVisionBackend?: () => "cpu" | "gpu";
  /**
   * Resolve an approved image id to base64 bytes for the vision bridge.
   * Required alongside `visionBridge` for image requests; image bytes are
   * never inlined in the request itself (see `hasNoInlineImageBytesOrKeys`).
   */
  readonly resolveApprovedImage?: (imageId: string) => Promise<string>;
}

/**
 * One vision inference request for the native bridge. References the
 * approved image by bytes resolved via `resolveApprovedImage` — the
 * request itself carries ids only, and bytes stay behind the bridge
 * boundary (never logged, never persisted by the adapter).
 */
export interface OfflineVisionRequest {
  readonly generationId: string;
  readonly imageBase64: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

/**
 * Image-capable native vision seam (see NATIVE SEAM in the header).
 * Implemented by the SmolVLM2-500M Capacitor plugin (`FindbackSmolVlm`);
 * faked in tests. A rejected `isVisionAvailable()` (or throw) means the
 * vision path is unavailable — never a reason to try cloud.
 */
export interface OfflineVisionNativeBridge {
  /** Human-readable bridge name for diagnostics (e.g. "smolvlm2-litertlm"). */
  readonly bridgeName: string;
  /** True only when an image-capable resident is loaded and alive. */
  isVisionAvailable(): Promise<boolean>;
  /**
   * Make `modelId` vision-resident (evict-then-load, self-test, resolve on
   * READY). `backend` arrives already resolved against probe evidence by
   * `vision/backendSelector` — the bridge never re-decides.
   */
  loadVisionModel(args: {
    readonly modelId: string;
    readonly backend: "cpu" | "gpu";
    readonly installedPath?: string;
    readonly maxOutputTokens: number;
  }): Promise<void>;
  /** Release the vision resident, if any (idempotent). */
  unloadVisionModel(): Promise<void>;
  /** Chunked vision inference; must honor `signal` (cancelGeneration). */
  describeImage(
    visionRequest: OfflineVisionRequest,
    signal: AbortSignal,
  ): AsyncGenerator<OfflineGenerationChunk>;
  /** Abort an in-flight generation. */
  cancelGeneration(generationId: string): Promise<void>;
}

/** Readiness verdict for one on-device model. */
export type OfflineReadiness =
  | { readonly ready: true; readonly modelId: string }
  | {
      readonly ready: false;
      readonly modelId: string;
      readonly code: "unknown_model" | "model_not_installed" | "checksum_unverified";
      readonly reason: string;
    };

/** Storage/memory estimates over injected asset facts (advisory, never UI). */
export interface OfflineAssetFacts {
  readonly modelId: string;
  /** Exact download size in bytes (resume math + storage gate). */
  readonly downloadBytes: number;
  /** Advisory minimum free RAM in MiB for a load attempt. */
  readonly minFreeRamMb: number;
}

export interface OfflineStorageEstimate {
  readonly modelId: string;
  readonly totalBytes: number;
  readonly stagedBytes: number;
  readonly remainingBytes: number;
}

function* failureEvents(
  code: string,
  message: string,
  retryable: boolean,
): Generator<StreamEvent> {
  yield { kind: "phase", phase: "failed", attempt: ATTEMPT, message: code };
  yield { kind: "error", attempt: ATTEMPT, code, message, retryable };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "error" };
}

function* cancelledEvents(): Generator<StreamEvent> {
  yield { kind: "phase", phase: "cancelled", attempt: ATTEMPT };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "cancelled" };
}

/**
 * Readiness of one model: installed AND checksum-verified AND known to
 * the manager. Anything else is not ready — file presence alone never
 * counts (archive `qwenLifecycle.ts` rule).
 */
export function describeOfflineReadiness(
  manager: OfflineModelManager,
  modelId: string,
): OfflineReadiness {
  const status = manager.statusOf(modelId);
  if (status === undefined) {
    return {
      ready: false,
      modelId,
      code: "unknown_model",
      reason: `unknown model ${modelId}`,
    };
  }
  if (status.download !== "installed") {
    return {
      ready: false,
      modelId,
      code: "model_not_installed",
      reason: `model ${modelId} is ${status.download}, not installed`,
    };
  }
  if (status.checksumVerified !== true) {
    return {
      ready: false,
      modelId,
      code: "checksum_unverified",
      reason: `model ${modelId} is installed but its checksum is unverified`,
    };
  }
  return { ready: true, modelId };
}

/**
 * Storage estimate for one model: total vs staged vs remaining download
 * bytes. Pure arithmetic over injected facts — no storage probing here
 * (probing is the manager's `StorageProbe` seam).
 */
export function estimateOfflineStorage(
  asset: OfflineAssetFacts,
  stagedBytes: number,
): OfflineStorageEstimate {
  const staged = Number.isFinite(stagedBytes) && stagedBytes > 0 ? Math.floor(stagedBytes) : 0;
  return {
    modelId: asset.modelId,
    totalBytes: asset.downloadBytes,
    stagedBytes: staged,
    remainingBytes: Math.max(0, asset.downloadBytes - staged),
  };
}

/**
 * Advisory minimum free RAM in MiB for a load attempt, from the injected
 * asset facts. The adapter never measures RAM itself.
 */
export function estimateOfflineMemoryMb(asset: OfflineAssetFacts): number {
  return asset.minFreeRamMb;
}

/**
 * WS3 skeleton: explicit on-device vision backend states
 * (SmolVLM2-500M LiteRT stable path).
 *
 * - `"ready"`: the model is installed+verified AND an image-capable
 *   vision bridge is present, so an image request may take the on-device
 *   vision path.
 * - `"unavailable"`: anything else. The request fails closed with typed
 *   `vision_unsupported` (see `OfflineVisionUnavailable`).
 *
 * There is no third outcome by construction: the only permitted fallback
 * is the literal `"no-fallback"` (`OfflineVisionFallback`). Callers must
 * surface the typed refusal — silently retrying via a cloud provider is
 * never allowed, and this module offers no value that could express it.
 * The compute-backend choice inside the vision path (CPU-first, GPU only
 * with measured probe-pass evidence) lives in
 * `../vision/backendSelector`; it likewise has no cloud member.
 */
export type OfflineVisionState = "ready" | "unavailable";

/** Literal marker: on-device vision never falls back, silently or otherwise. */
export const OFFLINE_VISION_NO_FALLBACK = "no-fallback" as const;

/** The only permitted fallback for on-device vision: none. */
export type OfflineVisionFallback = typeof OFFLINE_VISION_NO_FALLBACK;

export type OfflineVisionUnavailable = {
  readonly state: "unavailable";
  readonly code: Extract<OfflineErrorCode, "vision_unsupported">;
  readonly reason: string;
  readonly fallback: OfflineVisionFallback;
  readonly retryable: false;
};

export type OfflineVisionReady = {
  readonly state: "ready";
  readonly fallback: OfflineVisionFallback;
};

/** Verdict for the on-device vision path of one request. */
export type OfflineVisionVerdict = OfflineVisionReady | OfflineVisionUnavailable;

export interface OfflineVisionProbe {
  /** The model already passed `describeOfflineReadiness` (installed+verified). */
  readonly modelReady: boolean;
  /**
   * An image-capable vision bridge is present and its resident is loaded.
   * Callers derive this from the injected `OfflineVisionNativeBridge`
   * (`isVisionAvailable()`); the default with no seam is `false`. Never
   * inferred from the text bridge — text availability proves nothing
   * about vision.
   */
  readonly visionBridgeReady: boolean;
}

/**
 * Verdict for the on-device vision path. Pure: no bridge calls, no
 * downloads, no cloud. Unavailable carries the exact `vision_unsupported`
 * contract error the adapter streams, so the failure stays typed and
 * non-retryable end to end.
 */
export function describeOfflineVision(probe: OfflineVisionProbe): OfflineVisionVerdict {
  if (probe.modelReady && probe.visionBridgeReady) {
    return { state: "ready", fallback: OFFLINE_VISION_NO_FALLBACK };
  }
  const reason = !probe.modelReady
    ? "on-device model is not ready; vision unavailable"
    : "on-device vision is not proven; text requests only";
  return {
    state: "unavailable",
    code: "vision_unsupported",
    reason,
    fallback: OFFLINE_VISION_NO_FALLBACK,
    retryable: false,
  };
}

/**
 * Build the bridge prompt from a normalized request. Text only: callers
 * must reject `approvedImageIds` before calling (vision is unproven
 * on-device). History attachments are intentionally dropped — approval is
 * per-request, mirroring the sibling cloud adapters.
 */
export function buildOfflinePrompt(
  request: NormalizedRequest,
  systemText?: string,
): OfflinePrompt {
  const summaryText = request.summary?.summaryText.trim() !== "" ? request.summary?.summaryText : undefined;
  const trimmedSystem = systemText?.trim() ?? "";
  return {
    modelId: request.selection.modelId,
    task: request.task,
    ...(trimmedSystem !== "" ? { systemText: trimmedSystem } : {}),
    ...(summaryText !== undefined ? { summaryText } : {}),
    recentTurns: request.recentTurns
      .filter((turn) => turn.text.trim() !== "")
      .map((turn) => ({ role: turn.role, text: turn.text })),
    currentText: request.currentText,
    maxOutputTokens: request.maxOutputTokens,
  };
}

async function* completeOfflineVision(
  request: NormalizedRequest,
  deps: OfflineAdapterDeps,
  visionBridge: OfflineVisionNativeBridge,
): AsyncGenerator<StreamEvent> {
  const signal = request.signal;
  const modelId = request.selection.modelId;

  // The caller already emitted `queued`; do not repeat it here.
  if (signal.aborted) {
    yield* cancelledEvents();
    return;
  }

  // One image per call until multi-image batching is proven on-device.
  if (request.approvedImageIds.length !== 1) {
    yield* failureEvents(
      "vision_unsupported",
      "on-device vision supports exactly one approved image per call",
      false,
    );
    return;
  }
  const resolveImage = deps.resolveApprovedImage;
  if (resolveImage === undefined) {
    yield* failureEvents(
      "vision_unsupported",
      "on-device vision has no approved-image resolver on this build",
      false,
    );
    return;
  }

  let imageBase64: string;
  try {
    imageBase64 = await resolveImage(request.approvedImageIds[0] as string);
  } catch {
    yield* failureEvents(
      "vision_unsupported",
      "the approved image could not be resolved for on-device vision",
      false,
    );
    return;
  }
  if (imageBase64.trim() === "") {
    yield* failureEvents(
      "vision_unsupported",
      "the approved image resolved to empty bytes",
      false,
    );
    return;
  }

  // Ensure vision residency (backend pre-resolved by the selector; CPU
  // default here is the safe fallback, never a GPU guess).
  try {
    await visionBridge.loadVisionModel({
      modelId,
      backend: deps.resolveVisionBackend?.() ?? "cpu",
      maxOutputTokens: request.maxOutputTokens,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message.slice(0, 400)
        : "the on-device vision runtime failed to load the model";
    yield* failureEvents("runtime_load_failed", message, false);
    return;
  }
  if (signal.aborted) {
    yield* cancelledEvents();
    return;
  }

  const generationId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `vision-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const prompt =
    request.currentText.trim() !== "" ? request.currentText : "Describe this image.";

  yield { kind: "phase", phase: "sending", attempt: ATTEMPT };

  let sawText = false;
  try {
    for await (const chunk of visionBridge.describeImage(
      { generationId, imageBase64, prompt, maxOutputTokens: request.maxOutputTokens },
      signal,
    )) {
      if (signal.aborted) {
        await visionBridge.cancelGeneration(generationId).catch(() => undefined);
        yield* cancelledEvents();
        return;
      }
      const delta = chunk.textDelta;
      if (delta === "") continue;
      if (!sawText) {
        sawText = true;
        yield { kind: "phase", phase: "first-token", attempt: ATTEMPT };
        yield { kind: "phase", phase: "streaming", attempt: ATTEMPT };
      }
      yield { kind: "text", attempt: ATTEMPT, delta };
    }
  } catch (error) {
    if (signal.aborted) {
      await visionBridge.cancelGeneration(generationId).catch(() => undefined);
      yield* cancelledEvents();
      return;
    }
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message.slice(0, 400)
        : "on-device vision generation failed";
    yield* failureEvents("generation_failed", message, false);
    return;
  }

  yield { kind: "phase", phase: "complete", attempt: ATTEMPT };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "complete" };
}

async function* completeOffline(
  request: NormalizedRequest,
  deps: OfflineAdapterDeps,
): AsyncGenerator<StreamEvent> {
  const { manager, bridge } = deps;
  const signal = request.signal;

  yield { kind: "phase", phase: "queued", attempt: ATTEMPT };
  if (signal.aborted) {
    yield* cancelledEvents();
    return;
  }

  if (request.selection.provider !== OFFLINE_PROVIDER_ID) {
    yield* failureEvents(
      "invalid_provider",
      "request selection is not the offline provider",
      false,
    );
    return;
  }
  if (!hasNoInlineImageBytesOrKeys(request)) {
    yield* failureEvents(
      "request_not_allowed",
      "request carries inline data or unexpected fields",
      false,
    );
    return;
  }
  if (!Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
    yield* failureEvents(
      "invalid_max_output_tokens",
      "max output tokens must be a positive number",
      false,
    );
    return;
  }

  const modelId = request.selection.modelId;
  const readiness = describeOfflineReadiness(manager, modelId);
  if (!readiness.ready) {
    const code: OfflineErrorCode =
      readiness.code === "unknown_model" ? "unknown_model" : "model_not_installed";
    yield* failureEvents(code, readiness.reason, false);
    return;
  }

  // Vision path: model verdict first so a missing model never reads as a
  // vision refusal, then the injected vision seam. With no seam (web /
  // builds without the native module) the bridge is never ready and the
  // verdict stays explicit `vision_unsupported` with `no-fallback`: the
  // refusal is typed and must be surfaced, never silently retried via
  // cloud. Text-bridge availability is deliberately NOT consulted — a
  // working text path proves nothing about vision.
  if (request.approvedImageIds.length > 0) {
    const visionBridge = deps.visionBridge;
    // No seam injected (web / builds without the native module): the
    // probe default is visionBridgeReady: false and the verdict below
    // stays explicit `vision_unsupported` with `no-fallback`.
    let visionBridgeReady = false;
    if (visionBridge !== undefined) {
      try {
        visionBridgeReady = await visionBridge.isVisionAvailable();
      } catch {
        visionBridgeReady = false;
      }
    }
    const verdict = describeOfflineVision({ modelReady: true, visionBridgeReady });
    switch (verdict.state) {
      case "ready": {
        // Defensive: verdict ready implies a present, available seam, but
        // never call a possibly-absent bridge — fail closed instead.
        if (visionBridge === undefined) {
          yield* failureEvents(
            "vision_unsupported",
            "on-device vision is not proven; text requests only",
            false,
          );
          return;
        }
        yield* completeOfflineVision(request, deps, visionBridge);
        return;
      }
      case "unavailable":
        yield* failureEvents(verdict.code, verdict.reason, verdict.retryable);
        return;
    }
  }

  const hasContent =
    request.currentText.trim() !== "" ||
    request.recentTurns.some((turn) => turn.text.trim() !== "") ||
    (request.summary?.summaryText.trim() ?? "") !== "";
  if (!hasContent) {
    yield* failureEvents("no_messages", "request carries no message content", false);
    return;
  }

  if (!bridge.isAvailable()) {
    yield* failureEvents(
      "runtime_unavailable",
      `the ${bridge.bridgeName} native runtime is not available on this device`,
      false,
    );
    return;
  }
  if (signal.aborted) {
    yield* cancelledEvents();
    return;
  }

  // Ensure residency. Residency is runtime-only (never persisted): an
  // interrupted process always restarts `unloaded`, so LOAD here performs
  // no download — the model is already installed and verified above.
  const residency = manager.statusOf(modelId)?.residency ?? "unloaded";
  if (residency === "unloading") {
    yield* failureEvents(
      "runtime_busy",
      "the on-device runtime is busy unloading; retry the request",
      false,
    );
    return;
  }
  {
    try {
      if (residency === "unloaded") manager.dispatch(modelId, { type: "LOAD" });
      await bridge.load(modelId);
      const after = manager.statusOf(modelId)?.residency;
      if (after === "loading") manager.dispatch(modelId, { type: "LOADED" });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim() !== ""
          ? error.message.slice(0, 400)
          : "the on-device runtime failed to load the model";
      yield* failureEvents("runtime_load_failed", message, false);
      return;
    }
  }
  if (signal.aborted) {
    yield* cancelledEvents();
    return;
  }

  const systemText = deps.buildSystemText?.(request)?.trim();
  const prompt = buildOfflinePrompt(
    request,
    systemText !== undefined && systemText !== "" ? systemText : undefined,
  );

  yield { kind: "phase", phase: "sending", attempt: ATTEMPT };

  let sawText = false;
  try {
    for await (const chunk of bridge.generate(prompt, signal)) {
      if (signal.aborted) {
        yield* cancelledEvents();
        return;
      }
      const delta = chunk.textDelta;
      if (delta === "") continue;
      if (!sawText) {
        sawText = true;
        yield { kind: "phase", phase: "first-token", attempt: ATTEMPT };
        yield { kind: "phase", phase: "streaming", attempt: ATTEMPT };
      }
      yield { kind: "text", attempt: ATTEMPT, delta };
    }
  } catch (error) {
    if (signal.aborted) {
      yield* cancelledEvents();
      return;
    }
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? error.message.slice(0, 400)
        : "on-device generation failed";
    yield* failureEvents("generation_failed", message, false);
    return;
  }

  yield { kind: "phase", phase: "complete", attempt: ATTEMPT };
  yield { kind: "done", attempt: ATTEMPT, stopReason: "complete" };
}

/**
 * Build the offline `ProviderAdapter`.
 *
 * The adapter never downloads: a model that is not installed and
 * checksum-verified fails closed with `model_not_installed` (or
 * `unknown_model`) without touching the native bridge. No retries live
 * here — `attempt` is always 1, so the coordinator stays the single owner
 * of retries. Token usage is never reported: counts are unknown on this
 * path and are never zero-filled.
 */
export function createOfflineAdapter(deps: OfflineAdapterDeps): ProviderAdapter {
  return {
    id: OFFLINE_PROVIDER_ID,
    capabilities(): ProviderCapabilities {
      return {
        // Vision/context/window claims are unproven on-device: unknown
        // stays unknown (callers take the conservative path).
        vision: { state: "unknown" },
        maxImagesPerCall: { state: "unknown" },
        contextTokens: { state: "unknown" },
        maxOutputTokens: { state: "unknown" },
        streaming: { state: "known", value: true },
      };
    },
    async listModels(): Promise<readonly ModelRecord[]> {
      const records: ModelRecord[] = [];
      for (const modelId of deps.manager.assetIds()) {
        const readiness = describeOfflineReadiness(deps.manager, modelId);
        if (!readiness.ready) continue;
        records.push({
          provider: OFFLINE_PROVIDER_ID,
          id: modelId,
           input: profileFor(modelId)?.supportsVision ? ["text", "image"] : ["text"],
          output: ["text"],
          prices: [],
          priceClass: "free",
          retrievedAt: new Date().toISOString(),
          entitlement: "verified",
        });
      }
      return records;
    },
    complete(request: NormalizedRequest): AsyncIterable<StreamEvent> {
      return completeOffline(request, deps);
    },
  };
}
