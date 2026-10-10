// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeState = vi.hoisted(() => ({
  isNative: false,
  registerImpl: null as null | (() => unknown),
  isAvailableResult: { available: true },
  isAvailableError: null as unknown,
  searchResult: { results: [] as unknown[] },
  searchError: null as unknown,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridgeState.isNative },
  registerPlugin: () => {
    if (!bridgeState.registerImpl) throw new Error("no bridge");
    return bridgeState.registerImpl();
  },
}));

import {
  PlacesSearchError,
  isNativePlacesSearchAvailable,
  searchPlacesNative,
} from "./googlePlaces";

function nativeBridge() {
  return {
    isAvailable: vi.fn().mockImplementation(() => {
      if (bridgeState.isAvailableError) return Promise.reject(bridgeState.isAvailableError);
      return Promise.resolve(bridgeState.isAvailableResult);
    }),
    searchPlaces: vi.fn().mockImplementation(() => {
      if (bridgeState.searchError) return Promise.reject(bridgeState.searchError);
      return Promise.resolve(bridgeState.searchResult);
    }),
  };
}

afterEach(() => {
  bridgeState.isNative = false;
  bridgeState.registerImpl = null;
  bridgeState.isAvailableResult = { available: true };
  bridgeState.isAvailableError = null;
  bridgeState.searchResult = { results: [] };
  bridgeState.searchError = null;
});

describe("googlePlaces bridge facade", () => {
  it("is unavailable off-device and rejects without touching the bridge", async () => {
    expect(isNativePlacesSearchAvailable()).toBe(false);
    await expect(searchPlacesNative("mirpur")).rejects.toMatchObject({
      name: "PlacesSearchError",
      kind: "unavailable",
    });
  });

  it("rejects misconfigured when the native key is missing", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.isAvailableResult = { available: false };
    await expect(searchPlacesNative("mirpur")).rejects.toMatchObject({
      kind: "misconfigured",
    });
  });

  it("returns native results when configured", async () => {
    bridgeState.isNative = true;
    const bridge = nativeBridge();
    bridgeState.registerImpl = () => bridge;
    const results = [{ displayName: "Mirpur, Dhaka", latitude: 23.8, longitude: 90.4 }];
    bridgeState.searchResult = { results };
    await expect(searchPlacesNative("mirpur")).resolves.toEqual(results);
    expect(bridge.searchPlaces).toHaveBeenCalledWith({ query: "mirpur" });
  });

  it("maps native failures to failed with consumer-safe copy (no raw text)", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.searchError = new Error("PlacesClient statusCode=REQUEST_DENIED key=SECRET");
    const error = await searchPlacesNative("mirpur").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlacesSearchError);
    expect((error as PlacesSearchError).kind).toBe("failed");
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("never leaks the API key (the facade has no key parameter at all)", () => {
    expect(searchPlacesNative.length).toBe(1);
  });
});
