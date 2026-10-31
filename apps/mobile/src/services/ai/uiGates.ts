/**
 * Pure visibility gates for local-tool affordances.
 *
 * Pure TypeScript: no I/O, no runtimes, no matching logic, no UI. Each gate
 * defaults to false (hidden) without explicit verified evidence, so the app
 * never claims a local capability it cannot prove on this device.
 */

import type { OfflineModelStatus } from "./offlineModelManager";

/**
 * Measured Needle evidence. All three flags must be true before any
 * Needle-specific UI is shown; anything missing or stale stays hidden.
 */
export interface NeedleEvidence {
  /** A real on-device measurement ran (never a placeholder or guess). */
  readonly measured: boolean;
  /** The measurement's correctness spot-check passed. */
  readonly correctnessPass: boolean;
  /** The measurement is still fresh for the current model/corpus. */
  readonly fresh: boolean;
}

/**
 * Show offline-model UI only when the model is installed AND its checksum
 * verified. Anything else (queued, downloading, paused, verifying, failed,
 * missing, or unverified) stays hidden.
 */
export function canShowOffline(
  status: OfflineModelStatus | null | undefined,
): boolean {
  if (status === null || status === undefined) return false;
  return status.download === "installed" && status.checksumVerified === true;
}

/**
 * Show Needle-specific UI only with explicit, fresh, passing measurement
 * evidence. Defaults to hidden.
 */
export function canShowNeedle(
  evidence: NeedleEvidence | null | undefined,
): boolean {
  if (evidence === null || evidence === undefined) return false;
  return (
    evidence.measured === true &&
    evidence.correctnessPass === true &&
    evidence.fresh === true
  );
}
