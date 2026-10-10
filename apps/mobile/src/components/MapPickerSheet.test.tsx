// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapPickerSheet } from "./MapPickerSheet";
import type { LocationValue } from "./LocationPicker";
import type { LocationAdapter } from "../services/locationAdapter";
import type { NativeMapHandle, NativeMapLoader } from "../services/location/nativeMap";
import type { PlaceResult } from "../services/location/nominatimSearch";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));

// Test map behavior, not Motion's global RAF/exit scheduler. Keep real sheet
// semantics, refs and handlers, but mount/unmount motion DOM synchronously.
vi.mock("framer-motion", async () => {
  const { createElement } = await import("react");
  const motionProps = new Set([
    "initial", "animate", "exit", "transition", "whileTap", "whileHover",
    "layout", "drag", "dragListener", "dragControls", "dragConstraints",
    "dragElastic", "dragSnapToOrigin", "onDragEnd",
  ]);
  const staticElement = (tag: string) => (props: Record<string, unknown>) =>
    createElement(tag, Object.fromEntries(Object.entries(props).filter(([key]) => !motionProps.has(key))));
  return {
    motion: { div: staticElement("div"), button: staticElement("button"), span: staticElement("span") },
    AnimatePresence: ({ children }: { children: import("react").ReactNode }) => children,
    useDragControls: () => ({ start: vi.fn() }),
  };
});

vi.mock("../services/location/rasterTiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/location/rasterTiles")>();
  // A short stall budget keeps the timeout test fast; all tile math stays real.
  return { ...actual, MAP_LOAD_TIMEOUT_MS: 500 };
});

interface FakeMapState {
  center: { lat: number; lng: number };
  taps: Array<(pick: { center: { lat: number; lng: number } }) => void>;
  dragEnds: Array<(pick: { center: { lat: number; lng: number } }) => void>;
  markers: Array<{ lat: number; lng: number }>;
  cameras: Array<{ center: { lat: number; lng: number }; zoom?: number; animate?: boolean }>;
  destroyed: boolean;
}

interface FakeLoader {
  loader: NativeMapLoader;
  creates: Array<{ element: HTMLElement; options: { center: { lat: number; lng: number }; zoom: number; draggable?: boolean } }>;
  handles: FakeMapState[];
  /** Next create() rejects instead of resolving (one-shot). */
  failNextCreate: boolean;
  /** Next create() never resolves (stall test). */
  stallNextCreate: boolean;
  stalledResolvers: Array<(handle: NativeMapHandle) => void>;
}

/** Fake native-map transport: deterministic, no plugin, no WebView. */
function makeFakeLoader(): FakeLoader {
  const fake: FakeLoader = {
    creates: [],
    handles: [],
    failNextCreate: false,
    stallNextCreate: false,
    stalledResolvers: [],
    loader: {
      create: async (element, options) => {
        fake.creates.push({
          element,
          options: { center: options.center, zoom: options.zoom, draggable: options.draggable },
        });
        if (fake.failNextCreate) {
          fake.failNextCreate = false;
          throw new Error("native map failed");
        }
        const state: FakeMapState = {
          center: { ...options.center },
          taps: [],
          dragEnds: [],
          markers: [],
          cameras: [],
          destroyed: false,
        };
        const handle: NativeMapHandle = {
          setMarker: async (center) => { state.markers.push({ ...center }); },
          setCamera: async (center, zoom, animate) => {
            state.cameras.push({ center: { ...center }, zoom, animate });
          },
          onMapTap: async (callback) => { state.taps.push(callback); },
          onMarkerDragEnd: async (callback) => { state.dragEnds.push(callback); },
          onCameraIdle: async () => {},
          destroy: async () => { state.destroyed = true; },
        };
        if (fake.stallNextCreate) {
          fake.stallNextCreate = false;
          await new Promise<NativeMapHandle>((resolve) => {
            fake.stalledResolvers.push(resolve);
          }).then((late) => {
            Object.assign(handle, late);
          });
        }
        fake.handles.push(state);
        return handle;
      },
    },
  };
  return fake;
}

const CONFIGURED = { apiKey: "test-key" };
const KEYLESS = { apiKey: "" };

const behavior = vi.hoisted(() => ({
  loadDeadline: undefined as (() => void) | undefined,
}));

beforeEach(() => {
  // jsdom has no layout engine: provide a measured host instead of racing
  // the production two-frame 0x0 fallback against async search results.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 360, 320);
  });
  const setTimeout = window.setTimeout.bind(window);
  vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout, ...args) => {
    if (timeout === 500 && typeof handler === "function") {
      behavior.loadDeadline = () => handler(...args);
      return -1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }
    return setTimeout(handler, timeout, ...args) as unknown as ReturnType<typeof globalThis.setTimeout>;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (navigator as unknown as Record<string, unknown>).geolocation;
  behavior.loadDeadline = undefined;
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

function renderSheet(props: Partial<React.ComponentProps<typeof MapPickerSheet>> & { onConfirm: (v: LocationValue) => void }) {
  const fake = makeFakeLoader();
  const view = render(
    <MapPickerSheet
      open
      onClose={vi.fn()}
      value={pinned}
      mapsConfigOverride={CONFIGURED}
      mapLoader={fake.loader}
      {...props}
    />,
  );
  return { fake, ...view };
}

async function awaitMapReady(fake: FakeLoader, index = 0): Promise<FakeMapState> {
  await waitFor(() => expect(fake.handles[index]).toBeDefined());
  await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
  const state = fake.handles[index];
  if (!state) throw new Error("no map handle");
  return state;
}

describe("MapPickerSheet native map", () => {
  it("creates one native map at the report pin, marks it, and destroys it on close", async () => {
    const onConfirm = vi.fn();
    const props = { onClose: vi.fn(), value: pinned, onConfirm };
    const { fake, rerender } = renderSheet(props);
    const state = await awaitMapReady(fake);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]?.options.center).toEqual({ lat: 23.81, lng: 90.412 });
    expect(fake.creates[0]?.options.zoom).toBe(15);
    expect(fake.creates[0]?.options.draggable).toBe(true);
    expect(state.markers).toEqual([{ lat: 23.81, lng: 90.412 }]);
    expect(state.taps).toHaveLength(1);
    expect(state.dragEnds).toHaveLength(1);

    rerender(
      <MapPickerSheet
        open={false}
        onClose={props.onClose}
        value={pinned}
        onConfirm={onConfirm}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    await waitFor(() => expect(state.destroyed).toBe(true));
  });

  it("fails closed without a key: consumer copy, fallback grid, no retry, confirm stays usable", async () => {
    const onConfirm = vi.fn();
    renderSheet({ value: pinned, onConfirm, mapsConfigOverride: KEYLESS });
    expect(await screen.findByTestId("map-picker-fallback")).toBeTruthy();
    expect(await screen.findByText(/interactive map isn't available/i)).toBeTruthy();
    // No retry is offered for the missing-key state (a key cannot appear at runtime).
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.queryByTestId("map-picker-map")).toBeNull();
    // The existing draft still commits approximate-by-default.
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 23.81, precision: "APPROXIMATE" }),
    );
  });

  it("recovers through retry when native creation fails", async () => {
    const onConfirm = vi.fn();
    const fake = makeFakeLoader();
    fake.failNextCreate = true;
    render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={pinned}
        onConfirm={onConfirm}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    await waitFor(() => expect(fake.creates).toHaveLength(1));
    expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    // Two native attempts, one surviving map: only successful creates push a
    // handle, so the retry's map is handles[0] while creates has length 2.
    const state = await awaitMapReady(fake, 0);
    expect(fake.creates).toHaveLength(2);
    expect(state.markers).toEqual([{ lat: 23.81, lng: 90.412 }]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("degrades a stalled native view to error-with-retry and destroys late arrivals", async () => {
    const onConfirm = vi.fn();
    const fake = makeFakeLoader();
    fake.stallNextCreate = true;
    render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={pinned}
        onConfirm={onConfirm}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    await waitFor(() => expect(fake.creates).toHaveLength(1));
    expect(screen.getByText("Loading map…")).toBeTruthy();
    expect(behavior.loadDeadline).toBeTypeOf("function");
    // The native view never resolves: the stall budget must rescue the sheet.
    act(() => behavior.loadDeadline!());
    expect(await screen.findByRole("button", { name: /try again/i })).toBeTruthy();
    expect(screen.queryByText("Loading map…")).toBeNull();
    // A late-resolving create is destroyed on arrival (no leaked native view).
    const lateResolvers = [...fake.stalledResolvers];
    expect(lateResolvers).toHaveLength(1);
    const lateState: FakeMapState = {
      center: { lat: 0, lng: 0 },
      taps: [],
      dragEnds: [],
      markers: [],
      cameras: [],
      destroyed: false,
    };
    const lateHandle: NativeMapHandle = {
      setMarker: async (center) => { lateState.markers.push(center); },
      setCamera: async () => {},
      onMapTap: async () => {},
      onMarkerDragEnd: async () => {},
      onCameraIdle: async () => {},
      destroy: async () => { lateState.destroyed = true; },
    };
    await act(async () => {
      lateResolvers[0]?.(lateHandle);
      await Promise.resolve();
    });
    expect(lateState.destroyed).toBe(true);
    // Retry builds a fresh map that becomes ready and confirmable.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    const state = await awaitMapReady(fake, 1);
    expect(fake.creates).toHaveLength(2);
    expect(state.markers).toEqual([{ lat: 23.81, lng: 90.412 }]);
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("moves the draft on map tap (marker follows) and on marker drag-end (draft only)", async () => {
    const onConfirm = vi.fn();
    const { fake } = renderSheet({ value: empty, onConfirm });
    const state = await awaitMapReady(fake);
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty("disabled", true);

    act(() => state.taps[0]?.({ center: { lat: 23.5, lng: 90.5 } }));
    expect(await screen.findByText("23.500, 90.500")).toBeTruthy();
    expect(state.markers).toEqual([{ lat: 23.5, lng: 90.5 }]);
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty(
      "disabled",
      false,
    );

    act(() => state.dragEnds[0]?.({ center: { lat: 24.125, lng: 91.125 } }));
    expect(await screen.findByText("24.125, 91.125")).toBeTruthy();
    // Drag-end moves the draft only — the native marker already sits there.
    expect(state.markers).toEqual([{ lat: 23.5, lng: 90.5 }]);

    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 24.125, longitude: 91.125, precision: "APPROXIMATE" }),
    );
  });

  it("starts at the existing report pin and confirms approximate-by-default", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { fake } = renderSheet({ value: pinned, onConfirm, onClose });
    await awaitMapReady(fake);
    expect(await screen.findByText("Pin rounded to ~100 m precision.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledWith({
      label: "Pinned location",
      latitude: 23.81,
      longitude: 90.412,
      precision: "APPROXIMATE",
      preciseLatitude: 23.81,
      preciseLongitude: 90.412,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("searches only on submit via Nominatim fallback and recenters the marker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([{ display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" }]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onConfirm = vi.fn();
    const { fake } = renderSheet({ value: empty, onConfirm });
    const state = await awaitMapReady(fake);

    fireEvent.change(screen.getByLabelText("Search for a place"), {
      target: { value: "mirpur" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    expect(screen.getByLabelText("Search for a place").closest("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByText("Mirpur, Dhaka")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/openstreetmap/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Mirpur, Dhaka"));
    expect(state.markers.at(-1)).toEqual({ lat: 23.8103, lng: 90.4125 });
    expect(state.cameras.at(-1)?.center).toEqual({ lat: 23.8103, lng: 90.4125 });
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

  it("prefers native Places results and labels them Powered by Google", async () => {
    const place: PlaceResult = { displayName: "Mirpur, Dhaka", latitude: 23.8103, longitude: 90.4125 };
    const nativeSearch = vi.fn().mockResolvedValue([place]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fake } = renderSheet({ value: empty, onConfirm: vi.fn(), nativeSearch });
    await awaitMapReady(fake);
    fireEvent.change(screen.getByLabelText("Search for a place"), {
      target: { value: "mirpur" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByText("Mirpur, Dhaka")).toBeTruthy();
    expect(nativeSearch).toHaveBeenCalledWith("mirpur");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/powered by google/i)).toBeTruthy();
  });

  it("degrades gracefully when geolocation is unavailable", async () => {
    const { fake } = renderSheet({ value: empty, onConfirm: vi.fn() });
    await awaitMapReady(fake);
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    expect(
      await screen.findByText(/location is not supported in this browser/i),
    ).toBeTruthy();
  });

  it("offers an exact opt-in with the public-visibility warning", async () => {
    const { fake } = renderSheet({ value: pinned, onConfirm: vi.fn() });
    await awaitMapReady(fake);
    await screen.findByText("Pin rounded to ~100 m precision.");
    fireEvent.click(screen.getByRole("button", { name: "Use exact pin" }));
    expect(
      await screen.findByText(/exact pin and will be shown publicly/i),
    ).toBeTruthy();
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
      const { fake } = renderSheet({ value: empty, onConfirm: vi.fn() });
      const state = await awaitMapReady(fake);
      fireEvent.change(screen.getByLabelText("Search for a place"), {
        target: { value: "mirpur" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
      fireEvent.click(await screen.findByText("Mirpur, Dhaka"));
      await waitFor(() => expect(state.cameras).toHaveLength(1));
      expect(state.cameras[0]).toMatchObject({ animate: false });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
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
    const fake = makeFakeLoader();
    const props = {
      onClose: vi.fn(),
      value: empty,
      onConfirm,
      locationAdapter: adapter,
      mapsConfigOverride: CONFIGURED,
      mapLoader: fake.loader,
    };
    const { rerender } = render(<MapPickerSheet {...props} open />);
    await awaitMapReady(fake);
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

  it("keeps a manually placed pin when an earlier GPS request finishes", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onConfirm = vi.fn();
    const fake = makeFakeLoader();
    render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={empty}
        onConfirm={onConfirm}
        locationAdapter={adapter}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    const state = await awaitMapReady(fake);
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    act(() => state.taps[0]?.({ center: { lat: 24.123, lng: 91.123 } }));
    resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 });
    await act(async () => { await Promise.resolve(); });
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
    const { fake } = renderSheet({ value: empty, onConfirm: vi.fn() });
    await awaitMapReady(fake);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    renderSheet({ value: empty, onConfirm: vi.fn() });
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("asks once per explicit tap, coarsely, and never re-prompts after a denial", async () => {
    const geo = installGeolocation();
    const onConfirm = vi.fn();
    const { fake } = renderSheet({ value: empty, onConfirm });
    await awaitMapReady(fake);

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

    renderSheet({ value: empty, onConfirm });
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("gives services-off and timeout their own copy instead of one generic error", async () => {
    const geo = installGeolocation();
    const { fake } = renderSheet({ value: empty, onConfirm: vi.fn() });
    await awaitMapReady(fake);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.reject(2);
    expect(await screen.findByText(/location services are off/i)).toBeTruthy();
    expect(screen.queryByText(/permission is denied/i)).toBeNull();
    cleanup();

    const geo2 = installGeolocation();
    const { fake: fake2 } = renderSheet({ value: empty, onConfirm: vi.fn() });
    await awaitMapReady(fake2);
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
    const { fake } = renderSheet({ value: empty, onConfirm });
    const state = await awaitMapReady(fake);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.grant({ latitude: 23.8103321, longitude: 90.4125189, accuracy: 42 });

    expect(await screen.findByText("23.810, 90.413")).toBeTruthy();
    expect(confirmButton()).toHaveProperty("disabled", false);
    expect(onConfirm).not.toHaveBeenCalled();
    // The native marker and camera follow the preview (production adapter
    // rounds the fix to 6 decimals before it reaches the sheet).
    await waitFor(() => expect(state.markers.at(-1)).toEqual(
      { lat: 23.810332, lng: 90.412519 },
    ));
    expect(state.cameras.at(-1)?.center).toEqual({ lat: 23.810332, lng: 90.412519 });
  });

  it("does not snap to a low-accuracy fix until it is confirmed explicitly", async () => {
    const geo = installGeolocation();
    const onConfirm = vi.fn();
    const { fake } = renderSheet({ value: empty, onConfirm });
    await awaitMapReady(fake);
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

  it("renders a 3x3 raster grid with zoom when the key is missing", async () => {
    const onConfirm = vi.fn();
    renderSheet({ value: pinned, onConfirm, mapsConfigOverride: KEYLESS });
    expect(await screen.findByTestId("map-picker-fallback")).toBeTruthy();
    expect(await screen.findByText(/interactive map isn't available/i)).toBeTruthy();
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
    // Confirm stays usable off the initial draft with no native map at all.
    expect(screen.getByText("23.810, 90.412")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps unique tile identities at minimum zoom (wrapped/clamped duplicates)", async () => {
    // At z1 only 2x2 tile coordinates exist, so the 3x3 window necessarily
    // repeats z/x/y. Keys carry the grid position; without it React logs a
    // duplicate-key warning and corrupts reconciliation (production bug, not
    // test noise).
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
    try {
      renderSheet({ value: pinned, onConfirm: vi.fn(), mapsConfigOverride: KEYLESS });
      await screen.findByTestId("map-picker-fallback");
      for (let i = 0; i < 14; i += 1) {
        fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
      }
      const tiles = fallbackTiles();
      expect(tiles).toHaveLength(9);
      for (const tile of Array.from(tiles)) {
        expect(tile.getAttribute("src")).toMatch(/^https:\/\/tile\.openstreetmap\.org\/1\/[01]\/[01]\.png$/);
      }
      const keyWarnings = errors.filter((args) => /unique.*"key"/i.test(args.map(String).join(" ")));
      expect(keyWarnings).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("hides fallback tiles that fail to load instead of broken glyphs", async () => {
    renderSheet({ value: pinned, onConfirm: vi.fn(), mapsConfigOverride: KEYLESS });
    await screen.findByTestId("map-picker-fallback");
    expect(fallbackTiles()).toHaveLength(9);
    fireEvent.error(fallbackTiles()[0]!);
    expect((fallbackTiles()[0] as HTMLImageElement).style.display).toBe("none");
    expect((fallbackTiles()[1] as HTMLImageElement).style.display).not.toBe("none");
  });

  it("nudges the fallback pin without a key", async () => {
    renderSheet({ value: pinned, onConfirm: vi.fn(), mapsConfigOverride: KEYLESS });
    await screen.findByTestId("map-picker-fallback");
    expect(screen.getByText("23.810, 90.412")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /move pin east/i }));
    expect(await screen.findByText("23.810, 90.423")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /move pin west/i }));
    expect(await screen.findByText("23.810, 90.412")).toBeTruthy();
  });
});
