// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InteractiveLocationMap } from "./InteractiveLocationMap";

vi.mock("../services/location/rasterTiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/location/rasterTiles")>();
  // A short stall budget keeps the timeout test fast; all tile math stays real.
  return { ...actual, MAP_LOAD_TIMEOUT_MS: 500 };
});

const behavior = vi.hoisted(() => ({
  workerUrl: null as string | null,
  workerConfiguredAtConstruction: [] as boolean[],
  throwOnConstruct: false,
  throwGeneric: false,
  reportUnsupported: false,
  instances: [] as Array<{
    opts: { style: string; center: [number, number]; zoom: number };
    center: { lat: number; lng: number };
    handlers: Record<string, () => void>;
    zoomCalls: string[];
    controls: number;
  }>,
  markers: [] as Array<[number, number]>,
}));

vi.mock("maplibre-gl", () => {
  class GPUInitializationError extends Error {}
  class NavigationControl {
    constructor(_opts?: unknown) {}
  }
  class Marker {
    coords: [number, number] | null = null;
    setLngLat(coords: [number, number]): Marker {
      this.coords = coords;
      return this;
    }
    addTo(_map: unknown): Marker {
      if (this.coords) behavior.markers.push(this.coords);
      return this;
    }
    remove(): void {}
  }
  class FakeMap {
    state: (typeof behavior.instances)[number];
    constructor(opts: { style: string; center: [number, number]; zoom: number }) {
      behavior.workerConfiguredAtConstruction.push(behavior.workerUrl !== null);
      if (behavior.throwOnConstruct) {
        if (behavior.throwGeneric) throw new Error("boom");
        throw new GPUInitializationError("WebGL unavailable");
      }
      const [lng, lat] = opts.center;
      this.state = {
        opts,
        center: { lat, lng },
        handlers: {},
        zoomCalls: [],
        controls: 0,
      };
      behavior.instances.push(this.state);
    }
    on(event: string, cb: () => void): void {
      this.state.handlers[event] = cb;
    }
    getCenter(): { lat: number; lng: number } {
      return { ...this.state.center };
    }
    addControl(): void {
      this.state.controls += 1;
    }
    zoomIn(): void {
      this.state.zoomCalls.push("in");
    }
    zoomOut(): void {
      this.state.zoomCalls.push("out");
    }
    resize(): void {}
    remove(): void {}
  }
  return {
    Map: FakeMap,
    setWorkerUrl: (url: string) => { behavior.workerUrl = url; },
    Marker,
    NavigationControl,
    GPUInitializationError,
    supported: () => !behavior.reportUnsupported,
  };
});

afterEach(() => {
  cleanup();
  behavior.throwOnConstruct = false;
  behavior.throwGeneric = false;
  behavior.reportUnsupported = false;
  behavior.instances.length = 0;
  behavior.workerUrl = null;
  behavior.workerConfiguredAtConstruction.length = 0;
  behavior.markers.length = 0;
});

describe("InteractiveLocationMap", () => {
  it("configures a bundled worker before construction and stays loading until map load", async () => {
    render(<InteractiveLocationMap lat={23.8} lng={90.4} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    expect(behavior.workerConfiguredAtConstruction).toEqual([true]);
    expect(behavior.workerUrl).toBeTruthy();
    expect(screen.getByText("Loading map…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /zoom in/i })).toBeNull();
    behavior.instances[0]?.handlers.load?.();
    expect(await screen.findByRole("button", { name: /zoom in/i })).toBeTruthy();
  });

  it("falls back to raster tiles with retry when tiles error before load", async () => {
    render(<InteractiveLocationMap lat={23.8} lng={90.4} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    behavior.instances[0]?.handlers.error?.();
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(await screen.findByText(/fallback tiles instead/)).toBeTruthy();
    // No infinite "Loading map…" and the pin location stays listed.
    expect(screen.queryByText("Loading map…")).toBeNull();
    const tiles = document.querySelectorAll('[data-testid="interactive-fallback-map"] img');
    expect(tiles).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(behavior.instances).toHaveLength(2));
  });
  it("renders marker, attribution, and zoom controls for coordinates", async () => {
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    const mapEl = await screen.findByTestId("interactive-location-map");
    expect(mapEl.getAttribute("aria-label")).toMatch(/pan|zoom/i);
    expect(screen.getByRole("region", { name: "Location map: Dhaka" })).toBeTruthy();

    // Construction now waits a frame for layout — await the map itself.
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    expect(behavior.instances[0]?.opts.center).toEqual([90.4, 23.8]);
    expect(behavior.instances[0]?.opts.style).toContain("tiles.openfreemap.org");
    expect(behavior.markers).toEqual([[90.4, 23.8]]);
    expect(behavior.instances[0]?.controls).toBeGreaterThan(0);

    expect(screen.getByText(/OpenStreetMap contributors/)).toBeTruthy();
    expect(screen.getByText("Dhaka")).toBeTruthy();

    behavior.instances[0]?.handlers.load?.();
    const zoomIn = await screen.findByRole("button", { name: /zoom in/i });
    const zoomOut = screen.getByRole("button", { name: /zoom out/i });
    for (const zoomButton of [zoomIn, zoomOut]) {
      expect(zoomButton.className).toMatch(/focus-visible:outline-2/);
      expect(zoomButton.className).toMatch(/focus-visible:outline-offset-2/);
      expect(zoomButton.className).toMatch(/focus-visible:outline-on-surface/);
    }
    fireEvent.click(zoomIn);
    fireEvent.click(zoomOut);
    expect(behavior.instances[0]?.zoomCalls).toEqual(["in", "out"]);
  });

  it("label-only renders a neutral fallback without fabricating coordinates", async () => {
    render(<InteractiveLocationMap lat={null} lng={null} label="Near the park" />);

    expect(await screen.findByText("Near the park")).toBeTruthy();
    expect(await screen.findByText(/without coordinates/i)).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(behavior.instances).toHaveLength(0);
    expect(behavior.markers).toHaveLength(0);
    expect(screen.queryByTestId("interactive-location-map")).toBeNull();
  });

  it("shows a status fallback when WebGL is unavailable", async () => {
    behavior.throwOnConstruct = true;
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows a retryable load fallback on generic map failure", async () => {
    behavior.throwOnConstruct = true;
    behavior.throwGeneric = true;
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("shows the fallback when the supported() gate fails", async () => {
    behavior.reportUnsupported = true;
    render(<InteractiveLocationMap lat={23.8} lng={90.4} />);

    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    expect(behavior.instances).toHaveLength(0);
  });

  it("renders a 3x3 raster grid with working zoom in the fallback", async () => {
    behavior.throwOnConstruct = true;
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    // The pin location stays listed below the fallback.
    expect(screen.getByText("Dhaka")).toBeTruthy();
    const tiles = () =>
      document.querySelectorAll('[data-testid="interactive-fallback-map"] img');
    expect(tiles()).toHaveLength(9);
    for (const tile of Array.from(tiles())) {
      expect(tile.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    for (const tile of Array.from(tiles())) {
      expect(tile.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/14\/\d+\/\d+\.png$/,
      );
    }
    // No retry for WebGL-less devices — only for load errors.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("hides fallback tiles that fail to load instead of broken glyphs", async () => {
    behavior.throwOnConstruct = true;
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    await screen.findByTestId("interactive-fallback-map");
    const tiles = () =>
      document.querySelectorAll<HTMLImageElement>('[data-testid="interactive-fallback-map"] img');
    expect(tiles()).toHaveLength(9);
    fireEvent.error(tiles()[0]!);
    expect(tiles()[0]!.style.display).toBe("none");
    expect(tiles()[1]!.style.display).not.toBe("none");
  });

  it("degrades a stalled load to the fallback instead of loading forever", async () => {    render(<InteractiveLocationMap lat={23.8} lng={90.4} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    // Neither load nor error ever arrives: the timeout must rescue the view.
    expect(
      await screen.findByText(/taking a while to load/, undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(screen.queryByText("Loading map…")).toBeNull();
  });
});
