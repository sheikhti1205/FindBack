// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { attributionForSource, searchPlacesUnified } from "./placesSearch";
import { PlacesSearchError } from "../../native/googlePlaces";
import type { PlaceResult } from "./nominatimSearch";

const googlePlace: PlaceResult = {
  displayName: "Mirpur, Dhaka",
  latitude: 23.8103,
  longitude: 90.4125,
};

const nominatimPayload = [
  { display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" },
];

function nominatimFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(nominatimPayload),
  }) as unknown as typeof fetch;
}

describe("placesSearch (unified)", () => {
  it("prefers native Places results when the bridge answers", async () => {
    const nativeSearch = vi.fn().mockResolvedValue([googlePlace]);
    const fetcher = nominatimFetch();
    const result = await searchPlacesUnified("mirpur", { nativeSearch, fetcher });
    expect(result).toEqual({ places: [googlePlace], source: "places" });
    expect(nativeSearch).toHaveBeenCalledWith("mirpur");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to Nominatim when native is unavailable (web/keyless)", async () => {
    const nativeSearch = vi.fn().mockRejectedValue(new PlacesSearchError("unavailable"));
    const fetcher = nominatimFetch();
    const result = await searchPlacesUnified("mirpur", { nativeSearch, fetcher });
    expect(result.source).toBe("nominatim");
    expect(result.places).toEqual([googlePlace]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to Nominatim when native is misconfigured or fails", async () => {
    for (const kind of ["misconfigured", "failed"] as const) {
      const nativeSearch = vi.fn().mockRejectedValue(new PlacesSearchError(kind));
      const result = await searchPlacesUnified("mirpur", {
        nativeSearch,
        fetcher: nominatimFetch(),
      });
      expect(result.source).toBe("nominatim");
      expect(result.places).toEqual([googlePlace]);
    }
  });

  it("sanitizes native results and caps them at maxResults", async () => {
    const nativeSearch = vi.fn().mockResolvedValue([
      googlePlace,
      { displayName: "  ", latitude: 1, longitude: 2 },
      { displayName: "No coords", latitude: Number.NaN, longitude: 2 },
      { displayName: "Second", latitude: 1, longitude: 2 },
    ]);
    const result = await searchPlacesUnified("mirpur", {
      nativeSearch,
      fetcher: nominatimFetch(),
      maxResults: 1,
    });
    expect(result).toEqual({ places: [googlePlace], source: "places" });
  });

  it("lets unexpected (non-bridge) errors propagate instead of masking them", async () => {
    const nativeSearch = vi.fn().mockRejectedValue(new TypeError("boom"));
    await expect(
      searchPlacesUnified("mirpur", { nativeSearch, fetcher: nominatimFetch() }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("returns empty without touching any provider for blank queries", async () => {
    const nativeSearch = vi.fn();
    const fetcher = nominatimFetch();
    expect(await searchPlacesUnified("   ", { nativeSearch, fetcher })).toEqual({
      places: [],
      source: "nominatim",
    });
    expect(nativeSearch).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("labels attributions per answering source", () => {
    expect(attributionForSource("places")).toMatch(/google/i);
    expect(attributionForSource("nominatim")).toMatch(/openstreetmap/i);
  });
});
