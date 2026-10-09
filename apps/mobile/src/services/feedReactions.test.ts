import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_REACTION_BATCH_LIMIT,
  applyReactionDeltas,
  fetchFeedReactionState,
  legacyCountDeltas,
  loveToggleDeltas,
  nextLoveReaction,
  seedSummaryFromItem,
  toggleLoveReaction,
  togglePostReactionKind,
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

describe("nextLoveReaction (Love = LIKE, Unlove = null, no LOVE kind)", () => {
  it("maps no reaction to LIKE (Love)", () => {
    expect(nextLoveReaction(null)).toBe("LIKE");
  });

  it("maps LIKE to null (Unlove)", () => {
    expect(nextLoveReaction("LIKE")).toBeNull();
  });

  it("switches DISLIKE to LIKE (Love wins)", () => {
    expect(nextLoveReaction("DISLIKE")).toBe("LIKE");
  });

  it("never produces a LOVE or DISLIKE reaction from the Love toggle", () => {
    for (const current of [null, "LIKE", "DISLIKE"] as const) {
      const next = nextLoveReaction(current);
      expect(next).not.toBe("LOVE");
      expect(next).not.toBe("DISLIKE");
      expect(next === "LIKE" || next === null).toBe(true);
    }
  });
});

describe("loveToggleDeltas (optimistic count math)", () => {
  it("loving from null adds one like", () => {
    expect(loveToggleDeltas(null)).toEqual({ like: 1, dislike: 0 });
  });

  it("unloving from LIKE removes one like", () => {
    expect(loveToggleDeltas("LIKE")).toEqual({ like: -1, dislike: 0 });
  });

  it("switching from DISLIKE moves one vote across", () => {
    expect(loveToggleDeltas("DISLIKE")).toEqual({ like: 1, dislike: -1 });
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

describe("toggleLoveReaction", () => {
  it("loves from null via LIKE", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 5, dislikeCount: 0, myReaction: "LIKE" });

    const res = await toggleLoveReaction("p1", null);

    expect(reactToPostMock).toHaveBeenCalledWith("p1", "LIKE");
    expect(res.myReaction).toBe("LIKE");
  });

  it("unloves from LIKE via null", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 4, dislikeCount: 0, myReaction: null });

    await toggleLoveReaction("p1", "LIKE");

    expect(reactToPostMock).toHaveBeenCalledWith("p1", null);
  });

  it("switches from DISLIKE via LIKE", async () => {
    reactToPostMock.mockResolvedValue({ postId: "p1", likeCount: 4, dislikeCount: 0, myReaction: "LIKE" });

    await toggleLoveReaction("p1", "DISLIKE");

    expect(reactToPostMock).toHaveBeenCalledWith("p1", "LIKE");
  });
});

describe("kind-aware Love toggle (W3.3 additive)", () => {
  it("treats canonical LOVE as loved for the default tap", () => {
    expect(nextLoveReaction("LOVE")).toBeNull();
  });

  it("switches a non-Love kind to LIKE on default tap", () => {
    expect(nextLoveReaction("HELPFUL")).toBe("LIKE");
    expect(nextLoveReaction("SUPPORT")).toBe("LIKE");
    expect(nextLoveReaction("WOW")).toBe("LIKE");
  });

  it("decrements one like when unloving from canonical LOVE", () => {
    expect(loveToggleDeltas("LOVE")).toEqual({ like: -1, dislike: 0 });
  });

  it("adds one like when switching from a non-Love kind", () => {
    expect(loveToggleDeltas("HELPFUL")).toEqual({ like: 1, dislike: 0 });
  });
});

describe("togglePostReactionKind (tray write path, real RPC)", () => {
  it("sets the tapped kind through findback_react_client (never faked over LIKE)", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ my_reaction: "HELPFUL", reaction_counts: { LOVE: 2, HELPFUL: 1 } }],
      error: null,
    });

    const summary = await togglePostReactionKind("p1", null, "HELPFUL");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "HELPFUL",
    });
    expect(summary).toEqual({ counts: { LOVE: 2, HELPFUL: 1 }, myReaction: "HELPFUL", total: 3 });
  });

  it("clears the reaction when tapping the active kind (unreact)", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ my_reaction: null, reaction_counts: {} }],
      error: null,
    });

    await togglePostReactionKind("p1", "HELPFUL", "HELPFUL");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: null,
    });
  });

  it("defaults a bare tap to LOVE", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ my_reaction: "LOVE", reaction_counts: { LOVE: 1 } }],
      error: null,
    });

    await togglePostReactionKind("p1", null);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LOVE",
    });
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

describe("applyReactionDeltas (optimistic per-kind counts)", () => {  it("applies the current→next move over existing counts", () => {
    expect(applyReactionDeltas({ LOVE: 2 }, "LIKE", null)).toEqual({ LOVE: 1 });
    expect(applyReactionDeltas({}, null, "HELPFUL")).toEqual({ HELPFUL: 1 });
    expect(applyReactionDeltas({ HELPFUL: 1, LOVE: 2 }, "HELPFUL", "WOW")).toEqual({
      LOVE: 2,
      WOW: 1,
    });
  });

  it("drops buckets that reach zero", () => {
    expect(applyReactionDeltas({ WOW: 1 }, "WOW", null)).toEqual({});
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
