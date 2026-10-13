// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KLIPY_BUILD_CONFIG_KEY,
  KLIPY_CONTENT_FILTER,
  KLIPY_SEARCH_PLACEHOLDER,
  buildKlipyShareRequest,
  createKlipySearchController,
  isKlipyEnabled,
  isKlipyMediaUrl,
  klipyAppKey,
  klipyCustomerId,
  normalizeKlipyItem,
  searchKlipyGifs,
  searchKlipyStickers,
  trackKlipyShare,
  type KlipyItem,
  type KlipySearchState,
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
      fetchImpl: okFetch({ data: { content_items: [{ slug: "a", url: "https://media.klipy.com/a.gif" }] } }, seen),
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
    await trackKlipyShare("gifs", "s", "   ", { env: { VITE_KLIPY_API_KEY: "k" }, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * OFFICIAL-SHAPED, SANITIZED fixtures (spec 24 static completion): the live
 * KLIPY docs were unreachable from the sandbox on 2026-10-12, so these
 * mirror the documented contract shape (key-scoped path, page/per_page/
 * customer_id/content_filter params, search vs trending, data.content_items
 * nesting with media-variant tolerance) with invented slugs and the
 * documented media hosts only. No production data, no key. Revalidate
 * against the live docs before enabling with a production key.
 */
const OFFICIAL_SHAPED_SEARCH_FIXTURE = {
  data: {
    content_items: [
      {
        slug: "fixture-happy-dance-1",
        title: "Fixture happy dance",
        media: {
          gif: {
            url: "https://media.klipy.com/fixture/happy.gif",
            preview: "https://media.klipy.com/fixture/happy-preview.gif",
            width: 480,
            height: 270,
          },
        },
      },
      {
        id: "fixture-sticker-9",
        alt: "Fixture sticker",
        images: { original: "https://media.klipy.com/fixture/s.webp" },
      },
    ],
  },
};

describe("klipy provider URL allowlist (spec 24 URL safety)", () => {
  it("trusts https klipy hosts only", () => {
    expect(isKlipyMediaUrl("https://media.klipy.com/a.gif")).toBe(true);
    expect(isKlipyMediaUrl("https://klipy.com/a.gif")).toBe(true);
    expect(isKlipyMediaUrl("http://media.klipy.com/a.gif")).toBe(false);
    expect(isKlipyMediaUrl("https://evil.example/a.gif")).toBe(false);
    expect(isKlipyMediaUrl("https://media.klipy.com.evil.example/a.gif")).toBe(false);
    expect(isKlipyMediaUrl("data:image/gif;base64,AAA")).toBe(false);
    expect(isKlipyMediaUrl("not a url")).toBe(false);
  });

  it("parses the official-shaped nested fixture (media variants + dims)", () => {
    const items = OFFICIAL_SHAPED_SEARCH_FIXTURE.data.content_items
      .map((raw) => normalizeKlipyItem("gifs", raw))
      .filter((item): item is KlipyItem => item !== null);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      slug: "fixture-happy-dance-1",
      mediaUrl: "https://media.klipy.com/fixture/happy.gif",
      previewUrl: "https://media.klipy.com/fixture/happy-preview.gif",
      width: 480,
      height: 270,
    });
    expect(items[1]?.slug).toBe("fixture-sticker-9");
  });

  it("rejects a malicious provider URL (no arbitrary-host injection)", () => {
    expect(normalizeKlipyItem("gifs", { slug: "evil", url: "https://evil.example/x.gif" })).toBeNull();
    expect(normalizeKlipyItem("gifs", { slug: "evil", url: "http://media.klipy.com/x.gif" })).toBeNull();
  });

  it("falls back to the media URL when the preview is untrusted", () => {
    const item = normalizeKlipyItem("gifs", {
      slug: "s",
      url: "https://media.klipy.com/s.gif",
      preview_url: "https://evil.example/s.gif",
    });
    expect(item?.previewUrl).toBe("https://media.klipy.com/s.gif");
  });
});

/**
 * LIVE-VALIDATED fixture (2026-10-13): captured from the real KLIPY API with a
 * validated key (HTTP 200, `findback:selftest`). The live contract nests
 * results at `data.data` (a list) and carries media at
 * `file.<hd|md|sm|xs>.<gif|webp|jpg|mp4|webm>.url` — NOT `data.content_items`
 * with `media.gif.url`. `blur_preview` is a base64 data URI and must never be
 * used as a media/preview URL. Slugs/URLs here are invented; the host
 * (`static.klipy.com`) is the real allowlisted provider CDN. These tests guard
 * against provider contract drift.
 */
const LIVE_SHAPED_TRENDING_FIXTURE = {
  result: true,
  data: {
    data: [
      {
        id: 539075238,
        slug: "live-happy-dance-1",
        title: "Live happy dance",
        type: "gif",
        tags: [],
        blur_preview: "data:image/jpeg;base64,/9j//gA",
        file: {
          hd: {
            gif: { url: "https://static.klipy.com/fixture/happy.gif", width: 300, height: 300, size: 10 },
            mp4: { url: "https://static.klipy.com/fixture/happy.mp4", width: 300, height: 300, size: 9 },
            webp: { url: "https://static.klipy.com/fixture/happy.webp", width: 300, height: 300, size: 8 },
            jpg: { url: "https://static.klipy.com/fixture/happy.jpg", width: 300, height: 300, size: 7 },
          },
          md: {
            gif: { url: "https://static.klipy.com/fixture/happy-md.gif", width: 200, height: 200, size: 6 },
            jpg: { url: "https://static.klipy.com/fixture/happy-md.jpg", width: 200, height: 200, size: 5 },
          },
          sm: {
            gif: { url: "https://static.klipy.com/fixture/happy-sm.gif", width: 100, height: 100, size: 4 },
            jpg: { url: "https://static.klipy.com/fixture/happy-preview.jpg", width: 100, height: 100, size: 3 },
          },
        },
      },
    ],
    current_page: 1,
    per_page: 24,
    has_next: true,
    meta: {},
  },
};

describe("klipy live contract (2026-10-13 captured shape)", () => {
  it("finds items nested at data.data (live container)", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return { ok: true, json: async () => LIVE_SHAPED_TRENDING_FIXTURE } as Response;
    }) as typeof fetch;
    const items = await searchKlipyGifs("", {
      env: { VITE_KLIPY_API_KEY: "test-key" },
      customerId: "c1",
      fetchImpl,
    });
    expect(items).toHaveLength(1);
    expect(seen[0]).toContain("/test-key/gifs/trending");
  });

  it("normalizes the live item's file.<size>.<fmt>.url media and preview", () => {
    const raw = LIVE_SHAPED_TRENDING_FIXTURE.data.data[0];
    const item = normalizeKlipyItem("gifs", raw);
    expect(item).toMatchObject({
      slug: "live-happy-dance-1",
      title: "Live happy dance",
      mediaUrl: "https://static.klipy.com/fixture/happy.gif",
      previewUrl: "https://static.klipy.com/fixture/happy-preview.jpg",
      width: 300,
      height: 300,
    });
  });

  it("never surfaces the base64 blur_preview as a media or preview URL", () => {
    const raw = LIVE_SHAPED_TRENDING_FIXTURE.data.data[0];
    const item = normalizeKlipyItem("gifs", raw);
    expect(item?.mediaUrl.startsWith("data:")).toBe(false);
    expect(item?.previewUrl.startsWith("data:")).toBe(false);
  });
});

describe("buildKlipyShareRequest", () => {
  it("builds the POST share request with an encoded customer id", () => {
    const request = buildKlipyShareRequest("stickers", "happy-1", "findback:u-1", {
      VITE_KLIPY_API_KEY: "test-key",
    });
    expect(request?.method).toBe("POST");
    expect(request?.url).toContain("/test-key/stickers/share/happy-1");
    expect(request?.url).toContain("customer_id=findback%3Au-1");
  });

  it("returns null when tracking must not fire (fail-closed, never logs the key)", () => {
    expect(buildKlipyShareRequest("gifs", "s", "c", {})).toBeNull();
    expect(
      buildKlipyShareRequest("gifs", "  ", "c", { VITE_KLIPY_API_KEY: "k" }),
    ).toBeNull();
    expect(
      buildKlipyShareRequest("gifs", "s", "  ", { VITE_KLIPY_API_KEY: "k" }),
    ).toBeNull();
  });

  it("reads the key through the single build-config seam", () => {
    expect(KLIPY_BUILD_CONFIG_KEY).toBe("VITE_KLIPY_API_KEY");
    expect(klipyAppKey({ [KLIPY_BUILD_CONFIG_KEY]: " k " })).toBe("k");
  });
});

describe("searchKlipy pagination and cancellation", () => {
  function okFetch(payload: unknown, seen: string[]) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      void init;
      return { ok: true, json: async () => payload } as Response;
    }) as typeof fetch;
  }

  it("sends page/per_page for trending pagination", async () => {
    const seen: string[] = [];
    await searchKlipyGifs("", {
      page: 2,
      perPage: 10,
      env: { VITE_KLIPY_API_KEY: "test-key" },
      customerId: "c1",
      fetchImpl: okFetch({ data: { content_items: [] } }, seen),
    });
    expect(seen[0]).toContain("/test-key/gifs/trending");
    expect(seen[0]).toContain("page=2");
    expect(seen[0]).toContain("per_page=10");
  });

  it("resolves [] (never throws) when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw new DOMException("Aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(
      searchKlipyStickers("x", {
        env: { VITE_KLIPY_API_KEY: "k" },
        signal: controller.signal,
        fetchImpl,
      }),
    ).resolves.toEqual([]);
  });
});

describe("createKlipySearchController", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function klipyItem(slug: string): KlipyItem {
    return {
      kind: "gifs",
      slug,
      title: slug,
      mediaUrl: `https://media.klipy.com/${slug}.gif`,
      previewUrl: `https://media.klipy.com/${slug}.gif`,
      raw: {},
    };
  }

  it("debounces keystrokes into one trailing search", async () => {
    const seenQueries: string[] = [];
    const searchGifs = vi.fn(async (query: string) => {
      seenQueries.push(query);
      return [klipyItem("b")];
    });
    const states: KlipySearchState[] = [];
    const ctl = createKlipySearchController({
      debounceMs: 10,
      searchGifs,
      env: { VITE_KLIPY_API_KEY: "k" },
      onState: (s) => states.push(s),
    });
    ctl.search("a", "gifs");
    ctl.search("ab", "gifs");
    await sleep(40);
    expect(searchGifs).toHaveBeenCalledTimes(1);
    expect(seenQueries).toEqual(["ab"]);
    expect(ctl.getState()).toMatchObject({ status: "ready", query: "ab" });
    expect(states.map((s) => s.status)).toContain("loading");
    ctl.dispose();
  });

  it("keeps the latest request's results when responses race (latest-wins)", async () => {
    let resolveFirst!: (items: KlipyItem[]) => void;
    let resolveSecond!: (items: KlipyItem[]) => void;
    const searchGifs = vi
      .fn()
      .mockImplementationOnce(() => new Promise<KlipyItem[]>((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise<KlipyItem[]>((r) => { resolveSecond = r; }));
    const ctl = createKlipySearchController({
      debounceMs: 0,
      searchGifs,
      env: { VITE_KLIPY_API_KEY: "k" },
    });
    ctl.search("aaa", "gifs");
    await sleep(5);
    ctl.search("aab", "gifs");
    await sleep(5);
    expect(searchGifs).toHaveBeenCalledTimes(2);
    // The stale first response resolves first — and must be discarded.
    resolveFirst([klipyItem("stale")]);
    await sleep(5);
    expect(ctl.getState().status).toBe("loading");
    resolveSecond([klipyItem("fresh")]);
    await sleep(5);
    expect(ctl.getState()).toMatchObject({ status: "ready", query: "aab" });
    expect(ctl.getState().items.map((i) => i.slug)).toEqual(["fresh"]);
    ctl.dispose();
  });

  it("cancels a pending search so no request fires (picker closed)", async () => {
    const searchGifs = vi.fn(async () => []);
    const ctl = createKlipySearchController({
      debounceMs: 20,
      searchGifs,
      env: { VITE_KLIPY_API_KEY: "k" },
    });
    ctl.search("a", "gifs");
    ctl.cancel();
    await sleep(40);
    expect(searchGifs).not.toHaveBeenCalled();
    ctl.dispose();
  });

  it("aborts the in-flight fetch when superseded", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      await sleep(30);
      return { ok: true, json: async () => ({ data: { content_items: [] } }) } as Response;
    }) as typeof fetch;
    const ctl = createKlipySearchController({
      debounceMs: 0,
      env: { VITE_KLIPY_API_KEY: "k" },
      fetchImpl,
    });
    ctl.search("aaa", "gifs");
    await sleep(5);
    ctl.search("aab", "gifs");
    await sleep(60);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0]?.aborted).toBe(true);
    ctl.dispose();
  });

  it("surfaces a retryable error when the search rejects", async () => {
    const searchGifs = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([klipyItem("ok")]);
    const ctl = createKlipySearchController({
      debounceMs: 0,
      searchGifs,
      env: { VITE_KLIPY_API_KEY: "k" },
    });
    ctl.search("a", "gifs");
    await sleep(10);
    expect(ctl.getState().status).toBe("error");
    expect(ctl.getState().error).toMatch(/couldn't load/i);
    ctl.search("a", "gifs");
    await sleep(10);
    expect(ctl.getState().status).toBe("ready");
    expect(ctl.getState().items.map((i) => i.slug)).toEqual(["ok"]);
    ctl.dispose();
  });

  it("paginates trending with more() appended (no-op unless ready)", async () => {
    const seenPages: unknown[] = [];
    const searchGifs = vi.fn(async (query: string, opts?: { page?: number }) => {
      seenPages.push(opts?.page);
      return [klipyItem(`${query}-p${opts?.page ?? 1}`)];
    });
    const ctl = createKlipySearchController({
      debounceMs: 0,
      searchGifs,
      env: { VITE_KLIPY_API_KEY: "k" },
    });
    // more() before any search is a silent no-op.
    ctl.more();
    expect(searchGifs).not.toHaveBeenCalled();
    ctl.search("", "gifs");
    await sleep(10);
    expect(seenPages[0]).toBe(1);
    ctl.more();
    await sleep(10);
    expect(seenPages[1]).toBe(2);
    expect(ctl.getState().items.map((i) => i.slug)).toEqual(["-p1", "-p2"]);
    expect(ctl.getState().page).toBe(2);
    ctl.dispose();
  });
});
