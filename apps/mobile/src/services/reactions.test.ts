import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REACTION_EMOJI,
  REACTION_KINDS,
  applyCountDeltas,
  isReactionKind,
  likeMine,
  likeState,
  likeToggleDeltas,
  nextLikeReaction,
  normalizeReactionKind,
  reactionCountsFromJson,
  reactionEmojiForWire,
  reactionKindLabel,
  reactionMoveDeltas,
  reactionSummaryFromCounts,
  reactionSummaryFromRow,
  setCommentReaction,
  summarizeReactions,
} from "./reactions";

const { clientMock } = vi.hoisted(() => ({ clientMock: { rpc: vi.fn() } }));

vi.mock("./supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supabaseClient")>();
  return { ...actual, getSupabase: () => clientMock };
});

beforeEach(() => {
  clientMock.rpc.mockReset();
});

describe("REACTION_KINDS metadata", () => {
  it("lists the four canonical kinds in tray order", () => {
    expect(REACTION_KINDS.map((k) => k.kind)).toEqual(["LOVE", "HELPFUL", "SUPPORT", "WOW"]);
    for (const meta of REACTION_KINDS) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.glyph).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it("maps every kind to its canonical system emoji (the one presentation map)", () => {
    expect(REACTION_EMOJI).toEqual({
      LOVE: "❤️",
      HELPFUL: "💡",
      SUPPORT: "🤝",
      WOW: "😮",
    });
    for (const meta of REACTION_KINDS) {
      expect(meta.emoji).toBe(REACTION_EMOJI[meta.kind]);
    }
    // Accessible names stay human-readable next to the emoji.
    expect(REACTION_KINDS.map((k) => k.label)).toEqual(["Love", "Helpful", "Support", "Wow"]);
  });

  it("resolves wire kinds (legacy LIKE included) to the canonical emoji", () => {
    expect(reactionEmojiForWire("LOVE")).toBe("❤️");
    expect(reactionEmojiForWire("LIKE")).toBe("❤️");
    expect(reactionEmojiForWire("HELPFUL")).toBe("💡");
    expect(reactionEmojiForWire("SUPPORT")).toBe("🤝");
    expect(reactionEmojiForWire("WOW")).toBe("😮");
    expect(reactionEmojiForWire("DISLIKE")).toBeNull();
    expect(reactionEmojiForWire("BOGUS" as never)).toBeNull();
    expect(reactionEmojiForWire(null)).toBeNull();
  });
});

describe("normalizeReactionKind", () => {
  it("maps legacy LIKE to LOVE and leaves every other kind unchanged", () => {
    expect(normalizeReactionKind("LIKE")).toBe("LOVE");
    expect(normalizeReactionKind("LOVE")).toBe("LOVE");
    expect(normalizeReactionKind("DISLIKE")).toBe("DISLIKE");
    expect(normalizeReactionKind("HELPFUL")).toBe("HELPFUL");
    expect(normalizeReactionKind("SUPPORT")).toBe("SUPPORT");
    expect(normalizeReactionKind("WOW")).toBe("WOW");
  });
});

describe("isReactionKind", () => {
  it("accepts canonical and legacy kinds only", () => {
    expect(isReactionKind("LOVE")).toBe(true);
    expect(isReactionKind("LIKE")).toBe(true);
    expect(isReactionKind("BOGUS")).toBe(false);
    expect(isReactionKind(null)).toBe(false);
  });
});

describe("Like model (packet 08 §2 — reactions are Like-only)", () => {
  it("counts every positive kind and never a DISLIKE", () => {
    const summary = reactionSummaryFromCounts(
      { LOVE: 2, HELPFUL: 1, SUPPORT: 0, WOW: 3, DISLIKE: 4 },
      null,
    );
    expect(likeState(summary)).toEqual({ count: 6, mine: false });
  });

  it("treats any positive own reaction as mine (legacy LIKE included) and DISLIKE as not mine", () => {
    expect(likeMine(null)).toBe(false);
    expect(likeMine("DISLIKE")).toBe(false);
    for (const kind of ["LIKE", "LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(likeMine(kind)).toBe(true);
    }
  });

  it("writes LIKE or null only, whatever the caller already holds", () => {
    expect(nextLikeReaction(null)).toBe("LIKE");
    expect(nextLikeReaction("DISLIKE")).toBe("LIKE");
    for (const kind of ["LIKE", "LOVE", "HELPFUL", "SUPPORT", "WOW"] as const) {
      expect(nextLikeReaction(kind)).toBeNull();
    }
  });

  it("moves the Like count by exactly one on like → unlike", () => {
    const empty = reactionSummaryFromCounts({}, null);
    const likedCounts = applyCountDeltas(empty.counts, likeToggleDeltas(null));
    expect(likeState({ counts: likedCounts, myReaction: "LIKE", total: 1 })).toEqual({
      count: 1,
      mine: true,
    });
    const unlikedCounts = applyCountDeltas(likedCounts, likeToggleDeltas("LIKE"));
    expect(likeState({ counts: unlikedCounts, myReaction: null, total: 0 })).toEqual({
      count: 0,
      mine: false,
    });
  });

  it("clears a multi-kind-era positive row the caller owns", () => {
    const counts = { LOVE: 2, HELPFUL: 1 };
    const deltas = likeToggleDeltas("HELPFUL");
    expect(deltas).toEqual({ HELPFUL: -1 });
    expect(
      likeState({ counts: applyCountDeltas(counts, deltas), myReaction: null, total: 2 }),
    ).toEqual({ count: 2, mine: false });
  });

  it("replaces a legacy DISLIKE with a Like (one row per caller per target)", () => {
    const counts = { LOVE: 2, DISLIKE: 1 };
    const deltas = likeToggleDeltas("DISLIKE");
    expect(deltas).toEqual({ LOVE: 1, DISLIKE: -1 });
    expect(
      likeState({ counts: applyCountDeltas(counts, deltas), myReaction: "LIKE", total: 3 }),
    ).toEqual({ count: 3, mine: true });
  });
});

describe("reactionMoveDeltas / applyCountDeltas", () => {
  it("moves one reaction across kinds", () => {
    expect(reactionMoveDeltas("DISLIKE", "HELPFUL")).toEqual({ DISLIKE: -1, HELPFUL: 1 });
  });

  it("is a no-op between legacy LIKE and canonical LOVE", () => {
    expect(reactionMoveDeltas("LIKE", "LOVE")).toEqual({});
  });

  it("applies deltas immutably and drops buckets that reach zero", () => {
    const counts = { LOVE: 1, WOW: 2 };
    expect(applyCountDeltas(counts, { LOVE: -1, HELPFUL: 3 })).toEqual({ HELPFUL: 3, WOW: 2 });
    expect(counts).toEqual({ LOVE: 1, WOW: 2 });
  });

  it("ignores non-integer values and unknown keys", () => {
    expect(
      applyCountDeltas({ LOVE: 1 }, { LOVE: Number.NaN, BOGUS: 5 } as never),
    ).toEqual({ LOVE: 1 });
    expect(applyCountDeltas({ LOVE: 1 }, { LOVE: 1 })).toEqual({ LOVE: 2 });
  });
});

describe("reactionKindLabel (legacy row copy)", () => {
  it("labels canonical kinds, folds legacy LIKE, and stays null for anything else", () => {
    expect(reactionKindLabel("LOVE")).toBe("Love");
    expect(reactionKindLabel("LIKE")).toBe("Love");
    expect(reactionKindLabel("HELPFUL")).toBe("Helpful");
    expect(reactionKindLabel("SUPPORT")).toBe("Support");
    expect(reactionKindLabel("WOW")).toBe("Wow");
    expect(reactionKindLabel("DISLIKE")).toBeNull();
    expect(reactionKindLabel(null)).toBeNull();
    expect(reactionKindLabel("BOGUS" as never)).toBeNull();
  });
});

describe("summarizeReactions", () => {
  it("aggregates rows, folding LIKE into LOVE and ignoring unknown types", () => {
    const summary = summarizeReactions(
      [
        { type: "LIKE" },
        { type: "LIKE" },
        { type: "LOVE" },
        { type: "DISLIKE" },
        { type: "HELPFUL" },
        { type: "WOW" },
        { type: "BOGUS" },
      ],
      "LIKE",
    );
    expect(summary.counts).toEqual({ LOVE: 3, DISLIKE: 1, HELPFUL: 1, WOW: 1 });
    expect(summary.total).toBe(6);
    expect(summary.myReaction).toBe("LOVE");
  });

  it("defaults myReaction to null", () => {
    expect(summarizeReactions([{ type: "WOW" }])).toEqual({
      counts: { WOW: 1 },
      myReaction: null,
      total: 1,
    });
  });
});

describe("reactionCountsFromJson", () => {
  it("coerces numeric-like values and normalizes LIKE", () => {
    expect(reactionCountsFromJson({ LIKE: 2, LOVE: "1", WOW: 3, NOPE: 9, BAD: -1 })).toEqual({
      LOVE: 3,
      WOW: 3,
    });
  });

  it("returns empty for non-objects and arrays", () => {
    expect(reactionCountsFromJson(null)).toEqual({});
    expect(reactionCountsFromJson("x")).toEqual({});
    expect(reactionCountsFromJson([])).toEqual({});
  });
});

describe("reactionSummaryFromRow", () => {
  it("returns undefined when the row has neither reaction column", () => {
    expect(reactionSummaryFromRow({})).toBeUndefined();
  });

  it("builds a normalized summary", () => {
    expect(
      reactionSummaryFromRow({ reaction_counts: { LIKE: 1, WOW: 2 }, my_reaction: "WOW" }),
    ).toEqual({ counts: { LOVE: 1, WOW: 2 }, myReaction: "WOW", total: 3 });
  });

  it("treats an empty counts object plus a null reaction as an empty summary", () => {
    expect(reactionSummaryFromRow({ reaction_counts: {}, my_reaction: null })).toEqual({
      counts: {},
      myReaction: null,
      total: 0,
    });
  });

  it("normalizes a lone my_reaction through the one aggregator (LIKE→LOVE, unknown→null)", () => {
    expect(reactionSummaryFromRow({ my_reaction: "LIKE" })).toEqual({
      counts: {},
      myReaction: "LOVE",
      total: 0,
    });
    expect(reactionSummaryFromRow({ my_reaction: "BOGUS" })).toEqual({
      counts: {},
      myReaction: null,
      total: 0,
    });
  });
});

describe("reactionSummaryFromCounts (the one aggregator)", () => {
  it("totals exactly its counts and normalizes LIKE→LOVE", () => {
    expect(reactionSummaryFromCounts({ LOVE: 2, LIKE: 1, WOW: 0, BOGUS: 5 } as never, "LIKE")).toEqual({
      counts: { LOVE: 3 },
      myReaction: "LOVE",
      total: 3,
    });
  });

  it("agrees with summarizeReactions and reactionSummaryFromRow on the same truth", () => {
    const rows = [{ type: "LIKE" }, { type: "WOW" }, { type: "BOGUS" }];
    expect(summarizeReactions(rows, "WOW")).toEqual(
      reactionSummaryFromCounts({ LOVE: 1, WOW: 1 }, "WOW"),
    );
    expect(reactionSummaryFromRow({ reaction_counts: { LIKE: 1, WOW: 1 }, my_reaction: "WOW" })).toEqual(
      reactionSummaryFromCounts({ LOVE: 1, WOW: 1 }, "WOW"),
    );
  });
});

/**
 * There is no `setPostReaction` any more: a post Like goes through
 * `reactToPost(postId, nextLikeReaction(current))` / `toggleLikeReaction`, so
 * "new writes are LIKE or null only" (packet `08` §2) is structural — no
 * exported writer accepts a canonical kind or DISLIKE.
 */
describe("setCommentReaction", () => {
  it("rejects an unknown kind before calling the RPC", async () => {
    await expect(setCommentReaction("c1", "BOGUS" as never)).rejects.toMatchObject({ status: 400 });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });

  it("calls the comment react RPC and maps commentId + summary", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ comment_id: "c1", my_reaction: "HELPFUL", reaction_counts: { HELPFUL: 1 } }],
      error: null,
    });

    const summary = await setCommentReaction("c1", "HELPFUL");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_comment_client", {
      p_comment_id: "c1",
      p_type: "HELPFUL",
    });
    expect(summary).toEqual({
      commentId: "c1",
      counts: { HELPFUL: 1 },
      myReaction: "HELPFUL",
      total: 1,
    });
  });

  it("propagates an RPC error", async () => {
    clientMock.rpc.mockResolvedValue({ data: null, error: { message: "nope", code: "400" } });
    await expect(setCommentReaction("c1", "LOVE")).rejects.toThrow("nope");
  });
});

describe("reactToPostSchema input widening (W3.3)", () => {
  it("accepts canonical kinds, legacy kinds, and null; rejects unknown kinds", async () => {
    const { reactToPostSchema } = await import("@findback/shared");
    for (const type of ["LIKE", "DISLIKE", "LOVE", "HELPFUL", "SUPPORT", "WOW", null]) {
      expect(() => reactToPostSchema.parse({ type })).not.toThrow();
    }
    expect(() => reactToPostSchema.parse({ type: "BOGUS" })).toThrow();
  });
});
