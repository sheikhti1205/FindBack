/**
 * WS1 AI orchestrator: routes raw model output through the action gate.
 *
 * The orchestrator never executes effects itself: it validates the model's
 * untrusted output via `evaluateProposal` and returns the typed allow/deny
 * decision to the caller. The caller's `traceId` is passed through untouched
 * on both allow and deny so proposals correlate end to end.
 */
import { evaluateProposal, type GateDecision, type GatePermissions } from "./actionGate";

export type { GateDecision, GatePermissions };

export interface OrchestratorRequest {
  /** Untrusted raw model output, expected shape `{ op, args }`. */
  readonly modelOutput: unknown;
  readonly modelId: string;
  readonly traceId: string;
  readonly permissions: GatePermissions;
}

export type OrchestratorResult = GateDecision;

export class AiOrchestrator {
  propose(request: OrchestratorRequest): OrchestratorResult {
    return evaluateProposal(request.modelOutput, {
      modelId: request.modelId,
      traceId: request.traceId,
      permissions: request.permissions,
    });
  }
}
