/**
 * Phase A (Step 8): residency coordinator tests. One authority owns the
 * heavy resident, exclusive operations, and inference flights — no ad hoc
 * booleans, no two residents by accident.
 */
import { describe, expect, it } from "vitest";
import { ResidencyBusyError, ResidencyCoordinator } from "./residencyCoordinator";

describe("ResidencyCoordinator", () => {
  it("starts empty with no claims", () => {
    const coordinator = new ResidencyCoordinator();
    expect(coordinator.snapshot()).toEqual({ owner: "none", exclusive: undefined, claimed: false, inflight: 0 });
  });

  it("serializes inference: a second claim throws while one is held", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.claimInference("route-a");
    expect(() => coordinator.claimInference("route-b")).toThrow(ResidencyBusyError);
    coordinator.releaseInference("route-a");
    expect(() => coordinator.claimInference("route-b")).not.toThrow();
    coordinator.releaseInference("route-b");
  });

  it("exclusive operations block inference claims and vice versa", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.beginExclusive("remove:x");
    expect(() => coordinator.claimInference("route")).toThrow(ResidencyBusyError);
    expect(() => coordinator.beginGeneration()).toThrow(ResidencyBusyError);
    coordinator.endExclusive("remove:x");
    expect(coordinator.inferenceBlocked).toBe(false);
    coordinator.claimInference("route");
    expect(() => coordinator.beginExclusive("remove:x")).toThrow(ResidencyBusyError);
    coordinator.releaseInference("route");
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

  it("switchTo aborts in-flight generations so stale work cannot survive", async () => {
    const coordinator = new ResidencyCoordinator();
    const generation = coordinator.beginGeneration();
    let aborted = false;
    generation.signal.addEventListener("abort", () => { aborted = true; });
    await coordinator.switchTo("needle", { evict: async () => {}, load: async () => {} });
    expect(aborted).toBe(true);
    expect(generation.signal.aborted).toBe(true);
    generation.done();
  });

  it("released drops ownership only for the matching owner", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.released("needle");
    expect(coordinator.current).toBe("none");
  });

  it("reset aborts flights and drops every claim (logout cleanup)", () => {
    const coordinator = new ResidencyCoordinator();
    coordinator.claimInference("route");
    const generation = coordinator.beginGeneration();
    let aborted = false;
    generation.signal.addEventListener("abort", () => { aborted = true; });
    coordinator.reset();
    expect(aborted).toBe(true);
    expect(coordinator.snapshot()).toEqual({ owner: "none", exclusive: undefined, claimed: false, inflight: 0 });
    expect(() => coordinator.claimInference("route")).not.toThrow();
    coordinator.releaseInference("route");
  });
});
