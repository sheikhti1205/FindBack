/**
 * Node >=22 --experimental-strip-types; executes the actual TS ranker and the
 * actual reason derivation, no build, no model, no network.
 *
 * Usage:
 *   node --experimental-strip-types tools/bench/run-matching-reasons-eval.mjs <report.json>
 *
 * The report it writes is EVIDENCE, not a benchmark: the fixture carries
 * hand-labelled synthetic base scores, so the numbers describe the ranker and
 * the reason derivation over twelve labelled cases — never the quality of the
 * on-device embedding, which this harness does not run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import {
  MIN_COSINE_CUTOFF,
  MATCH_RESULT_LIMIT,
  MATCH_REASON_MIN,
  deriveMatchReasons,
  isReasonSupported,
  rankMatches,
} from "../../apps/mobile/src/services/similarity.ts";
import { evaluateFixture, validateEvaluationFixture } from "../../apps/mobile/src/services/matchingEvaluation.ts";

const source = new URL("./matching-reasons-fixtures.v1.json", import.meta.url);
const fixture = JSON.parse(readFileSync(source, "utf8"));

// The vitest suite imports a vendored copy (the Docker build context excludes
// tools/), so fail loudly on drift between the canonical fixture and the copy.
const vendored = new URL(
  "../../apps/mobile/src/services/__tests__/fixtures/matching-reasons-fixtures.v1.json",
  import.meta.url,
);
deepStrictEqual(
  JSON.parse(readFileSync(vendored, "utf8")),
  fixture,
  "vendored fixture drifted from tools/bench canonical",
);

const errors = validateEvaluationFixture(fixture);
if (errors.length > 0) throw new Error(`invalid fixture: ${errors.join("; ")}`);

const report = evaluateFixture(fixture, {
  rank: (target, candidates, scores) =>
    rankMatches(target, candidates, scores, MIN_COSINE_CUTOFF, MATCH_RESULT_LIMIT),
  deriveReasons: deriveMatchReasons,
  isSupported: isReasonSupported,
  minimumReasons: MATCH_REASON_MIN,
});

report.fixturePath = "tools/" + fileURLToPath(source).split("/tools/")[1];
report.policy = {
  rawCosineCutoff: MIN_COSINE_CUTOFF,
  maxResults: MATCH_RESULT_LIMIT,
  minimumReasons: MATCH_REASON_MIN,
};
// No run timestamp: the same fixture and the same code must produce the same
// report byte for byte, so a committed artifact can be diffed against a fresh
// run. The date the evidence carries is the fixture's own `createdAt`.

const out = process.argv[2];
if (!out) {
  throw new Error(
    "usage: node --experimental-strip-types tools/bench/run-matching-reasons-eval.mjs <report.json>",
  );
}
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

console.log(
  JSON.stringify({
    fixture: report.fixtureVersion,
    cases: report.caseCount,
    fixtureSize: report.fixtureSize,
    createdAt: report.createdAt,
    precisionAt1: report.metrics.precisionAt1,
    precisionAt3: report.metrics.precisionAt3,
    precisionAt5: report.metrics.precisionAt5,
    recallAt1: report.metrics.recallAt1,
    recallAt3: report.metrics.recallAt3,
    recallAt5: report.metrics.recallAt5,
    mrr: report.metrics.reciprocalRank,
    reasonSupportRate: report.reasonSupport.supportRate,
    reasonsEmitted: report.reasonSupport.reasonsEmitted,
    matchesBelowReasonMinimum: report.reasonSupport.matchesBelowReasonMinimum,
    reasonLabelAgreement: report.reasonLabels.agreement,
    report: out,
  }),
);
