/**
 * WS7 UI/privacy/capability-truth skeleton: pure visibility gates.
 *
 * Pure TypeScript: no I/O, no runtimes, no matching/bench/probe logic, no UI.
 * Each gate defaults to false (hidden) without explicit measured evidence and
 * returns true only for fresh, correctness-passing measurements. UI layers
 * call these gates before showing Automatic/offline/Needle/GPU affordances so
 * the app never claims GPU-faster or auto-magic behavior up front.
 *
 * Evidence shapes are borrowed (never owned) from `./deviceProbe` and
 * `./offlineModelManager`; this module only reads them.
 */

import { isFreshProbe, type ProbeContext, type ProbeRecord } from "./deviceProbe";
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

function isSelectableProbe(record: ProbeRecord, current: ProbeContext): boolean {
  return (
    isFreshProbe(record, current) &&
    record.correctnessPass === true &&
    Number.isFinite(record.tokensPerSec) &&
    record.tokensPerSec > 0 &&
    Number.isFinite(record.ttftMs) &&
    record.ttftMs > 0
  );
}

function selectableProbes(
  records: readonly ProbeRecord[] | null | undefined,
  current: ProbeContext | null | undefined,
): ProbeRecord[] {
  if (records === null || records === undefined) return [];
  if (current === null || current === undefined) return [];
  return records.filter((record) => isSelectableProbe(record, current));
}

/**
 * Show Automatic-mode UI only when at least one fresh, correctness-passing
 * probe exists. Empty, missing, stale, or failing evidence stays hidden
 * (the caller keeps serving the safe CPU fallback).
 */
export function canShowAuto(
  records: readonly ProbeRecord[] | null | undefined,
  current: ProbeContext | null | undefined,
): boolean {
  return selectableProbes(records, current).length > 0;
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

/**
 * Show any GPU-specific affordance only when a fresh, correctness-passing
 * GPU probe exists AND it is the measured winner (highest tokensPerSec,
 * lowest ttftMs on ties) among fresh passing probes. A fast-but-unmeasured
 * or fast-but-failing GPU never shows. This gate is why capability copy may
 * describe what was measured without ever claiming GPU-faster up front.
 */
export function canShowGpu(
  records: readonly ProbeRecord[] | null | undefined,
  current: ProbeContext | null | undefined,
): boolean {
  const selectable = selectableProbes(records, current);
  if (selectable.length === 0) return false;
  let winner: ProbeRecord | undefined;
  for (const record of selectable) {
    if (winner === undefined) {
      winner = record;
      continue;
    }
    if (
      record.tokensPerSec > winner.tokensPerSec ||
      (record.tokensPerSec === winner.tokensPerSec && record.ttftMs < winner.ttftMs)
    ) {
      winner = record;
    }
  }
  return winner !== undefined && winner.backend === "gpu";
}
