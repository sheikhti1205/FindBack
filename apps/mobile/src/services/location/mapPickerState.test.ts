import { describe, expect, it } from "vitest";
import {
  PIN_ZOOM,
  WORLD_VIEW_ZOOM,
  commitCenterAsLocation,
  formatCoordinateReadout,
  isNeutralView,
  isValidCenter,
  resolveInitialView,
} from "./mapPickerState";

describe("mapPickerState start-order", () => {
  it("prefers the existing report pin over everything else", () => {
    const view = resolveInitialView({
      reportPin: { lat: 23.81, lng: 90.41 },
      searchResult: { lat: 1, lng: 1 },
      gpsPreview: { lat: 2, lng: 2 },
    });
    expect(view).toEqual({ center: { lat: 23.81, lng: 90.41 }, zoom: PIN_ZOOM, source: "report-pin" });
  });

  it("falls back to search result, then explicit GPS preview", () => {
    expect(
      resolveInitialView({ searchResult: { lat: 1, lng: 2 }, gpsPreview: { lat: 3, lng: 4 } }).source,
    ).toBe("search-result");
    expect(resolveInitialView({ gpsPreview: { lat: 3, lng: 4 } })).toEqual({
      center: { lat: 3, lng: 4 },
      zoom: PIN_ZOOM,
      source: "gps-preview",
    });
  });

  it("ends at a neutral world state that defaults to no country", () => {
    const view = resolveInitialView({});
    expect(view.source).toBe("neutral-world");
    expect(view.zoom).toBe(WORLD_VIEW_ZOOM);
    expect(isNeutralView(view)).toBe(true);
  });

  it("ignores out-of-range centers instead of committing them", () => {
    expect(isValidCenter({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidCenter({ lat: 0, lng: 181 })).toBe(false);
    expect(isValidCenter({ lat: "23", lng: 90 })).toBe(false);
    expect(isValidCenter(null)).toBe(false);
    expect(
      resolveInitialView({ reportPin: { lat: 91, lng: 0 } }).source,
    ).toBe("neutral-world");
  });
});

describe("mapPickerState LocationValue semantics", () => {
  it("commits approximate-by-default with the precise fix retained", () => {
    expect(
      commitCenterAsLocation("Pinned location", { lat: 23.810332, lng: 90.412518 }, "APPROXIMATE"),
    ).toEqual({
      label: "Pinned location",
      latitude: 23.81,
      longitude: 90.413,
      precision: "APPROXIMATE",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412518,
    });
  });

  it("commits exact pins at full precision on explicit opt-in", () => {
    expect(
      commitCenterAsLocation("Pinned location", { lat: 23.810332, lng: 90.412518 }, "EXACT"),
    ).toEqual({
      label: "Pinned location",
      latitude: 23.810332,
      longitude: 90.412518,
      precision: "EXACT",
      preciseLatitude: 23.810332,
      preciseLongitude: 90.412518,
    });
  });

  it("clears coordinates on null centers", () => {
    expect(commitCenterAsLocation("label", null, "APPROXIMATE")).toEqual({
      label: "label",
      latitude: null,
      longitude: null,
      precision: "APPROXIMATE",
      preciseLatitude: null,
      preciseLongitude: null,
    });
  });

  it("formats readouts without implying false precision", () => {
    expect(
      formatCoordinateReadout({ latitude: 23.81, longitude: 90.413, precision: "APPROXIMATE" }),
    ).toBe("23.810, 90.413");
    expect(
      formatCoordinateReadout({ latitude: 23.810332, longitude: 90.412518, precision: "EXACT" }),
    ).toBe("23.810332, 90.412518");
    expect(
      formatCoordinateReadout({ latitude: null, longitude: null, precision: "APPROXIMATE" }),
    ).toBeNull();
  });
});
