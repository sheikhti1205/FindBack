// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocationPicker, type LocationValue } from "./LocationPicker";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));

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
