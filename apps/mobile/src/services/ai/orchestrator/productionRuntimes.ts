/**
 * WS-G production runtime registration: the task specs name `local-text`,
 * `local-embedding`, and `local-vision`, but the default registry only
 * carries `deterministic-local`. This module registers production adapters
 * for exactly those three ids — nothing else, and never the lab-only
 * llama.cpp challenger (lab channel only, never routable).
 *
 * Availability is synchronous and manager-driven: a runtime reports
 * available only while its model is installed AND checksum-verified in the
 * `OfflineModelManager` AND its backend seam is injected (web builds and
 * builds without the native module inject nothing, so they stay
 * unavailable). Seam presence is a build fact, not liveness: every invoke
 * re-probes the resident (`isReady`/`isAvailable`) and fails closed with
 * MODEL_NOT_READY when it died between availability and invoke.
 *
 * Provenance carries the real catalogue profile id, the runtime backend id,
 * and the pinned revision (never "unknown-model"): vendors of these seams
 * report their own modelId, and registration binds the revision from
 * `modelProfiles` at wire-up time.
 */
import { profileFor } from "../modelProfiles";
import { validateNeedleVectors } from "../needle/embedder";
import { describeOfflineReadiness } from "../providers/offline";
import type { OfflineModelManager } from "../offlineModelManager";
import { LOCAL_TASK_INVALID } from "./routeValidation";
import { interpreterFor } from "./taskInterpreters";
import { listTaskSpecs } from "./taskRegistry";
import type { AiRuntime, RuntimeRegistry, RuntimeResult } from "./runtimeRegistry";

export const LOCAL_TEXT_RUNTIME_ID = "local-text" as const;
export const LOCAL_EMBEDDING_RUNTIME_ID = "local-embedding" as const;
export const LOCAL_VISION_RUNTIME_ID = "local-vision" as const;

/** Every runtime id this module may register. The gate asserts this set. */
export const PRODUCTION_RUNTIME_IDS = [
  LOCAL_TEXT_RUNTIME_ID,
  LOCAL_EMBEDDING_RUNTIME_ID,
  LOCAL_VISION_RUNTIME_ID,
] as const;

export type ProductionRuntimeId = (typeof PRODUCTION_RUNTIME_IDS)[number];

/**
 * Text backend seam: the production text model behind one task's generation.
 * The seam returns RAW model strings only — never parsed values. Parsing
 * and validation belong to the task interpreter, in the open, so a future
 * prose model (Qwen/llama) plugs the same seam without a Needle-shaped
 * contract rejecting its output first.
 *
 * Two generation modes: `completeText` is free model completion (prose
 * tasks); `completeStructured` is tool-constrained completion returning the
 * canonical slot envelope string (tasks with JSON contracts). The task id
 * selects the tool schema: each advertised structured task installs its own
 * real schema, never one generic schema borrowed across tasks. Production
 * implements both on the resident engine; fakes implement the modes the
 * test exercises.
 */
export interface ProductionTextBackend {
  readonly modelId: string;
  /**
   * Phase A (Step 6): physical runtime id (e.g. "needle-cact"). Reported in
   * every route result so downstream normalization is driven by the actual
   * producer. (Canonical ids move to the Step 2 descriptor registry.)
   */
  readonly runtimeId: string;
  /**
   * Audit closure: descriptor task roles for this model. The adapter serves
   * a task only when its roles permit it — roles drive selection, they are
   * not documentation.
   */
  readonly taskRoles: readonly string[];
  /**
   * W-A multi-engine text: every installed model id behind this seam (e.g.
   * Qwen prose + Needle structured). Availability holds when ANY listed
   * model is installed and verified; omitted means exactly `modelId`.
   * Provenance still names the real per-call producer (see
   * ProductionTextCompletion).
   */
  readonly modelIds?: readonly string[];
  isReady(): Promise<boolean>;
  /**
   * W-A: the route signal arrives so engines with native cancellation
   * (Qwen text) stop promptly; await-only engines (Needle) ignore it and
   * rely on the route's cooperative race instead.
   */
  completeText(input: string, signal?: AbortSignal): Promise<string | ProductionTextCompletion>;
  completeStructured(taskId: string, input: string, signal?: AbortSignal): Promise<string | ProductionTextCompletion>;
  /**
   * Model id that serves STRUCTURED (tool-constrained) tasks behind this
   * seam. When set, structured roles are advertised only while that model is
   * installed AND verified — a prose-only install (e.g. Qwen alone) must
   * never advertise a structured role the seam cannot serve. Omitted keeps
   * the legacy union behavior for single-engine/test backends.
   */
  readonly structuredModelId?: string;
  /** Qualified prose producer, independently installed from the tool model. */
  readonly proseModelId?: string;
}

/**
 * W-A multi-engine text completion: the producer behind one generation.
 * Composite backends (Qwen prose + Needle structured behind `local-text`)
 * return this so provenance names the real engine; single-engine backends
 * and test fakes keep returning bare strings (resolved to the backend's
 * own modelId/runtimeId).
 */
export interface ProductionTextCompletion {
  readonly text: string;
  readonly modelId: string;
  readonly runtimeId: string;
}

/** Embedding backend seam: native Needle embedder in production. */
export interface ProductionEmbeddingBackend {
  readonly modelId: string;
  /** Physical runtime id (e.g. "needle-cact"); see ProductionTextBackend. */
  readonly runtimeId: string;
  /** Descriptor task roles; the adapter serves only permitted tasks. */
  readonly taskRoles: readonly string[];
  /** Live width from the engine probe; vectors are validated against it. */
  readonly dimension: number;
  isReady(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Vision backend seam: SmolVLM2 native bridge in production. */
export interface ProductionVisionBackend {
  readonly modelId: string;
  /** Physical runtime id (e.g. "smolvlm2-litertlm"); see ProductionTextBackend. */
  readonly runtimeId: string;
  /** Descriptor task roles; the adapter serves only permitted tasks. */
  readonly taskRoles: readonly string[];
  isAvailable(): Promise<boolean>;
  describe(prompt: string, imageBase64: string, signal: AbortSignal): Promise<string>;
}

export interface ProductionRuntimeDeps {
  readonly manager: OfflineModelManager;
  readonly text?: ProductionTextBackend;
  readonly embedding?: ProductionEmbeddingBackend;
  readonly vision?: ProductionVisionBackend;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Thrown internally when the route signal aborts while a backend is in flight. */
export class RouteCancelledError extends Error {
  constructor() {
    super("route signal aborted");
    this.name = "RouteCancelledError";
  }
}

/**
 * Phase A (Step 7): cooperative cancellation for backends without a native
 * signal surface (Needle `completeJson`/`embed` are await-only). The route
 * stops waiting on abort; the orphaned native call can no longer resolve
 * into a route value. Bridges with real cancellation (vision `describe`)
 * receive the signal directly instead.
 */
function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RouteCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new RouteCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function toPromptText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (isRecord(input) && typeof input["text"] === "string") return input["text"];
  if (isRecord(input) && typeof input["prompt"] === "string") return input["prompt"];
  return undefined;
}

/**
 * Manager-driven availability: installed AND checksum-verified. File
 * presence alone never counts (the readiness rule mirrors
 * `describeOfflineReadiness`: unknown models and unverified installs are
 * not ready). The injected seam proves the build ships the native module.
 */
function managerReady(manager: OfflineModelManager, modelId: string): boolean {
  return describeOfflineReadiness(manager, modelId).ready === true;
}

function revisionFor(modelId: string): string | undefined {
  return profileFor(modelId)?.revision;
}

function notReady(modelId: string): RuntimeResult {
  return { ok: false, error: `Model ${modelId} is not resident.`, denialReason: "MODEL_NOT_READY" };
}

function runtimeError(error: unknown): RuntimeResult {
  const message = error instanceof Error ? error.message : "The runtime failed.";
  return { ok: false, error: message.slice(0, 400), denialReason: "RUNTIME_ERROR" };
}

function invalidOutput(detail: string): RuntimeResult {
  return { ok: false, error: detail.slice(0, 400), denialReason: "INVALID_OUTPUT" };
}

function servesRoles(taskRoles: readonly string[]): (taskId: string) => boolean {
  return (taskId: string) => taskRoles.includes(taskId);
}

function textRuntime(manager: OfflineModelManager, backend: ProductionTextBackend): AiRuntime {
  const ids = backend.modelIds ?? [backend.modelId];
  return {
    id: LOCAL_TEXT_RUNTIME_ID,
    kind: "model",
    available: () => ids.some((modelId) => managerReady(manager, modelId)),
    servesTask: (taskId: string) => {
      if (!backend.taskRoles.includes(taskId)) return false;
      // Structured roles belong to the structured engine specifically: a
      // prose-only install must not advertise a role the seam cannot serve.
      if (backend.structuredModelId !== undefined && interpreterFor(taskId)?.generation === "structured") {
        return managerReady(manager, backend.structuredModelId);
      }
      if (backend.proseModelId !== undefined && interpreterFor(taskId)?.generation === "raw") {
        return managerReady(manager, backend.proseModelId);
      }
      return true;
    },
    invoke: async (input) => {
      if (!(await backend.isReady().catch(() => false))) return notReady(backend.modelId);
      // The task interpreter owns generation mode AND interpretation: the
      // adapter executes raw model output and never parses it. A task
      // without an interpreter fails closed here, never as silent success.
      const interpreter = interpreterFor(input.taskId);
      if (interpreter === undefined || interpreter.generation === "typed") {
        return { ok: false, error: `Task "${input.taskId}" has no text contract.`, denialReason: "NO_TASK_CONTRACT" };
      }
      const prompt = toPromptText(input.input);
      if (prompt === undefined) {
        return { ok: false, error: "Text input needs a string or a text/prompt field.", denialReason: "INVALID_INPUT" };
      }
      let completion: ProductionTextCompletion;
      try {
        const native =
          interpreter.generation === "structured"
            ? backend.completeStructured(input.taskId, prompt, input.signal)
            : backend.completeText(prompt, input.signal);
        // Busy-until-settle: the lease observes the raw native promise so
        // the runtime stays owned until native work settles, even when the
        // visible request already timed out.
        input.trackSettlement?.(native);
        const produced = await raceWithSignal(native, input.signal);
        // Single-engine backends return bare strings (resolved to their own
        // provenance); composite backends name the real per-call producer.
        completion =
          typeof produced === "string"
            ? { text: produced, modelId: backend.modelId, runtimeId: backend.runtimeId }
            : produced;
      } catch (error) {
        if (error instanceof RouteCancelledError) return { ok: false, error: "Text generation cancelled.", denialReason: "CANCELLED" };
        return runtimeError(error);
      }
      const interpreted = interpreter.interpret(completion.text, { taskId: input.taskId, input: input.input });
      if (!interpreted.ok) {
        return { ok: false, error: interpreted.error, denialReason: LOCAL_TASK_INVALID };
      }
      const modelRevision = revisionFor(completion.modelId);
      return { ok: true, value: interpreted.value, modelId: completion.modelId, backend: LOCAL_TEXT_RUNTIME_ID, runtimeId: completion.runtimeId, ...(modelRevision === undefined ? {} : { modelRevision }) };
    },
  };
}

function embeddingRuntime(
  manager: OfflineModelManager,
  backend: ProductionEmbeddingBackend,
): AiRuntime {
  const modelRevision = revisionFor(backend.modelId);
  return {
    id: LOCAL_EMBEDDING_RUNTIME_ID,
    kind: "embedding",
    available: () => managerReady(manager, backend.modelId),
    servesTask: servesRoles(backend.taskRoles),
    invoke: async (input) => {
      if (!(await backend.isReady().catch(() => false))) return notReady(backend.modelId);
      const interpreter = interpreterFor(input.taskId);
      if (interpreter === undefined || interpreter.generation !== "typed") {
        return { ok: false, error: `Task "${input.taskId}" has no embedding contract.`, denialReason: "NO_TASK_CONTRACT" };
      }
      const raw = input.input;
      const texts =
        typeof raw === "string" ? [raw] : isRecord(raw) && Array.isArray(raw["texts"]) ? (raw["texts"] as unknown[]) : undefined;
      if (texts === undefined || texts.some((text) => typeof text !== "string")) {
        return { ok: false, error: "Embedding input needs a string or a texts array.", denialReason: "INVALID_INPUT" };
      }
      let vectors: number[][];
      try {
        const native = backend.embed(texts as string[]);
        input.trackSettlement?.(native);
        const produced = await raceWithSignal(native, input.signal);
        vectors = validateNeedleVectors(texts as string[], produced, backend.dimension);
      } catch (error) {
        if (error instanceof RouteCancelledError) return { ok: false, error: "Embedding cancelled.", denialReason: "CANCELLED" };
        if (error instanceof Error && error.message === "Invalid needle embedding result") {
          return invalidOutput("Embedding vectors failed validation against the probed dimension.");
        }
        return runtimeError(error);
      }
      const interpreted = interpreter.interpret({ vectors }, { taskId: input.taskId, input: input.input });
      if (!interpreted.ok) {
        return { ok: false, error: interpreted.error, denialReason: LOCAL_TASK_INVALID };
      }
      return {
        ok: true,
        value: interpreted.value,
        modelId: backend.modelId,
        backend: LOCAL_EMBEDDING_RUNTIME_ID,
        runtimeId: backend.runtimeId,
        ...(modelRevision === undefined ? {} : { modelRevision }),
      };
    },
  };
}

function visionRuntime(manager: OfflineModelManager, backend: ProductionVisionBackend): AiRuntime {
  const modelRevision = revisionFor(backend.modelId);
  return {
    id: LOCAL_VISION_RUNTIME_ID,
    kind: "vision",
    available: () => managerReady(manager, backend.modelId),
    servesTask: servesRoles(backend.taskRoles),
    invoke: async (input) => {
      if (!(await backend.isAvailable().catch(() => false))) return notReady(backend.modelId);
      const interpreter = interpreterFor(input.taskId);
      if (interpreter === undefined || interpreter.generation !== "typed") {
        return { ok: false, error: `Task "${input.taskId}" has no vision contract.`, denialReason: "NO_TASK_CONTRACT" };
      }
      const raw = input.input;
      const prompt = isRecord(raw) && typeof raw["prompt"] === "string" ? (raw["prompt"] as string) : undefined;
      const imageBase64 = isRecord(raw) && typeof raw["imageBase64"] === "string" ? (raw["imageBase64"] as string) : undefined;
      if (prompt === undefined || imageBase64 === undefined) {
        return {
          ok: false,
          error: "Vision input needs a prompt and imageBase64.",
          denialReason: "INVALID_INPUT",
        };
      }
      // The route owns the timeout and aborts input.signal; the bridge gets
      // the same signal so native work cancels end to end. No adapter-local
      // timer: a second timeout here could mask the route's abort accounting.
      try {
        const native = backend.describe(prompt, imageBase64, input.signal);
        input.trackSettlement?.(native);
        const text = await native;
        const interpreted = interpreter.interpret({ text }, { taskId: input.taskId, input: input.input });
        if (!interpreted.ok) {
          return { ok: false, error: interpreted.error, denialReason: LOCAL_TASK_INVALID };
        }
        return {
          ok: true,
          value: interpreted.value,
          modelId: backend.modelId,
          backend: LOCAL_VISION_RUNTIME_ID,
          runtimeId: backend.runtimeId,
          ...(modelRevision === undefined ? {} : { modelRevision }),
        };
      } catch (error) {
        if (error instanceof RouteCancelledError || input.signal.aborted) {
          return { ok: false, error: "Vision request cancelled.", denialReason: "CANCELLED" };
        }
        return runtimeError(error);
      }
    },
  };
}

/**
 * Task ids each production runtime may serve, derived from the task
 * registry (single source of truth: spec.runtimes). A runtime id absent
 * from every spec serves nothing and is not registered.
 */
function taskIdsFor(runtimeId: string): readonly string[] {
  return listTaskSpecs()
    .filter((spec) => spec.runtimes.includes(runtimeId))
    .map((spec) => spec.taskId);
}

/**
 * Register production adapters for the task-spec runtime ids whose backend
 * seam is injected. Returns the registered ids. The lab-only llama.cpp
 * challenger is never registered here — there is no branch that does.
 */
export function registerProductionRuntimes(
  registry: RuntimeRegistry,
  deps: ProductionRuntimeDeps,
): readonly ProductionRuntimeId[] {
  const registered: ProductionRuntimeId[] = [];
  if (deps.text !== undefined && taskIdsFor(LOCAL_TEXT_RUNTIME_ID).length > 0) {
    registry.register(textRuntime(deps.manager, deps.text));
    registered.push(LOCAL_TEXT_RUNTIME_ID);
  }
  if (deps.embedding !== undefined && taskIdsFor(LOCAL_EMBEDDING_RUNTIME_ID).length > 0) {
    registry.register(embeddingRuntime(deps.manager, deps.embedding));
    registered.push(LOCAL_EMBEDDING_RUNTIME_ID);
  }
  if (deps.vision !== undefined && taskIdsFor(LOCAL_VISION_RUNTIME_ID).length > 0) {
    registry.register(visionRuntime(deps.manager, deps.vision));
    registered.push(LOCAL_VISION_RUNTIME_ID);
  }
  return registered;
}
