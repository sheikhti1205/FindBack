/**
 * Promotion policy for lab-only runtimes (WS4, isolated scope).
 *
 * MLC-LLM, ExecuTorch, and Neuron backends are lab experiments: they may be
 * benchmarked behind an explicit opt-in, but they are never routable and
 * never promotable to a production path. This module is the single
 * promotability decision point for those runtimes.
 *
 * No orchestrator, router, probe, or runtime behavior changes here — pure
 * policy decision, no I/O.
 */

/** Runtimes confined to the lab; never routable, never promotable. */
export const LAB_ONLY_RUNTIMES = ["mlc-llm", "executorch", "neuron"] as const;

export type LabOnlyRuntime = (typeof LAB_ONLY_RUNTIMES)[number];

export interface PromotionDecision {
  readonly promotable: boolean;
  readonly routable: boolean;
  readonly reason: string;
}

/** True for the lab-only runtime set (exact match, case-sensitive). */
export function isLabOnlyRuntime(runtime: string): boolean {
  return (LAB_ONLY_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * Promotion decision for a runtime id.
 *
 * Lab-only runtimes are permanently pinned to
 * `{ promotable: false, routable: false }` — no evidence threshold, guard
 * result, or benchmark score can promote them through this policy. Any other
 * runtime id is left to its own policy owner (`promotable: true` here means
 * only "not blocked by this policy", not "approved for production").
 */
export function promotionDecision(runtime: string): PromotionDecision {
  if (isLabOnlyRuntime(runtime)) {
    return {
      promotable: false,
      routable: false,
      reason: `${runtime} is lab-only: benchmark behind explicit opt-in, never routable, never promotable`,
    };
  }
  return {
    promotable: true,
    routable: true,
    reason: `${runtime} is not lab-gated by this policy`,
  };
}

/** Convenience: false for lab-only runtimes, true otherwise. */
export function isPromotable(runtime: string): boolean {
  return promotionDecision(runtime).promotable;
}

/** Convenience: false for lab-only runtimes, true otherwise. */
export function isRoutable(runtime: string): boolean {
  return promotionDecision(runtime).routable;
}
