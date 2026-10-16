import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_REACTION_BATCH_LIMIT,
  fetchFeedReactionState,
  legacyCountDeltas,
  likeBucketDeltas,
  seedSummaryFromItem,
  toggleLikeReaction,
} from "./feedReactions";

const { clientMock, reactToPostMock } = vi.hoisted(() => ({
  clientMock: { rpc: vi.fn() },
  reactToPostMock: vi.fn(),
}));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

vi.mock("./posts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./posts")>();
  return { ...actual, reactToPost: reactToPostMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
  reactToPostMock.mockReset();
});

describe("likeBucketDeltas (legacy like/dislike columns for a Like tap)", () => {
  it("liking from nothing adds one like", () => {
    expect(likeBucketDeltas(null)).toEqual({ like: 1, dislike: 0 });
  });

  it("unliking a raw LIKE removes one like", () => {
    expect(likeBucketDeltas("LIKE")).toEqual({ like: -1, dislike: 0 });
  });

  it("replacing a DISLIKE moves one vote across", () => {
    expect(likeBucketDeltas("DISLIKE")).toEqual({ like: 1, dislike: -1 });
  });

  it("touches no legacy bucket when the caller's row is a canonical-era kind", () => {
    for (const kind of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(likeBucketDeltas(kind)).toEqual({ like: 0, dislike: 0 });
    }
  });
});

describe("fetchFeedReactionState (batch hydration)", () => {
  it("hydrates N cards with a single RPC call", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        { post_id: "p1", my_reaction: "LIKE", my_rating: null },
        { post_id: "p2", my_reaction: null, my_rating: 4 },
        { post_id: "p3", my_reaction: "DISLIKE", my_rating: null },
      ],
      error: null,
    });

    const state = await fetchFeedReactionState(["p1", "p2", "p3"]);

    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_feed_reaction_state_client", {
      p_post_ids: ["p1", "p2", "p3"],
    });
    expect(state).toEqual({
      p1: { myReaction: "LIKE", myRating: null },
      p2: { myReaction: null, myRating: 4 },
      p3: { myReaction: "DISLIKE", myRating: null },
    });
  });

  it("never calls the per-card social-state RPC", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await fetchFeedReactionState(["p1", "p2"]);

    expect(clientMock.rpc).not.toHaveBeenCalledWith(
      "findback_post_social_state_client",
      expect.anything(),
    );
  });

  it("fills nulls for ids the RPC returns no row for", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ post_id: "p1", my_reaction: "LIKE", my_rating: null }],
      error: null,
    });

    const state = await fetchFeedReactionState(["p1", "p9"]);

    expect(state["p9"]).toEqual({ myReaction: null, myRating: null });
  });

  it("chunks ids at the 20-id RPC limit", async () => {
    expect(FEED_REACTION_BATCH_LIMIT).toBe(20);
    clientMock.rpc.mockResolvedValue({ data: [], error: null });
    const ids = Array.from({ length: 25 }, (_, i) => `p${i}`);

    await fetchFeedReactionState(ids);

    expect(clientMock.rpc).toHaveBeenCalledTimes(2);
    expect(clientMock.rpc).toHaveBeenNthCalledWith(1, "findback_feed_reaction_state_client", {
      p_post_ids: ids.slice(0, 20),
    });
    expect(clientMock.rpc).toHaveBeenNthCalledWith(2, "findback_feed_reaction_state_client", {
      p_post_ids: ids.slice(20),
    });
  });

  it("dedupes ids so one card never costs an extra slot", async () => {
    clientMock.rpc.mockResolvedValue({ data: [], error: null });

    await fetchFeedReactionState(["p1", "p1", "p2"]);

    expect(clientMock.rpc).toHaveBeenCalledTimes(1);
    expect(clientMock.rpc).toHaveBeenCalledWith("findback_feed_reaction_state_client", {
      p_post_ids: ["p1", "p2"],
    });
  });

  it("makes no RPC call for an empty id list", async () => {
    await expect(fetchFeedReactionState([])).resolves.toEqual({});
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("propagates RPC errors to the caller", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "400" } });

    await expect(fetchFeedReactionState(["p1"])).rejects.toThrow("boom");
  });
});

describe("toggleLikeReaction (Like-only wire: LIKE / null)", () => {
  it("likes from no reaction via LIKE", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 5, dislikeCount: 0, myReaction: "LIKE" });

    const res = await toggleLikeReaction("p1", null);

    expect(reactToPostMock).toHaveBeenCalledWith("p1", "LIKE");
    expect(res.myReaction).toBe("LIKE");
  });

  it("unlikes from LIKE via null", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 4, dislikeCount: 0, myReaction: null });

    await toggleLikeReaction("p1", "LIKE");

    expect(reactToPostMock).toHaveBeenCalledWith("p1", null);
  });

  it("replaces a legacy DISLIKE via LIKE", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 4, dislikeCount: 0, myReaction: "LIKE" });

    await toggleLikeReaction("p1", "DISLIKE");

    expect(reactToPostMock).toHaveBeenCalledWith("p1", "LIKE");
  });
});

describe("Like-only toggle over canonical-era rows (packet 08 §2)", () => {
  it("treats any positive reaction as mine, so a tap clears it", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 4, dislikeCount: 0, myReaction: null });

    for (const current of ["LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      await toggleLikeReaction("p1", current);
    }

    for (const call of reactToPostMock.mock.calls) {
      expect(call).toEqual(["p1", null]);
    }
  });

  it("never writes a canonical kind from the Like control", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 1, dislikeCount: 0, myReaction: "LIKE" });

    await toggleLikeReaction("p1", null);
    // Exact wire arg, not a disjunction: no row → a Like.
    expect(reactToPostMock).toHaveBeenLastCalledWith("p1", "LIKE");

    await toggleLikeReaction("p1", "HELPFUL");
    // A canonical-era row is cleared with null, never rewritten as a kind.
    expect(reactToPostMock).toHaveBeenLastCalledWith("p1", null);
  });
});

describe("legacyCountDeltas (legacy buckets for a kind move)", () => {
  it("moves the like bucket only for raw LIKE moves", () => {
    expect(legacyCountDeltas(null, "LIKE")).toEqual({ like: 1, dislike: 0 });
    expect(legacyCountDeltas("LIKE", null)).toEqual({ like: -1, dislike: 0 });
    expect(legacyCountDeltas("LIKE", "HELPFUL")).toEqual({ like: -1, dislike: 0 });
    expect(legacyCountDeltas("HELPFUL", "LIKE")).toEqual({ like: 1, dislike: 0 });
  });

  it("leaves legacy buckets alone for canonical-only moves", () => {
    expect(legacyCountDeltas(null, "HELPFUL")).toEqual({ like: 0, dislike: 0 });
    expect(legacyCountDeltas("HELPFUL", "WOW")).toEqual({ like: 0, dislike: 0 });
    expect(legacyCountDeltas("HELPFUL", null)).toEqual({ like: 0, dislike: 0 });
  });

  it("moves the dislike bucket only for raw DISLIKE moves", () => {
    expect(legacyCountDeltas("DISLIKE", "LIKE")).toEqual({ like: 1, dislike: -1 });
    expect(legacyCountDeltas(null, "DISLIKE")).toEqual({ like: 0, dislike: 1 });
  });
});

describe("seedSummaryFromItem (batch hydration has no counts)", () => {
  it("seeds LOVE/DISLIKE buckets from the feed item's legacy counts", () => {
    expect(seedSummaryFromItem(4, 1, null)).toEqual({
      counts: { LOVE: 4, DISLIKE: 1 },
      myReaction: null,
      total: 5,
    });
  });

  it("adds one bucket for a canonical own reaction the legacy counts miss", () => {
    expect(seedSummaryFromItem(4, 0, "HELPFUL")).toEqual({
      counts: { LOVE: 4, HELPFUL: 1 },
      myReaction: "HELPFUL",
      total: 5,
    });
  });

  it("adds nothing for a raw LIKE/DISLIKE own reaction (already counted)", () => {
    expect(seedSummaryFromItem(4, 0, "LIKE")).toEqual({
      counts: { LOVE: 4 },
      myReaction: "LIKE",
      total: 4,
    });
  });
});
