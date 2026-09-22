// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocationPicker, type LocationValue } from "./LocationPicker";

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

describe("LocationPicker coordinate readout (WP17 #14)", () => {
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
