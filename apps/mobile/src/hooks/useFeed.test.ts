// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFeed } from "./useFeed";

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
    expect(result.current.error).toBe("network down");
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
});