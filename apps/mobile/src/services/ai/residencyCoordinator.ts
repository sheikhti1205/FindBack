/**
 * Phase A (Step 8): application-wide local runtime coordinator.
 *
 * One authority owns heavy-runtime residency (Needle vs SmolVLM2 vision),
 * exclusive operations (remove/measure), and in-flight inference
 * generations. Default rule: one heavy generative resident at a time;
 * switching evicts first, aborts in-flight work, then loads — never two
 * heavy runtimes coexisting by accident.
 *
 * Layering: this is the TypeScript application authority. Native plugins
 * keep their own operation gates (SmolVLM2 `RuntimeOperationGate`, Needle
 * locks) as defense in depth; they never grant residency by themselves.
 * Phase B wires llama.cpp under this same authority — no new ad hoc locks.
 */
export type ResidencyOwner = "needle" | "smol-vision" | "none";

export class ResidencyBusyError extends Error {
  constructor(label: string) {
    super(`On-device runtime is busy (${label})`);
    this.name = "ResidencyBusyError";
  }
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
  private claimedLabel: string | undefined;
  private nextGenerationId = 1;
  private readonly generations = new Map<number, Generation>();

  /** True while an exclusive operation (remove/measure) holds the gate. */
  get isExclusive(): boolean {
    return this.exclusiveLabel !== undefined;
  }

  get exclusiveOwner(): string | undefined {
    return this.exclusiveLabel;
  }

  /** True while any inference generation is in flight. */
  get hasInflight(): boolean {
    for (const generation of this.generations.values()) {
      if (!generation.done) return true;
    }
    return false;
  }

  /** Route/inference gate: busy when exclusive work holds the gate. */
  get inferenceBlocked(): boolean {
    return this.isExclusive || this.claimedLabel !== undefined;
  }

  /**
   * Claim the single inference flight (replaces the old `inferenceBusy`
   * boolean). Throws ResidencyBusyError when exclusive work or another
   * inference holds it. Check-then-claim is atomic within one synchronous
   * stretch, so concurrent routes serialize exactly like before. Pair with
   * `releaseInference` in a finally.
   */
  claimInference(label: string): void {
    if (this.exclusiveLabel !== undefined || this.claimedLabel !== undefined) {
      throw new ResidencyBusyError(label);
    }
    this.claimedLabel = label;
  }

  releaseInference(label: string): void {
    if (this.claimedLabel === label) this.claimedLabel = undefined;
  }

  get current(): ResidencyOwner {
    return this.owner;
  }

  snapshot(): { owner: ResidencyOwner; exclusive: string | undefined; claimed: boolean; inflight: number } {
    let inflight = 0;
    for (const generation of this.generations.values()) {
      if (!generation.done) inflight += 1;
    }
    return { owner: this.owner, exclusive: this.exclusiveLabel, claimed: this.claimedLabel !== undefined, inflight };
  }

  /**
   * Take the exclusive gate for remove/measure-style work. Throws
   * ResidencyBusyError when inference is in flight or another exclusive
   * operation holds the gate. Pair every success with `endExclusive`.
   */
  beginExclusive(label: string): void {
    if (this.exclusiveLabel !== undefined || this.claimedLabel !== undefined || this.hasInflight) {
      throw new ResidencyBusyError(label);
    }
    this.exclusiveLabel = label;
  }

  endExclusive(label: string): void {
    if (this.exclusiveLabel === label) this.exclusiveLabel = undefined;
  }

  /**
   * Register one inference generation. Throws when the exclusive gate is
   * held. The caller links `entry.signal` into its cancellation chain and
   * calls `done()` exactly once when the generation settles.
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

  /** Abort every in-flight generation (switch, reset, account change). */
  abortInflight(): void {
    for (const generation of this.generations.values()) {
      if (!generation.done) generation.controller.abort();
    }
  }

  /**
   * Switch the heavy resident. Aborts in-flight generations first so no
   * stale work survives the switch, refuses while exclusive work holds the
   * gate, then runs evict (old engine unload) and load (new engine load).
   * A failed load leaves ownership at "none" — never claiming a resident
   * that did not report ready.
   */
  async switchTo(
    next: Exclude<ResidencyOwner, "none">,
    actions: { evict(): Promise<void>; load(): Promise<void> },
  ): Promise<void> {
    if (this.exclusiveLabel !== undefined) {
      throw new ResidencyBusyError(`switch to ${next}`);
    }
    this.abortInflight();
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
   * Account/logout cleanup: abort everything, drop residency and exclusive
   * claims. Engine processes themselves are released by the service's async
   * reset, which runs best-effort alongside this synchronous state drop.
   */
  reset(): void {
    this.abortInflight();
    this.generations.clear();
    this.owner = "none";
    this.exclusiveLabel = undefined;
    this.claimedLabel = undefined;
  }
}
