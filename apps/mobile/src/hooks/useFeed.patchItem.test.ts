// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useFeed } from "./useFeed";
import { buildFeedCacheKey, clearFeedCaches, loadFeedCache } from "./feedCache";

const { fetchFeedMock } = vi.hoisted(() => ({ fetchFeedMock: vi.fn() }));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));

function page(items: Array<{ id: string; likeCount?: number }>, nextCursor: string | null, total: number) {
  return {
    items: items.map((i) => ({ id: i.id, title: i.id, likeCount: i.likeCount ?? 0 })),
    nextCursor,
    total,
  };
}

describe("useFeed.patchItem (optimistic feed-cache patch)", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    clearFeedCaches();
  });

  it("merges a partial patch into one item without refetching or reordering", async () => {
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "a" }, { id: "b" }], null, 2));
    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    fetchFeedMock.mockClear();

    act(() => result.current.patchItem("b", { likeCount: 9 }));

    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(result.current.items[1]).toMatchObject({ likeCount: 9 });
    expect(result.current.items[0]).toMatchObject({ likeCount: 0 });
    expect(result.current.total).toBe(2);
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("supports an updater patch derived from the previous item", async () => {
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "a", likeCount: 4 }], null, 1));
    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() =>
      result.current.patchItem("a", (prev) => ({ likeCount: (prev.likeCount ?? 0) + 1 })),
    );

    expect(result.current.items[0]).toMatchObject({ likeCount: 5 });
  });

  it("ignores patches for posts that are not loaded", async () => {
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "a" }], null, 1));
    const { result } = renderHook(() => useFeed({}));
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.patchItem("zzz", { likeCount: 1 }));

    expect(result.current.items.map((i) => i.id)).toEqual(["a"]);
    expect(result.current.total).toBe(1);
  });

  it("persists the patch into the back-navigation snapshot", async () => {
    fetchFeedMock.mockResolvedValueOnce(page([{ id: "a", likeCount: 4 }], null, 1));
    const scrollRef = { current: { scrollTop: 0 } };
    const { result, unmount } = renderHook(() =>
      useFeed({}, { cacheKey: "test:patch-cache", scrollRef }),
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.patchItem("a", { likeCount: 5 }));
    unmount();

    const key = buildFeedCacheKey("test:patch-cache", {});
    expect(loadFeedCache(key)?.items[0]).toMatchObject({ id: "a", likeCount: 5 });
  });
});
