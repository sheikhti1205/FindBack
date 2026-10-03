/**
 * WS-A inference provenance: one record per `AiOrchestrator.route` call.
 *
 * `requestedBackend` is the first runtime in the task spec (the preference
 * head); `actualBackend` is the runtime that produced the value
 * (`"deterministic-local"` when the deterministic path resolved, `"none"`
 * when nothing ran). `denialReason` is present only on FAILED routes.
 * `latencyMs` is wall-clock time for the whole route call.
 */
export type OrchestratorState = "IDLE" | "RESOLVING" | "INVOKING" | "COMPLETE" | "FAILED";

export const ORCHESTRATOR_STATES: readonly OrchestratorState[] = [
  "IDLE",
  "RESOLVING",
  "INVOKING",
  "COMPLETE",
  "FAILED",
];

export function isOrchestratorState(value: unknown): value is OrchestratorState {
  return (
    typeof value === "string" &&
    (ORCHESTRATOR_STATES as readonly string[]).includes(value)
  );
}

const TRANSITIONS: Readonly<Record<OrchestratorState, readonly OrchestratorState[]>> = {
  IDLE: ["RESOLVING"],
  RESOLVING: ["INVOKING", "COMPLETE", "FAILED"],
  INVOKING: ["COMPLETE", "FAILED"],
  COMPLETE: ["RESOLVING"],
  FAILED: ["RESOLVING"],
};

export function isAllowedTransition(from: OrchestratorState, to: OrchestratorState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface InferenceProvenance {
  readonly taskId: string;
  readonly modelId: string;
  readonly requestedBackend: string;
  readonly actualBackend: string;
  readonly denialReason?: string;
  readonly latencyMs: number;
  readonly traceId: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function isInferenceProvenance(value: unknown): value is InferenceProvenance {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate["taskId"])) return false;
  if (typeof candidate["modelId"] !== "string") return false;
  if (!isNonEmptyString(candidate["requestedBackend"])) return false;
  if (!isNonEmptyString(candidate["actualBackend"])) return false;
  if (typeof candidate["latencyMs"] !== "number") return false;
  if (!Number.isFinite(candidate["latencyMs"]) || candidate["latencyMs"] < 0) return false;
  if (typeof candidate["traceId"] !== "string" || candidate["traceId"] === "") return false;
  const denial = candidate["denialReason"];
  return denial === undefined || isNonEmptyString(denial);
}
