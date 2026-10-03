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
 * Text backend seam: implemented in production by the Needle JSON path
 * (`completeNeedleJson` over the resident needle3 engine); faked in tests.
 * `completeJson` resolves the model-output string, never parsed values —
 * parsing (and its failure) belongs to the adapter, in the open.
 */
export interface ProductionTextBackend {
  readonly modelId: string;
  isReady(): Promise<boolean>;
  completeJson(input: string): Promise<string>;
}

/** Embedding backend seam: native Needle embedder in production. */
export interface ProductionEmbeddingBackend {
  readonly modelId: string;
  /** Live width from the engine probe; vectors are validated against it. */
  readonly dimension: number;
  isReady(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Vision backend seam: SmolVLM2 native bridge in production. */
export interface ProductionVisionBackend {
  readonly modelId: string;
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

function textRuntime(manager: OfflineModelManager, backend: ProductionTextBackend): AiRuntime {
  const modelRevision = revisionFor(backend.modelId);
  return {
    id: LOCAL_TEXT_RUNTIME_ID,
    kind: "model",
    available: () => managerReady(manager, backend.modelId),
    invoke: async (input) => {
      if (!(await backend.isReady().catch(() => false))) return notReady(backend.modelId);
      const prompt = toPromptText(input.input);
      if (prompt === undefined) {
        return { ok: false, error: "Text input needs a string or a text/prompt field.", denialReason: "INVALID_INPUT" };
      }
      let raw: string;
      try {
        raw = await backend.completeJson(prompt);
      } catch (error) {
        return runtimeError(error);
      }
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        return invalidOutput("Model output was not a JSON object.");
      }
      if (!isRecord(value)) return invalidOutput("Model output was not a JSON object.");
      return { ok: true, value, modelId: backend.modelId, backend: LOCAL_TEXT_RUNTIME_ID, ...(modelRevision === undefined ? {} : { modelRevision }) };
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
    invoke: async (input) => {
      if (!(await backend.isReady().catch(() => false))) return notReady(backend.modelId);
      const raw = input.input;
      const texts =
        typeof raw === "string" ? [raw] : isRecord(raw) && Array.isArray(raw["texts"]) ? (raw["texts"] as unknown[]) : undefined;
      if (texts === undefined || texts.some((text) => typeof text !== "string")) {
        return { ok: false, error: "Embedding input needs a string or a texts array.", denialReason: "INVALID_INPUT" };
      }
      let vectors: number[][];
      try {
        const produced = await backend.embed(texts as string[]);
        vectors = validateNeedleVectors(texts as string[], produced, backend.dimension);
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid needle embedding result") {
          return invalidOutput("Embedding vectors failed validation against the probed dimension.");
        }
        return runtimeError(error);
      }
      return {
        ok: true,
        value: { vectors },
        modelId: backend.modelId,
        backend: LOCAL_EMBEDDING_RUNTIME_ID,
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
    invoke: async (input) => {
      if (!(await backend.isAvailable().catch(() => false))) return notReady(backend.modelId);
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
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const text = await backend.describe(prompt, imageBase64, controller.signal);
        return {
          ok: true,
          value: { text },
          modelId: backend.modelId,
          backend: LOCAL_VISION_RUNTIME_ID,
          ...(modelRevision === undefined ? {} : { modelRevision }),
        };
      } catch (error) {
        return runtimeError(error);
      } finally {
        clearTimeout(timeout);
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
