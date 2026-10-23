/** Node >=22 --experimental-strip-types; executes the actual TS ranker, no build/model/network. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import { rankMatches, rankingMetrics, averageRankingMetrics, MIN_COSINE_CUTOFF, CATEGORY_BONUS, MATCH_RESULT_LIMIT } from "../../apps/mobile/src/services/similarity.ts";

const source = new URL("./matching-ranking-fixtures.v1.json", import.meta.url);
const fixture = JSON.parse(readFileSync(source, "utf8"));
// The vitest suite imports a vendored copy (Docker build context excludes
// tools/), so fail loudly on drift between the canonical fixture and the copy.
const vendored = new URL("../../apps/mobile/src/services/__tests__/fixtures/matching-ranking-fixtures.v1.json", import.meta.url);
deepStrictEqual(JSON.parse(readFileSync(vendored, "utf8")), fixture, "vendored fixture drifted from tools/bench canonical");
const rows = fixture.cases.map((row) => {
  const target = { ...fixture.target, ...row.target };
  const candidates = row.candidates.map(({ mappedScore: _score, ...c }) => ({ ...fixture.target, ...c }));
  const scores = new Map(row.candidates.map((c) => [c.id, c.mappedScore]));
  const ranked = rankMatches(target, candidates, scores, MIN_COSINE_CUTOFF);
  const rankedIds = ranked.map((m) => m.post.id);
  deepStrictEqual(rankedIds, row.expectedIds, row.id);
  return { id: row.id, relevantIds: row.relevantIds, rankedIds, scores: ranked.map((m) => m.score), metrics: rankingMetrics(rankedIds, row.relevantIds) };
});
const report = {
  benchmark: fixture.version,
  evidenceKind: fixture.evidenceKind,
  fixturePath: "tools/" + fileURLToPath(source).split("/tools/")[1],
  policy: { rawCosineCutoff: MIN_COSINE_CUTOFF, categoryBonus: CATEGORY_BONUS, maxResults: MATCH_RESULT_LIMIT },
  count: rows.length,
  metrics: averageRankingMetrics(rows.map((r) => r.metrics)),
  rows,
};
const out = process.argv[2];
if (!out) throw new Error("usage: node --experimental-strip-types tools/bench/run-matching-regression.mjs <existing-parent/report.json>");
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ count: report.count, ...report.metrics }));
