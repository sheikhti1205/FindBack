// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InteractiveLocationMap } from "./InteractiveLocationMap";
import type { NativeMapHandle, NativeMapLoader } from "../services/location/nativeMap";

vi.mock("../services/location/rasterTiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/location/rasterTiles")>();
  // A short stall budget keeps the timeout test fast; all tile math stays real.
  return { ...actual, MAP_LOAD_TIMEOUT_MS: 500 };
});

interface FakeMapState {
  markers: Array<{ lat: number; lng: number }>;
  cameras: Array<{ center: { lat: number; lng: number }; zoom?: number }>;
  destroyed: boolean;
}

interface FakeLoader {
  loader: NativeMapLoader;
  creates: Array<{ center: { lat: number; lng: number }; zoom: number; draggable?: boolean }>;
  states: FakeMapState[];
  failNextCreate: boolean;
}

function makeFakeLoader(): FakeLoader {
  const fake: FakeLoader = {
    creates: [],
    states: [],
    failNextCreate: false,
    loader: {
      create: async (_element, options) => {
        fake.creates.push({
          center: { ...options.center },
          zoom: options.zoom,
          draggable: options.draggable,
        });
        if (fake.failNextCreate) {
          fake.failNextCreate = false;
          throw new Error("native map failed");
        }
        const state: FakeMapState = { markers: [], cameras: [], destroyed: false };
        const handle: NativeMapHandle = {
          setMarker: async (center) => { state.markers.push({ ...center }); },
          setCamera: async (center, zoom) => {
            state.cameras.push({ center: { ...center }, zoom });
          },
          onMapTap: async () => {},
          onMarkerDragEnd: async () => {},
          onCameraIdle: async () => {},
          destroy: async () => { state.destroyed = true; },
        };
        fake.states.push(state);
        return handle;
      },
    },
  };
  return fake;
}

const CONFIGURED = { apiKey: "test-key" };
const KEYLESS = { apiKey: "" };

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 360, 320),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function awaitReadyMap(fake: FakeLoader, index = 0): Promise<FakeMapState> {
  await waitFor(() => expect(fake.states[index]).toBeDefined());
  await waitFor(() => expect(screen.queryByText("Loading map…")).toBeNull());
  const state = fake.states[index];
  if (!state) throw new Error("no map handle");
  return state;
}

describe("InteractiveLocationMap", () => {
  it("creates one fixed-marker map and destroys it on unmount", async () => {
    const fake = makeFakeLoader();
    const { unmount } = render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        label="Dhaka"
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    const state = await awaitReadyMap(fake);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]?.center).toEqual({ lat: 23.8, lng: 90.4 });
    expect(fake.creates[0]?.draggable).toBe(false);
    expect(state.markers).toEqual([{ lat: 23.8, lng: 90.4 }]);
    expect(await screen.findByRole("button", { name: /zoom in/i })).toBeTruthy();
    expect(screen.getByText("Dhaka")).toBeTruthy();
    expect(screen.getByText("© Google")).toBeTruthy();
    unmount();
    await waitFor(() => expect(state.destroyed).toBe(true));
  });

  it("fails closed without a key: consumer copy, fallback grid, no retry", async () => {
    const fake = makeFakeLoader();
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        label="Dhaka"
        mapsConfigOverride={KEYLESS}
        mapLoader={fake.loader}
      />,
    );
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(await screen.findByText(/interactive map isn't available/i)).toBeTruthy();
    expect(fake.creates).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    // The pin location stays listed below the fallback.
    expect(screen.getByText("Dhaka")).toBeTruthy();
  });

  it("falls back to raster tiles with retry when creation fails", async () => {
    const fake = makeFakeLoader();
    fake.failNextCreate = true;
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    await waitFor(() => expect(fake.creates).toHaveLength(1));
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(await screen.findByText(/could not start/)).toBeTruthy();
    expect(screen.queryByText("Loading map…")).toBeNull();
    const tiles = document.querySelectorAll('[data-testid="interactive-fallback-map"] img');
    expect(tiles).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    // Only successful creates push a handle: the retry's map is states[0].
    await awaitReadyMap(fake, 0);
    expect(fake.creates).toHaveLength(2);
  });

  it("zooms the native camera from the overlay buttons", async () => {
    const fake = makeFakeLoader();
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    const state = await awaitReadyMap(fake);
    const zoomIn = await screen.findByRole("button", { name: /zoom in/i });
    const zoomOut = screen.getByRole("button", { name: /zoom out/i });
    for (const zoomButton of [zoomIn, zoomOut]) {
      expect(zoomButton.className).toMatch(/focus-visible:outline-2/);
      expect(zoomButton.className).toMatch(/focus-visible:outline-offset-2/);
      expect(zoomButton.className).toMatch(/focus-visible:outline-on-surface/);
    }
    fireEvent.click(zoomIn);
    fireEvent.click(zoomOut);
    await waitFor(() => expect(state.cameras).toHaveLength(2));
    expect(state.cameras[0]?.zoom).toBe(16);
    expect(state.cameras[1]?.zoom).toBe(15);
  });

  it("label-only renders a neutral fallback without fabricating coordinates", async () => {
    const fake = makeFakeLoader();
    render(
      <InteractiveLocationMap
        lat={null}
        lng={null}
        label="Near the park"
        mapsConfigOverride={CONFIGURED}
        mapLoader={fake.loader}
      />,
    );
    expect(await screen.findByText("Near the park")).toBeTruthy();
    expect(await screen.findByText(/without coordinates/i)).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(fake.creates).toHaveLength(0);
    expect(screen.queryByTestId("interactive-location-map")).toBeNull();
  });

  it("renders a 3x3 raster grid with working zoom in the fallback", async () => {
    const fake = makeFakeLoader();
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        label="Dhaka"
        mapsConfigOverride={KEYLESS}
        mapLoader={fake.loader}
      />,
    );
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(await screen.findByText(/isn't available/i)).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
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
    // No retry for the missing-key state — only for load errors.
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("hides fallback tiles that fail to load instead of broken glyphs", async () => {
    const fake = makeFakeLoader();
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        label="Dhaka"
        mapsConfigOverride={KEYLESS}
        mapLoader={fake.loader}
      />,
    );
    await screen.findByTestId("interactive-fallback-map");
    const tiles = () =>
      document.querySelectorAll<HTMLImageElement>('[data-testid="interactive-fallback-map"] img');
    expect(tiles()).toHaveLength(9);
    fireEvent.error(tiles()[0]!);
    expect(tiles()[0]!.style.display).toBe("none");
    expect(tiles()[1]!.style.display).not.toBe("none");
  });

  it("degrades a stalled load to the fallback instead of loading forever", async () => {
    const fake = makeFakeLoader();
    const stalled: Array<(h: NativeMapHandle) => void> = [];
    const stallingLoader: NativeMapLoader = {
      create: async (element, options) => {
        fake.creates.push({
          center: { ...options.center },
          zoom: options.zoom,
          draggable: options.draggable,
        });
        await new Promise<NativeMapHandle>((resolve) => {
          stalled.push(resolve);
        });
        const state: FakeMapState = { markers: [], cameras: [], destroyed: false };
        fake.states.push(state);
        return {
          setMarker: async () => {},
          setCamera: async () => {},
          onMapTap: async () => {},
          onMarkerDragEnd: async () => {},
          onCameraIdle: async () => {},
          destroy: async () => {},
        };
      },
    };
    render(
      <InteractiveLocationMap
        lat={23.8}
        lng={90.4}
        mapsConfigOverride={CONFIGURED}
        mapLoader={stallingLoader}
      />,
    );
    await waitFor(() => expect(fake.creates).toHaveLength(1));
    expect(
      await screen.findByText(/taking a while to load/, undefined, { timeout: 3000 }),
    ).toBeTruthy();
    expect(await screen.findByTestId("interactive-fallback-map")).toBeTruthy();
    expect(screen.queryByText("Loading map…")).toBeNull();
    expect(stalled).toHaveLength(1);
  });
});
