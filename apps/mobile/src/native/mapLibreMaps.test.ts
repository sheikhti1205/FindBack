// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeState = vi.hoisted(() => ({
  isNative: false,
  registerImpl: null as null | (() => unknown),
  capabilities: {
    native: true,
    renderer: "maplibre-native",
    rendererVersion: "13.6.1",
    styleProvider: "openfreemap",
    snapshot: true,
    picker: true,
  },
  pickerResult: { cancelled: true } as unknown,
  pickerError: null as unknown,
  viewerResult: { closed: true } as unknown,
  viewerError: null as unknown,
  snapshotResult: { uri: "file:///cache/snap.png", width: 512, height: 320, cacheKey: "abc" } as unknown,
  snapshotError: null as unknown,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => bridgeState.isNative },
  registerPlugin: () => {
    if (!bridgeState.registerImpl) throw new Error("no bridge");
    return bridgeState.registerImpl();
  },
}));

import {
  FindbackMapError,
  getMapCapabilities,
  isNativeMapPickerAvailable,
  openMapPickerNative,
  openMapViewerNative,
  renderMapSnapshotNative,
} from "./mapLibreMaps";

function nativeBridge() {
  return {
    getCapabilities: vi.fn(() => Promise.resolve(bridgeState.capabilities)),
    openPicker: vi.fn(() => {
      if (bridgeState.pickerError) return Promise.reject(bridgeState.pickerError);
      return Promise.resolve(bridgeState.pickerResult);
    }),
    openViewer: vi.fn(() => {
      if (bridgeState.viewerError) return Promise.reject(bridgeState.viewerError);
      return Promise.resolve(bridgeState.viewerResult);
    }),
    renderSnapshot: vi.fn(() => {
      if (bridgeState.snapshotError) return Promise.reject(bridgeState.snapshotError);
      return Promise.resolve(bridgeState.snapshotResult);
    }),
  };
}

afterEach(() => {
  bridgeState.isNative = false;
  bridgeState.registerImpl = null;
  bridgeState.pickerResult = { cancelled: true };
  bridgeState.pickerError = null;
  bridgeState.viewerError = null;
  bridgeState.snapshotResult = { uri: "file:///cache/snap.png", width: 512, height: 320, cacheKey: "abc" };
  bridgeState.snapshotError = null;
});

describe("mapLibreMaps bridge facade", () => {
  it("is unavailable off-device and rejects the picker without touching the bridge", async () => {
    expect(isNativeMapPickerAvailable()).toBe(false);
    await expect(
      openMapPickerNative({ latitude: 23.8, longitude: 90.4 }),
    ).rejects.toMatchObject({ name: "FindbackMapError", code: "MAP_UNAVAILABLE" });
  });

  it("returns capabilities on-device and null on web", async () => {
    await expect(getMapCapabilities()).resolves.toBeNull();
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    await expect(getMapCapabilities()).resolves.toMatchObject({
      renderer: "maplibre-native",
      picker: true,
      snapshot: true,
    });
  });

  it("passes picker confirm coordinates through", async () => {
    bridgeState.isNative = true;
    const bridge = nativeBridge();
    bridgeState.registerImpl = () => bridge;
    bridgeState.pickerResult = { cancelled: false, latitude: 22.3569, longitude: 91.7832, zoom: 15 };
    await expect(
      openMapPickerNative({ latitude: 0, longitude: 0, label: "Chattogram" }),
    ).resolves.toEqual({ cancelled: false, latitude: 22.3569, longitude: 91.7832, zoom: 15 });
    expect(bridge.openPicker).toHaveBeenCalledWith({
      latitude: 0,
      longitude: 0,
      zoom: undefined,
      label: "Chattogram",
      allowCurrentLocation: true,
    });
  });

  it("passes picker cancel through without mutation", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.pickerResult = { cancelled: true };
    await expect(openMapPickerNative({})).resolves.toEqual({ cancelled: true });
  });

  it("rejects malformed picker results instead of committing them", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    for (const bad of [
      { cancelled: false, latitude: 95, longitude: 0, zoom: 15 },
      { cancelled: false, latitude: 22, longitude: Number.NaN, zoom: 15 },
      { cancelled: false, latitude: "22", longitude: 91, zoom: 15 },
      { cancelled: false },
      null,
    ]) {
      bridgeState.pickerResult = bad;
      const error = await openMapPickerNative({}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FindbackMapError);
      expect((error as FindbackMapError).code).toBe("MAP_INVALID_RESULT");
    }
  });

  it("maps native picker failures to consumer-safe errors (no raw text)", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.pickerError = new Error("ActivityNotFoundException: internal state");
    const error = await openMapPickerNative({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FindbackMapError);
    expect((error as Error).message).not.toContain("ActivityNotFoundException");
  });

  it("preserves snapshot specificity instead of collapsing to a generic failure", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.snapshotError = { code: "MAP_SNAPSHOT_FAILED", message: "native detail" };
    const error = await renderMapSnapshotNative({
      latitude: 23.8,
      longitude: 90.4,
      width: 512,
      height: 320,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FindbackMapError);
    expect((error as FindbackMapError).code).toBe("MAP_SNAPSHOT_FAILED");
  });

  it("opens the viewer for valid coordinates and rejects invalid ones before the bridge", async () => {
    bridgeState.isNative = true;
    const bridge = nativeBridge();
    bridgeState.registerImpl = () => bridge;
    await expect(openMapViewerNative({ latitude: 23.8, longitude: 90.4 })).resolves.toEqual({ closed: true });
    await expect(openMapViewerNative({ latitude: 999, longitude: 90.4 })).rejects.toMatchObject({
      code: "MAP_INVALID_COORDINATES",
    });
    expect(bridge.openViewer).toHaveBeenCalledTimes(1);
  });

  it("passes snapshot results through and rejects invalid input before the bridge", async () => {
    bridgeState.isNative = true;
    const bridge = nativeBridge();
    bridgeState.registerImpl = () => bridge;
    await expect(
      renderMapSnapshotNative({ latitude: 23.8, longitude: 90.4, width: 512, height: 320 }),
    ).resolves.toMatchObject({ uri: "file:///cache/snap.png", cacheKey: "abc" });
    await expect(
      renderMapSnapshotNative({ latitude: 999, longitude: 90.4, width: 512, height: 320 }),
    ).rejects.toMatchObject({ code: "MAP_INVALID_COORDINATES" });
    expect(bridge.renderSnapshot).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed snapshot payloads instead of rendering them", async () => {
    bridgeState.isNative = true;
    bridgeState.registerImpl = nativeBridge;
    bridgeState.snapshotResult = { uri: "", width: 1, height: 1, cacheKey: "" };
    await expect(
      renderMapSnapshotNative({ latitude: 23.8, longitude: 90.4, width: 512, height: 320 }),
    ).rejects.toMatchObject({ code: "MAP_INVALID_RESULT" });
  });

  it("never exposes map secrets (the facade has no key parameter at all)", () => {
    expect(openMapPickerNative.length).toBe(1);
    expect(renderMapSnapshotNative.length).toBe(1);
  });
});
