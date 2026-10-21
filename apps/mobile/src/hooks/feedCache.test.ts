import { beforeEach, describe, expect, it } from "vitest";
import type { PostItem } from "@findback/shared";
import {
  clearFeedCaches,
  getNewPostCount,
  incrementNewPostCount,
  invalidateFeedCaches,
  loadFeedCache,
  saveFeedCache,
} from "./feedCache";

const data = { items: [], total: 0, cursor: null, scrollTop: 0 };

describe("feedCache", () => {
  beforeEach(() => clearFeedCaches());

  it("preserves the pending new-post count across a cache save", () => {
    saveFeedCache("k", data);
    incrementNewPostCount("k", 3);
    expect(getNewPostCount("k")).toBe(3);

    // e.g. the unmount persist that runs on Detail→Back must not wipe the pill.
    saveFeedCache("k", data);
    expect(getNewPostCount("k")).toBe(3);
  });

  it("clears the pending count only when explicitly asked", () => {
    saveFeedCache("k", data);
    incrementNewPostCount("k", 2);
    saveFeedCache("k", data, { clearNewPostCount: true });
    expect(getNewPostCount("k")).toBe(0);
  });

  it("loads a valid cache as not dirty", () => {
    saveFeedCache("k", data);
    expect(loadFeedCache("k")?.dirty).toBe(false);
  });

  it("marks every cached feed dirty on a realtime invalidation", () => {
    saveFeedCache("k1", data);
    saveFeedCache("k2", data);
    invalidateFeedCaches();
    expect(loadFeedCache("k1")?.dirty).toBe(true);
    expect(loadFeedCache("k2")?.dirty).toBe(true);
    // A refresh saves fresh data and clears the flag again.
    saveFeedCache("k1", data);
    expect(loadFeedCache("k1")?.dirty).toBe(false);
  });

  // CF-060 R10 / F15: the cache stores live PostItem objects (no serialization
  // and no allowlist), so the O5 bit survives a save/load round-trip — and the
  // reveal state, which is component-local, must never ride along.
  it("keeps the O5 bit on a cached row and persists no reveal state", () => {
    const items = [
      { id: "p1", blockedAuthor: true },
      { id: "p2", blockedAuthor: false },
    ] as PostItem[];
    saveFeedCache("k", { items, total: 2, cursor: null, scrollTop: 0 });

    const entry = loadFeedCache("k")!;
    expect(entry.items[0]!.blockedAuthor).toBe(true);
    expect(entry.items[1]!.blockedAuthor).toBe(false);
    expect("revealed" in entry.items[0]!).toBe(false);
    expect("reveal" in entry.items[0]!).toBe(false);
  });

  it("drops the cached bit with the cache on logout", () => {
    saveFeedCache("k", { items: [{ id: "p1", blockedAuthor: true }] as PostItem[], total: 1, cursor: null, scrollTop: 0 });
    clearFeedCaches();
    expect(loadFeedCache("k")).toBeNull();
  });
});
