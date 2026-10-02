import { describe, expect, it } from "vitest";
import {
  averageRankingMetrics,
  ndcgAtK,
  rankingMetrics,
  recallAtK,
  reciprocalRank,
} from "./similarity";

describe("ranking metric hooks", () => {
  it("scores a perfect ranking as 1.0 on every metric", () => {
    const ranked = ["a", "b", "c"];
    expect(recallAtK(ranked, ["a"], 1)).toBe(1);
    expect(recallAtK(ranked, ["a"], 3)).toBe(1);
    expect(reciprocalRank(ranked, ["a"])).toBe(1);
    expect(ndcgAtK(ranked, ["a"], 3)).toBe(1);
    expect(rankingMetrics(ranked, ["a"])).toEqual({ recallAt1: 1, recallAt3: 1, mrr: 1, ndcgAt3: 1 });
  });

  it("scores a perfect multi-relevant ranking as 1.0", () => {
    expect(rankingMetrics(["a", "b", "c"], ["a", "b"])).toEqual({
      recallAt1: 0.5,
      recallAt3: 1,
      mrr: 1,
      ndcgAt3: 1,
    });
  });

  it("scores a known imperfect case (relevant second)", () => {
    // ranked [a, b, c], relevant {b}: miss at 1, hit at 3, RR 1/2,
    // nDCG@3 = (1/log2(3)) / 1.
    const ranked = ["a", "b", "c"];
    expect(recallAtK(ranked, ["b"], 1)).toBe(0);
    expect(recallAtK(ranked, ["b"], 3)).toBe(1);
    expect(reciprocalRank(ranked, ["b"])).toBe(0.5);
    expect(ndcgAtK(ranked, ["b"], 3)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it("scores zero when nothing relevant is ranked", () => {
    expect(rankingMetrics(["a", "b"], ["z"])).toEqual({ recallAt1: 0, recallAt3: 0, mrr: 0, ndcgAt3: 0 });
  });

  it("handles degenerate inputs without NaN", () => {
    expect(recallAtK([], [], 3)).toBe(0);
    expect(recallAtK(["a"], [], 3)).toBe(0);
    expect(recallAtK(["a"], ["a"], 0)).toBe(0);
    expect(reciprocalRank([], [])).toBe(0);
    expect(ndcgAtK(["a"], ["a"], 0)).toBe(0);
    expect(ndcgAtK([], [], 3)).toBe(0);
    expect(averageRankingMetrics([])).toEqual({ recallAt1: 0, recallAt3: 0, mrr: 0, ndcgAt3: 0 });
  });

  it("macro-averages per-query metrics equally", () => {
    const avg = averageRankingMetrics([
      rankingMetrics(["a", "b"], ["a"]),
      rankingMetrics(["a", "b"], ["b"]),
    ]);
    expect(avg.recallAt1).toBeCloseTo(0.5);
    expect(avg.recallAt3).toBe(1);
    expect(avg.mrr).toBeCloseTo(0.75);
    expect(avg.ndcgAt3).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 10);
  });
});
