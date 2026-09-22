/**
 * Verified single-resident activation (runtime selection).
 *
 * A UI model switch succeeds only after the selected runtime really
 * initialized the selected model. `READY_GPU` is that proof: native sets
 * it only after a successful image-bearing GPU self-test
 * (`LocalVlmPlugin.runGpuSelfTest`). Switching preserves the ordered
 * cancel → release → verify-memory → init-proof sequence with at most one
 * resident generative model (`modelSession.planModelSwitch`).
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { AvailableFreeRamMb } from "./ramPolicy";
import type { VlmModelId, VlmModelInfo } from "../vlmPlugin";
import { planModelSwitch } from "./modelSession";
import { routeEntryToAdapter } from "./runtimeAdapters";

/** Minimal bridge surface activation needs (subset of `VlmBridge`). */
export interface ActivationBridge {
  cancelInference(): Promise<void>;
  release(): Promise<void>;
  getModelStates(): Promise<VlmModelInfo[]>;
}

export interface ActivateModelOptions {
  currentResidentId: string | null;
  availableFreeRamMb: AvailableFreeRamMb;
  advancedConfirmed: boolean;
}

export type ActivationResult =
  | { readonly ok: true; readonly alreadyActive: boolean }
  | { readonly ok: false; readonly reason: string };

/** True only when native reports the bridge model genuinely initialized. */
export function isRuntimeReadyForEntry(
  states: readonly VlmModelInfo[],
  bridgeId: VlmModelId,
): boolean {
  return states.some((m) => m.id === bridgeId && m.state === "READY_GPU");
}

/**
 * Activates `entry`: plans the single-resident switch, runs
 * cancel → release, re-verifies memory, then requires the `READY_GPU`
 * init proof before reporting success. Never persists anything; the
 * caller records the active id only when `ok` is true.
 */
export async function activateModel(
  bridge: ActivationBridge,
  entry: ModelCatalogueEntry,
  options: ActivateModelOptions,
): Promise<ActivationResult> {
  const route = routeEntryToAdapter(entry);
  if (!route.ok) {
    return { ok: false, reason: route.reason };
  }
  const plan = planModelSwitch({
    currentResidentId: options.currentResidentId,
    target: entry,
    availableFreeRamMb: options.availableFreeRamMb,
    advancedConfirmed: options.advancedConfirmed,
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
  const states = await bridge.getModelStates();
  const info = states.find((m) => m.id === route.bridgeId);
  if (!isRuntimeReadyForEntry(states, route.bridgeId)) {
    const state = info?.state ?? "unknown";
    return {
      ok: false,
      reason: `Model runtime is not ready (state: ${state}). Complete accelerator verification before setting it active.`,
    };
  }
  return { ok: true, alreadyActive: false };
}
