// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  extractCoordsFromGeoUri,
  extractCoordsFromMapsUrl,
  geoUri,
  isAllowlistedShortLink,
  mapsSearchUrl,
  openInMaps,
  parseLocationInput,
  resolveShortLink,
  roundToApproximate,
  validateDecimalPair,
} from "./location";

describe("validateDecimalPair", () => {
  it("accepts valid lat/lng", () => {
    expect(validateDecimalPair(23.8, 90.4)).toEqual({ ok: true });
    expect(validateDecimalPair(-90, -180)).toEqual({ ok: true });
    expect(validateDecimalPair(90, 180)).toEqual({ ok: true });
  });

  it("rejects out-of-range values", () => {
    expect(validateDecimalPair(91, 0).ok).toBe(false);
    expect(validateDecimalPair(-91, 0).ok).toBe(false);
    expect(validateDecimalPair(0, 181).ok).toBe(false);
    expect(validateDecimalPair(0, -181).ok).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(validateDecimalPair(NaN, 0).ok).toBe(false);
    expect(validateDecimalPair(0, Infinity).ok).toBe(false);
  });
});

describe("roundToApproximate", () => {
  it("rounds to 3 decimals (~100m)", () => {
    expect(roundToApproximate(23.8101234, 90.4123456)).toEqual({ lat: 23.81, lng: 90.412 });
  });
});

describe("extractCoordsFromMapsUrl", () => {
  it("parses /maps/search/?api=1&query=LAT,LNG", () => {
    expect(extractCoordsFromMapsUrl("https://www.google.com/maps/search/?api=1&query=23.8,90.4")).toEqual({
      lat: 23.8,
      lng: 90.4,
    });
  });

  it("parses @LAT,LNG in the path", () => {
    expect(extractCoordsFromMapsUrl("https://www.google.com/maps/@23.8103,90.4125,15z")).toEqual({
      lat: 23.8103,
      lng: 90.4125,
    });
  });

  it("parses ?q=LAT,LNG", () => {
    expect(extractCoordsFromMapsUrl("https://maps.google.com/?q=23.8,90.4")).toEqual({
      lat: 23.8,
      lng: 90.4,
    });
  });

  it("parses ?query=LAT,LNG", () => {
    expect(extractCoordsFromMapsUrl("https://maps.google.com/?query=23.8,90.4")).toEqual({
      lat: 23.8,
      lng: 90.4,
    });
  });

  it("parses ?center=LAT,LNG", () => {
    expect(extractCoordsFromMapsUrl("https://maps.google.com/?center=23.8,90.4")).toEqual({
      lat: 23.8,
      lng: 90.4,
    });
  });

  it("returns null for a place-name query", () => {
    expect(extractCoordsFromMapsUrl("https://www.google.com/maps/search/?api=1&query=Chittagong")).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(extractCoordsFromMapsUrl("not a url")).toBeNull();
  });
});

describe("extractCoordsFromGeoUri", () => {
  it("parses geo:lat,lng", () => {
    expect(extractCoordsFromGeoUri("geo:23.8,90.4")).toEqual({ lat: 23.8, lng: 90.4 });
    expect(extractCoordsFromGeoUri("geo:23.8,90.4?z=15")).toEqual({ lat: 23.8, lng: 90.4 });
  });

  it("rejects out-of-range geo URIs", () => {
    expect(extractCoordsFromGeoUri("geo:123,90.4")).toBeNull();
  });
});

describe("isAllowlistedShortLink", () => {
  it("accepts maps.app.goo.gl and goo.gl", () => {
    expect(isAllowlistedShortLink("https://maps.app.goo.gl/abc123")).toBe(true);
    expect(isAllowlistedShortLink("https://goo.gl/maps/abc123")).toBe(true);
  });

  it("rejects arbitrary hosts", () => {
    expect(isAllowlistedShortLink("https://evil.example/abc")).toBe(false);
    expect(isAllowlistedShortLink("https://bit.ly/abc")).toBe(false);
  });
});

describe("resolveShortLink", () => {
  it("follows bounded redirects on allowlisted hosts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "https://maps.google.com/?q=23.8,90.4" }),
      })
      .mockResolvedValueOnce({ status: 200, headers: new Headers() });

    const final = await resolveShortLink("https://maps.app.goo.gl/abc", fetcher);
    expect(final).toBe("https://maps.google.com/?q=23.8,90.4");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects redirects to arbitrary hosts", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "https://evil.example/x" }),
    });

    await expect(resolveShortLink("https://maps.app.goo.gl/abc", fetcher)).rejects.toThrow(
      "untrusted host",
    );
  });

  it("rejects non-allowlisted input", async () => {
    await expect(resolveShortLink("https://bit.ly/abc")).rejects.toThrow(
      "Only Google Maps short links",
    );
  });

  it("times out after 8s", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    const promise = resolveShortLink("https://maps.app.goo.gl/abc", fetcher);
    const assertion = expect(promise).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
    vi.useRealTimers();
  });
});

describe("parseLocationInput", () => {
  it("parses decimal lat,lng", () => {
    const r = parseLocationInput("23.8, 90.4");
    expect(r.latitude).toBe(23.8);
    expect(r.longitude).toBe(90.4);
    expect(r.label).toBe("Pinned location");
  });

  it("reports invalid decimal pairs without fabricating coords", () => {
    const r = parseLocationInput("123, 90.4");
    expect(r.latitude).toBeNull();
    expect(r.longitude).toBeNull();
    expect(r.error).toMatch(/latitude/i);
  });

  it("parses a long Google Maps URL", () => {
    const r = parseLocationInput("https://www.google.com/maps/search/?api=1&query=23.8,90.4");
    expect(r.latitude).toBe(23.8);
    expect(r.fromUrl).toBe(true);
  });

  it("parses @ coords", () => {
    const r = parseLocationInput("https://www.google.com/maps/@23.8103,90.4125,15z");
    expect(r.latitude).toBe(23.8103);
    expect(r.longitude).toBe(90.4125);
  });

  it("parses a geo URI", () => {
    const r = parseLocationInput("geo:23.8,90.4");
    expect(r.latitude).toBe(23.8);
    expect(r.longitude).toBe(90.4);
  });

  it("flags short links for native resolution", () => {
    const r = parseLocationInput("https://maps.app.goo.gl/abc123");
    expect(r.needsResolve).toBe(true);
    expect(r.latitude).toBeNull();
  });

  it("keeps place text as a searchable label without coords", () => {
    const r = parseLocationInput("Science Faculty, University of Chittagong");
    expect(r.label).toBe("Science Faculty, University of Chittagong");
    expect(r.latitude).toBeNull();
    expect(r.longitude).toBeNull();
  });

  it("keeps a maps URL with no coords as a label (no fabricated coords)", () => {
    const r = parseLocationInput("https://www.google.com/maps/search/?api=1&query=Chittagong");
    expect(r.latitude).toBeNull();
    expect(r.longitude).toBeNull();
    expect(r.label).toContain("google.com");
  });
});

describe("maps helpers", () => {
  it("builds a geo URI", () => {
    expect(geoUri(23.8, 90.4)).toBe("geo:23.8,90.4?q=23.8,90.4");
  });

  it("builds a keyless Maps search URL", () => {
    expect(mapsSearchUrl(23.8, 90.4, "")).toBe(
      "https://www.google.com/maps/search/?api=1&query=23.8,90.4",
    );
    expect(mapsSearchUrl(null, null, "Chittagong")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Chittagong",
    );
  });

  it("opens in Maps via geo URI when coords exist", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    openInMaps(23.8, 90.4, "");
    expect(open).toHaveBeenCalledWith("geo:23.8,90.4?q=23.8,90.4", "_blank", "noopener,noreferrer");
    vi.unstubAllGlobals();
  });

  it("opens in Maps via search URL when only a label exists", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    openInMaps(null, null, "Chittagong");
    expect(open).toHaveBeenCalledWith(
      "https://www.google.com/maps/search/?api=1&query=Chittagong",
      "_blank",
      "noopener,noreferrer",
    );
    vi.unstubAllGlobals();
  });
});