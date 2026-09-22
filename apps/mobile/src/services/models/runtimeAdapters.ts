/**
 * Runtime-neutral model routing (runtime selection).
 *
 * Evidence: native `VlmModelId` is exactly two ids and `analyzeImage()`
 * takes no `modelId` — native picks by `mode` (`VlmTypes.kt`,
 * `LocalVlmPlugin.analyzeImage`, `VlmRouter.selectForAnalysis`). The
 * catalogue spans `litert-lm` / `llama-cpp` / `tbd` runtimes
 * (`catalogueTypes.ts`) but only `smolvlm2-500m-litert-int4` maps to a
 * wired bridge model (`shippedCatalogue.bridgeModelIdForEntry`). Routing
 * by mapping — never by runtime string — keeps text entries from being
 * forced through the image runtime.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { BackendMode, VlmModelId } from "../vlmPlugin";
import { bridgeModelIdForEntry } from "./shippedCatalogue";

/** Adapter kinds with a proven on-device path in this build. */
export const SUPPORTED_RUNTIME_ADAPTERS = ["vlm-image"] as const;

export type RuntimeAdapterKind =
  (typeof SUPPORTED_RUNTIME_ADAPTERS)[number];

export interface RuntimeTextInput {
  kind: "text";
  prompt: string;
}

export interface RuntimeImageInput {
  kind: "image";
  imageUri: string;
  instruction: string;
}

export interface RuntimeGenerateOptions {
  maxOutputTokens: number;
  temperature: number;
}

/**
 * Runtime-neutral generation request: model identity (entry + bridge id),
 * role, input, and options travel together. The native half does not accept
 * this yet (`analyzeImage` takes `mode`, no `modelId`) — see the blocked
 * native contract in the status report.
 */
export interface RuntimeGenerateRequest {
  entryId: string;
  bridgeId: VlmModelId;
  adapter: RuntimeAdapterKind;
  role: string;
  input: RuntimeTextInput | RuntimeImageInput;
  options: RuntimeGenerateOptions;
}

export type RouteRuntimeResult =
  | { readonly ok: true; readonly adapter: RuntimeAdapterKind; readonly bridgeId: VlmModelId }
  | { readonly ok: false; readonly reason: string };

/**
 * Routes a catalogue entry to its wired adapter. Only entries with a
 * proven bridge mapping and a matching role resolve; everything else is
 * catalogue information, never forced through the image runtime.
 */
export function routeEntryToAdapter(
  entry: ModelCatalogueEntry,
): RouteRuntimeResult {
  if (entry.catalogOnly === true) {
    return {
      ok: false,
      reason:
        "Catalog reference only: this entry is not distributed via FindBack releases and cannot be activated.",
    };
  }
  if (entry.verificationStatus === "EXPERIMENTAL") {
    return {
      ok: false,
      reason:
        "Experimental eval-only entry: activation is not offered in the v1 library.",
    };
  }
  if (entry.verificationStatus === "INCOMPATIBLE") {
    return {
      ok: false,
      reason: "Incompatible entry: no on-device runtime can serve it.",
    };
  }
  const bridgeId = bridgeModelIdForEntry(entry.id);
  if (bridgeId == null) {
    return {
      ok: false,
      reason:
        "No on-device runtime is wired for this entry in this build, so it cannot be activated here.",
    };
  }
  if (entry.runtime !== "litert-lm" || entry.role !== "report-from-photo") {
    return {
      ok: false,
      reason:
        "No on-device runtime is wired for this entry in this build, so it cannot be activated here.",
    };
  }
  return { ok: true, adapter: "vlm-image", bridgeId };
}

/**
 * Builds the runtime-neutral request for a routed entry. Callers must route
 * first; this keeps `modelId` attached to every generation request.
 */
export function buildRuntimeRequest(
  entry: ModelCatalogueEntry,
  route: Extract<RouteRuntimeResult, { ok: true }>,
  input: RuntimeTextInput | RuntimeImageInput,
  options: RuntimeGenerateOptions,
): RuntimeGenerateRequest {
  return {
    entryId: entry.id,
    bridgeId: route.bridgeId,
    adapter: route.adapter,
    role: entry.role,
    input,
    options,
  };
}

/**
 * Maps a runtime-neutral image request onto the current native
 * `AnalyzeRequest` shape. The `modelId` has no native field yet — the
 * caller must already hold the active session for `request.bridgeId`
 * (see `modelActivation.activateModel`); the native `modelId` parameter
 * is tracked as blocked work in the status report.
 */
export function toLegacyAnalyzeRequest(
  request: RuntimeGenerateRequest,
  mode: BackendMode,
): { mode: BackendMode; imageUri: string; instruction: string; maxOutputTokens: number; temperature: number } {
  if (request.input.kind !== "image") {
    throw new Error("vlm-image adapter serves image input only");
  }
  return {
    mode,
    imageUri: request.input.imageUri,
    instruction: request.input.instruction,
    maxOutputTokens: request.options.maxOutputTokens,
    temperature: request.options.temperature,
  };
}
