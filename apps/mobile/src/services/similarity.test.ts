import { describe, expect, it } from "vitest";
import { averageRankingMetrics, CATEGORY_BONUS, cosineSimilarity, MIN_COSINE_CUTOFF, rankMatches, rankingMetrics, type MatchCandidate } from "./similarity";
import fixtures from "../../../../tools/bench/matching-ranking-fixtures.v1.json";

const target = { id: "lost-1", type: "LOST" as const, title: "black umbrella", description: "wooden handle", category: "Clothing" as const, eventDate: "2026-09-10", locationLat: 1.3, locationLng: 103.8, locationLabel: "Test Location" };

function candidate(over: Partial<typeof target> & { id: string }) {
  return { ...target, ...over };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical and 0 for orthogonal vectors and never NaN on a zero vector", () => {
    expect(cosineSimilarity([1, 2], [1, 2])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("frozen default matching policy (synthetic labeled score regression, not device calibration)", () => {
  type FixtureRow = (typeof fixtures.cases)[number];
  function rankFixture(row: { target?: FixtureRow["target"]; candidates: FixtureRow["candidates"][number][] }) {
    const query = { ...fixtures.target, ...row.target } as MatchCandidate;
    const candidates = row.candidates.map((c) => ({ ...fixtures.target, ...c })) as MatchCandidate[];
    return rankMatches(query, candidates, new Map(row.candidates.map((c) => [c.id, c.mappedScore])), MIN_COSINE_CUTOFF);
  }

  it("freezes the conservative raw cutoff and category bonus", () => {
    expect(MIN_COSINE_CUTOFF).toBe(0);
    expect(CATEGORY_BONUS).toBe(0.15);
  });

  it("freezes full-context bonuses and the clamped saturation tie", () => {
    const context = rankFixture(fixtures.cases.find((c) => c.id === "context-can-reorder")!);
    expect(context[0]!.score).toBeCloseTo(0.62 + 0.15 + 0.10 + 0.10, 10);
    expect(context[0]!.reasons).toEqual(["same category", "similar date", "close location"]);
    const saturated = rankFixture(fixtures.cases.find((c) => c.id === "saturation-id-tie-limitation")!);
    expect(saturated.map((m) => m.score)).toEqual([1, 1]);
  });

  it.each(fixtures.cases)("$id: $notes", (row) => {
    expect(rankFixture(row).map((m) => m.post.id)).toEqual(row.expectedIds);
    // Candidate enumeration cannot change tie-breaking or the three-card cap.
    expect(rankFixture({ ...row, candidates: [...row.candidates].reverse() }).map((m) => m.post.id)).toEqual(row.expectedIds);
  });

  it("freezes macro metrics including the known tie and three-card misses", () => {
    const metrics = averageRankingMetrics(fixtures.cases.map((row) =>
      rankingMetrics(rankFixture(row).map((m) => m.post.id), row.relevantIds),
    ));
    expect(metrics.recallAt1).toBeCloseTo(4 / 6, 10);
    expect(metrics.recallAt3).toBeCloseTo(5 / 6, 10);
    expect(metrics.mrr).toBeCloseTo(0.75, 10);
    expect(metrics.ndcgAt3).toBeCloseTo((4 + 1 / Math.log2(3)) / 6, 10);
  });
});

describe("rankMatches", () => {
  const scores = new Map([["a", 0.9], ["b", 0.5], ["c", 0.4], ["d", 0.3]]);

  it("returns at most three and sorts by score with an id tie-break", () => {
    const ranked = rankMatches(target, [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" }), candidate({ id: "d" })], scores);
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b", "c"]);
  });

  it("adds transparent category and proximity bonuses without claiming a probability", () => {
    const ranked = rankMatches(target, [candidate({ id: "x" })], new Map([["x", 0.2]]));
    expect(ranked[0]!.score).toBeGreaterThan(0.2);
    expect(ranked[0]!.score).toBeLessThanOrEqual(1);
    expect(ranked[0]!.reasons.join(" ")).toMatch(/same category/i);
  });

  it("ties break deterministically by postId", () => {
    const ranked = rankMatches(target, [candidate({ id: "b" }), candidate({ id: "a" })], new Map([["a", 0.4], ["b", 0.4]]));
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b"]);
  });

  it("drops candidates below the cosine cutoff", () => {
    const scores = new Map([["a", 0.9], ["b", 0.5], ["c", 0.4]]);
    // cutoff 0.0 raw cosine => mapped 0.5; c (0.4) is dropped.
    const ranked = rankMatches(target, [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" })], scores, 0.0);
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b"]);
  });

  it("keeps all candidates when no cutoff is given", () => {
    const scores = new Map([["a", 0.9], ["b", 0.4]]);
    const ranked = rankMatches(target, [candidate({ id: "a" }), candidate({ id: "b" })], scores);
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b"]);
  });
});
