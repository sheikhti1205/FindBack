// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { attributionForSource, searchPlacesUnified } from "./placesSearch";
import { NominatimRateLimitError, NominatimThrottler } from "./nominatimSearch";

const nominatimPayload = [
  { display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" },
  { display_name: "  ", lat: "1", lon: "2" },
  { display_name: "No coords", lat: "NaN", lon: "2" },
];

function nominatimFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(nominatimPayload),
  }) as unknown as typeof fetch;
}

describe("placesSearch (unified, Nominatim-only)", () => {
  it("searches Nominatim directly with no native bridge involved", async () => {
    const fetcher = nominatimFetch();
    const result = await searchPlacesUnified("mirpur", { fetcher });
    expect(result).toEqual({
      places: [{ displayName: "Mirpur, Dhaka", latitude: 23.8103, longitude: 90.4125 }],
      source: "nominatim",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const calls = (fetcher as unknown as { mock: { calls: Array<[string]> } }).mock.calls;
    expect(calls[0]?.[0] ?? "").toContain("nominatim.openstreetmap.org");
  });

  it("caps results at maxResults", async () => {
    const fetcher = nominatimFetch();
    const result = await searchPlacesUnified("mirpur", { fetcher, maxResults: 1 });
    expect(result.places).toHaveLength(1);
  });

  it("surfaces the Nominatim rate limit so the UI can say 'wait a moment'", async () => {
    const throttler = new NominatimThrottler();
    const fetcher = nominatimFetch();
    await searchPlacesUnified("mirpur", { fetcher, throttler, now: 1_000 });
    await expect(
      searchPlacesUnified("mirpur", { fetcher, throttler, now: 1_000 }),
    ).rejects.toBeInstanceOf(NominatimRateLimitError);
  });

  it("returns empty without touching the network for blank queries", async () => {
    const fetcher = nominatimFetch();
    expect(await searchPlacesUnified("   ", { fetcher })).toEqual({
      places: [],
      source: "nominatim",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("labels attribution for the answering source", () => {
    expect(attributionForSource()).toMatch(/openstreetmap/i);
  });
});
