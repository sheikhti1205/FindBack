import { describe, expect, it } from "vitest";
import {
  averageRankingMetrics,
  CATEGORY_BONUS,
  cosineSimilarity,
  deriveMatchReasons,
  isReasonSupported,
  MATCH_REASON_MAX,
  MATCH_REASON_MIN,
  MATCH_RESULT_LIMIT,
  MIN_COSINE_CUTOFF,
  rankMatches,
  rankTextMatches,
  rankingMetrics,
  deriveTextMatchReasons,
  matchTextTokens,
  textOverlap,
  TEXT_MATCH_MIN_OVERLAP,
  type MatchCandidate,
  type MatchReason,
} from "./similarity";
import fixtures from "./__tests__/fixtures/matching-ranking-fixtures.v1.json";

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
    expect(context[0]!.reasons).toEqual(["Within 5 km", "Same event date", "Same category"]);
    const saturated = rankFixture(fixtures.cases.find((c) => c.id === "saturation-id-tie-limitation")!);
    expect(saturated.map((m) => m.score)).toEqual([1, 1]);
  });

  it.each(fixtures.cases)("$id: $notes", (row) => {
    expect(rankFixture(row).map((m) => m.post.id)).toEqual(row.expectedIds);
    // Candidate enumeration cannot change tie-breaking or the five-card cap.
    expect(rankFixture({ ...row, candidates: [...row.candidates].reverse() }).map((m) => m.post.id)).toEqual(row.expectedIds);
  });

  it("freezes macro metrics including the known tie and the five-card miss", () => {
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

  it("returns at most five and sorts by score with an id tie-break", () => {
    const ranked = rankMatches(
      target,
      [candidate({ id: "a" }), candidate({ id: "b" }), candidate({ id: "c" }), candidate({ id: "d" }), candidate({ id: "e" })],
      new Map([["a", 0.9], ["b", 0.5], ["c", 0.4], ["d", 0.3], ["e", 0.2]]),
    );
    expect(ranked).toHaveLength(MATCH_RESULT_LIMIT);
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("leaves out the sixth suggestion rather than widening the list", () => {
    const ranked = rankMatches(
      target,
      ["a", "b", "c", "d", "e", "f"].map((id) => candidate({ id })),
      new Map([["a", 0.9], ["b", 0.8], ["c", 0.7], ["d", 0.6], ["e", 0.5], ["f", 0.4]]),
    );
    expect(ranked.map((m) => m.post.id)).toEqual(["a", "b", "c", "d", "e"]);
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

describe("consumer reasons (actual ranking bonuses only)", () => {
  const lost: MatchCandidate = { id: "lost", title: "Umbrella", description: "wood handle", category: "Clothing", eventDate: "2026-09-10", locationLabel: "Library", locationLat: 23.81, locationLng: 90.412, photoUrl: "photo.jpg" };
  const found = { ...lost, id: "found" };
  it("emits three supported bonuses, never text or visual claims", () => {
    expect(deriveMatchReasons(lost, found).map((r) => r.text)).toEqual(["Within 5 km", "Same event date", "Same category"]);
    expect(deriveMatchReasons(lost, found).length).toBeLessThanOrEqual(MATCH_REASON_MAX);
  });
  it("does not pad missing evidence with text, labels or photos", () => {
    const sparse = { ...found, eventDate: null, locationLat: null, locationLng: null };
    expect(deriveMatchReasons(lost, sparse).map((r) => r.text)).toEqual(["Same category"]);
    expect(deriveMatchReasons(lost, { ...sparse, category: "Other" })).toEqual([]);
    expect(deriveMatchReasons(lost, sparse).length).toBeLessThan(MATCH_REASON_MIN);
  });
  it("requires coordinate proximity rather than matching labels", () => {
    expect(deriveMatchReasons(lost, { ...found, locationLat: 23.92 }).find((r) => r.signal === "location")?.text).toBe("Within 20 km");
    expect(deriveMatchReasons(lost, { ...found, locationLat: 24.2 }).some((r) => r.signal === "location")).toBe(false);
  });
  it("uses event dates and rejects missing, invalid or distant dates", () => {
    expect(deriveMatchReasons(lost, { ...found, eventDate: "2026-09-12" }).find((r) => r.signal === "date")?.text).toBe("Events 2 days apart");
    for (const eventDate of [null, "invalid", "2026-10-10"]) expect(deriveMatchReasons(lost, { ...found, eventDate }).some((r) => r.signal === "date")).toBe(false);
  });
  it("supports its output and rejects invented wording or removed evidence", () => {
    for (const reason of deriveMatchReasons(lost, found)) expect(isReasonSupported(reason, lost, found)).toBe(true);
    const invented: MatchReason = { signal: "date", text: "Events 2 days apart" };
    expect(isReasonSupported(invented, lost, found)).toBe(false);
    expect(isReasonSupported({ signal: "location", text: "Within 5 km" }, lost, { ...found, locationLat: null })).toBe(false);
  });
});

describe("text/structured fallback (no embedding model)", () => {
  const lost: MatchCandidate = {
    id: "lost-1",
    title: "Black umbrella",
    description: "Wooden handle, left in the bus",
    category: "Clothing",
    eventDate: "2026-09-10",
    locationLat: 23.81,
    locationLng: 90.41,
    locationLabel: "Dhaka",
  };

  function cand(over: Partial<MatchCandidate> & { id: string }): MatchCandidate {
    return { ...lost, ...over };
  }

  it("normalizes punctuation, case and stopwords before comparing", () => {
    expect(matchTextTokens("The BLACK umbrella, in the bus!")).toEqual(["black", "umbrella", "bus"]);
    // A one-letter token is not a matching signal.
    expect(matchTextTokens("a b umbrella")).toEqual(["umbrella"]);
    expect(matchTextTokens("")).toEqual([]);
  });

  it("scores shared wording symmetrically and ignores unrelated text", () => {
    expect(textOverlap("black umbrella", "black umbrella")).toBeCloseTo(1);
    expect(textOverlap("black umbrella", "red bicycle")).toBe(0);
    expect(textOverlap("black umbrella", "umbrella")).toBeCloseTo(2 * 1 / (2 + 1));
  });

  it("works on Bangla and Banglish descriptions without a language model", () => {
    // Combining vowel signs stay inside the word: "কালো" is one token, not four
    // single letters, or every Bangla description would score zero.
    expect(matchTextTokens("কালো ছাতা")).toEqual(["কালো", "ছাতা"]);
    const bangla = "কালো ছাতা কাঠের হাতল";
    expect(textOverlap(bangla, "কালো ছাতা")).toBeGreaterThan(TEXT_MATCH_MIN_OVERLAP);
    expect(textOverlap(bangla, "লাল সাইকেল")).toBe(0);
    expect(textOverlap("kalo chata kather hathol", "kalo chata")).toBeGreaterThan(TEXT_MATCH_MIN_OVERLAP);
  });

  it("ranks by wording plus the same structured bonuses, and explains itself", () => {
    const results = rankTextMatches(lost, [
      cand({ id: "same-words", title: "Black umbrella", description: "Wooden handle" }),
      cand({ id: "same-category", title: "Blue scarf", description: "Silk", eventDate: "2026-09-10" }),
      cand({ id: "noise", title: "Red bicycle", description: "Chained outside", category: "Other", eventDate: "2026-09-10" }),
    ]);
    expect(results.map((r) => r.post.id)).toEqual(["same-words", "same-category"]);
    expect(results[0]!.reasons).toContain("Similar wording");
    expect(results[0]!.reasons).toContain("Same category");
    // The category+same-day lead has no wording claim.
    expect(results[1]!.reasons).not.toContain("Similar wording");
    expect(results.every((r) => r.score <= 1)).toBe(true);
  });

  it("drops a candidate that shares neither wording nor category-and-day", () => {
    expect(
      rankTextMatches(lost, [cand({ id: "far", title: "Red bicycle", description: "Chained", category: "Other", eventDate: "2026-08-01" })]),
    ).toEqual([]);
  });

  it("never emits a wording reason below the overlap threshold", () => {
    const reasons = deriveTextMatchReasons(lost, cand({ id: "x", title: "Umbrella" }), TEXT_MATCH_MIN_OVERLAP - 0.01);
    expect(reasons.some((r) => r.signal === "text")).toBe(false);
  });
});
