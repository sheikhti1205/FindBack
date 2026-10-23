// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocationPicker, type LocationValue } from "./LocationPicker";
import type { LocationAdapter } from "../services/locationAdapter";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));

// Stub the sheet: its internals (map start-order, submit-only search,
// WebGL fallbacks) are covered in MapPickerSheet.test.tsx. Here the picker
// boundary is under test — open state, value handoff, confirm handling.
vi.mock("./MapPickerSheet", () => ({
  MapPickerSheet: ({
    open,
    onClose,
    value,
    onConfirm,
  }: {
    open: boolean;
    onClose: () => void;
    value: LocationValue;
    onConfirm: (next: LocationValue) => void;
  }) =>
    open ? (
      <div data-testid="map-picker-stub">
        <span data-testid="stub-value">
          {String(value.latitude)},{String(value.longitude)}
        </span>
        <button
          type="button"
          onClick={() =>
            onConfirm({
              label: "Mirpur, Dhaka",
              latitude: 23.81,
              longitude: 90.413,
              precision: "APPROXIMATE",
              preciseLatitude: 23.810332,
              preciseLongitude: 90.412518,
            })
          }
        >
          stub-confirm-approx
        </button>
        <button
          type="button"
          onClick={() =>
            onConfirm({
              label: "Mirpur, Dhaka",
              latitude: 23.810332,
              longitude: 90.412518,
              precision: "EXACT",
              preciseLatitude: 23.810332,
              preciseLongitude: 90.412518,
            })
          }
        >
          stub-confirm-exact
        </button>
        <button type="button" onClick={onClose}>
          stub-close
        </button>
      </div>
    ) : null,
}));

afterEach(cleanup);
// The geolocation API must never leak between tests: an installed stub is an
// own navigator property and is removed again here.
afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).geolocation;
});

/** Captures the callbacks the component hands to navigator.geolocation. */
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

/**
 * Installs a navigator.geolocation stub that never answers on its own, so a
 * test decides exactly when a fix arrives or fails. Nothing is requested until
 * the component is explicitly asked for it.
 */
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

const openSpy = vi.fn();

beforeEach(() => {
  openSpy.mockReset();
  vi.stubGlobal("open", openSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPicker(value: LocationValue) {
  const onChange = vi.fn();
  const { rerender } = render(<LocationPicker value={value} onChange={onChange} />);
  return { onChange, rerender };
}

const approxValue: LocationValue = {
  label: "Pinned location",
  latitude: 23.81,
  longitude: 90.412,
  precision: "APPROXIMATE",
  preciseLatitude: 23.810332,
  preciseLongitude: 90.412518,
};

const emptyValue: LocationValue = {
  label: "",
  latitude: null,
  longitude: null,
  precision: "APPROXIMATE",
  preciseLatitude: null,
  preciseLongitude: null,
};

describe("LocationPicker coordinate readout", () => {
  it("shows approximate pins at 3 decimals, matching the ~100 m claim", () => {
    renderPicker(approxValue);
    expect(screen.getByText("23.810, 90.412")).toBeTruthy();
  });

  it("shows exact pins at full stored precision", () => {
    renderPicker({
      ...approxValue,
      latitude: 23.810332,
      longitude: 90.412518,
      precision: "EXACT",
    });
    expect(screen.getByText("23.810332, 90.412518")).toBeTruthy();
  });

  it("keeps the readout in sync when rounding an exact pin", () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<LocationValue>({
        ...approxValue,
        latitude: 23.810332,
        longitude: 90.412518,
        precision: "EXACT",
      });
      return (
        <LocationPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByText("23.810332, 90.412518")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /round to ~100 m/i }));
    expect(screen.getByText("23.810, 90.413")).toBeTruthy();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 23.81, longitude: 90.413, precision: "APPROXIMATE" }),
    );
  });
});

describe("LocationPicker map wiring", () => {
  function renderHarness(initial: LocationValue) {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<LocationValue>(initial);
      return (
        <LocationPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    return { onChange };
  }

  function input(): HTMLInputElement {
    return screen.getByPlaceholderText(
      /place, decimal coords/i,
    ) as HTMLInputElement;
  }

  it("opens the sheet with the existing pin and emits nothing on open", () => {
    const { onChange } = renderPicker(approxValue);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    expect(screen.getByTestId("map-picker-stub")).toBeTruthy();
    expect(screen.getByTestId("stub-value").textContent).toBe("23.81,90.412");
    expect(onChange).not.toHaveBeenCalled();
    expect(input().value).toBe("Pinned location");
  });

  it("closing the sheet without confirming leaves the value alone", () => {
    const { onChange } = renderPicker(approxValue);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(screen.queryByTestId("map-picker-stub")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("map confirm commits approximate-by-default and syncs the text field", () => {
    const { onChange } = renderHarness(emptyValue);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    fireEvent.click(screen.getByRole("button", { name: "stub-confirm-approx" }));
    expect(onChange).toHaveBeenCalledWith({
      label: "Mirpur, Dhaka",
      latitude: 23.81,
      longitude: 90.413,
      precision: "APPROXIMATE",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412518,
    });
    expect(input().value).toBe("Mirpur, Dhaka");
    expect(screen.getByText("23.810, 90.413")).toBeTruthy();
    expect(screen.getByText("Pin rounded to ~100 m precision.")).toBeTruthy();
  });

  it("map confirm with exact shows the public-visibility warning at full precision", () => {
    renderHarness(emptyValue);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    fireEvent.click(screen.getByRole("button", { name: "stub-confirm-exact" }));
    expect(screen.getByText("23.810332, 90.412518")).toBeTruthy();
    expect(
      screen.getByText(/exact pin and will be shown publicly/i),
    ).toBeTruthy();
  });

  it("typed coordinates keep working without ever opening the map", () => {
    const { onChange } = renderPicker(emptyValue);
    expect(screen.queryByTestId("map-picker-stub")).toBeNull();
    fireEvent.change(input(), { target: { value: "23.810332, 90.412518" } });
    expect(onChange).toHaveBeenCalledWith({
      label: "Pinned location",
      latitude: 23.81,
      longitude: 90.413,
      precision: "APPROXIMATE",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412518,
    });
  });

  it("typed place text stays usable and the external Maps handoff stays enabled", () => {
    const { onChange } = renderPicker(emptyValue);
    fireEvent.change(input(), { target: { value: "Dhanmondi Lake" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Dhanmondi Lake", latitude: null, longitude: null }),
    );
    const findInMaps = screen.getByRole("button", { name: /find location in maps/i });
    expect(findInMaps).toHaveProperty("disabled", false);
    fireEvent.click(findInMaps);
    expect(screen.queryByTestId("map-picker-stub")).toBeNull();
  });
});

describe("LocationPicker one-time approximate location", () => {
  it("discards a short-link resolution begun before locking even if it settles after unlocking", async () => {
    let resolveLink!: (response: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveLink = resolve; }));
    const onChange = vi.fn();
    const { rerender } = render(<LocationPicker value={emptyValue} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText(/place, decimal coords/i), { target: { value: "https://maps.app.goo.gl/fixture" } });
    expect(resolveLink).toBeTypeOf("function");
    rerender(<LocationPicker value={emptyValue} onChange={onChange} disabled />);
    rerender(<LocationPicker value={emptyValue} onChange={onChange} />);
    await act(async () => resolveLink(new Response("", { status: 200 })));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/place, decimal coords/i)).toHaveProperty("value", "https://maps.app.goo.gl/fixture");
  });
  it("discards a fix begun before locking even if it settles after unlocking", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onChange = vi.fn();
    const { rerender } = render(<LocationPicker value={emptyValue} onChange={onChange} locationAdapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    rerender(<LocationPicker value={emptyValue} onChange={onChange} locationAdapter={adapter} disabled />);
    rerender(<LocationPicker value={emptyValue} onChange={onChange} locationAdapter={adapter} />);
    await act(async () => resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/place, decimal coords/i)).toHaveProperty("value", "");
  });
  it("discards a late adapter fix after an external report reset", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onChange = vi.fn();
    const { rerender } = render(<LocationPicker value={emptyValue} onChange={onChange} locationAdapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    rerender(<LocationPicker value={{ ...emptyValue, label: "Reset report" }} onChange={onChange} locationAdapter={adapter} />);
    expect(screen.getByRole("button", { name: /use my location once/i })).toHaveProperty("disabled", false);
    resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 });
    await waitFor(() => expect(screen.getByPlaceholderText(/place, decimal coords/i)).toHaveProperty("value", "Reset report"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not replace a manually typed place when an older fix arrives", async () => {
    let resolveFix!: (fix: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    const adapter: LocationAdapter = {
      getPermission: async () => "granted",
      getCurrentPosition: () => new Promise((resolve) => { resolveFix = resolve; }),
    };
    const onChange = vi.fn();
    render(<LocationPicker value={emptyValue} onChange={onChange} locationAdapter={adapter} />);
    fireEvent.click(screen.getByRole("button", { name: /use my location once/i }));
    await waitFor(() => expect(resolveFix).toBeTypeOf("function"));
    fireEvent.change(screen.getByPlaceholderText(/place, decimal coords/i), { target: { value: "My place" } });
    resolveFix({ latitude: 23.810332, longitude: 90.412518, accuracyMeters: 42 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByPlaceholderText(/place, decimal coords/i)).toHaveProperty("value", "My place"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "My place", latitude: null }));
  });

  function useMyLocation() {
    return screen.getByRole("button", { name: /use my location once/i });
  }

  /**
   * Parent that owns the value, the way CreateReport does: the readout can
   * only show the imported pin if onChange actually feeds back.
   */
  function renderLive(initial: LocationValue) {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<LocationValue>(initial);
      return (
        <LocationPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    return { onChange };
  }

  function locationInput(): HTMLInputElement {
    return screen.getByPlaceholderText(/place, decimal coords/i) as HTMLInputElement;
  }

  it("never requests a location on mount, on re-render or when the map sheet opens", () => {
    const geo = installGeolocation();
    const { rerender } = renderPicker(emptyValue);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    rerender(<LocationPicker value={emptyValue} onChange={vi.fn()} />);
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("asks once per explicit tap, coarsely, and never re-prompts by itself after a denial", async () => {
    const geo = installGeolocation();
    const { onChange, rerender } = renderPicker(emptyValue);

    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    const options = geo.getCurrentPosition.mock.calls[0]?.[2];
    expect(options?.enableHighAccuracy).toBe(false);
    expect(options?.timeout).toBeGreaterThan(0);

    // A double tap must not produce a second system prompt.
    fireEvent.click(useMyLocation());
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    // Neither must a re-render.
    rerender(<LocationPicker value={emptyValue} onChange={vi.fn()} />);
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);

    geo.reject(1);
    expect(await screen.findByText(/permission is denied/i)).toBeTruthy();

    // After a denial nothing may prompt again on its own: re-render, close the
    // sheet and reopen it — the request count stays at one.
    rerender(<LocationPicker value={emptyValue} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    fireEvent.click(screen.getByRole("button", { name: "stub-close" }));
    expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("denied gets its own actionable state and attaches no coordinates", async () => {
    const geo = installGeolocation();
    const { onChange } = renderPicker(emptyValue);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.reject(1);

    expect(await screen.findByText(/permission is denied/i)).toBeTruthy();
    expect(screen.queryByText(/location services are off/i)).toBeNull();
    expect(screen.queryByText(/within 8 seconds/i)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(locationInput().value).toBe("");
    expect(document.querySelector('iframe[title="Map"]')).toBeNull();
  });

  it("disabled location services get their own actionable state and attach no coordinates", async () => {
    const geo = installGeolocation();
    const { onChange } = renderPicker(emptyValue);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.reject(2);

    expect(await screen.findByText(/location services are off/i)).toBeTruthy();
    expect(screen.queryByText(/permission is denied/i)).toBeNull();
    expect(screen.queryByText(/within 8 seconds/i)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a timeout gets its own actionable state and attaches no coordinates", async () => {
    const geo = installGeolocation();
    const { onChange } = renderPicker(emptyValue);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.reject(3);

    expect(await screen.findByText(/within 8 seconds/i)).toBeTruthy();
    expect(screen.queryByText(/permission is denied/i)).toBeNull();
    expect(screen.queryByText(/location services are off/i)).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a granted coarse fix is attached as an approximate ~100 m pin", async () => {
    const geo = installGeolocation();
    // Stateful harness: the readout renders from the parent-owned value, so the
    // parent has to apply the emitted change for it to appear.
    const { onChange } = renderLive(emptyValue);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.grant();

    expect(await screen.findByText("23.810, 90.413")).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      label: "Pinned location",
      latitude: 23.81,
      longitude: 90.413,
      precision: "APPROXIMATE",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412519,
    });
  });

  it("a low-accuracy fix gets its own state and attaches nothing until confirmed", async () => {
    const geo = installGeolocation();
    const { onChange } = renderPicker(emptyValue);
    fireEvent.click(useMyLocation());
    await waitFor(() => expect(geo.getCurrentPosition).toHaveBeenCalledTimes(1));
    geo.grant({ latitude: 23.8103321, longitude: 90.4125189, accuracy: 4200 });

    const notice = await screen.findByTestId("low-accuracy-notice");
    expect(notice.textContent).toMatch(/accurate to about ~4\.2 km/i);
    expect(screen.getByRole("button", { name: /use this location anyway/i })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('iframe[title="Map"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /use this location anyway/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 23.81, longitude: 90.413, precision: "APPROXIMATE" }),
    );
  });
});

describe("LocationPicker in-app preview vs external map app", () => {
  it("keeps the in-app preview closed until it is deliberately opened", () => {
    renderPicker(approxValue);
    // Keyless preview: no third-party iframe, ever — just the raster grid.
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByTestId("map-embed-frame")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /preview map in app/i }));
    expect(screen.getByTestId("map-embed-frame")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("the external handoff opens Maps without the in-app preview or the picker sheet", async () => {
    const { onChange } = renderPicker(approxValue);
    fireEvent.click(screen.getByRole("button", { name: /open in maps/i }));

    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(String(openSpy.mock.calls[0]?.[0])).toContain("google.com/maps");
    expect(document.querySelector('iframe[title="Map"]')).toBeNull();
    expect(screen.queryByTestId("map-picker-stub")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opening the in-app picker never hands off to the external map app", async () => {
    renderPicker(approxValue);
    fireEvent.click(screen.getByRole("button", { name: /choose on map/i }));
    expect(screen.getByTestId("map-picker-stub")).toBeTruthy();
    expect(document.querySelector('iframe[title="Map"]')).toBeNull();
    await vi.waitFor(() => expect(openSpy).not.toHaveBeenCalled());
  });
});
