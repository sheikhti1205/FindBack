import { describe, expect, it } from "vitest";
import {
  MATCH_REASON_MIN,
  MATCH_RESULT_LIMIT,
  MIN_COSINE_CUTOFF,
  deriveMatchReasons,
  isReasonSupported,
  rankMatches,
} from "./similarity";
import { evaluateFixture, validateEvaluationFixture, type EvaluationFixture } from "./matchingEvaluation";
import fixtureJson from "./__tests__/fixtures/matching-reasons-fixtures.v1.json";

/**
 * The vendored copy of the canonical fixture. The canonical file lives in
 * tools/bench (excluded from the Docker build context); the harness in
 * tools/bench/run-matching-reasons-eval.mjs fails loudly if the two drift.
 */
const fixture = fixtureJson as unknown as EvaluationFixture;

/** The production functions, wired exactly as the offline harness wires them. */
const deps = {
  rank: (target: Parameters<typeof rankMatches>[0], candidates: Parameters<typeof rankMatches>[1], scores: Map<string, number>) =>
    rankMatches(target, candidates, scores, MIN_COSINE_CUTOFF, MATCH_RESULT_LIMIT),
  deriveReasons: deriveMatchReasons,
  isSupported: isReasonSupported,
  minimumReasons: MATCH_REASON_MIN,
};

describe("matching evaluation harness", () => {
  it("accepts the committed fixture and records what it is", () => {
    expect(validateEvaluationFixture(fixture)).toEqual([]);
    expect(fixture.fixtureSize).toBe(fixture.cases.length);
    expect(fixture.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The fixture says out loud that its base scores are synthetic.
    expect(fixture.evidenceKind).toMatch(/SYNTHETIC/);
  });

  it("rejects a fixture whose size, ids or scores do not hold up", () => {
    const broken = {
      ...fixture,
      fixtureSize: fixture.cases.length + 1,
      cases: [
        {
          ...fixture.cases[0]!,
          relevantIds: ["not-a-candidate"],
          candidates: [{ ...fixture.cases[0]!.candidates[0]!, mappedScore: Number.NaN }],
        },
      ],
    };
    const errors = validateEvaluationFixture(broken);
    expect(errors.join(" ")).toMatch(/fixtureSize/);
    expect(errors.join(" ")).toMatch(/mappedScore/);
    expect(errors.join(" ")).toMatch(/names no candidate/);
    expect(() => evaluateFixture(broken, deps)).toThrow(/Invalid evaluation fixture/);
  });

  it("measures the ranker over the labelled cases", () => {
    const report = evaluateFixture(fixture, deps);
    expect(report.caseCount).toBe(12);
    expect(report.labelledCaseCount).toBe(11);
    // The top suggestion is the labelled one in 11 of the 12 cases; the
    // twelfth case deliberately has nothing relevant in the pool.
    expect(report.metrics.precisionAt1).toBeCloseTo(11 / 12, 10);
    expect(report.metrics.recallAt1).toBeCloseTo(10 / 11, 10);
    expect(report.metrics.recallAt3).toBeCloseTo(10.5 / 11, 10);
    expect(report.metrics.reciprocalRank).toBeCloseTo(1, 10);
  });

  it("supports every reason it emits, and says so in the report", () => {
    const report = evaluateFixture(fixture, deps);
    expect(report.reasonSupport.reasonsEmitted).toBeGreaterThan(0);
    expect(report.reasonSupport.supportRate).toBe(1);
    expect(report.reasonSupport.unsupported).toEqual([]);
  });

  it("shows fewer than three reasons where the comparison supports fewer, and never pads", () => {
    const report = evaluateFixture(fixture, deps);
    expect(report.reasonSupport.matchesBelowReasonMinimum).toBeGreaterThan(0);
    // Every match stays inside the cap.
    for (const row of report.rows) {
      for (const count of row.reasonCounts) {
        expect(count).toBeLessThanOrEqual(5);
      }
    }
    // The histogram is what a reader of the artifact sees.
    expect(report.reasonSupport.reasonCountHistogram["0"]).toBe(1);
    expect(report.reasonSupport.reasonCountHistogram["3"]).toBe(14);
    expect(report.reasonSupport.reasonCountHistogram["5"]).toBeUndefined();
  });

  it("agrees with the hand labels on every labelled case", () => {
    const report = evaluateFixture(fixture, deps);
    expect(report.reasonLabels.labelledCases).toBe(11);
    expect(report.reasonLabels.agreement).toBe(1);
    for (const row of report.rows) {
      expect(row.reasonLabels?.missing ?? []).toEqual([]);
    }
  });

  it("makes no quality claim, and says the fixture is too small for one", () => {
    const report = evaluateFixture(fixture, deps);
    expect(report.claim.fixtureTooSmallForAQualityClaim).toBe(true);
    expect(report.claim.statement).toMatch(/No matching-quality claim is made/);
    expect(report.scope.notMeasured.join(" ")).toMatch(/text-embedding quality/);
    expect(report.scope.measured.join(" ")).toMatch(/reason derivation/);
  });

  it("is deterministic: the same fixture produces the same report", () => {
    const first = evaluateFixture(fixture, deps);
    const second = evaluateFixture(fixture, deps);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
