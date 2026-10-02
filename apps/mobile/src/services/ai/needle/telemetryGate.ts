/**
 * WS2 Needle TEXT challenger seam — telemetry gate.
 *
 * Defaults OFF. Recording additionally requires the global diag gate
 * (`setDiagEnabled(true)`), plus an explicit per-seam opt-in
 * (`setNeedleTelemetryOptIn(true)`). There is deliberately NO upload path:
 * the only sink is the local redacted diag ring (user-triggered export),
 * shared with `services/diag.ts`. No fetch, no beacon, no uploader.
 */

import { diag, isDiagEnabled, type DiagFields } from "../../diag";

let needleTelemetryOptIn = false;

/** Explicit per-seam opt-in. Off by default; never persisted here. */
export function setNeedleTelemetryOptIn(value: boolean): void {
  needleTelemetryOptIn = value;
}

export function isNeedleTelemetryOptedIn(): boolean {
  return needleTelemetryOptIn;
}

/**
 * True only when BOTH the global diag gate and the explicit needle opt-in
 * are set. Either one missing keeps the seam silent.
 */
export function isNeedleTelemetryEnabled(): boolean {
  if (!needleTelemetryOptIn) return false;
  return isDiagEnabled();
}

/**
 * Records one local redacted diag event. No-op (returns false) unless the
 * gate is fully enabled. Never uploads: `diag()` writes to the in-memory
 * ring and the on-device JSONL sink only.
 */
export function recordNeedleTelemetry(event: string, fields?: DiagFields): boolean {
  if (!isNeedleTelemetryEnabled()) return false;
  diag(event, fields);
  return true;
}
