/**
 * Single-resident generative-model switching semantics (Task 26, NEW FILE).
 *
 * Guard G7: at most one generative model is resident at a time. Switching
 * models follows the ordered sequence cancel → release → verify memory →
 * init. This module plans the switch as pure data — cancellation, engine
 * release, memory verification, and init are performed by the later runtime
 * task, never here.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import { needsAdvancedConfirm, type AvailableFreeRamMb } from "./ramPolicy";

/** At most one generative model resident (guard G7 invariant). */
export const MAX_RESIDENT_GENERATIVE_MODELS = 1;

/** Ordered switch steps: cancel → release → verify memory → init. */
export type ModelSwitchStep = "cancel" | "release" | "verify-memory" | "init";

export const MODEL_SWITCH_STEPS: readonly ModelSwitchStep[] = [
  "cancel",
  "release",
  "verify-memory",
  "init",
] as const;

export interface ModelSwitchRequest {
  /** Currently resident entry id, or null when idle. */
  currentResidentId: string | null;
  /** Entry the user asked to activate. */
  target: ModelCatalogueEntry;
  /** Passively observed free RAM (never an allocation probe). */
  availableFreeRamMb: AvailableFreeRamMb;
  /** Whether the advanced-confirmation gate was explicitly accepted. */
  advancedConfirmed: boolean;
}

export type ModelSwitchPlan =
  | { readonly blocked: false; readonly steps: readonly ModelSwitchStep[] }
  | { readonly blocked: true; readonly reason: string };

/**
 * Plans activation of `target` under the single-resident invariant.
 *
 * - Same id as resident → no steps (already resident).
 * - Non-installable targets (catalogue reference, experimental eval-only
 *   slots) → blocked, never planned as downloads.
 * - Gate-triggering targets without `advancedConfirmed` → blocked with the
 *   gate reason; the gate UI lives in `ModelAdvancedConfirmGate`.
 * - Otherwise → the full cancel → release → verify-memory → init sequence
 *   (`cancel`/`release` are no-ops when idle but stay in the plan for audit).
 */
export function planModelSwitch(request: ModelSwitchRequest): ModelSwitchPlan {
  const { currentResidentId, target, availableFreeRamMb, advancedConfirmed } =
    request;

  if (currentResidentId === target.id) {
    return { blocked: false, steps: [] };
  }

  if (target.catalogOnly === true) {
    return {
      blocked: true,
      reason:
        "Catalog reference only: this entry is not distributed via FindBack releases and cannot be activated.",
    };
  }

  if (target.verificationStatus === "EXPERIMENTAL") {
    return {
      blocked: true,
      reason:
        "Experimental eval-only entry: activation is not offered in the v1 library.",
    };
  }

  if (
    needsAdvancedConfirm(target, availableFreeRamMb) &&
    !advancedConfirmed
  ) {
    return {
      blocked: true,
      reason:
        "Advanced confirmation required: available memory is below the entry minimum (or unknown-gated) and no explicit acknowledgement was recorded.",
    };
  }

  return { blocked: false, steps: MODEL_SWITCH_STEPS };
}
