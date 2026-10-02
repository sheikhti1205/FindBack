/**
 * WS5 measured Automatic mode skeleton: backend selection from probe data.
 *
 * Pure TypeScript: no I/O, no benchmark corpus, no Needle/LiteRT/llama
 * bindings, no orchestrator, no UI, no pricing logic.
 *
 * Selection rules (all load-bearing):
 * - Only FRESH probes are candidates: a record whose model revision, probe
 *   schema, or corpus version mismatches the current context is stale and
 *   must be re-measured, never auto-preferred — even if it was fastest.
 * - Only CORRECTNESS-PASSING probes are candidates: a fast but wrong
 *   backend must never win. Throughput ranks passing samples only.
 * - Ranking is MEASURED ONLY: highest `tokensPerSec` wins, lowest `ttftMs`
 *   breaks ties. Device identity fields (`socModel`, `gpuInfo`, `ramMb`,
 *   `osVersion`) are never read here — no SoC-name guessing, ever.
 * - Safe fallback is always `cpu`: no probes, all stale, or nothing
 *   passing all resolve to re-measure with a `cpu` fallback. The caller
 *   serves `cpu` while the re-measure runs.
 */

import type { DeviceBackend, ProbeContext, ProbeRecord } from "./deviceProbe";
import { isFreshProbe } from "./deviceProbe";

/** Safe fallback backend: always available, never guessed. */
export const AUTOMATIC_FALLBACK_BACKEND: DeviceBackend = "cpu";

/** Why Automatic mode is asking for a (re-)measurement. */
export type AutomaticRemeasureReason =
  | "no-probe"
  | "stale"
  | "none-passing";

/**
 * Backend decision for Automatic mode.
 *
 * - `use`: serve `backend`; `record` is the fresh, passing measurement
 *   that won the ranking.
 * - `remeasure`: no selectable measurement exists. Serve
 *   `fallbackBackend` (`cpu`) while the caller schedules a fresh probe.
 */
export type AutomaticBackendDecision =
  | {
      readonly kind: "use";
      readonly backend: DeviceBackend;
      readonly record: ProbeRecord;
    }
  | {
      readonly kind: "remeasure";
      readonly reason: AutomaticRemeasureReason;
      readonly fallbackBackend: DeviceBackend;
    };

function isSelectableSample(record: ProbeRecord, current: ProbeContext): boolean {
  return (
    isFreshProbe(record, current) &&
    record.correctnessPass === true &&
    Number.isFinite(record.tokensPerSec) &&
    record.tokensPerSec > 0 &&
    Number.isFinite(record.ttftMs) &&
    record.ttftMs > 0
  );
}

/**
 * Pick the backend for Automatic mode from measured probes.
 *
 * Compares MEASURED throughput only (`tokensPerSec` descending, `ttftMs`
 * ascending on ties) across fresh, correctness-passing samples. Stale
 * samples are reported as needing re-measurement and are never ranked —
 * there is no auto-prefer path for them.
 */
export function selectBackend(
  records: readonly ProbeRecord[],
  current: ProbeContext,
): AutomaticBackendDecision {
  if (records.length === 0) {
    return {
      kind: "remeasure",
      reason: "no-probe",
      fallbackBackend: AUTOMATIC_FALLBACK_BACKEND,
    };
  }
  const fresh = records.filter((record) => isFreshProbe(record, current));
  if (fresh.length === 0) {
    return {
      kind: "remeasure",
      reason: "stale",
      fallbackBackend: AUTOMATIC_FALLBACK_BACKEND,
    };
  }
  const passing = fresh.filter((record) => isSelectableSample(record, current));
  if (passing.length === 0) {
    return {
      kind: "remeasure",
      reason: "none-passing",
      fallbackBackend: AUTOMATIC_FALLBACK_BACKEND,
    };
  }
  const ordered = [...passing].sort((a, b) => {
    if (b.tokensPerSec !== a.tokensPerSec) return b.tokensPerSec - a.tokensPerSec;
    return a.ttftMs - b.ttftMs;
  });
  const winner = ordered[0] as ProbeRecord;
  return { kind: "use", backend: winner.backend, record: winner };
}
