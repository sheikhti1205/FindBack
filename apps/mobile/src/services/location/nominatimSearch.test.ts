import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOMINATIM_CONFIG,
  NOMINATIM_MIN_INTERVAL_MS,
  NominatimRateLimitError,
  NominatimThrottler,
  parseRetryAfterMs,
  resolveNominatimConfig,
  searchPlaces,
  sharedNominatimThrottler,
} from "./nominatimSearch";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("nominatimSearch endpoint seam", () => {
  it("defaults to the public Nominatim search endpoint with attribution", () => {
    expect(DEFAULT_NOMINATIM_CONFIG.endpoint).toContain("nominatim.openstreetmap.org");
    expect(DEFAULT_NOMINATIM_CONFIG.attribution).toContain("OpenStreetMap");
    expect(resolveNominatimConfig()).toEqual(DEFAULT_NOMINATIM_CONFIG);
  });

  it("lets a controlled proxy replace the endpoint without call-site changes", () => {
    expect(
      resolveNominatimConfig({ endpoint: "https://proxy.example.com/nominatim" }).endpoint,
    ).toBe("https://proxy.example.com/nominatim");
  });

  it("makes no request for blank queries", async () => {
    const fetcher = vi.fn();
    await expect(searchPlaces("   ", { fetcher })).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps a successful response to place results", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse([
        { display_name: "Mirpur, Dhaka", lat: "23.8103", lon: "90.4125" },
        { display_name: "Broken", lat: "NaN", lon: "200" },
        { display_name: "", lat: "23", lon: "90" },
      ]),
    );
    const places = await searchPlaces("mirpur", {
      fetcher,
      throttler: new NominatimThrottler(),
      now: 0,
    });
    expect(places).toEqual([
      { displayName: "Mirpur, Dhaka", latitude: 23.8103, longitude: 90.4125 },
    ]);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent("mirpur"));
    expect(url).toContain("format=jsonv2");
    // Browser builds must not set a User-Agent header (forbidden header).
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/user-agent/i);
  });

  it("enforces ≤1 req/s between explicit submissions", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
    const throttler = new NominatimThrottler();
    await searchPlaces("mirpur", { fetcher, throttler, now: 1_000 });
    const failed = await searchPlaces("mirpur", { fetcher, throttler, now: 1_000 }).catch(
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(NominatimRateLimitError);
    expect((failed as NominatimRateLimitError).retryAfterMs).toBe(
      NOMINATIM_MIN_INTERVAL_MS,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    // After the floor elapses the same throttler allows the next submit.
    await searchPlaces("mirpur", {
      fetcher,
      throttler,
      now: 1_000 + NOMINATIM_MIN_INTERVAL_MS,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("surfaces server failures as plain-language errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse([], false));
    await expect(
      searchPlaces("mirpur", { fetcher, throttler: new NominatimThrottler(), now: 0 }),
    ).rejects.toThrow(/pan the map/i);
  });

  it("shares one process-wide throttle by default (MAP-3, no fresh limiter per call)", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse([]));
    // Deterministic clock far from any other test's injected `now`.
    const t = 9_000_000;
    await searchPlaces("mirpur", { fetcher, now: t });
    const failed = await searchPlaces("mirpur", { fetcher, now: t }).catch(
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(NominatimRateLimitError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await searchPlaces("mirpur", { fetcher, now: t + NOMINATIM_MIN_INTERVAL_MS });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sharedNominatimThrottler).toBeInstanceOf(NominatimThrottler);
  });

  it("maps HTTP 429 to the rate-limit error and honors Retry-After (web parity)", async () => {
    const headers = { get: (name: string) => (name.toLowerCase() === "retry-after" ? "2" : null) };
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 429, headers, json: () => Promise.resolve([]) });
    const throttler = new NominatimThrottler();
    const failed = await searchPlaces("chattogram", { fetcher, throttler, now: 50_000 }).catch(
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(NominatimRateLimitError);
    expect((failed as NominatimRateLimitError).retryAfterMs).toBe(2_000);
    // Server backpressure disciplines the same gate: an immediate retry fails fast.
    const again = await searchPlaces("chattogram", { fetcher, throttler, now: 50_500 }).catch(
      (err: unknown) => err,
    );
    expect(again).toBeInstanceOf(NominatimRateLimitError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats 429 without Retry-After as rate-limited at the 1 req/s floor", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 429, headers: { get: () => null }, json: () => Promise.resolve([]) });
    const failed = await searchPlaces("chattogram", { fetcher, throttler: new NominatimThrottler(), now: 60_000 }).catch(
      (err: unknown) => err,
    );
    expect(failed).toBeInstanceOf(NominatimRateLimitError);
    expect((failed as NominatimRateLimitError).retryAfterMs).toBe(NOMINATIM_MIN_INTERVAL_MS);
  });

  it("parses Retry-After delta-seconds and rejects anything else", () => {
    expect(parseRetryAfterMs("2")).toBe(2_000);
    expect(parseRetryAfterMs("  30 ")).toBe(30_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("tomorrow")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
  });
});
