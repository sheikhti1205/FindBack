import { beforeEach, describe, expect, it } from "vitest";
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

  it("preserves the pending new-post count across a cache save (WP7 #9)", () => {
    saveFeedCache("k", data);
    incrementNewPostCount("k", 3);
    expect(getNewPostCount("k")).toBe(3);

    // e.g. the unmount persist that runs on Detail→Back must not wipe the pill.
    saveFeedCache("k", data);
    expect(getNewPostCount("k")).toBe(3);
  });

  it("clears the pending count only when explicitly asked (WP7 #9)", () => {
    saveFeedCache("k", data);
    incrementNewPostCount("k", 2);
    saveFeedCache("k", data, { clearNewPostCount: true });
    expect(getNewPostCount("k")).toBe(0);
  });

  it("loads a valid cache as not dirty (WP7 #8)", () => {
    saveFeedCache("k", data);
    expect(loadFeedCache("k")?.dirty).toBe(false);
  });

  it("marks every cached feed dirty on a realtime invalidation (WP7 #8)", () => {
    saveFeedCache("k1", data);
    saveFeedCache("k2", data);
    invalidateFeedCaches();
    expect(loadFeedCache("k1")?.dirty).toBe(true);
    expect(loadFeedCache("k2")?.dirty).toBe(true);
    // A refresh saves fresh data and clears the flag again.
    saveFeedCache("k1", data);
    expect(loadFeedCache("k1")?.dirty).toBe(false);
  });
});
