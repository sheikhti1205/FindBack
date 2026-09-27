// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bridgeStub, geolocationStub } = vi.hoisted(() => ({
  bridgeStub: {
    isLocationEnabled: vi.fn(),
    requestEnableLocation: vi.fn(),
  },
  geolocationStub: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    getCurrentPosition: vi.fn(),
  },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: (name: string) => {
    if (name === "LocationServices") return bridgeStub;
    throw new Error(`unexpected plugin ${name}`);
  },
}));

vi.mock("@capacitor/geolocation", () => ({
  Geolocation: geolocationStub,
}));

import {
  createProductionLocationAdapter,
  mapNativeGeolocationError,
  requestFixWithGeneration,
} from "./locationAdapter";
import { isDeviceLocationEnabled, requestEnableDeviceLocation } from "./locationServices";

function grantedPermissions() {
  return { coarseLocation: "granted", location: "denied" };
}

beforeEach(() => {
  vi.clearAllMocks();
  bridgeStub.isLocationEnabled.mockResolvedValue({ enabled: true });
  geolocationStub.checkPermissions.mockResolvedValue(grantedPermissions());
});

describe("mapNativeGeolocationError", () => {
  it.each([
    ["User denied location permission", "denied"],
    ["Location permission denied", "denied"],
    ["Timeout expired", "timeout"],
    ["Location unavailable", "disabled"],
    ["Device location is off", "disabled"],
    ["Something unexpected", "unavailable"],
  ])("maps %s to %s", (message, expected) => {
    expect(mapNativeGeolocationError(new Error(message))).toBe(expected);
  });
});

describe("native production adapter (fused provider)", () => {
  it("returns the fused fix with accuracy", async () => {
    geolocationStub.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 23.8103, longitude: 90.4125, accuracy: 14 },
      timestamp: Date.now(),
    });
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state).toEqual({ kind: "fix", lat: 23.8103, lng: 90.4125, accuracy: 14 });
    expect(geolocationStub.getCurrentPosition).toHaveBeenCalledWith(
      expect.objectContaining({ enableHighAccuracy: false, maximumAge: 0 }),
    );
  });

  it("short-circuits to services-off when the device switch is off", async () => {
    bridgeStub.isLocationEnabled.mockResolvedValue({ enabled: false });
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state.kind).toBe("services-off");
    expect(geolocationStub.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("maps denial to the denied state", async () => {
    geolocationStub.getCurrentPosition.mockRejectedValue(new Error("User denied location permission"));
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state.kind).toBe("denied");
  });

  it("maps provider unavailability to services-off, never a bare timeout", async () => {
    geolocationStub.getCurrentPosition.mockRejectedValue(new Error("Location unavailable"));
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state.kind).toBe("services-off");
  });

  it("reads permission without prompting: denied short-circuits", async () => {
    geolocationStub.checkPermissions.mockResolvedValue({ coarseLocation: "denied", location: "denied" });
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state.kind).toBe("denied");
    expect(geolocationStub.requestPermissions).not.toHaveBeenCalled();
    expect(geolocationStub.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("attempts a fix when the bridge cannot read the switch (unknown)", async () => {
    bridgeStub.isLocationEnabled.mockRejectedValue(new Error("missing plugin"));
    geolocationStub.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 1, longitude: 2, accuracy: null },
      timestamp: Date.now(),
    });
    const adapter = createProductionLocationAdapter();
    const state = await requestFixWithGeneration(adapter, { timeoutMs: 1000 });
    expect(state.kind).toBe("fix");
  });
});

describe("locationServices bridge", () => {
  it("reports the device switch state", async () => {
    bridgeStub.isLocationEnabled.mockResolvedValue({ enabled: false });
    await expect(isDeviceLocationEnabled()).resolves.toBe(false);
  });

  it("returns null when the bridge throws (unknown, not off)", async () => {
    bridgeStub.isLocationEnabled.mockRejectedValue(new Error("nope"));
    await expect(isDeviceLocationEnabled()).resolves.toBeNull();
  });

  it("resolves the enable dialog result", async () => {
    bridgeStub.requestEnableLocation.mockResolvedValue({ enabled: true });
    await expect(requestEnableDeviceLocation()).resolves.toBe(true);
  });

  it("treats dialog dismissal as false, never throws", async () => {
    bridgeStub.requestEnableLocation.mockRejectedValue(new Error("dismissed"));
    await expect(requestEnableDeviceLocation()).resolves.toBe(false);
  });
});
