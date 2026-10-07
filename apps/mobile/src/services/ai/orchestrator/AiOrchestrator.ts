/**
 * WS-A AI orchestrator: task router with a deterministic-first policy.
 *
 * `propose` (WS1) routes raw model output through the action gate and never
 * executes effects. `route` (WS-A) routes a task id plus input to exactly
 * one runtime: deterministic rules first, then the first available runtime
 * in spec order (single-path invoke, never fan-out). Every route call
 * returns an `InferenceProvenance` record and moves the observable state
 * machine IDLE → RESOLVING → INVOKING → COMPLETE/FAILED (the deterministic
 * path skips INVOKING: RESOLVING → COMPLETE).
 *
 * Fail-closed: unknown tasks, over-budget input, missing consent, no
 * available runtime, gate-denied model output, and runtime failures all
 * return `{ ok: false }` with a `denialReason` — never a guessed value.
 * When a model runtime fails on a task with a local fallback
 * (summarize-local-context), the fallback travels alongside the failure.
 */
import { evaluateProposal, type GateDecision, type GatePermissions } from "./actionGate";
import { isAllowedTransition, type InferenceProvenance, type OrchestratorState } from "./provenance";
import { createDefaultRegistry, type AiRuntime, type RuntimeRegistry } from "./runtimeRegistry";
import { fallbackFor, getTaskSpec, isTaskId, tryDeterministic } from "./taskRegistry";
import {
  registerProductionRuntimes,
  RouteCancelledError,
  type ProductionRuntimeDeps,
  type ProductionRuntimeId,
} from "./productionRuntimes";
import { LOCAL_TASK_INVALID, validateRouteValue } from "./routeValidation";

export type { GateDecision, GatePermissions };
export type { InferenceProvenance, OrchestratorState };

export interface OrchestratorRequest {
  /** Untrusted raw model output, expected shape `{ op, args }`. */
  readonly modelOutput: unknown;
  readonly modelId: string;
  readonly traceId: string;
  readonly permissions: GatePermissions;
}

export type OrchestratorResult = GateDecision;

export interface RouteContext {
  readonly traceId: string;
  readonly modelId?: string;
  readonly requestedBackend?: string;
  readonly registry?: RuntimeRegistry;
  readonly permissions?: GatePermissions;
  readonly consent?: boolean;
  readonly timeoutMs?: number;
  /** Phase A (Step 7): caller cancel. Aborting this aborts the route. */
  readonly signal?: AbortSignal;
  readonly onState?: (state: OrchestratorState) => void;
}

export type RouteResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly provenance: InferenceProvenance;
      readonly state: "COMPLETE";
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly denialReason: string;
      readonly provenance: InferenceProvenance;
      readonly state: "FAILED";
      readonly fallback?: unknown;
    };

const ANONYMOUS_PERMISSIONS: GatePermissions = { accountId: null, canProposeComments: false };
const NO_BACKEND = "none";
const DETERMINISTIC_BACKEND = "deterministic-local";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text-budget measure for a route input. Image payloads (`images` array,
 * `imageBase64` string) are deliberately EXCLUDED: images are bounded by the
 * task's `maxImages`, not by `maxBytes`, so an inline base64 of a legitimate
 * photo can never trip the text guard and make the vision route unreachable.
 * Every non-image field is still measured, so the text bound is intact.
 */
function inputBytes(input: unknown): number {
  if (typeof input === "string") return input.length;
  if (isRecord(input)) {
    const textOnly: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "images" || key === "imageBase64") continue;
      textOnly[key] = value;
    }
    try {
      return JSON.stringify(textOnly)?.length ?? 0;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function inputImages(input: unknown): number {
  if (isRecord(input) && Array.isArray(input["images"])) return input["images"].length;
  return 0;
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`route-timeout-after-${timeoutMs}ms`);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class AiOrchestrator {
  private currentRouteState: OrchestratorState = "IDLE";
  private readonly sharedRegistry = createDefaultRegistry();

  get routeState(): OrchestratorState {
    return this.currentRouteState;
  }

  propose(request: OrchestratorRequest): OrchestratorResult {
    return evaluateProposal(request.modelOutput, {
      modelId: request.modelId,
      traceId: request.traceId,
      permissions: request.permissions,
    });
  }

  /**
   * Attach production runtimes to the shared registry (WS-G boot path).
   * The shared registry starts deterministic-only; after attach, routes
   * without an injected `ctx.registry` can reach installed + verified
   * on-device models. Idempotent per runtime id (re-registration replaces
   * the adapter). Returns the registered ids.
   */
  attachProductionRuntimes(deps: ProductionRuntimeDeps): readonly ProductionRuntimeId[] {
    return registerProductionRuntimes(this.sharedRegistry, deps);
  }

  async route(taskId: string, input: unknown, ctx: RouteContext): Promise<RouteResult> {
    const startedAt = Date.now();
    const traceId = ctx.traceId;
    const modelId = ctx.modelId ?? "unknown-model";
    const registry = ctx.registry ?? this.sharedRegistry;
    const permissions = ctx.permissions ?? ANONYMOUS_PERMISSIONS;

    this.moveTo("RESOLVING", ctx);

    if (traceId.trim() === "") {
      return this.fail({
        taskId,
        modelId,
        requestedBackend: NO_BACKEND,
        actualBackend: NO_BACKEND,
        denialReason: "BAD_TRACE",
        error: "Missing or malformed traceId.",
        traceId: "",
        startedAt,
        ctx,
      });
    }

    const spec = getTaskSpec(taskId);
    const requestedBackend =
      ctx.requestedBackend ?? (spec !== undefined && spec.runtimes.length > 0 ? spec.runtimes[0]! : NO_BACKEND);
    if (spec === undefined || !isTaskId(taskId)) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: NO_BACKEND,
        denialReason: "UNKNOWN_TASK",
        error: `Unknown task "${taskId}".`,
        traceId,
        startedAt,
        ctx,
      });
    }

    if (inputBytes(input) > spec.maxBytes || inputImages(input) > spec.maxImages) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: NO_BACKEND,
        denialReason: "INPUT_BOUNDS",
        error: "Input exceeds the task budget.",
        traceId,
        startedAt,
        ctx,
      });
    }

    if (spec.consent.required && ctx.consent !== true) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: NO_BACKEND,
        denialReason: "CONSENT_REQUIRED",
        error: `Task "${taskId}" requires explicit consent.`,
        traceId,
        startedAt,
        ctx,
      });
    }

    // Deterministic-first: a resolved rule skips every model runtime, so no
    // model invoke is ever spent on an input decided locally.
    const deterministic = tryDeterministic(taskId, input);
    if (deterministic.resolved) {
      const gated = this.gateValue(deterministic.value, modelId, traceId, permissions);
      if (!gated.allowed) {
        return this.fail({
          taskId,
          modelId,
          requestedBackend,
          actualBackend: DETERMINISTIC_BACKEND,
          denialReason: gated.code,
          error: gated.reason,
          traceId,
          startedAt,
          ctx,
        });
      }
      return this.complete({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: DETERMINISTIC_BACKEND,
        value: deterministic.value,
        traceId,
        startedAt,
        ctx,
      });
    }

    this.moveTo("INVOKING", ctx);
    const timeoutMs =
      ctx.timeoutMs === undefined || ctx.timeoutMs <= 0
        ? spec.timeoutMs
        : Math.min(ctx.timeoutMs, spec.timeoutMs);
    // Model path: the deterministic rules already ran above, so the
    // deterministic registry entry is skipped — otherwise its
    // always-available stub would shadow every model runtime and reduce
    // every non-deterministic input to NO_DETERMINISTIC.
    const runtime = registry.firstAvailable(
      spec.runtimes.filter((id) => id !== DETERMINISTIC_BACKEND),
    );
    if (runtime === undefined) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: NO_BACKEND,
        denialReason: "NO_RUNTIME",
        error: "No available runtime for this task.",
        traceId,
        startedAt,
        ctx,
        fallback: fallbackFor(taskId, input),
      });
    }

    // Single-path invoke: exactly one runtime runs per route call. Phase A
    // (Step 7): the route owns one AbortController per invocation. Timeout
    // aborts it, caller cancel aborts it, and every adapter receives the
    // signal — no generation outlives the returned route.
    const controller = new AbortController();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) controller.abort();
      else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let outcome: Awaited<ReturnType<AiRuntime["invoke"]>>;
    try {
      outcome = await withTimeout(
        runtime.invoke({ taskId, input, timeoutMs, traceId, signal: controller.signal }),
        timeoutMs,
      );
    } catch (error) {
      controller.abort();
      const timedOut = error instanceof Error && error.message.startsWith("route-timeout-after-");
      const cancelled = error instanceof RouteCancelledError || controller.signal.aborted;
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: runtime.id,
        runtimeId: runtime.id,
        denialReason: timedOut ? "TIMEOUT" : cancelled ? "CANCELLED" : "RUNTIME_ERROR",
        error: timedOut
          ? "The runtime exceeded its bound."
          : cancelled
            ? "The route was cancelled."
            : "The runtime failed.",
        traceId,
        startedAt,
        ctx,
        fallback: fallbackFor(taskId, input),
      });
    }
    // A resolved invoke still aborts the controller: a backend that settles
    // its promise while native work lingers must observe abort promptly.
    controller.abort();

    if (!outcome.ok) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: runtime.id,
        runtimeId: runtime.id,
        denialReason: outcome.denialReason,
        error: outcome.error,
        traceId,
        startedAt,
        ctx,
        fallback: fallbackFor(taskId, input),
      });
    }

    // Phase A (Step 5): task output contracts own SUCCESS. A technically
    // successful generation whose value fails the task schema is
    // LOCAL_TASK_INVALID — eligible for allowed cloud fallback in Automatic
    // mode, surfaced in on-device-only, never a silent downstream drop.
    const checked = validateRouteValue(taskId, outcome.value);
    if (!checked.ok) {
      return this.fail({
        taskId,
        modelId,
        requestedBackend,
        actualBackend: runtime.id,
        runtimeId: outcome.runtimeId,
        denialReason: LOCAL_TASK_INVALID,
        error: checked.error,
        traceId,
        startedAt,
        ctx,
        fallback: fallbackFor(taskId, input),
      });
    }

    const gated = this.gateValue(outcome.value, outcome.modelId, traceId, permissions);
    if (!gated.allowed) {
      return this.fail({
        taskId,
        modelId: ctx.modelId ?? outcome.modelId,
        requestedBackend,
        actualBackend: outcome.backend,
        denialReason: gated.code,
        error: gated.reason,
        traceId,
        startedAt,
        ctx,
      });
    }

    return this.complete({
      taskId,
      modelId: ctx.modelId ?? outcome.modelId,
      requestedBackend,
      actualBackend: outcome.backend,
      runtimeId: outcome.runtimeId,
      modelRevision: outcome.modelRevision,
      value: outcome.value,
      traceId,
      startedAt,
      ctx,
    });
  }

  private gateValue(
    value: unknown,
    modelId: string,
    traceId: string,
    permissions: GatePermissions,
  ): { readonly allowed: true } | { readonly allowed: false; readonly code: string; readonly reason: string } {
    if (!isRecord(value) || typeof value["op"] !== "string") return { allowed: true };
    const decision = evaluateProposal(value, { modelId, traceId, permissions });
    if (decision.decision === "allow") return { allowed: true };
    return { allowed: false, code: decision.code, reason: decision.reason };
  }

  private moveTo(state: OrchestratorState, ctx: RouteContext): void {
    if (!isAllowedTransition(this.currentRouteState, state)) {
      // Terminal states re-arm for the next route call: COMPLETE/FAILED may
      // only transition back through RESOLVING, so reset via IDLE first.
      if (
        (this.currentRouteState === "COMPLETE" || this.currentRouteState === "FAILED") &&
        state === "RESOLVING"
      ) {
        this.currentRouteState = "IDLE";
      }
    }
    if (isAllowedTransition(this.currentRouteState, state)) {
      this.currentRouteState = state;
      ctx.onState?.(state);
    }
  }

  private complete(args: {
    readonly taskId: string;
    readonly modelId: string;
    readonly requestedBackend: string;
    readonly actualBackend: string;
    readonly runtimeId?: string;
    readonly modelRevision?: string;
    readonly value: unknown;
    readonly traceId: string;
    readonly startedAt: number;
    readonly ctx: RouteContext;
  }): Extract<RouteResult, { readonly ok: true }> {
    this.moveTo("COMPLETE", args.ctx);
    return {
      ok: true,
      value: args.value,
      provenance: {
        taskId: args.taskId,
        modelId: args.modelId,
        requestedBackend: args.requestedBackend,
        actualBackend: args.actualBackend,
        runtimeId: args.runtimeId ?? args.actualBackend,
        ...(args.modelRevision === undefined ? {} : { modelRevision: args.modelRevision }),
        latencyMs: Date.now() - args.startedAt,
        traceId: args.traceId,
      },
      state: "COMPLETE",
    };
  }

  private fail(args: {
    readonly taskId: string;
    readonly modelId: string;
    readonly requestedBackend: string;
    readonly actualBackend: string;
    readonly runtimeId?: string;
    readonly denialReason: string;
    readonly error: string;
    readonly traceId: string;
    readonly startedAt: number;
    readonly ctx: RouteContext;
    readonly fallback?: unknown;
  }): Extract<RouteResult, { readonly ok: false }> {
    this.moveTo("FAILED", args.ctx);
    return {
      ok: false,
      error: args.error,
      denialReason: args.denialReason,
      provenance: {
        taskId: args.taskId,
        modelId: args.modelId,
        requestedBackend: args.requestedBackend,
        actualBackend: args.actualBackend,
        runtimeId: args.runtimeId ?? args.actualBackend,
        denialReason: args.denialReason,
        latencyMs: Date.now() - args.startedAt,
        traceId: args.traceId,
      },
      state: "FAILED",
      ...(args.fallback === undefined ? {} : { fallback: args.fallback }),
    };
  }
}
