/**
 * Application-wide local runtime coordinator: one authority owns
 * heavy-runtime residency (Needle vs SmolVLM2 vision), exclusive operations
 * (remove/measure), and in-flight inference — exclusion AND cancellation
 * through a single lease object.
 *
 * One production inference lease contains the generation id, the
 * AbortController/signal, runtime ownership, visible-request completion,
 * native settlement, and release semantics. Every production local route
 * registers with it; there is no second generation mechanism on the
 * production path.
 *
 * Two lifecycles, deliberately distinguished:
 * - visible request lifecycle: may return TIMEOUT/CANCELLED promptly.
 * - native operation lifecycle: the lease stays busy (refusing new
 *   inference, switches, removals, and measurements) until every tracked
 *   native promise actually settles. No switch/remove/new inference may
 *   start while orphaned native work is still running.
 *
 * Layering: this is the TypeScript application authority. Native plugins
 * keep their own operation gates (SmolVLM2 `RuntimeOperationGate`, Needle
 * locks) as defense in depth; they never grant residency by themselves.
 */
export type ResidencyOwner = "needle" | "smol-vision" | "none";

export class ResidencyBusyError extends Error {
  constructor(label: string) {
    super(`On-device runtime is busy (${label})`);
    this.name = "ResidencyBusyError";
  }
}

/**
 * One production inference flight. `signal` aborts the visible request;
 * `trackNative` observes raw native promises; `requestSettled` runs when
 * the visible request returns. The lease frees only when the request has
 * settled AND no tracked native work is pending.
 */
export interface InferenceLease {
  readonly id: number;
  readonly signal: AbortSignal;
  abort(): void;
  trackNative(work: Promise<unknown>): void;
  requestSettled(): void;
}

interface Generation {
  readonly id: number;
  readonly controller: AbortController;
  done: boolean;
}

/**
 * Single-flight residency + operation gate. All methods are synchronous
 * except `switchTo`, which awaits caller-provided evict/load callbacks
 * while holding the gate.
 */
export class ResidencyCoordinator {
  private owner: ResidencyOwner = "none";
  private exclusiveLabel: string | undefined;
  private nextGenerationId = 1;
  private readonly generations = new Map<number, Generation>();
  private activeLeaseId: number | undefined;
  private activeLeaseController: AbortController | undefined;
  private settlingNative = 0;
  private readonly idleWaiters = new Set<() => void>();

  /** Resolve idle waiters whenever the gate reaches the free state. */
  private notifyIdle(): void {
    if (this.activeLeaseId !== undefined || this.settlingNative > 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const wake of waiters) wake();
  }

  /** True while an exclusive operation (remove/measure) holds the gate. */
  get isExclusive(): boolean {
    return this.exclusiveLabel !== undefined;
  }

  get exclusiveOwner(): string | undefined {
    return this.exclusiveLabel;
  }

  /** True while any legacy inference generation is in flight. */
  get hasInflight(): boolean {
    for (const generation of this.generations.values()) {
      if (!generation.done) return true;
    }
    return false;
  }

  /**
   * Route/inference gate: busy while exclusive work holds the gate, while
   * a visible request is active, or while orphaned native work is still
   * settling after its request returned.
   */
  get inferenceBlocked(): boolean {
    return this.exclusiveLabel !== undefined || this.activeLeaseId !== undefined || this.settlingNative > 0;
  }

  /**
   * Begin one production inference flight. Throws ResidencyBusyError while
   * exclusive work, another flight, or unsettled native work holds the
   * gate. Pair every success with `requestSettled` in a finally.
   */
  beginInference(label: string): InferenceLease {
    if (this.exclusiveLabel !== undefined || this.activeLeaseId !== undefined || this.settlingNative > 0) {
      throw new ResidencyBusyError(label);
    }
    const id = this.nextGenerationId++;
    const controller = new AbortController();
    this.activeLeaseId = id;
    this.activeLeaseController = controller;
    return {
      id,
      signal: controller.signal,
      abort: () => {
        if (this.activeLeaseId === id) controller.abort();
      },
      trackNative: (work: Promise<unknown>) => {
        if (this.activeLeaseId !== id) return;
        this.trackActiveNative(work);
      },
      requestSettled: () => {
        if (this.activeLeaseId === id) {
          this.activeLeaseId = undefined;
          this.activeLeaseController = undefined;
        }
        this.notifyIdle();
      },
    };
  }

  /** Abort the active flight's visible request (logout, account switch). */
  abortInference(): void {
    this.activeLeaseController?.abort();
  }

  /**
   * Track native work onto the currently active flight, if any. Lets
   * nested producers that cannot hold their own lease (single flight) —
   * e.g. the offline provider's inner orchestrator route — still keep
   * the gate busy until their native work settles. No active flight:
   * ignored.
   */
  trackActiveNative(work: Promise<unknown>): void {
    if (this.activeLeaseId === undefined) return;
    this.settlingNative += 1;
    const done = () => {
      this.settlingNative = Math.max(0, this.settlingNative - 1);
      this.notifyIdle();
    };
    work.then(done, done);
  }

  /**
   * Audit closure: resolve when no flight is active and no tracked native
   * work is settling. Account reset awaits this before unloading engines,
   * so a non-cancellable native call is never torn down mid-execution.
   * Bounded escape hatch (default 30s): a leaked native promise must not
   * hang sign-out forever — false means the gate is still busy.
   */
  whenNativeIdle(timeoutMs = 30_000): Promise<boolean> {
    if (this.activeLeaseId === undefined && this.settlingNative === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.add(wake);
    });
  }

  get current(): ResidencyOwner {
    return this.owner;
  }

  snapshot(): { owner: ResidencyOwner; exclusive: string | undefined; claimed: boolean; inflight: number } {
    let inflight = 0;
    for (const generation of this.generations.values()) {
      if (!generation.done) inflight += 1;
    }
    if (this.activeLeaseId !== undefined) inflight += 1;
    return { owner: this.owner, exclusive: this.exclusiveLabel, claimed: this.activeLeaseId !== undefined, inflight };
  }

  /**
   * Take the exclusive gate for remove/measure-style work. Throws
   * ResidencyBusyError while inference (active or settling) or another
   * exclusive operation holds the gate. Pair every success with
   * `endExclusive`.
   */
  beginExclusive(label: string): void {
    if (
      this.exclusiveLabel !== undefined ||
      this.activeLeaseId !== undefined ||
      this.settlingNative > 0 ||
      this.hasInflight
    ) {
      throw new ResidencyBusyError(label);
    }
    this.exclusiveLabel = label;
  }

  endExclusive(label: string): void {
    if (this.exclusiveLabel === label) this.exclusiveLabel = undefined;
  }

  /**
   * Register one auxiliary inference generation. Throws when the exclusive
   * gate is held. This is NOT the production route mechanism (routes use
   * `beginInference`); it exists for auxiliary flights whose cancellation
   * must join switch/reset. The caller links `entry.signal` into its
   * cancellation chain and calls `done()` exactly once on settlement.
   */
  beginGeneration(): { id: number; signal: AbortSignal; done(): void } {
    if (this.exclusiveLabel !== undefined) {
      throw new ResidencyBusyError("inference generation");
    }
    const id = this.nextGenerationId++;
    const controller = new AbortController();
    const entry: Generation = { id, controller, done: false };
    this.generations.set(id, entry);
    return {
      id,
      signal: controller.signal,
      done: () => {
        entry.done = true;
        this.generations.delete(id);
      },
    };
  }

  /** Abort every auxiliary in-flight generation (reset path). */
  abortInflight(): void {
    for (const generation of this.generations.values()) {
      if (!generation.done) generation.controller.abort();
    }
  }

  /**
   * Switch the heavy resident. Refuses while exclusive work holds the
   * gate, then runs evict (old engine unload) and load (new engine load).
   * A failed load leaves ownership at "none" — never claiming a resident
   * that did not report ready.
   *
   * Deliberately aborts nothing: `switchTo` always runs inside the active
   * flight's own residency switch (via readiness probes), so aborting
   * would cancel the very route performing the switch. Stale-flight
   * cancellation belongs to `reset`/`abortInference`, and the single
   * flight plus busy-until-settle guarantees no second flight can exist
   * across a switch.
   */
  async switchTo(
    next: Exclude<ResidencyOwner, "none">,
    actions: { evict(): Promise<void>; load(): Promise<void> },
  ): Promise<void> {
    if (this.exclusiveLabel !== undefined) {
      throw new ResidencyBusyError(`switch to ${next}`);
    }
    await actions.evict();
    try {
      await actions.load();
    } catch (error) {
      this.owner = "none";
      throw error;
    }
    this.owner = next;
  }

  /** Mark one resident released outside a switch (removal path). */
  released(owner: ResidencyOwner): void {
    if (this.owner === owner) this.owner = "none";
  }

  /**
   * Account/logout cleanup: abort the active flight and every auxiliary
   * generation, drop residency and exclusive claims. The active lease
   * pointer is KEPT (aborted, not cleared) so no new flight can begin
   * until the orphaned route's finally releases it — a stale route can
   * never hand results to the next account, and unsettled native work
   * keeps the gate busy. Engine processes themselves are released by the
   * service's async reset, which runs best-effort alongside.
   */
  reset(): void {
    this.abortInference();
    this.abortInflight();
    this.generations.clear();
    this.owner = "none";
    this.exclusiveLabel = undefined;
  }
}
