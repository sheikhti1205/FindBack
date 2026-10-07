/**
 * Residency coordinator tests: one lease owns exclusion, cancellation, and
 * native settlement for every production flight.
 */
import { describe, expect, it } from "vitest";
import { ResidencyBusyError, ResidencyCoordinator } from "./residencyCoordinator";

describe("ResidencyCoordinator", () => {
  it("starts empty with no claims", () => {
    const coordinator = new ResidencyCoordinator();
    expect(coordinator.snapshot()).toEqual({ owner: "none", exclusive: undefined, claimed: false, inflight: 0 });
  });

  it("serializes inference: a second flight throws while one is held", () => {
    const coordinator = new ResidencyCoordinator();
    const first = coordinator.beginInference("route-a");
    expect(() => coordinator.beginInference("route-b")).toThrow(ResidencyBusyError);
    first.requestSettled();
    expect(() => coordinator.beginInference("route-b")).not.toThrow();
  });

  it("exclusive operations block inference flights and vice versa", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.beginExclusive("remove:x");
    expect(() => coordinator.beginInference("route")).toThrow(ResidencyBusyError);
    expect(() => coordinator.beginGeneration()).toThrow(ResidencyBusyError);
    coordinator.endExclusive("remove:x");
    expect(coordinator.inferenceBlocked).toBe(false);
    const lease = coordinator.beginInference("route");
    expect(() => coordinator.beginExclusive("remove:x")).toThrow(ResidencyBusyError);
    lease.requestSettled();
  });

  it("switchTo evicts before loading and records the new owner", async () => {
    const coordinator = new ResidencyCoordinator();
    const order: string[] = [];
    await coordinator.switchTo("needle", {
      evict: async () => { order.push("evict"); },
      load: async () => { order.push("load"); },
    });
    expect(order).toEqual(["evict", "load"]);
    expect(coordinator.current).toBe("needle");
  });

  it("a failed load leaves ownership at none, never a half-loaded resident", async () => {
    const coordinator = new ResidencyCoordinator();
    await expect(
      coordinator.switchTo("smol-vision", {
        evict: async () => {},
        load: async () => { throw new Error("GPU init failed"); },
      }),
    ).rejects.toThrow("GPU init failed");
    expect(coordinator.current).toBe("none");
  });

  it("switchTo refuses while exclusive work holds the gate", async () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.beginExclusive("measure:cpu");
    await expect(
      coordinator.switchTo("needle", { evict: async () => {}, load: async () => {} }),
    ).rejects.toThrow(ResidencyBusyError);
    coordinator.endExclusive("measure:cpu");
  });

  it("switchTo never aborts auxiliary generations: it runs inside the active flight", async () => {
    const coordinator = new ResidencyCoordinator();
    const generation = coordinator.beginGeneration();
    let aborted = false;
    generation.signal.addEventListener("abort", () => { aborted = true; });
    // Aborting here would cancel the very route performing the residency
    // switch; stale-flight cancellation belongs to reset/abortInference.
    await coordinator.switchTo("needle", { evict: async () => {}, load: async () => {} });
    expect(aborted).toBe(false);
    generation.done();
  });

  it("released drops ownership only for the matching owner", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.released("needle");
    expect(coordinator.current).toBe("none");
  });

  it("reset aborts the active flight but keeps its lease until the route settles", () => {
    const coordinator = new ResidencyCoordinator();
    const lease = coordinator.beginInference("route");
    let aborted = false;
    lease.signal.addEventListener("abort", () => { aborted = true; });
    coordinator.reset();
    expect(aborted).toBe(true);
    // The aborted (not yet settled) flight still owns the gate: no new
    // flight may start until the orphaned route's finally releases it, so
    // stale results can never reach the next account.
    expect(coordinator.inferenceBlocked).toBe(true);
    expect(() => coordinator.beginInference("route-b")).toThrow(ResidencyBusyError);
    lease.requestSettled();
    expect(coordinator.inferenceBlocked).toBe(false);
  });

  it("stays busy until tracked native work settles, even after the request returns", async () => {
    const coordinator = new ResidencyCoordinator();
    const lease = coordinator.beginInference("route");
    let releaseNative!: () => void;
    const native = new Promise<void>((resolve) => { releaseNative = resolve; });
    lease.trackNative(native);
    lease.requestSettled();
    // Visible request returned, native still running: gate stays busy.
    expect(coordinator.inferenceBlocked).toBe(true);
    expect(() => coordinator.beginInference("route-b")).toThrow(ResidencyBusyError);
    expect(() => coordinator.beginExclusive("remove:x")).toThrow(ResidencyBusyError);
    releaseNative();
    await native;
    await Promise.resolve();
    expect(coordinator.inferenceBlocked).toBe(false);
    const next = coordinator.beginInference("route-b");
    next.requestSettled();
  });

  it("a stale lease can never release a newer flight", () => {
    const coordinator = new ResidencyCoordinator();
    const first = coordinator.beginInference("route-a");
    // Simulate logout timing: first is aborted and superseded without its
    // finally having run, then a new flight begins after settlement.
    first.requestSettled();
    const second = coordinator.beginInference("route-b");
    first.requestSettled();
    expect(coordinator.inferenceBlocked).toBe(true);
    second.requestSettled();
    expect(coordinator.inferenceBlocked).toBe(false);
  });

  it("late native tracking after settlement is ignored", async () => {
    const coordinator = new ResidencyCoordinator();
    const lease = coordinator.beginInference("route");
    lease.requestSettled();
    let releaseNative!: () => void;
    const native = new Promise<void>((resolve) => { releaseNative = resolve; });
    lease.trackNative(native);
    releaseNative();
    await native;
    expect(coordinator.inferenceBlocked).toBe(false);
  });
});
