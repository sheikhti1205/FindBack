// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KLIPY_CONTENT_FILTER,
  KLIPY_SEARCH_PLACEHOLDER,
  isKlipyEnabled,
  klipyAppKey,
  klipyCustomerId,
  normalizeKlipyItem,
  searchKlipyGifs,
  searchKlipyStickers,
  trackKlipyShare,
} from "./klipy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("klipy config flag", () => {
  it("reads the testing key from config only (never hardcoded)", () => {
    expect(klipyAppKey({ VITE_KLIPY_API_KEY: "  test-key-1 " })).toBe("test-key-1");
    expect(klipyAppKey({})).toBe("");
    expect(isKlipyEnabled({ VITE_KLIPY_API_KEY: "k" })).toBe(true);
    expect(isKlipyEnabled({})).toBe(false);
    expect(isKlipyEnabled({ VITE_KLIPY_API_KEY: "   " })).toBe(false);
  });

  it("exposes the Search KLIPY placeholder", () => {
    expect(KLIPY_SEARCH_PLACEHOLDER).toBe("Search KLIPY");
  });
});

describe("klipyCustomerId", () => {
  it("is stable for the signed-in user", () => {
    expect(klipyCustomerId("u-123")).toBe("findback:u-123");
    expect(klipyCustomerId("u-123")).toBe("findback:u-123");
  });

  it("persists one anonymous id across calls (never regenerates per request)", () => {
    const first = klipyCustomerId(null);
    const second = klipyCustomerId(undefined);
    expect(first).toMatch(/^findback-anon:/);
    expect(second).toBe(first);
  });
});

describe("normalizeKlipyItem", () => {
  it("preserves provider URLs, slug, and raw data", () => {
    const raw = {
      slug: "happy-dance-1",
      title: "Happy dance",
      url: "https://media.klipy.com/happy.gif",
      preview_url: "https://media.klipy.com/happy-preview.gif",
    };
    const item = normalizeKlipyItem("gifs", raw);
    expect(item?.slug).toBe("happy-dance-1");
    expect(item?.mediaUrl).toBe("https://media.klipy.com/happy.gif");
    expect(item?.previewUrl).toBe("https://media.klipy.com/happy-preview.gif");
    expect(item?.raw).toBe(raw);
  });

  it("falls back to the media URL when no preview is provided (direct loading)", () => {
    const item = normalizeKlipyItem("stickers", { id: "s-9", url: "https://media.klipy.com/s.webp" });
    expect(item?.slug).toBe("s-9");
    expect(item?.previewUrl).toBe("https://media.klipy.com/s.webp");
  });

  it("skips entries without a usable media URL", () => {
    expect(normalizeKlipyItem("gifs", { slug: "x" })).toBeNull();
    expect(normalizeKlipyItem("gifs", null)).toBeNull();
  });
});

describe("searchKlipy", () => {
  function okFetch(payload: unknown, seen: string[]) {
    return (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, json: async () => payload } as Response;
    }) as typeof fetch;
  }

  it("returns [] when the key is absent (gracefully hidden, no request)", async () => {
    const fetchImpl = vi.fn();
    expect(await searchKlipyGifs("hi", { env: {}, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("searches with a stable customer_id and the high content filter", async () => {
    const seen: string[] = [];
    const items = await searchKlipyGifs("happy", {
      env: { VITE_KLIPY_API_KEY: "test-key" },
      customerId: "findback:u-1",
      fetchImpl: okFetch({ data: { content_items: [{ slug: "a", url: "https://m/a.gif" }] } }, seen),
    });
    expect(items).toHaveLength(1);
    const url = seen[0]!;
    expect(url).toContain("/test-key/gifs/search");
    expect(url).toContain("q=happy");
    expect(url).toContain("customer_id=findback%3Au-1");
    expect(url).toContain(`content_filter=${KLIPY_CONTENT_FILTER}`);
  });

  it("uses trending for an empty query and supports stickers", async () => {
    const seen: string[] = [];
    const items = await searchKlipyStickers("   ", {
      env: { VITE_KLIPY_API_KEY: "test-key" },
      customerId: "c1",
      fetchImpl: okFetch({ data: { content_items: [] } }, seen),
    });
    expect(items).toEqual([]);
    expect(seen[0]).toContain("/test-key/stickers/trending");
  });

  it("never throws on provider failures (empty results, no error surface)", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await searchKlipyGifs("x", { env: { VITE_KLIPY_API_KEY: "k" }, fetchImpl: failing })).toEqual([]);
    const bad = (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    expect(await searchKlipyGifs("x", { env: { VITE_KLIPY_API_KEY: "k" }, fetchImpl: bad })).toEqual([]);
  });
});

describe("trackKlipyShare", () => {
  it("posts share-tracking only (never on search/preview) and never throws", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response);
    await trackKlipyShare("gifs", "happy-1", "findback:u-1", {
      env: { VITE_KLIPY_API_KEY: "test-key" },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/test-key/gifs/share/happy-1");
    expect(init.method).toBe("POST");
  });

  it("is a silent no-op without a key or slug", async () => {
    const fetchImpl = vi.fn();
    await trackKlipyShare("gifs", "s", "c", { env: {}, fetchImpl });
    await trackKlipyShare("gifs", "  ", "c", { env: { VITE_KLIPY_API_KEY: "k" }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
