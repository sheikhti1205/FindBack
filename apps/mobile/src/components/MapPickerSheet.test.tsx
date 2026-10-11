// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapPickerSheet } from "./MapPickerSheet";
import type { LocationValue } from "./LocationPicker";
import type { LocationAdapter } from "../services/locationAdapter";
import type { MapPickerInput, MapPickerResult } from "../native/mapLibreMaps";
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

const searchState = vi.hoisted(() => ({
  places: [] as PlaceResult[],
  error: null as unknown,
  calls: [] as string[],
}));

vi.mock("../services/location/placesSearch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/location/placesSearch")>();
  return {
    ...actual,
    searchPlacesUnified: async (query: string) => {
      searchState.calls.push(query);
      if (searchState.error) throw searchState.error;
      return { places: searchState.places, source: "nominatim" as const };
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  searchState.places = [];
  searchState.error = null;
  searchState.calls = [];
});

const EMPTY_VALUE: LocationValue = {
  label: "",
  latitude: null,
  longitude: null,
  precision: "APPROXIMATE",
  preciseLatitude: null,
  preciseLongitude: null,
};

const PINNED_VALUE: LocationValue = {
  label: "Dhaka",
  latitude: 23.81,
  longitude: 90.412,
  precision: "APPROXIMATE",
  preciseLatitude: 23.8103,
  preciseLongitude: 90.4125,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof MapPickerSheet>> = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <MapPickerSheet
      open
      onClose={onClose}
      value={EMPTY_VALUE}
      onConfirm={onConfirm}
      nativePicker={null}
      {...overrides}
    />,
  );
  return { onConfirm, onClose, ...utils };
}

describe("MapPickerSheet (native picker path)", () => {
  it("commits the native confirm through the approximate-by-default path", async () => {
    const calls: MapPickerInput[] = [];
    const nativePicker = vi.fn(async (options: MapPickerInput): Promise<MapPickerResult> => {
      calls.push(options);
      return { cancelled: false, latitude: 22.35694, longitude: 91.78324, zoom: 15 };
    });
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <MapPickerSheet
        open
        onClose={onClose}
        value={EMPTY_VALUE}
        onConfirm={onConfirm}
        nativePicker={nativePicker}
      />,
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const committed = onConfirm.mock.calls[0]?.[0] as LocationValue;
    // Approximate-by-default: rounded to ~100 m with the precise fix retained.
    expect(committed.latitude).toBe(22.357);
    expect(committed.longitude).toBe(91.783);
    expect(committed.precision).toBe("APPROXIMATE");
    expect(committed.preciseLatitude).toBe(22.35694);
    expect(committed.preciseLongitude).toBe(91.78324);
    expect(committed.label).toBe("Pinned location");
  });

  it("starts the native camera at the existing report pin first", async () => {
    const calls: MapPickerInput[] = [];
    const nativePicker = vi.fn(async (options: MapPickerInput): Promise<MapPickerResult> => {
      calls.push(options);
      return { cancelled: true };
    });
    render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={PINNED_VALUE}
        onConfirm={vi.fn()}
        nativePicker={nativePicker}
      />,
    );
    await waitFor(() => expect(nativePicker).toHaveBeenCalledTimes(1));
    expect(calls[0]?.latitude).toBe(23.81);
    expect(calls[0]?.longitude).toBe(90.412);
  });

  it("starts the native camera at a prior search result when there is no pin", async () => {
    const calls: MapPickerInput[] = [];
    const nativePicker = vi.fn(async (options: MapPickerInput): Promise<MapPickerResult> => {
      calls.push(options);
      return { cancelled: true };
    });
    render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={EMPTY_VALUE}
        onConfirm={vi.fn()}
        nativePicker={nativePicker}
        initialSearchResult={{ lat: 22.3569, lng: 91.7832, label: "Chattogram" }}
      />,
    );
    await waitFor(() => expect(nativePicker).toHaveBeenCalledTimes(1));
    expect(calls[0]?.latitude).toBe(22.3569);
    expect(calls[0]?.longitude).toBe(91.7832);
    expect(calls[0]?.label).toBe("Chattogram");
  });

  it("cancel closes with no mutation", async () => {
    const nativePicker = vi.fn(async (): Promise<MapPickerResult> => ({ cancelled: true }));
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <MapPickerSheet open onClose={onClose} value={PINNED_VALUE} onConfirm={onConfirm} nativePicker={nativePicker} />,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a rejected bridge closes with no mutation", async () => {
    const nativePicker = vi.fn(async (): Promise<MapPickerResult> => {
      throw new Error("MAP_UNAVAILABLE");
    });
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <MapPickerSheet open onClose={onClose} value={PINNED_VALUE} onConfirm={onConfirm} nativePicker={nativePicker} />,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores a stale native response after unmount", async () => {
    const gate = deferred<MapPickerResult>();
    const nativePicker = vi.fn(() => gate.promise);
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(
      <MapPickerSheet open onClose={onClose} value={EMPTY_VALUE} onConfirm={onConfirm} nativePicker={nativePicker} />,
    );
    unmount();
    await act(async () => {
      gate.resolve({ cancelled: false, latitude: 22.35, longitude: 91.78, zoom: 15 });
      await gate.promise.catch(() => undefined);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing while the native picker owns the interaction", () => {
    const gate = deferred<MapPickerResult>();
    const { container } = render(
      <MapPickerSheet
        open
        onClose={vi.fn()}
        value={EMPTY_VALUE}
        onConfirm={vi.fn()}
        nativePicker={() => gate.promise}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("MapPickerSheet (keyless fallback path)", () => {
  it("searches Nominatim on submit and confirms the picked result", async () => {
    searchState.places = [{ displayName: "Mirpur, Dhaka", latitude: 23.8103, longitude: 90.4125 }];
    const { onConfirm, onClose } = renderSheet();
    expect(screen.getByTestId("map-picker-map")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: "mirpur" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(searchState.calls).toEqual(["mirpur"]));
    fireEvent.click(await screen.findByText("Mirpur, Dhaka"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const committed = onConfirm.mock.calls[0]?.[0] as LocationValue;
    expect(committed.label).toBe("Mirpur, Dhaka");
    expect(committed.latitude).toBe(23.81);
    expect(committed.longitude).toBe(90.413);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Confirm disabled with no draft and enables it after nudging", async () => {
    const { onConfirm } = renderSheet();
    expect(screen.getByText("No location yet — search or move the pin to place it.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Move pin north" }));
    expect(screen.getByRole("button", { name: "Confirm location" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("commits EXACT only through the explicit opt-in", async () => {
    const { onConfirm } = renderSheet({ value: PINNED_VALUE });
    fireEvent.click(screen.getByRole("button", { name: "Use exact pin" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    const committed = onConfirm.mock.calls[0]?.[0] as LocationValue;
    expect(committed.precision).toBe("EXACT");
    expect(committed.latitude).toBe(23.81);
  });

  it("previews a one-shot GPS fix without committing it", async () => {
    const adapter: LocationAdapter = {
      getCurrentPosition: async () => ({ latitude: 22.3569, longitude: 91.7832, accuracyMeters: 25 }),
      getPermission: async () => "granted",
    };
    const { onConfirm } = renderSheet({ locationAdapter: adapter });
    fireEvent.click(screen.getByRole("button", { name: "Use my location once" }));
    await screen.findByText(/Preview centered on your location/);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm location" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows Nominatim attribution only when results exist", async () => {
    renderSheet();
    expect(screen.queryByText(/Place results:/)).toBeNull();
    searchState.places = [{ displayName: "Dhaka", latitude: 23.8, longitude: 90.4 }];
    fireEvent.change(screen.getByLabelText("Search for a place"), { target: { value: "dhaka" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText(/Place results:.*OpenStreetMap/);
  });
});
