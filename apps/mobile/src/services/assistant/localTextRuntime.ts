/**
 * Local text runtime hookup for the guided assistant.
 *
 * Resolves the active local TEXT-capable model into an
 * `AssistantExecutionRuntime`: when the qualified Qwen entry is active,
 * installed, and the real text bridge is present, `generate` calls
 * `generateText` with the explicit Qwen model id and the Qwen text profile
 * (narrow text ops only) — the execution layer's `GenerationGuard` then
 * judges every raw output before an op normalizes it. Otherwise the
 * runtime carries no `generate` and the sheet stays on the deterministic
 * grounded Help fallback. Nothing here edits the execution layer itself.
 */

import type { AssistantExecutionRuntime } from "./assistantExecution";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  isNarrowTextProfile,
  qwenTextProfile,
  type GenerateTextRequest,
  type GenerateTextResult,
} from "../models/textRuntime";

export interface LocalTextRuntimeSignals {
  /** Persisted active catalogue entry id, or null when none is active. */
  activeEntryId: string | null;
  /** Real-bridge probe: the native `generateText` method exists. */
  textRuntimePresent: boolean;
  /** Whether the Qwen model data is on device in an installed state. */
  installed: boolean;
  /** Bridge-bound explicit-modelId text generation. */
  generateText: (request: GenerateTextRequest) => Promise<GenerateTextResult>;
}

/**
 * Builds the assistant runtime for the active local text model. Fail
 * closed: any missing precondition (wrong entry, absent bridge, missing
 * install, missing/non-narrow profile) yields a generator-free runtime
 * and the grounded fallback path applies.
 */
export function resolveLocalTextRuntime(
  signals: LocalTextRuntimeSignals,
): AssistantExecutionRuntime {
  const profile = qwenTextProfile();
  if (
    signals.activeEntryId !== QWEN_TEXT_ENTRY_ID ||
    !signals.textRuntimePresent ||
    !signals.installed ||
    profile === undefined ||
    !isNarrowTextProfile(profile)
  ) {
    return {};
  }
  return {
    generate: async (prompt, options) => {
      const result = await signals.generateText({
        modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
      });
      return result.text;
    },
    profile,
  };
}
