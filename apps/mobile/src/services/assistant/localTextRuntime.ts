/**
 * Local text runtime hookup for the guided assistant.
 *
 * Resolves the active local TEXT-capable model into an
 * `AssistantExecutionRuntime`: when a mapped text entry is active,
 * installed, and the real text bridge is present, `generate` calls
 * `generateText` with the explicit model id and that entry's own text
 * profile (narrow text ops only; see `profileForTextEntry` — the LFM
 * LiteRT candidate never borrows the Qwen profile) — the execution
 * layer's `GenerationGuard` then judges every raw output before an op
 * normalizes it. Otherwise the runtime carries no `generate` and the
 * sheet stays on the deterministic grounded Help fallback. Nothing here
 * edits the execution layer itself.
 */

import type { AssistantExecutionRuntime } from "./assistantExecution";
import { profileFor, type ModelProfile } from "../ai/modelProfiles";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  QWEN_TEXT_PROFILE_ID,
  isLocalTextEntryId,
  isNarrowTextProfile,
  type GenerateTextRequest,
  type GenerateTextResult,
} from "../models/textRuntime";

/**
 * Lab profile backing the resident LFM LiteRT text candidate
 * (`lfm2.5-1.2b-instruct-litert-int4-gpu`). No litert-lm arm of this model
 * was lab-evaluated; the GGUF-evaluated `lfm2.5-1.2b-q4_0` profile is the
 * closest evaluated text behavior and is deliberately prose-help-only and
 * experimental — the conservative reuse. Structured slot extraction with
 * this profile runs behind the same GenerationGuard with a higher expected
 * failure rate; manual use and on-device testing stay available.
 */
export const LFM_LITERT_TEXT_PROFILE_ID = "lfm2.5-1.2b-q4_0" as const;

/**
 * Honest per-candidate text profile mapping (AI-06). A prior revision
 * attached the generic Qwen profile to every local text entry, silently
 * grading LFM LiteRT output with Qwen's thought-envelope expectations.
 * Each resident text entry now maps to its own evaluated behavior:
 * - qualified Qwen entry + Qwen quant variants (same base model, same
 *   thought-envelope guards; the mixed/int8 quants were not lab-evaluated
 *   and stay labeled as variants, never as the qualified pin);
 * - LFM LiteRT text candidate -> the prose-help-only experimental LFM
 *   profile;
 * - vision/unknown entries -> undefined (fail closed: grounded fallback).
 */
export function profileForTextEntry(entryId: string): ModelProfile | undefined {
  switch (entryId) {
    case QWEN_TEXT_ENTRY_ID:
    case "qwen3-0.6b-litert-mixed-int4":
    case "qwen3-0.6b-litert-int8":
      return profileFor(QWEN_TEXT_PROFILE_ID);
    case "lfm2.5-1.2b-instruct-litert-int4-gpu":
      return profileFor(LFM_LITERT_TEXT_PROFILE_ID);
    default:
      return undefined;
  }
}

/**
 * Display label for the resident text entry. Values track the compact
 * manager labels (`COMPACT_LABELS`); unknown ids fall back to the raw
 * entry id so the sheet shows an identity, never a wrong model name.
 */
export function modelLabelForTextEntry(entryId: string): string {
  switch (entryId) {
    case QWEN_TEXT_ENTRY_ID:
      // Short "Qwen" keeps the established session wording ("Using Qwen
      // locally for this session.", also asserted by the status-owned
      // Shell suite); quant variants below stay fully qualified.
      return "Qwen";
    case "qwen3-0.6b-litert-mixed-int4":
      return "Qwen3 0.6B Mixed INT4";
    case "qwen3-0.6b-litert-int8":
      return "Qwen3 0.6B INT8";
    case "lfm2.5-1.2b-instruct-litert-int4-gpu":
      return "LFM2.5 1.2B";
    default:
      return entryId;
  }
}

export interface LocalTextRuntimeSignals {
  /** Persisted active catalogue entry id, or null when none is active. */
  activeEntryId: string | null;
  /** Real-bridge probe: the native `generateText` method exists. */
  textRuntimePresent: boolean;
  /** Whether the Qwen model data is on device in an installed state. */
  installed: boolean;
  /** Observed TEXT_READY proof (never persisted, never inferred from files). */
  textReady: boolean;
  /** Bridge-bound explicit-modelId text generation. */
  generateText: (request: GenerateTextRequest) => Promise<GenerateTextResult>;
}

/**
 * Builds the assistant runtime for the active local text model. Fail
 * closed: any missing precondition (wrong entry, absent bridge, missing
 * install, missing TEXT_READY proof, missing/non-narrow profile) yields a
 * generator-free runtime and the grounded fallback path applies. Installed
 * without TEXT_READY never answers locally and is never labeled ready.
 */
export function resolveLocalTextRuntime(
  signals: LocalTextRuntimeSignals,
): AssistantExecutionRuntime {
  const activeEntryId = signals.activeEntryId;
  // Both gates must agree: the entry allowlist (textRuntime) and the
  // per-entry profile mapping below. A future text entry without a mapped
  // profile fails closed to the grounded fallback instead of borrowing
  // another model's profile.
  const profile = activeEntryId === null ? undefined : profileForTextEntry(activeEntryId);
  if (
    activeEntryId === null ||
    !isLocalTextEntryId(activeEntryId) ||
    !signals.textRuntimePresent ||
    !signals.installed ||
    !signals.textReady ||
    profile === undefined ||
    !isNarrowTextProfile(profile)
  ) {
    return {};
  }
  return {
    generate: async (prompt, options) => {
      // The qualified Qwen entry keeps its short bridge id; a resident
      // experimental candidate is addressed by its catalogue entry id.
      const modelId =
        activeEntryId === QWEN_TEXT_ENTRY_ID
          ? QWEN_TEXT_BRIDGE_MODEL_ID
          : activeEntryId;
      const result = await signals.generateText({
        modelId,
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
      });
      return result.text;
    },
    profile,
    modelLabel: modelLabelForTextEntry(activeEntryId),
  };
}
