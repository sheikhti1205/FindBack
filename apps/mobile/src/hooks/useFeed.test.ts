// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFeed } from "./useFeed";
import { buildFeedCacheKey, clearFeedCaches, feedFilterKey } from "./feedCache";

const { fetchFeedMock } = vi.hoisted(() => ({ fetchFeedMock: vi.fn() }));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));

function page(items: Array<{ id: string }>, nextCursor: string | null, total: number) {
  return {
    items: items.map((i) => ({ id: i.id, title: i.id })),
    nextCursor,
    total,
  };
}

describe("useFeed", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    clearFeedCaches();
  });

  it("ignores a stale response after filters change (generation guard)", async () => {
    let resolveFirst: (p: unknown) => void;
    const first = new Promise((r) => {
      resolveFirst = r;
    });
    fetchFeedMock.mockImplementationOnce(() => first);
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "b1" }], null, 1));

    const { result, rerender } = renderHook(
      ({ q }) => useFeed({ q }),
      { initialProps: { q: "old" } },
    );

    // First request is in flight; filters change to "new".
    rerender({ q: "new" });
    // Resolve the stale first request AFTER the filter change.
    await act(async () => {
      resolveFirst!(page([{ id: "stale" }], null, 1));
      await first;
    });

    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["b1"]));
    expect(result.current.items.map((i) => i.id)).not.toContain("stale");
  });

  it("appends pages and dedupes by cursor", async () => {
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], "cur-1", 4))
      .mockResolvedValueOnce(page([{ id: "c" }, { id: "d" }], null, 4));

    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("keeps loaded items and exposes an error when append fails", async () => {
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }], "cur-1", 2))
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["a"]);
    expect(result.current.error).toContain("Network problem");
  });

  it("refresh replaces items and resets the cursor", async () => {
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }], "cur-1", 2))
      .mockResolvedValueOnce(page([{ id: "z" }], null, 1));

    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["z"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("restores cached items and cursor when cacheKey is provided", async () => {
    fetchFeedMock.mockResolvedValue(page([{ id: "fresh" }], null, 1));

    const { result, unmount } = renderHook(() =>
      useFeed({}, { cacheKey: "test:feed" }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Unmount saves the cache.
    unmount();

    // New mount with same cacheKey restores without a flash.
    fetchFeedMock.mockClear();
    const { result: second } = renderHook(() =>
      useFeed({}, { cacheKey: "test:feed" }),
    );
    expect(second.current.items.map((i) => i.id)).toEqual(["fresh"]);
    expect(second.current.loading).toBe(false);
  });

  it("normalizes filter identity for cache keys (trimmed search)", () => {
    expect(feedFilterKey({ q: "  hello " })).toBe(feedFilterKey({ q: "hello" }));
    expect(buildFeedCacheKey("home:feed", { q: "hello" })).toBe(
      buildFeedCacheKey("home:feed", { q: "  hello " }),
    );
    expect(buildFeedCacheKey("home:feed", { q: "a" })).not.toBe(
      buildFeedCacheKey("home:feed", { q: "b" }),
    );
  });

  it("changing filter starts a new fetch with the new filters", async () => {
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }], null, 1))
      .mockResolvedValueOnce(page([{ id: "b" }], null, 1));
    const { result, rerender } = renderHook(({ q }) => useFeed({ q }, { cacheKey: "test:filter" }), {
      initialProps: { q: "first" },
    });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["a"]));
    expect(fetchFeedMock).toHaveBeenCalledTimes(1);
    rerender({ q: "second" });
    await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["b"]));
    expect(fetchFeedMock).toHaveBeenCalledTimes(2);
    expect(fetchFeedMock).toHaveBeenLastCalledWith(expect.objectContaining({ q: "second" }), undefined);
  });

  it("restores per-filter results without refetch after unmount", async () => {
    fetchFeedMock.mockResolvedValue(page([{ id: "kept" }], "cur-1", 1));
    const { unmount } = renderHook(() => useFeed({ q: "same" }, { cacheKey: "test:restore" }));
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
    unmount();
    fetchFeedMock.mockClear();
    const { result: second } = renderHook(() => useFeed({ q: "same" }, { cacheKey: "test:restore" }));
    expect(second.current.items.map((i) => i.id)).toEqual(["kept"]);
    expect(second.current.loading).toBe(false);
    expect(second.current.hasMore).toBe(true);
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("does not let a stale response overwrite a restored cached filter", async () => {
    // Pre-cache filter B.
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "b-cached" }], null, 1));
    const seeded = renderHook(() => useFeed({ q: "B" }, { cacheKey: "test:race" }));
    await waitFor(() => expect(seeded.result.current.items).toHaveLength(1));
    seeded.unmount();

    // Filter A request is in flight.
    let resolveA: (p: unknown) => void;
    const inflightA = new Promise((r) => {
      resolveA = r;
    });
    fetchFeedMock.mockReset();
    fetchFeedMock.mockImplementationOnce(() => inflightA);

    const { result, rerender } = renderHook(
      ({ q }) => useFeed({ q }, { cacheKey: "test:race" }),
      { initialProps: { q: "A" } },
    );
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));

    // Switch to B while A is still in flight — B is served from cache.
    rerender({ q: "B" });
    expect(result.current.items.map((i) => i.id)).toEqual(["b-cached"]);

    // The late A response must be discarded.
    await act(async () => {
      resolveA!(page([{ id: "a-stale" }], null, 1));
      await inflightA;
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["b-cached"]);
  });

  it("preserves the initial full total across keyset appends (WP7)", async () => {
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], "cur-1", 25))
      .mockResolvedValueOnce(page([{ id: "c" }, { id: "d" }], "cur-2", 20))
      .mockResolvedValueOnce(page([{ id: "e" }, { id: "f" }], null, 15));

    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.total).toBe(25);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.current.total).toBe(25);

    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(result.current.total).toBe(25);
  });

  it("does not re-run scroll restoration when paginating", async () => {
    const scrollEl = { scrollTop: 0 };
    const scrollRef = { current: scrollEl };
    fetchFeedMock
      .mockResolvedValueOnce(page([{ id: "a" }], "cur-1", 2))
      .mockResolvedValueOnce(page([{ id: "b" }], null, 2));

    const { result } = renderHook(() =>
      useFeed({}, { cacheKey: "test:scroll", scrollRef }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    scrollEl.scrollTop = 500;
    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items).toHaveLength(2);
    expect(scrollEl.scrollTop).toBe(500);
  });

  it("restores cached items + scrollTop on back-nav without refetching (WP8)", async () => {
    const firstScroll = { scrollTop: 0 };
    const firstRef = { current: firstScroll };
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], "cur-1", 2));
    const { unmount } = renderHook(() => useFeed({}, { cacheKey: "test:backnav", scrollRef: firstRef }));
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));

    // User scrolled, then opened a post (unmount saves scrollTop).
    firstScroll.scrollTop = 350;
    unmount();

    fetchFeedMock.mockClear();
    const secondScroll = { scrollTop: 0 };
    const { result: second } = renderHook(() =>
      useFeed({}, { cacheKey: "test:backnav", scrollRef: { current: secondScroll } }),
    );
    expect(second.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(second.current.loading).toBe(false);
    expect(second.current.hasMore).toBe(true);
    await waitFor(() => expect(secondScroll.scrollTop).toBe(350));
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("refetches when the session cache is stale (WP8)", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      const scrollRef = { current: { scrollTop: 0 } };
      fetchFeedMock.mockResolvedValueOnce(page([{ id: "old" }], null, 1));
      const { unmount } = renderHook(() => useFeed({}, { cacheKey: "test:stale", scrollRef }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
      unmount();

      // 6 minutes later the cache is stale and must refetch.
      nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000);
      fetchFeedMock.mockClear();
      fetchFeedMock.mockResolvedValueOnce(page([{ id: "new" }], null, 1));
      const { result } = renderHook(() => useFeed({}, { cacheKey: "test:stale", scrollRef }));
      await waitFor(() => expect(result.current.items.map((i) => i.id)).toEqual(["new"]));
      expect(fetchFeedMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});