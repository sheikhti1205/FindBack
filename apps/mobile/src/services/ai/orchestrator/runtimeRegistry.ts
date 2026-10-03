/**
 * WS-A runtime registry: named inference backends behind a tiny surface.
 *
 * A runtime reports availability synchronously (`available`) and runs one
 * invocation (`invoke`). The orchestrator picks the FIRST available runtime
 * in spec order and invokes it exactly once per route (single-path: no
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
}

export type RuntimeResult =
  | { readonly ok: true; readonly value: unknown; readonly modelId: string; readonly backend: string }
  | { readonly ok: false; readonly error: string; readonly denialReason: string };

export interface AiRuntime {
  readonly id: string;
  readonly kind: RuntimeKind;
  available(): boolean;
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

  /** First runtime in `ids` order whose `available()` is true. */
  firstAvailable(ids: readonly string[]): AiRuntime | undefined {
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime !== undefined && runtime.available()) return runtime;
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
        };
      }
      return { ok: false, error: "No deterministic rule matched.", denialReason: "NO_DETERMINISTIC" };
    },
  });
  return registry;
}
