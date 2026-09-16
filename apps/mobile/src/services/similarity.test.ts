import { describe, expect, it } from "vitest";
import { cosineSimilarity, rankMatches } from "./similarity";

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