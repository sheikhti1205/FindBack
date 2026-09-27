// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixState, LocationAdapter } from "./locationAdapter";
import {
  FIX_MICROCOPY,
  FIX_OFFLINE_MAP_COPY,
  FIX_READY_COPY,
  LOW_ACCURACY_METERS,
  accuracyBand,
  accuracyReviewMessage,
  createProductionLocationAdapter,
  isApproximateDefault,
  needsAccuracyReview,
  requestFixWithGeneration,
} from "./locationAdapter";

/**
 * Deterministic fake adapter for testing. Allows controlling the
 * permission state, services state, and fix outcome without any
 * real geolocation API or timers.
 */
function createFakeAdapter(overrides: {
  permission?: "granted" | "prompt" | "denied" | "unknown";
  servicesEnabled?: boolean | null;
  fix?: { latitude: number; longitude: number; accuracyMeters: number | null } | null;
  fixError?: "timeout" | "unavailable" | Error;
  fixDelayMs?: number;
} = {}): LocationAdapter {
  const {
    permission = "granted",
    servicesEnabled = null,
    fix = { latitude: 23.8103, longitude: 90.4125, accuracyMeters: 50 },
    fixError,
    fixDelayMs = 0,
  } = overrides;

  return {
    async getPermission() {
      return permission;
    },
    async servicesEnabled() {
      return servicesEnabled;
    },
    async getCurrentPosition() {
      if (fixDelayMs > 0) {
        await new Promise((r) => setTimeout(r, fixDelayMs));
      }
      if (fixError) {
        if (fixError === "timeout") {
          throw new Error("timeout");
        }
        if (fixError === "unavailable") {
          throw new Error("unavailable");
        }
        throw fixError;
      }
      if (!fix) {
        throw new Error("unavailable");
      }
      return fix;
    },
  };
}

describe("locationAdapter core types and helpers", () => {
  it("exports FixState with all required variants", () => {
    const states: FixState[] = [
      { kind: "idle" },
      { kind: "requesting-permission" },
      { kind: "locating", startedAt: Date.now() },
      { kind: "fix", lat: 1, lng: 2, accuracy: 10 },
      { kind: "denied", message: "x" },
      { kind: "services-off", message: "x" },
      { kind: "timeout", message: "x" },
      { kind: "unavailable", message: "x" },
      { kind: "unsupported", message: "x" },
    ];
    expect(states).toHaveLength(9);
  });

  it("FIX_MICROCOPY has exact strings from the packet", () => {
    expect(FIX_MICROCOPY.denied).toBe(
      "Location access is off for FindBack. Enable it in Settings, or choose a place on the map.",
    );
    expect(FIX_MICROCOPY["services-off"]).toBe(
      "Device location is off. Turn it on or enter a place.",
    );
    expect(FIX_MICROCOPY.timeout).toBe(
      "We couldn't get a fix in time. Try again, choose on map, or enter a place.",
    );
    expect(FIX_MICROCOPY.unavailable).toBe(
      "Location is unavailable right now. Try again, choose on map, or enter a place.",
    );
    expect(FIX_MICROCOPY.unsupported).toBe(
      "Location is not supported in this browser. Choose a place on the map or enter coordinates.",
    );
  });

  it("isApproximateDefault tracks whether high accuracy was requested", () => {
    expect(isApproximateDefault()).toBe(true);
    expect(isApproximateDefault({ enableHighAccuracy: false })).toBe(true);
    expect(isApproximateDefault({ enableHighAccuracy: true })).toBe(false);
  });

  it("accuracyBand formats metres and kilometres with 'around' prefix", () => {
    expect(accuracyBand(null)).toBe("around a few km");
    expect(accuracyBand(NaN)).toBe("around a few km");
    expect(accuracyBand(50)).toBe("around 50 m");
    expect(accuracyBand(500)).toBe("around 500 m");
    expect(accuracyBand(999)).toBe("around 999 m");
    expect(accuracyBand(1000)).toBe("around 1.0 km");
    expect(accuracyBand(1500)).toBe("around 1.5 km");
    expect(accuracyBand(5000)).toBe("around 5.0 km");
  });

  it("exposes ready and offline-map copy and the low-accuracy review gate", () => {
    expect(FIX_READY_COPY).toBe(
      "Approximate area selected. Review the public pin before posting.",
    );
    expect(FIX_OFFLINE_MAP_COPY).toBe(
      "Map tiles are unavailable. Your typed place and coordinate choice are still saved.",
    );
    expect(accuracyReviewMessage(1500)).toBe(
      "This estimate is around 1.5 km; review before using it.",
    );
    // At or under the ~500 m published-pin band no explicit review is needed.
    expect(needsAccuracyReview(499)).toBe(false);
    expect(needsAccuracyReview(500)).toBe(false);
    expect(needsAccuracyReview(501)).toBe(true);
    expect(needsAccuracyReview(null)).toBe(false);
    expect(LOW_ACCURACY_METERS).toBe(500);
  });
});

describe("requestFixWithGeneration with fake adapter", () => {
  it("permission denied -> returns denied state with exact microcopy", async () => {
    const adapter = createFakeAdapter({ permission: "denied" });
    const states: FixState[] = [];
    const result = await requestFixWithGeneration(adapter, {
      onStateChange: (s) => states.push(s),
    });
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.message).toBe(FIX_MICROCOPY.denied);
    // Should have emitted requesting-permission then denied
    expect(states.map((s) => s.kind)).toEqual(["requesting-permission", "denied"]);
  });

  it("permission unknown (unsupported) -> returns unsupported state", async () => {
    const adapter = createFakeAdapter({ permission: "unknown" });
    const result = await requestFixWithGeneration(adapter);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.message).toBe(FIX_MICROCOPY.unsupported);
  });

  it("services off -> returns services-off state", async () => {
    const adapter = createFakeAdapter({ permission: "granted", servicesEnabled: false });
    const result = await requestFixWithGeneration(adapter);
    expect(result.kind).toBe("services-off");
    if (result.kind === "services-off") expect(result.message).toBe(FIX_MICROCOPY["services-off"]);
  });

  it("servicesEnabled returns null -> proceeds to locating (unknown treated as on)", async () => {
    const adapter = createFakeAdapter({ permission: "granted", servicesEnabled: null });
    const states: FixState[] = [];
    const result = await requestFixWithGeneration(adapter, { onStateChange: (s) => states.push(s) });
    expect(result.kind).toBe("fix");
    expect(states.some((s) => s.kind === "locating")).toBe(true);
  });

  it("valid fix -> returns fix state with coordinates and accuracy", async () => {
    const adapter = createFakeAdapter({
      fix: { latitude: 23.8103, longitude: 90.4125, accuracyMeters: 50 },
    });
    const result = await requestFixWithGeneration(adapter);
    expect(result.kind).toBe("fix");
    if (result.kind === "fix") {
      expect(result.lat).toBe(23.8103);
      expect(result.lng).toBe(90.4125);
      expect(result.accuracy).toBe(50);
    }
  });

  it("low accuracy fix -> returns fix state with accuracy (caller decides warning)", async () => {
    const adapter = createFakeAdapter({
      fix: { latitude: 23.8103, longitude: 90.4125, accuracyMeters: 800 },
    });
    const result = await requestFixWithGeneration(adapter);
    expect(result.kind).toBe("fix");
    if (result.kind === "fix") {
      expect(result.accuracy).toBe(800);
      // accuracyBand formats the warning band
      expect(accuracyBand(result.accuracy)).toBe("around 800 m");
    }
  });

  it("timeout -> returns timeout state with exact microcopy", async () => {
    const adapter = createFakeAdapter({ fixError: "timeout" });
    const result = await requestFixWithGeneration(adapter, { timeoutMs: 100 });
    expect(result.kind).toBe("timeout");
    if (result.kind === "timeout") expect(result.message).toBe(FIX_MICROCOPY.timeout);
  });

  it("unavailable error -> returns unavailable state", async () => {
    const adapter = createFakeAdapter({ fixError: "unavailable" });
    const result = await requestFixWithGeneration(adapter);
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") expect(result.message).toBe(FIX_MICROCOPY.unavailable);
  });

  it("late callback after generation bump is ignored (no fix committed)", async () => {
    // First request: slow fix
    let resolveSlowFix: (v: { latitude: number; longitude: number; accuracyMeters: number | null }) => void;
    const slowFixPromise = new Promise<{ latitude: number; longitude: number; accuracyMeters: number | null }>(
      (r) => {
        resolveSlowFix = r;
      },
    );

    const adapter = createFakeAdapter({
      fix: null,
      fixError: undefined,
    });
    // Override getCurrentPosition to return our controllable promise
    adapter.getCurrentPosition = vi.fn().mockImplementation(() => slowFixPromise);

    // External generation token shared between requests
    const generation = { current: 0 };

    // Start first request with generation token
    const firstRequest = requestFixWithGeneration(adapter, { timeoutMs: 5000, generation });

    // Immediately bump generation (simulating screen close / account switch / new request)
    generation.current += 1;

    // Start a second request (with new generation)
    const adapter2 = createFakeAdapter({
      fix: { latitude: 1, longitude: 2, accuracyMeters: 10 },
    });
    const secondResult = await requestFixWithGeneration(adapter2, { generation: { current: generation.current } });

    // Now resolve the slow fix from the first request
    resolveSlowFix!({ latitude: 99, longitude: 99, accuracyMeters: 10 });

    const firstResult = await firstRequest;

    // First request should return idle (discarded) because generation was bumped
    expect(firstResult.kind).toBe("idle");
    // Second request should have succeeded normally
    expect(secondResult.kind).toBe("fix");
  });

  it("retries allowed after previous promise settles", async () => {
    // First request times out
    const adapter1 = createFakeAdapter({ fixError: "timeout" });
    const result1 = await requestFixWithGeneration(adapter1, { timeoutMs: 50 });
    expect(result1.kind).toBe("timeout");

    // Second request (new adapter instance) succeeds
    const adapter2 = createFakeAdapter({ fix: { latitude: 1, longitude: 2, accuracyMeters: 10 } });
    const result2 = await requestFixWithGeneration(adapter2);
    expect(result2.kind).toBe("fix");
  });

  it("manual coordinates remain usable without any fix (idle state)", async () => {
    // When user doesn't request location at all, the adapter is never called.
    // This test documents that the FixState.idle exists and carries no coords.
    const idleState: FixState = { kind: "idle" };
    expect(idleState.kind).toBe("idle");
    expect("lat" in idleState).toBe(false);
  });

  it("coordinates are never written to logs (no console.log/spy in adapter)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adapter = createFakeAdapter({ fix: { latitude: 23.8103, longitude: 90.4125, accuracyMeters: 50 } });
    await requestFixWithGeneration(adapter);

    // No coordinates should appear in any console call
    const allCalls = [
      ...consoleSpy.mock.calls.flat(),
      ...consoleErrorSpy.mock.calls.flat(),
      ...consoleWarnSpy.mock.calls.flat(),
    ];
    const allText = allCalls.join(" ");
    expect(allText).not.toContain("23.8103");
    expect(allText).not.toContain("90.4125");

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it("emits intermediate states in order: requesting-permission -> locating -> fix", async () => {
    const adapter = createFakeAdapter({ fix: { latitude: 1, longitude: 2, accuracyMeters: 10 } });
    const states: FixState[] = [];
    await requestFixWithGeneration(adapter, { onStateChange: (s) => states.push(s) });
    expect(states.map((s) => s.kind)).toEqual([
      "requesting-permission",
      "locating",
      "fix",
    ]);
  });

  it("emits requesting-permission -> services-off when services disabled", async () => {
    const adapter = createFakeAdapter({ permission: "granted", servicesEnabled: false });
    const states: FixState[] = [];
    await requestFixWithGeneration(adapter, { onStateChange: (s) => states.push(s) });
    expect(states.map((s) => s.kind)).toEqual(["requesting-permission", "services-off"]);
  });

  it("emits requesting-permission -> denied when permission denied", async () => {
    const adapter = createFakeAdapter({ permission: "denied" });
    const states: FixState[] = [];
    await requestFixWithGeneration(adapter, { onStateChange: (s) => states.push(s) });
    expect(states.map((s) => s.kind)).toEqual(["requesting-permission", "denied"]);
  });
});

describe("createProductionLocationAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as Record<string, unknown>).geolocation;
    delete (navigator as unknown as Record<string, unknown>).permissions;
  });

  it("queries permission without requesting coordinates or a prompt", async () => {
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    const query = vi.fn().mockResolvedValue({ state: "prompt" });
    Object.defineProperty(navigator, "permissions", { configurable: true, value: { query } });

    expect(await createProductionLocationAdapter().getPermission()).toBe("prompt");
    expect(query).toHaveBeenCalledWith({ name: "geolocation" });
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("does not invoke geolocation when read-only permission status is denied", async () => {
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    Object.defineProperty(navigator, "permissions", {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: "denied" }) },
    });
    const result = await requestFixWithGeneration(createProductionLocationAdapter());
    expect(result.kind).toBe("denied");
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("allows a gesture to try a fix when Permissions API is unavailable", async () => {
    const getCurrentPosition = vi.fn((_: unknown, fail: (error: { code: number }) => void) => fail({ code: 1 }));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    expect(await createProductionLocationAdapter().getPermission()).toBe("prompt");
    expect(getCurrentPosition).not.toHaveBeenCalled();
    const result = await requestFixWithGeneration(createProductionLocationAdapter());
    expect(result.kind).toBe("denied");
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("preserves platform service-off and timeout failures", async () => {
    for (const [code, kind] of [[2, "services-off"], [3, "timeout"]] as const) {
      const getCurrentPosition = vi.fn((_: unknown, fail: (error: { code: number }) => void) => fail({ code }));
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
      expect((await requestFixWithGeneration(createProductionLocationAdapter())).kind).toBe(kind);
    }
  });

  it("returns an object matching LocationAdapter interface", () => {
    const adapter = createProductionLocationAdapter();
    expect(typeof adapter.getCurrentPosition).toBe("function");
    expect(typeof adapter.getPermission).toBe("function");
    expect(typeof adapter.servicesEnabled).toBe("function");
  });

  it("getPermission returns a promise resolving to a valid permission string", async () => {
    const adapter = createProductionLocationAdapter();
    const permission = await adapter.getPermission();
    expect(["granted", "prompt", "denied", "unknown"]).toContain(permission);
  });

  it("servicesEnabled returns null (unknown) by default", async () => {
    const adapter = createProductionLocationAdapter();
    const services = await adapter.servicesEnabled?.();
    expect(services).toBeNull();
  });
});
