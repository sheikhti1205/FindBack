/**
 * WS-A runtime registry: named inference backends behind a tiny surface.
 *
 * A runtime reports availability synchronously (`available`) and runs one
 * invocation (`invoke`). The orchestrator picks the FIRST available runtime
 * in spec order on the model path (skipping `deterministic-local`, whose
 * rules already ran) and invokes it exactly once per route (single-path: no
 * fan-out, no silent retry on another backend). Test doubles register
 * counting fakes the same way production registers native bridges.
 */
import { isTaskId, tryDeterministic } from "./taskRegistry";

export type RuntimeKind = "deterministic" | "model" | "embedding" | "vision";

export interface RuntimeInvokeInput {
  readonly taskId: string;
  readonly input: unknown;
  readonly timeoutMs: number;
  readonly traceId: string;
  /**
   * Phase A (Step 7): cooperative cancellation. The orchestrator aborts this
   * signal on route timeout and on caller cancel; adapters must stop waiting
   * on (and, where the native bridge supports it, cancel) the underlying
   * work once it fires. Never run unobserved after abort.
   */
  readonly signal: AbortSignal;
  /**
   * Audit closure: busy-until-settle. Adapters hand the RAW native promise
   * here before racing it, so the inference lease stays busy until the
   * underlying native work actually settles — even when the visible request
   * already returned TIMEOUT/CANCELLED. Optional so test doubles stay tiny.
   */
  readonly trackSettlement?: (work: Promise<unknown>) => void;
}

export type RuntimeResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly modelId: string;
      readonly backend: string;
      /**
       * Phase A (Step 6): the physical runtime that produced the value
       * (e.g. "needle-cact"), distinct from the logical `backend` runtime
       * id (e.g. "local-text"). Downstream normalization must be driven by
       * this id, never by a hard-coded profile for another model.
       */
      readonly runtimeId: string;
      /** Pinned catalogue revision of the serving model, when the runtime knows it. */
      readonly modelRevision?: string;
    }
  | { readonly ok: false; readonly error: string; readonly denialReason: string };

export interface AiRuntime {
  readonly id: string;
  readonly kind: RuntimeKind;
  available(): boolean;
  /**
   * Audit closure: descriptor task roles drive selection. A runtime serves
   * a task only when its model's descriptor permits the role; runtimes
   * without role metadata (legacy/test doubles) serve every task their
   * spec lists. Production adapters always carry roles.
   */
  servesTask?(taskId: string): boolean;
  invoke(input: RuntimeInvokeInput): Promise<RuntimeResult>;
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, AiRuntime>();

  register(runtime: AiRuntime): void {
    this.runtimes.set(runtime.id, runtime);
  }

  get(id: string): AiRuntime | undefined {
    return this.runtimes.get(id);
  }

  list(): readonly AiRuntime[] {
    return [...this.runtimes.values()];
  }

  /**
   * First runtime in `ids` order that is available AND permitted to serve
   * `taskId`. Role metadata decides eligibility; availability decides
   * readiness. Both must hold — installed but role-incompatible runtimes
   * never serve the task.
   */
  firstAvailable(ids: readonly string[], taskId?: string): AiRuntime | undefined {
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime === undefined || !runtime.available()) continue;
      if (taskId !== undefined && runtime.servesTask !== undefined && !runtime.servesTask(taskId)) continue;
      return runtime;
    }
    return undefined;
  }
}

const DETERMINISTIC_RUNTIME_ID = "deterministic-local" as const;

/**
 * Default registry: the in-process deterministic runtime only. Model,
 * embedding, and vision bridges register themselves when their native
 * capability is present; until then those tasks fail closed (NO_RUNTIME)
 * instead of guessing. The deterministic runtime delegates to the same
 * `tryDeterministic` rules the orchestrator consults first.
 */
export function createDefaultRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();
  registry.register({
    id: DETERMINISTIC_RUNTIME_ID,
    kind: "deterministic",
    available: () => true,
    invoke: async (input) => {
      if (!isTaskId(input.taskId)) {
        return { ok: false, error: "Unknown task.", denialReason: "UNKNOWN_TASK" };
      }
      const outcome = tryDeterministic(input.taskId, input.input);
      if (outcome.resolved) {
        return {
          ok: true,
          value: outcome.value,
          modelId: DETERMINISTIC_RUNTIME_ID,
          backend: DETERMINISTIC_RUNTIME_ID,
          runtimeId: DETERMINISTIC_RUNTIME_ID,
        };
      }
      return { ok: false, error: "No deterministic rule matched.", denialReason: "NO_DETERMINISTIC" };
    },
  });
  return registry;
}
