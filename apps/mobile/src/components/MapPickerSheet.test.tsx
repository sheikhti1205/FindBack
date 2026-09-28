// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapPickerSheet } from "./MapPickerSheet";
import type { LocationValue } from "./LocationPicker";
import type { LocationAdapter } from "../services/locationAdapter";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));

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
  reportUnsupported: false,
  instances: [] as Array<{
    opts: { style: string; center: [number, number]; zoom: number };
    center: { lat: number; lng: number };
    handlers: Record<string, () => void>;
    jumpedTo: Array<{ center: [number, number]; zoom?: number }>;
    easedTo: Array<{ center: [number, number]; zoom?: number; duration?: number }>;
    resizeCalls: number;
  }>,
}));

vi.mock("maplibre-gl", () => {
  class GPUInitializationError extends Error {}
  class NavigationControl {}
  class FakeMap {
    state: (typeof behavior.instances)[number];
    constructor(opts: { style: string; center: [number, number]; zoom: number }) {
      behavior.workerConfiguredAtConstruction.push(behavior.workerUrl !== null);
      if (behavior.throwOnConstruct) {
        throw new GPUInitializationError("WebGL unavailable");
      }
      const [lng, lat] = opts.center;
      this.state = {
        opts,
        center: { lat, lng },
        handlers: {},
        jumpedTo: [],
        easedTo: [],
        resizeCalls: 0,
      };
      behavior.instances.push(this.state);
    }
    on(event: string, cb: () => void): void {
      this.state.handlers[event] = cb;
    }
    getCenter(): { lat: number; lng: number } {
      return { ...this.state.center };
    }
    jumpTo(next: { center: [number, number]; zoom?: number }): void {
      const [lng, lat] = next.center;
      this.state.center = { lat, lng };
      this.state.jumpedTo.push(next);
    }
    easeTo(next: { center: [number, number]; zoom?: number; duration?: number }): void {
      const [lng, lat] = next.center;
      this.state.center = { lat, lng };
      this.state.easedTo.push(next);
    }
    addControl(): void {}
    resize(): void { this.state.resizeCalls += 1; }
    remove(): void {}
  }
  return {
    Map: FakeMap,
    setWorkerUrl: (url: string) => { behavior.workerUrl = url; },
    NavigationControl,
    GPUInitializationError,
    // Present on some MapLibre lines; the sheet honors it when available.
    supported: () => !behavior.reportUnsupported,
  };
});

function moveEnd(index: number, lat: number, lng: number): void {
  const instance = behavior.instances[index];
  if (!instance) throw new Error("no map instance");
  instance.center = { lat, lng };
  instance.handlers.moveend?.();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).geolocation;
  behavior.throwOnConstruct = false;
  behavior.reportUnsupported = false;
  behavior.instances.length = 0;
  behavior.workerUrl = null;
  behavior.workerConfiguredAtConstruction.length = 0;
});

/** Captures the callbacks the sheet hands to navigator.geolocation. */
interface GeoStub {
  getCurrentPosition: ReturnType<typeof vi.fn>;
  pending: Array<{
    success: (position: {
      coords: { latitude: number; longitude: number; accuracy?: number };
    }) => void;
    failure: (error: { code?: number }) => void;
    options?: PositionOptions;
  }>;
  grant: (coords?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  }) => void;
  reject: (code?: number) => void;
}

/** Nothing is requested until the sheet is explicitly asked for it. */
function installGeolocation(): GeoStub {
  const pending: GeoStub["pending"] = [];
  const getCurrentPosition = vi.fn(
    (
      success: GeoStub["pending"][number]["success"],
      failure: GeoStub["pending"][number]["failure"],
      options?: PositionOptions,
    ) => {
      pending.push({ success, failure, options });
    },
  );
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition },
  });
  return {
    getCurrentPosition,
    pending,
    grant(coords = { latitude: 23.8103321, longitude: 90.4125189, accuracy: 42 }) {
      const next = pending.shift();
      if (!next) throw new Error("no location request in flight");
      next.success({ coords });
    },
    reject(code = 1) {
      const next = pending.shift();
      if (!next) throw new Error("no location request in flight");
      next.failure({ code });
    },
  };
}

const pinned: LocationValue = {
  label: "Pinned location",
  latitude: 23.81,
  longitude: 90.412,
  precision: "APPROXIMATE",
  preciseLatitude: 23.810332,
  preciseLongitude: 90.412518,
};

const empty: LocationValue = {
  label: "",
  latitude: null,
  longitude: null,
  precision: "APPROXIMATE",
  preciseLatitude: null,
  preciseLongitude: null,
};

describe("MapPickerSheet", () => {
  it("configures a bundled worker before constructing the map and waits for load to be ready", async () => {
    render(<MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={vi.fn()} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    expect(behavior.workerConfiguredAtConstruction).toEqual([true]);
    expect(behavior.workerUrl).toBeTruthy();
    expect(screen.getByText("Loading map…")).toBeTruthy();
    expect(screen.queryByText(/Map tiles are unavailable/)).toBeNull();
    behavior.instances[0]?.handlers.load?.();
    await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
    expect(behavior.instances[0]?.resizeCalls).toBeGreaterThan(0);
  });

  it("falls back to a usable pin when tiles error before load (P1)", async () => {
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={onConfirm} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    behavior.instances[0]?.handlers.error?.();
    expect(await screen.findByText(/Map tiles are unavailable/)).toBeTruthy();
    // Load never arrives: the sheet must not stay stuck on "starting" forever.
    await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
    // Map stays mounted so pan/search still work; the center pin is visible.
    expect(screen.getByTestId("map-picker-map")).toBeTruthy();
    expect(screen.getByTestId("map-picker-pin")).toBeTruthy();
    // Truthful copy: never claim tiles are visible/loaded.
    expect(screen.queryByText(/tiles (are )?visible|tiles loaded/i)).toBeNull();
    // Retry is offered and confirm stays usable for the manual pin.
    expect(
      screen.getByRole("button", { name: /retry map tiles|try again/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /retry map tiles/i }));
    await waitFor(() => expect(behavior.instances).toHaveLength(2));
    expect(behavior.workerConfiguredAtConstruction).toEqual([true, true]);
    behavior.instances[1]?.handlers.load?.();
    await waitFor(() => expect(screen.getByTestId("map-picker-pin")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps search confirmation usable when tiles error before load with no pin yet", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([{ display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" }]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    behavior.instances[0]?.handlers.error?.();
    expect(await screen.findByText(/Map tiles are unavailable/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
    fireEvent.change(screen.getByLabelText("Search for a place"), {
      target: { value: "mirpur" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByText("Mirpur, Dhaka")).toBeTruthy();
    fireEvent.click(screen.getByText("Mirpur, Dhaka"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ label: "Mirpur, Dhaka" }));
  });

  it("resizes on sheet layout changes and disconnects its observer when closed", async () => {
    let onResize: (() => void) | undefined;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { onResize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const props = { onClose: vi.fn(), value: pinned, onConfirm: vi.fn() };
    const { rerender } = render(<MapPickerSheet {...props} open />);
    await waitFor(() => expect(observe).toHaveBeenCalledWith(screen.getByTestId("map-picker-map")));
    onResize?.();
    expect(behavior.instances[0]?.resizeCalls).toBe(1);
    rerender(<MapPickerSheet {...props} open={false} />);
    expect(disconnect).toHaveBeenCalledTimes(1);
    onResize?.();
    expect(behavior.instances[0]?.resizeCalls).toBe(1);
  });
  it("starts at the existing report pin and confirms approximate-by-default", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <MapPickerSheet open onClose={onClose} value={pinned} onConfirm={onConfirm} />,
    );

    expect(await screen.findByText("Pin rounded to ~100 m precision.")).toBeTruthy();
    // Construction now waits a frame for sheet layout — await the map itself.
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    expect(behavior.instances[0]?.opts.center).toEqual([90.412, 23.81]);
    expect(behavior.instances[0]?.opts.zoom).toBe(15);
    expect(behavior.instances[0]?.opts.style).toContain("tiles.openfreemap.org");

    moveEnd(0, 23.810332, 90.412518);
    expect(await screen.findByText("23.810, 90.413")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith({
      label: "Pinned location",
      latitude: 23.81,
      longitude: 90.413,
      precision: "APPROXIMATE",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412518,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps confirm disabled in the neutral world state until the user pans", async () => {
    render(
      <MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />,
    );
    expect(
      await screen.findByText("No location yet — pan the map to place the pin."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty(
      "disabled",
      true,
    );

    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    moveEnd(0, 23.5, 90.5);
    expect(await screen.findByText("23.500, 90.500")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("searches only on submit and feeds the selection without autocomplete", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([{ display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" }]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onConfirm = vi.fn();
    render(
      <MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />,
    );
    await screen.findByTestId("map-picker-map");

    // Keystrokes alone must not hit the network.
    fireEvent.change(screen.getByLabelText("Search for a place"), {
      target: { value: "mirpur" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The search control is deliberately NOT a nested <form> (it renders
    // inside the Report form): both the Search button and Enter trigger it.
    expect(screen.getByLabelText("Search for a place").closest("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByText("Mirpur, Dhaka")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Mirpur, Dhaka"));
    expect(behavior.instances[0]?.easedTo[0]?.center).toEqual([90.4125, 23.8103]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Mirpur, Dhaka",
        latitude: 23.81,
        longitude: 90.413,
        precision: "APPROXIMATE",
      }),
    );
  });

  it("degrades gracefully when geolocation is unavailable", async () => {
    render(
      <MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />,
    );
    await screen.findByTestId("map-picker-map");
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    expect(
      await screen.findByText(/location is not supported in this browser/i),
    ).toBeTruthy();
  });

  it("keeps the pin committable when WebGL is unavailable (offline fallback)", async () => {
    behavior.throwOnConstruct = true;
    const onConfirm = vi.fn();
    render(
      <MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={onConfirm} />,
    );
    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 23.81, precision: "APPROXIMATE" }),
    );
  });

  it("shows the fallback when the supported() gate fails", async () => {
    behavior.reportUnsupported = true;
    render(
      <MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />,
    );
    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    expect(behavior.instances).toHaveLength(0);
  });

  it("offers an exact opt-in with the public-visibility warning", async () => {
    render(
      <MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={vi.fn()} />,
    );
    await screen.findByText("Pin rounded to ~100 m precision.");
    fireEvent.click(screen.getByRole("button", { name: "Use exact pin" }));
    expect(
      await screen.findByText(/exact pin and will be shown publicly/i),
    ).toBeTruthy();
  });
});

describe("MapPickerSheet one-time approximate location", () => {
  it("ignores an adapter fix arriving after the sheet closes and reopens", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onConfirm = vi.fn();
    const props = { onClose: vi.fn(), value: empty, onConfirm, locationAdapter: adapter };
    const { rerender } = render(<MapPickerSheet {...props} open />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    rerender(<MapPickerSheet {...props} open={false} />);
    rerender(<MapPickerSheet {...props} open />);
    expect(screen.getByRole("button", { name: /use my location once/i })).toHaveProperty("disabled", false);
    resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 });
    await screen.findByTestId("map-picker-map");
    expect(screen.queryByText("23.810, 90.413")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps a manually panned pin when an earlier GPS request finishes", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} locationAdapter={adapter} />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    moveEnd(0, 24.123, 91.123);
    resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText("24.123, 91.123")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ latitude: 24.123, longitude: 91.123 }));
  });

  function useMyLocation() {
    return screen.getByRole("button", { name: /use my location once/i });
  }

  function confirmButton(): HTMLElement {
    return screen.getByRole("button", { name: "Confirm location" });
  }

  it("never prompts by itself — not on mount, not after the map is ready", async () => {
    const geo = installGeolocation();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />);
    await screen.findByTestId("map-picker-map");
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    // A re-render of the open sheet must not prompt either.
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("asks once per explicit tap, coarsely, and never re-prompts after a denial", async () => {
    const geo = installGeolocation();
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />);
    await screen.findByTestId("map-picker-map");

    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    expect(geo.getCurrentPosition.mock.calls[0]?.[2]?.enableHighAccuracy).toBe(false);

    fireEvent.click(useMyLocation());
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);

    geo.reject(1);
    expect(await screen.findByText(/permission is denied/i)).toBeTruthy();
    expect(screen.queryByText(/location services are off/i)).toBeNull();
    expect(screen.queryByText(/within 8 seconds/i)).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    // Re-rendering after a denial must not prompt again.
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("gives services-off and timeout their own copy instead of one generic error", async () => {
    const geo = installGeolocation();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.reject(2);
    expect(await screen.findByText(/location services are off/i)).toBeTruthy();
    expect(screen.queryByText(/permission is denied/i)).toBeNull();
    cleanup();

    const geo2 = installGeolocation();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo2.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo2.reject(3);
    expect(await screen.findByText(/within 8 seconds/i)).toBeTruthy();
    expect(screen.queryByText(/permission is denied/i)).toBeNull();
    expect(screen.queryByText(/location services are off/i)).toBeNull();
  });

  it("recentres the preview on a granted coarse fix without auto-confirming", async () => {
    const geo = installGeolocation();
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.grant({ latitude: 23.8103321, longitude: 90.4125189, accuracy: 42 });

    expect(await screen.findByText("23.810, 90.413")).toBeTruthy();
    expect(confirmButton()).toHaveProperty("disabled", false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not snap to a low-accuracy fix until it is confirmed explicitly", async () => {
    const geo = installGeolocation();
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={onConfirm} />);
    await screen.findByTestId("map-picker-map");
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.grant({ latitude: 23.8103321, longitude: 90.4125189, accuracy: 4200 });

    const notice = await screen.findByTestId("low-accuracy-notice");
    expect(notice.textContent).toMatch(/accurate to about ~4\.2 km/i);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText("23.810, 90.413")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /use this location anyway/i }));
    expect(await screen.findByText("23.810, 90.413")).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ precision: "APPROXIMATE", latitude: 23.81, longitude: 90.413 }),
    );
  });
});

describe("MapPickerSheet fallback and camera", () => {
  function fallbackTiles(): NodeListOf<HTMLImageElement> {
    return document.querySelectorAll('[data-testid="map-picker-fallback"] img');
  }

  it("renders a 3x3 raster grid with zoom when WebGL is unavailable", async () => {
    behavior.throwOnConstruct = true;
    const onConfirm = vi.fn();
    render(
      <MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={onConfirm} />,
    );
    expect(await screen.findByTestId("map-picker-fallback")).toBeTruthy();
    expect(await screen.findByText(/webgl unavailable/i)).toBeTruthy();
    expect(screen.queryByTestId("map-picker-map")).toBeNull();
    const tiles = fallbackTiles();
    expect(tiles).toHaveLength(9);
    for (const tile of Array.from(tiles)) {
      expect(tile.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    for (const tile of Array.from(fallbackTiles())) {
      expect(tile.getAttribute("src")).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/,
      );
    }
    // Confirm stays usable off the initial draft with no GL map at all.
    expect(screen.getByText("23.810, 90.412")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("hides fallback tiles that fail to load instead of broken glyphs", async () => {
    behavior.throwOnConstruct = true;
    render(
      <MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={vi.fn()} />,
    );
    await screen.findByTestId("map-picker-fallback");
    expect(fallbackTiles()).toHaveLength(9);
    fireEvent.error(fallbackTiles()[0]!);
    expect((fallbackTiles()[0] as HTMLImageElement).style.display).toBe("none");
    expect((fallbackTiles()[1] as HTMLImageElement).style.display).not.toBe("none");
  });

  it("nudges the fallback pin without WebGL", async () => {
    behavior.throwOnConstruct = true;
    render(
      <MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={vi.fn()} />,
    );
    await screen.findByTestId("map-picker-fallback");
    expect(screen.getByText("23.810, 90.412")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /move pin east/i }));
    expect(await screen.findByText("23.810, 90.423")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /move pin west/i }));
    expect(await screen.findByText("23.810, 90.412")).toBeTruthy();
  });

  it("degrades a stalled load to ready-with-notice instead of loading forever", async () => {
    const onConfirm = vi.fn();
    render(<MapPickerSheet open onClose={vi.fn()} value={pinned} onConfirm={onConfirm} />);
    await waitFor(() => expect(behavior.instances).toHaveLength(1));
    // Neither load nor error ever arrives: the timeout must rescue the sheet.
    expect(await screen.findByText(/taking a while to load/, undefined, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
    expect(screen.getByTestId("map-picker-map")).toBeTruthy();
    expect(screen.getByTestId("map-picker-pin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("jumps instead of easing when reduced motion is preferred", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([{ display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" }]),
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<MapPickerSheet open onClose={vi.fn()} value={empty} onConfirm={vi.fn()} />);
      await screen.findByTestId("map-picker-map");
      fireEvent.change(screen.getByLabelText("Search for a place"), {
        target: { value: "mirpur" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
      fireEvent.click(await screen.findByText("Mirpur, Dhaka"));
      await waitFor(() => expect(behavior.instances[0]?.jumpedTo).toHaveLength(1));
      expect(behavior.instances[0]?.jumpedTo[0]?.center).toEqual([90.4125, 23.8103]);
      expect(behavior.instances[0]?.easedTo).toHaveLength(0);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
