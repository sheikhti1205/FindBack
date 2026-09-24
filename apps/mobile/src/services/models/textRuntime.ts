/**
 * Local text runtime seam (Qwen text path).
 *
 * Background: `AssistantExecutionRuntime.generate` stays optional and is
 * injected only when the local text path is active
 * (`localTextRuntime.resolveLocalTextRuntime`). The image path is dedicated,
 * so text generation is a separate explicit-modelId surface (native
 * `VlmModelId` is exactly `smolvlm-500m`/`smolvlm2-500m` and
 * `analyzeImage()` takes no `modelId` — `VlmTypes.kt`,
 * `LocalVlmPlugin.analyzeImage`). This module provides the TS seam:
 *
 * - `TextGenerationBridge`: the explicit-modelId native contract,
 *   conceptually `generateText({modelId, prompt, maxOutputTokens,
 *   temperature})`. Unlike `analyzeImage`, the requested model is always
 *   explicit. The native `generateText` / `runTextSelfTest` /
 *   `getTextRuntimeStatus` methods live on `LocalVlmPlugin` and are bound
 *   through the production `VlmBridge` text surface (`vlmPlugin.ts`);
 *   `isTextRuntimePresent` probes for it so Qwen stays non-runnable where
 *   the bridge is absent.
 * - `TextEngine` / `createBridgeTextEngine`: generic LiteRT-LM text engine
 *   seam — `initialize(model)`, conversation, `sendText`, cancel, `release`.
 *   No image requirement. Streaming has no bridge method yet, so the
 *   bridge-backed engine reports `supportsStreaming: false` and carries no
 *   `streamText`; cancel is supported via `cancelInference`.
 * - Qwen gating: `activateTextModel` accepts only the qualified pin
 *   (`QWEN_TEXT_MODEL_PIN`, verified against
 *   `docs/specs/model-library/catalogue.v1.json`), and only while the real
 *   bridge is present. The other Qwen candidates are not pinned here (no
 *   activation selection work in this module); they report capability via
 *   `runtimeCapabilityForTextEntry` and run through the candidate host once
 *   verified and made resident. `activateTextModel` reuses `planModelSwitch`
 *   (shared single-resident semantics) and requires an observed
 *   runtime-ready proof before reporting success. Nothing here edits the
 *   sibling-owned modules (`runtimeCapability.ts`, `modelSession.ts`, the
 *   library-card screens).
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { AvailableFreeRamMb } from "./ramPolicy";
import type { RuntimeCapability } from "./runtimeCapability";
import { profileFor, type ModelProfile } from "../ai/modelProfiles";
import type { GenerateOptions, NarrowOp } from "../ai/types";
import { planModelSwitch } from "./modelSession";
import {
  CANDIDATE_VISION_ENTRY_ID,
  EXPERIMENTAL_CANDIDATE_ENTRY_IDS,
} from "./shippedCatalogue";

/** Catalogue id of the single qualified on-device text entry. */
export const QWEN_TEXT_ENTRY_ID = "qwen3-0.6b-litert-dynamic-int4" as const;

/** Bridge-level model id for the qualified Qwen text runtime. */
export const QWEN_TEXT_BRIDGE_MODEL_ID = "qwen3-0.6b" as const;

/**
 * Bridge model id carried by a text request. The qualified Qwen runtime uses
 * the short `qwen3-0.6b` id; a resident experimental text candidate uses its
 * catalogue entry id (see [CANDIDATE_TEXT_ENTRY_IDS]). Native enforces which
 * ids are actually accepted, so this stays a plain string.
 */
export type TextBridgeModelId = string;

/**
 * Catalogue entry ids of the three experimental TEXT candidates. These have
 * no dedicated production runtime; once verified and made resident they run
 * through the same generic text host (see `CandidateRuntimeController`).
 */
export const CANDIDATE_TEXT_ENTRY_IDS: readonly string[] =
  EXPERIMENTAL_CANDIDATE_ENTRY_IDS.filter(
    (id) => id !== CANDIDATE_VISION_ENTRY_ID,
  );

/** True only for one of the experimental text-candidate entry ids. */
export function isCandidateTextEntryId(id: string | null | undefined): boolean {
  return id != null && (CANDIDATE_TEXT_ENTRY_IDS as readonly string[]).includes(id);
}

/** True for any entry the local text path may serve (qualified or candidate). */
export function isLocalTextEntryId(id: string | null | undefined): boolean {
  return id === QWEN_TEXT_ENTRY_ID || isCandidateTextEntryId(id);
}

/** Profile id backing text ops for the qualified Qwen runtime. */
export const QWEN_TEXT_PROFILE_ID = "qwen3-0.6b-dynamic-int4" as const;

/**
 * Qualified pin for the text runtime: the INSTALLED weights artifact
 * (rev a3c5d805, 344671744 B, lab-verified hash), NOT the distribution
 * package — packaging changes package bytes/hash by design, so the pin
 * tracks `installedBytes`/`installedSha256` plus the upstream revision.
 */
export const QWEN_TEXT_MODEL_PIN = {
  fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
  revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
  installedBytes: 344671744,
  installedSha256:
    "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
} as const;

/** Narrow ops the local text runtime may serve. Image analysis is excluded. */
export const TEXT_NARROW_OPS: readonly NarrowOp[] = [
  "classify-intent",
  "extract-report-fields",
  "answer-help",
  "extract-search-filters",
] as const;

/**
 * Explicit-modelId text generation request. The model identity travels
 * with every request; the bridge must never substitute another model.
 */
export interface GenerateTextRequest {
  modelId: TextBridgeModelId;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface GenerateTextResult {
  text: string;
  modelId: TextBridgeModelId;
}

/**
 * Minimal native surface the text runtime needs. Structural (not an
 * extension of `VlmBridge`) so the image bridge stays untouched; the native
 * methods themselves live on `LocalVlmPlugin` (see the module header).
 */
export interface TextGenerationBridge {
  generateText(request: GenerateTextRequest): Promise<GenerateTextResult>;
  cancelInference(): Promise<void>;
  release(): Promise<void>;
}

/**
 * True only when `candidate` exposes a callable `generateText`. This is
 * the real-bridge probe: Qwen capability/activation require it, so a
 * missing native method keeps Qwen listed but unrunnable.
 */
export function isTextRuntimePresent(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  return (
    typeof (candidate as Partial<TextGenerationBridge>).generateText ===
    "function"
  );
}

/** One text conversation: prompt/response turns against one resident model. */
export interface TextConversation {
  sendText(prompt: string, options: GenerateOptions): Promise<string>;
  cancel(): Promise<void>;
}

/**
 * Generic LiteRT-LM text engine seam: `initialize(model)`, conversation,
 * `sendText`, cancel, `release`. Streaming is intentionally absent until
 * the bridge exposes token streaming (`supportsStreaming` reports false).
 */
export interface TextEngine {
  readonly supportsStreaming: boolean;
  initialize(modelId: TextBridgeModelId): Promise<void>;
  startConversation(): TextConversation;
  release(): Promise<void>;
}

/**
 * Bridge-backed text engine. Single-resident like the image path: release
 * drops the initialized model and every conversation started from it.
 */
export function createBridgeTextEngine(
  bridge: TextGenerationBridge,
): TextEngine {
  let resident: TextBridgeModelId | null = null;
  let released = false;
  const checkUsable = (modelId: TextBridgeModelId): void => {
    if (released || resident !== modelId) {
      throw new Error(
        "Text engine is not initialized for this model. Call initialize(modelId) first.",
      );
    }
  };
  return {
    supportsStreaming: false,
    async initialize(modelId: TextBridgeModelId): Promise<void> {
      released = false;
      resident = modelId;
    },
    startConversation(): TextConversation {
      const modelId = resident;
      if (released || modelId === null) {
        throw new Error(
          "Text engine is not initialized for this model. Call initialize(modelId) first.",
        );
      }
      return {
        async sendText(
          prompt: string,
          options: GenerateOptions,
        ): Promise<string> {
          checkUsable(modelId);
          const result = await bridge.generateText({
            modelId,
            prompt,
            maxOutputTokens: options.maxOutputTokens,
            temperature: options.temperature,
          });
          return result.text;
        },
        async cancel(): Promise<void> {
          await bridge.cancelInference();
        },
      };
    },
    async release(): Promise<void> {
      resident = null;
      released = true;
      await bridge.release();
    },
  };
}

/** Builds an explicit-modelId request; the model id is never defaulted. */
export function toGenerateTextRequest(
  modelId: TextBridgeModelId,
  prompt: string,
  options: GenerateOptions,
): GenerateTextRequest {
  return {
    modelId,
    prompt,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
  };
}

export type QwenPinResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a catalogue entry against the qualified Qwen pin. Guards the
 * capability/activation gates against catalogue drift (revision, bytes,
 * or hash changes re-block the text path until re-qualified).
 */
export function verifyQwenCataloguePin(
  entry: ModelCatalogueEntry,
): QwenPinResult {
  if (entry.id !== QWEN_TEXT_ENTRY_ID) {
    return {
      ok: false,
      reason:
        "No on-device text runtime is wired for this entry in this build, so it cannot be activated here.",
    };
  }
  if (
    entry.revision !== QWEN_TEXT_MODEL_PIN.revision ||
    entry.installedBytes !== QWEN_TEXT_MODEL_PIN.installedBytes ||
    entry.installedSha256 !== QWEN_TEXT_MODEL_PIN.installedSha256
  ) {
    return {
      ok: false,
      reason:
        "Catalogue pin mismatch: the entry no longer matches the qualified text-runtime pin (revision, installed bytes, installed-weights hash). Re-qualification required before activation.",
    };
  }
  return { ok: true };
}

/**
 * Text-runtime capability for an entry. RUNTIME_AVAILABLE for either the
 * pin-verified Qwen text entry or one of the experimental text candidates,
 * in both cases only while the real bridge method is present. Catalog
 * reference entries, `INCOMPATIBLE` entries and shipped entries with no
 * wired text path stay RUNTIME_UNAVAILABLE. Mirrors
 * `runtimeCapabilityForEntry` without editing it.
 */
export function runtimeCapabilityForTextEntry(
  entry: ModelCatalogueEntry,
  textRuntimePresent: boolean,
): RuntimeCapability {
  if (entry.catalogOnly === true) return "RUNTIME_UNAVAILABLE";
  if (entry.verificationStatus === "INCOMPATIBLE") return "RUNTIME_UNAVAILABLE";
  // Experimental text candidates are wired through the same generic text
  // host once verified and made resident, so they report runnable while the
  // real bridge method is present.
  if (isCandidateTextEntryId(entry.id)) {
    return textRuntimePresent ? "RUNTIME_AVAILABLE" : "RUNTIME_UNAVAILABLE";
  }
  if (verifyQwenCataloguePin(entry).ok !== true) return "RUNTIME_UNAVAILABLE";
  if (entry.verificationStatus === "EXPERIMENTAL") {
    return "RUNTIME_UNAVAILABLE";
  }
  return textRuntimePresent ? "RUNTIME_AVAILABLE" : "RUNTIME_UNAVAILABLE";
}

/** Profile backing text ops, or undefined when unavailable (fail closed). */
export function qwenTextProfile(): ModelProfile | undefined {
  return profileFor(QWEN_TEXT_PROFILE_ID);
}

/**
 * True only for text-capable profiles limited to the narrow text ops.
 * The text runtime never serves image analysis or unconstrained agency.
 */
export function isNarrowTextProfile(profile: ModelProfile): boolean {
  return (
    profile.supportsText === true &&
    profile.roles.length > 0 &&
    profile.roles.every((role) =>
      (TEXT_NARROW_OPS as readonly string[]).includes(role),
    )
  );
}

export interface ActivateTextModelOptions {
  currentResidentId: string | null;
  availableFreeRamMb: AvailableFreeRamMb;
  advancedConfirmed: boolean;
  /** Real-bridge probe (`isTextRuntimePresent`); absent runtime stays blocked. */
  textRuntimePresent: boolean;
  /** Observed ready proof for the Qwen bridge model (init completed). */
  runtimeReady: boolean;
}

export type TextActivationResult =
  | { readonly ok: true; readonly alreadyActive: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Activates the Qwen text entry: pin + presence checks, then the shared
 * single-resident plan (cancel → release → verify-memory → init), then the
 * observed ready proof. Persists nothing; the caller records the active
 * id only when `ok` is true.
 */
export async function activateTextModel(
  bridge: TextGenerationBridge,
  entry: ModelCatalogueEntry,
  options: ActivateTextModelOptions,
): Promise<TextActivationResult> {
  const pin = verifyQwenCataloguePin(entry);
  if (pin.ok !== true) {
    return { ok: false, reason: pin.reason };
  }
  if (!options.textRuntimePresent) {
    return {
      ok: false,
      reason:
        "Cannot activate: no executable text runtime for this entry in this build.",
    };
  }
  const plan = planModelSwitch({
    currentResidentId: options.currentResidentId,
    target: entry,
    availableFreeRamMb: options.availableFreeRamMb,
    advancedConfirmed: options.advancedConfirmed,
    runtimeCapability: runtimeCapabilityForTextEntry(
      entry,
      options.textRuntimePresent,
    ),
  });
  if (plan.blocked) {
    return { ok: false, reason: plan.reason };
  }
  if (plan.steps.length === 0) {
    return { ok: true, alreadyActive: true };
  }
  await bridge.cancelInference();
  await bridge.release();
  if (
    options.availableFreeRamMb != null &&
    options.availableFreeRamMb < entry.minFreeRamMb
  ) {
    return {
      ok: false,
      reason:
        "Memory verification failed: available memory dropped below the entry minimum after release. Activation aborted.",
    };
  }
  if (!options.runtimeReady) {
    return {
      ok: false,
      reason:
        "Model runtime is not ready (state: unknown). Complete text-runtime initialization before setting it active.",
    };
  }
  return { ok: true, alreadyActive: false };
}
