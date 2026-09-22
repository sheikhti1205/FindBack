// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MapPickerSheet } from "./MapPickerSheet";
import type { LocationValue } from "./LocationPicker";

vi.mock("./LiveRegion", () => ({ announce: vi.fn() }));

const behavior = vi.hoisted(() => ({
  throwOnConstruct: false,
  reportUnsupported: false,
  instances: [] as Array<{
    opts: { style: string; center: [number, number]; zoom: number };
    center: { lat: number; lng: number };
    handlers: Record<string, () => void>;
    jumpedTo: Array<{ center: [number, number]; zoom?: number }>;
  }>,
}));

vi.mock("maplibre-gl", () => {
  class GPUInitializationError extends Error {}
  class NavigationControl {}
  class FakeMap {
    state: (typeof behavior.instances)[number];
    constructor(opts: { style: string; center: [number, number]; zoom: number }) {
      if (behavior.throwOnConstruct) {
        throw new GPUInitializationError("WebGL unavailable");
      }
      const [lng, lat] = opts.center;
      this.state = {
        opts,
        center: { lat, lng },
        handlers: {},
        jumpedTo: [],
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
    addControl(): void {}
    remove(): void {}
  }
  return {
    Map: FakeMap,
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
  behavior.throwOnConstruct = false;
  behavior.reportUnsupported = false;
  behavior.instances.length = 0;
});

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
  it("starts at the existing report pin and confirms approximate-by-default", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <MapPickerSheet open onClose={onClose} value={pinned} onConfirm={onConfirm} />,
    );

    expect(await screen.findByText("Pin rounded to ~100 m precision.")).toBeTruthy();
    expect(behavior.instances).toHaveLength(1);
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

    fireEvent.submit(screen.getByLabelText("Search for a place").closest("form")!);
    expect(await screen.findByText("Mirpur, Dhaka")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("Mirpur, Dhaka"));
    expect(behavior.instances[0]?.jumpedTo[0]?.center).toEqual([90.4125, 23.8103]);
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
