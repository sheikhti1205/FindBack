// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InteractiveLocationMap } from "./InteractiveLocationMap";
import type { MapSnapshotInput, MapSnapshotResult, MapViewerInput } from "../native/mapLibreMaps";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    convertFileSrc: (uri: string) => `converted:${uri}`,
  },
}));

vi.mock("../services/location/rasterTiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/location/rasterTiles")>();
  // A short stall budget keeps the timeout test fast; all tile math stays real.
  return { ...actual, MAP_LOAD_TIMEOUT_MS: 300 };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SNAPSHOT: MapSnapshotResult = {
  uri: "file:///cache/snap.png",
  width: 640,
  height: 360,
  cacheKey: "key-1",
};

function renderMap(overrides: Partial<React.ComponentProps<typeof InteractiveLocationMap>> = {}) {
  const viewer = vi.fn(async (_input: MapViewerInput) => ({ closed: true }));
  const utils = render(
    <InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" snapshotter={null} viewer={viewer} {...overrides} />,
  );
  return { viewer, ...utils };
}

describe("InteractiveLocationMap", () => {
  it("renders the keyless raster fallback when the bridge is missing", () => {
    const snapshotter = vi.fn();
    renderMap({ snapshotter: null });
    expect(screen.getByTestId("interactive-fallback-map")).toBeDefined();
    expect(snapshotter).not.toHaveBeenCalled();
    expect(screen.getByText(/OpenStreetMap contributors/)).toBeDefined();
  });

  it("requests a snapshot on-device and renders the preview", async () => {
    const snapshotter = vi.fn(async (_input: MapSnapshotInput) => SNAPSHOT);
    const viewer = vi.fn(async (_input: MapViewerInput) => ({ closed: true }));
    render(
      <InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" snapshotter={snapshotter} viewer={viewer} />,
    );
    expect(screen.getByText("Loading map preview…")).toBeDefined();
    await waitFor(() => expect(snapshotter).toHaveBeenCalledTimes(1));
    expect(snapshotter).toHaveBeenCalledWith({
      latitude: 23.8,
      longitude: 90.4,
      zoom: 15,
      width: 640,
      height: 360,
    });
    const preview = await screen.findByTestId("interactive-snapshot");
    expect(preview).toBeDefined();
    const img = preview.querySelector("img");
    expect(img?.getAttribute("src")).toBe("converted:file:///cache/snap.png");
  });

  it("taps the preview to open the native viewer", async () => {
    const snapshotter = vi.fn(async (_input: MapSnapshotInput) => SNAPSHOT);
    const viewer = vi.fn(async (_input: MapViewerInput) => ({ closed: true }));
    render(
      <InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" snapshotter={snapshotter} viewer={viewer} />,
    );
    fireEvent.click(await screen.findByTestId("interactive-snapshot"));
    await waitFor(() => expect(viewer).toHaveBeenCalledTimes(1));
    expect(viewer).toHaveBeenCalledWith({ latitude: 23.8, longitude: 90.4, zoom: 15, label: "Dhaka" });
  });

  it("falls back truthfully when the snapshot fails, keeping Open map", async () => {
    const snapshotter = vi.fn(async (_input: MapSnapshotInput): Promise<MapSnapshotResult> => {
      throw new Error("MAP_SNAPSHOT_FAILED");
    });
    const viewer = vi.fn(async (_input: MapViewerInput) => ({ closed: true }));
    render(
      <InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" snapshotter={snapshotter} viewer={viewer} />,
    );
    await screen.findByTestId("interactive-fallback-map");
    expect(screen.getByText(/preview failed/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open map" }));
    await waitFor(() => expect(viewer).toHaveBeenCalledTimes(1));
  });

  it("never fabricates a map without coordinates and never requests one", () => {
    const snapshotter = vi.fn();
    render(
      <InteractiveLocationMap lat={null} lng={null} label="Somewhere" snapshotter={snapshotter} viewer={vi.fn()} />,
    );
    expect(screen.getByText("Somewhere")).toBeDefined();
    expect(screen.queryByTestId("interactive-fallback-map")).toBeNull();
    expect(screen.queryByTestId("interactive-snapshot")).toBeNull();
    expect(snapshotter).not.toHaveBeenCalled();
  });

  it("ignores a stale snapshot response after unmount", async () => {
    let resolveSnapshot!: (value: MapSnapshotResult) => void;
    const snapshotter = vi.fn(
      (_input: MapSnapshotInput) =>
        new Promise<MapSnapshotResult>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { unmount } = render(
      <InteractiveLocationMap lat={23.8} lng={90.4} snapshotter={snapshotter} viewer={vi.fn()} />,
    );
    await waitFor(() => expect(snapshotter).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      resolveSnapshot(SNAPSHOT);
      await Promise.resolve();
    });
    // No crash, no post-unmount state write — the test passing IS the assert.
  });

  it("zooms the fallback grid without a snapshot", () => {
    renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByTestId("interactive-fallback-map")).toBeDefined();
  });
});
