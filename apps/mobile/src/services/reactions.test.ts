import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REACTION_KIND,
  REACTION_EMOJI,
  REACTION_KINDS,
  isReactionKind,
  nextReactionForTap,
  normalizeReactionKind,
  reactionCountsFromJson,
  reactionEmoji,
  reactionEmojiForWire,
  reactionSummaryFromCounts,
  reactionSummaryFromRow,
  reactionToggleDeltas,
  setCommentReaction,
  setPostReaction,
  summarizeReactions,
  topKinds,
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
      expect(reactionEmoji(meta.kind)).toBe(REACTION_EMOJI[meta.kind]);
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

describe("nextReactionForTap", () => {
  it("defaults to Love from no reaction", () => {
    expect(DEFAULT_REACTION_KIND).toBe("LOVE");
    expect(nextReactionForTap(null)).toBe("LOVE");
  });

  it("tapping the same kind clears it", () => {
    expect(nextReactionForTap("LOVE", "LOVE")).toBeNull();
    expect(nextReactionForTap("HELPFUL", "HELPFUL")).toBeNull();
  });

  it("treats legacy LIKE as the same kind as LOVE", () => {
    expect(nextReactionForTap("LIKE", "LOVE")).toBeNull();
  });

  it("switches to the tapped kind", () => {
    expect(nextReactionForTap("LOVE", "WOW")).toBe("WOW");
    expect(nextReactionForTap("DISLIKE", "LOVE")).toBe("LOVE");
  });
});

describe("reactionToggleDeltas", () => {
  it("adds on a fresh reaction", () => {
    expect(reactionToggleDeltas(null, "LOVE")).toEqual({ LOVE: 1 });
  });

  it("removes on unreact", () => {
    expect(reactionToggleDeltas("LOVE", null)).toEqual({ LOVE: -1 });
  });

  it("moves one reaction across kinds", () => {
    expect(reactionToggleDeltas("DISLIKE", "HELPFUL")).toEqual({ DISLIKE: -1, HELPFUL: 1 });
  });

  it("is a no-op between legacy LIKE and LOVE", () => {
    expect(reactionToggleDeltas("LIKE", "LOVE")).toEqual({});
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

describe("topKinds (the one top-kinds helper)", () => {
  it("orders best-first with canonical-order ties and honors n", () => {
    expect(topKinds({ LOVE: 1, WOW: 4, HELPFUL: 2 })).toEqual(["WOW", "HELPFUL", "LOVE"]);
    expect(topKinds({ WOW: 2, LOVE: 2 })).toEqual(["LOVE", "WOW"]);
    expect(topKinds({ LOVE: 4, HELPFUL: 3, SUPPORT: 2, WOW: 1 }, 2)).toEqual(["LOVE", "HELPFUL"]);
    expect(topKinds({})).toEqual([]);
    expect(topKinds({ LOVE: 1 }, 0)).toEqual([]);
  });
});

describe("setPostReaction", () => {
  it("calls the widened react RPC and maps the summary", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [
        {
          post_id: "p1",
          like_count: 2,
          dislike_count: 0,
          my_reaction: "LOVE",
          reaction_counts: { LOVE: 2, WOW: 1 },
        },
      ],
      error: null,
    });

    const summary = await setPostReaction("p1", "LOVE");

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: "LOVE",
    });
    expect(summary).toEqual({ counts: { LOVE: 2, WOW: 1 }, myReaction: "LOVE", total: 3 });
  });

  it("clears the reaction with null", async () => {
    clientMock.rpc.mockResolvedValue({
      data: [{ post_id: "p1", like_count: 0, dislike_count: 0, my_reaction: null, reaction_counts: {} }],
      error: null,
    });

    const summary = await setPostReaction("p1", null);

    expect(clientMock.rpc).toHaveBeenCalledWith("findback_react_client", {
      p_post_id: "p1",
      p_type: null,
    });
    expect(summary.myReaction).toBeNull();
  });

  it("rejects an unknown kind before calling the RPC", async () => {
    await expect(setPostReaction("p1", "BOGUS" as never)).rejects.toMatchObject({ status: 400 });
    expect(clientMock.rpc).not.toHaveBeenCalled();
  });
});

describe("setCommentReaction", () => {
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
