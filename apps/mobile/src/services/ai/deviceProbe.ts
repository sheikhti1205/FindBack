/**
 * WS5 device-probe record schema + staleness gate (measured Automatic mode
 * skeleton).
 *
 * Pure TypeScript: no I/O, no benchmark corpus, no Needle/LiteRT/llama
 * bindings, no orchestrator, no UI. The native side mirrors this schema in
 * `android/.../vlm/DeviceProbe.kt` (timing record only, no privileged APIs);
 * this module owns the TypeScript shape and the invalidation rule.
 *
 * A probe is a single measured timing sample for one
 * (model revision, backend) pair on one device. Automatic mode NEVER guesses
 * from `socModel`/RAM names — selection (see `./automaticMode.ts`) ranks only
 * fresh, correctness-passing measurements. Any change to the model revision,
 * backend, probe schema, or benchmark corpus invalidates the record: the
 * caller must re-measure, never auto-prefer the stale sample.
 */

/** Schema version stamped into every `ProbeRecord`. Bump on shape change. */
export const PROBE_VERSION = 1 as const;

/**
 * Measured inference backends. `cpu` is the always-available safe fallback;
 * the probe measures which of these actually runs fastest on-device.
 */
export type DeviceBackend = "cpu" | "gpu" | "nnapi";

/**
 * One measured timing sample for a (model revision, backend) pair.
 *
 * Identity fields (`socModel`, `gpuInfo`, `ramMb`, `osVersion`) are
 * record-keeping ONLY: they describe where the sample was taken and must
 * never influence backend selection (no SoC-name guessing).
 */
export interface ProbeRecord {
  /** SoC marketing/model string as reported by the OS (descriptive only). */
  readonly socModel: string;
  /** GPU/renderer string as reported by the OS (descriptive only). */
  readonly gpuInfo: string;
  /** Total device RAM in MiB at probe time (descriptive only). */
  readonly ramMb: number;
  /** OS version string, e.g. Android release (descriptive only). */
  readonly osVersion: string;
  /** Backend this sample was measured on. */
  readonly backend: DeviceBackend;
  /** Time to first token in milliseconds. Must be finite and > 0. */
  readonly ttftMs: number;
  /** Sustained decode throughput. Must be finite and > 0. */
  readonly tokensPerSec: number;
  /** Benchmark corpus revision the correctness spot-check ran against. */
  readonly corpusVersion: string;
  /** Schema version of the probe itself (see `PROBE_VERSION`). */
  readonly probeVersion: number;
  /** Weighed-model revision the sample was measured with. */
  readonly modelRev: string;
  /**
   * Whether the sample's correctness spot-check passed. Only passing
   * samples are selectable; a fast but wrong backend must never win.
   */
  readonly correctnessPass: boolean;
}

/**
 * Full invalidation key for a single stored probe: the exact
 * (model revision, backend, probe schema, corpus) tuple the sample claims.
 * Any component change means re-measure.
 */
export interface ProbeInvalidationKey {
  readonly modelRev: string;
  readonly backend: DeviceBackend;
  readonly probeVersion: number;
  readonly corpusVersion: string;
}

/**
 * Backend-agnostic freshness context for multi-backend selection: the
 * currently expected (model revision, probe schema, corpus) triple. Backend
 * is per-record, so it is not part of this context (see `isProbeStale` for
 * the single-record check that includes the backend).
 */
export interface ProbeContext {
  readonly modelRev: string;
  readonly probeVersion: number;
  readonly corpusVersion: string;
}

/**
 * Single-record staleness gate. Returns true when ANY invalidation
 * component differs: model revision, backend, probe schema version, or
 * benchmark corpus version. A stale record must be re-measured, never
 * auto-preferred.
 */
export function isProbeStale(
  record: ProbeRecord,
  current: ProbeInvalidationKey,
): boolean {
  return (
    record.modelRev !== current.modelRev ||
    record.backend !== current.backend ||
    record.probeVersion !== current.probeVersion ||
    record.corpusVersion !== current.corpusVersion
  );
}

/**
 * Backend-agnostic freshness for selection: true when the record matches
 * the current (model revision, probe schema, corpus) triple. Backend is
 * the dimension being compared across records, so it is excluded here.
 */
export function isFreshProbe(record: ProbeRecord, current: ProbeContext): boolean {
  return (
    record.modelRev === current.modelRev &&
    record.probeVersion === current.probeVersion &&
    record.corpusVersion === current.corpusVersion
  );
}

/**
 * Structural validation for a probe sample. Returns error strings
 * (empty = valid). Selection additionally requires freshness + a passing
 * correctness flag; this check only guards the measurement shape.
 */
export function validateProbeRecord(record: ProbeRecord): string[] {
  const errors: string[] = [];
  if (record.socModel.trim() === "") errors.push("socModel must be non-empty");
  if (record.gpuInfo.trim() === "") errors.push("gpuInfo must be non-empty");
  if (!Number.isFinite(record.ramMb) || record.ramMb <= 0) {
    errors.push("ramMb must be finite and > 0");
  }
  if (record.osVersion.trim() === "") errors.push("osVersion must be non-empty");
  if (!Number.isFinite(record.ttftMs) || record.ttftMs <= 0) {
    errors.push("ttftMs must be finite and > 0");
  }
  if (!Number.isFinite(record.tokensPerSec) || record.tokensPerSec <= 0) {
    errors.push("tokensPerSec must be finite and > 0");
  }
  if (record.corpusVersion.trim() === "") errors.push("corpusVersion must be non-empty");
  if (!Number.isInteger(record.probeVersion) || record.probeVersion <= 0) {
    errors.push("probeVersion must be a positive integer");
  }
  if (record.modelRev.trim() === "") errors.push("modelRev must be non-empty");
  return errors;
}
