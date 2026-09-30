import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEED_REACTION_BATCH_LIMIT,
  fetchFeedReactionState,
  loveToggleDeltas,
  nextLoveReaction,
  toggleLoveReaction,
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
