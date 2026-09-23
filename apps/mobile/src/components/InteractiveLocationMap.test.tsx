// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InteractiveLocationMap } from "./InteractiveLocationMap";

const behavior = vi.hoisted(() => ({
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
    remove(): void {}
  }
  return {
    Map: FakeMap,
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
  behavior.markers.length = 0;
});

describe("InteractiveLocationMap", () => {
  it("renders marker, attribution, and zoom controls for coordinates", async () => {
    render(<InteractiveLocationMap lat={23.8} lng={90.4} label="Dhaka" />);

    const mapEl = await screen.findByTestId("interactive-location-map");
    expect(mapEl.getAttribute("aria-label")).toMatch(/pan|zoom/i);
    expect(screen.getByRole("region", { name: "Location map: Dhaka" })).toBeTruthy();

    expect(behavior.instances).toHaveLength(1);
    expect(behavior.instances[0]?.opts.center).toEqual([90.4, 23.8]);
    expect(behavior.instances[0]?.opts.style).toContain("tiles.openfreemap.org");
    expect(behavior.markers).toEqual([[90.4, 23.8]]);
    expect(behavior.instances[0]?.controls).toBeGreaterThan(0);

    expect(screen.getByText(/OpenStreetMap contributors/)).toBeTruthy();
    expect(screen.getByText("Dhaka")).toBeTruthy();

    const zoomIn = screen.getByRole("button", { name: /zoom in/i });
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
});
