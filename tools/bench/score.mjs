/**
 * WS6 benchmark scorer: pure ranking-metric functions + a small CLI that
 * computes Recall@1/Recall@3, MRR, and nDCG@3 from a results file.
 *
 * Source-of-truth mirrors:
 *   apps/mobile/src/services/similarity.ts  (recallAtK, reciprocalRank, ndcgAtK)
 * Keep the two in sync; the TS module owns the contract, this file owns
 * file-level scoring for bench records.
 *
 * Results file shape:
 *   { "cases": [ { "id": "...", "rankedIds": ["c2","c1"], "relevantIds": ["c1"], "latencyMs"?: 3 } ] }
 * A runBench benchmark record can also be scored directly: it carries
 * `configs.<name>.cases` in the same per-case shape — pass --config <name>.
 *
 * Usage:
 *   node tools/bench/score.mjs --results <results.json> [--k 3]
 *   node tools/bench/score.mjs --record <benchmark-record.json> --config fake
 *
 * No dependencies. No network. No model downloads.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_K = 3;

/** Rank (0-based) of the first ranked id present in `relevant`, or -1. */
function firstRelevantRank(rankedIds, relevant) {
  for (let i = 0; i < rankedIds.length; i++) {
    if (relevant.has(rankedIds[i])) return i;
  }
  return -1;
}

/**
 * Recall@k over binary relevance: fraction of relevant ids appearing in the
 * top-k ranked ids. Returns 0 when k <= 0 or when there are no relevant ids
 * (corpus validation requires non-empty relevantIds; such cases score 0).
 */
export function recallAtK(rankedIds, relevantIds, k) {
  if (k <= 0 || relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  const topK = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (topK.has(id)) hits++;
  }
  return hits / relevant.size;
}

/**
 * Reciprocal rank: 1 / (1 + rank of first relevant), or 0 when no relevant
 * id is ranked. Returns 0 when there are no relevant ids.
 */
export function reciprocalRank(rankedIds, relevantIds) {
  if (relevantIds.length === 0) return 0;
  const rank = firstRelevantRank(rankedIds, new Set(relevantIds));
  return rank < 0 ? 0 : 1 / (rank + 1);
}

/**
 * nDCG@k over binary relevance. DCG sums rel_i / log2(i + 2); IDCG is the
 * ideal DCG of min(|relevant|, k) ones up front. Returns 0 when k <= 0 or
 * when there are no relevant ids; 1.0 for a perfect top-k ranking.
 */
export function ndcgAtK(rankedIds, relevantIds, k) {
  if (k <= 0 || relevantIds.length === 0) return 0;
  const relevant = new Set(relevantIds);
  let dcg = 0;
  const depth = Math.min(k, rankedIds.length);
  for (let i = 0; i < depth; i++) {
    if (relevant.has(rankedIds[i])) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Per-case WS6 metrics: Recall@1, Recall@3, MRR, nDCG@3. */
export function scoreCase(rankedIds, relevantIds) {
  return {
    recallAt1: recallAtK(rankedIds, relevantIds, 1),
    recallAt3: recallAtK(rankedIds, relevantIds, DEFAULT_K),
    mrr: reciprocalRank(rankedIds, relevantIds),
    ndcgAt3: ndcgAtK(rankedIds, relevantIds, DEFAULT_K),
  };
}

/**
 * Macro-average per-case metrics over `cases`. Empty input yields zeros
 * (and count 0) rather than NaN. Preserves an optional mean latency when
 * every case reports latencyMs.
 */
export function scoreCases(cases) {
  const count = cases.length;
  const zero = { count, recallAt1: 0, recallAt3: 0, mrr: 0, ndcgAt3: 0 };
  if (count === 0) return zero;
  let recallAt1 = 0;
  let recallAt3 = 0;
  let mrr = 0;
  let ndcgAt3 = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  const perCase = [];
  for (const c of cases) {
    const rankedIds = Array.isArray(c.rankedIds) ? c.rankedIds : [];
    const relevantIds = Array.isArray(c.relevantIds) ? c.relevantIds : [];
    const s = scoreCase(rankedIds, relevantIds);
    recallAt1 += s.recallAt1;
    recallAt3 += s.recallAt3;
    mrr += s.mrr;
    ndcgAt3 += s.ndcgAt3;
    if (typeof c.latencyMs === "number" && Number.isFinite(c.latencyMs)) {
      latencyTotal += c.latencyMs;
      latencyCount++;
    }
    perCase.push({ id: c.id ?? "", ...s });
  }
  const summary = {
    count,
    recallAt1: recallAt1 / count,
    recallAt3: recallAt3 / count,
    mrr: mrr / count,
    ndcgAt3: ndcgAt3 / count,
  };
  if (latencyCount === count) summary.meanLatencyMs = latencyTotal / count;
  return { ...summary, perCase };
}

function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main() {
  const argv = globalThis.process.argv.slice(2);
  const resultsPath = flagValue(argv, "--results");
  const recordPath = flagValue(argv, "--record");
  const configName = flagValue(argv, "--config");
  const log = globalThis.console;

  if (!resultsPath && !recordPath) {
    log.error("usage: score.mjs --results <results.json> | --record <benchmark-record.json> --config <name>");
    globalThis.process.exitCode = 1;
    return;
  }

  const raw = await readFile(resultsPath ?? recordPath, "utf8");
  const doc = JSON.parse(raw);
  let cases = doc.cases;
  if (recordPath) {
    if (!configName) {
      log.error("usage: score.mjs --record <benchmark-record.json> --config <name>");
      globalThis.process.exitCode = 1;
      return;
    }
    const cfg = doc?.configs?.[configName];
    if (!cfg) {
      log.error(`config not found in record: ${configName}`);
      globalThis.process.exitCode = 1;
      return;
    }
    cases = cfg.cases;
  }
  if (!Array.isArray(cases)) {
    log.error("input has no cases array (expected { cases: [...] } or a benchmark record with configs.<name>.cases)");
    globalThis.process.exitCode = 1;
    return;
  }
  log.log(JSON.stringify(scoreCases(cases), null, 2));
}

const invokedAsCli =
  globalThis.process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(globalThis.process.argv[1]).href;

if (invokedAsCli) {
  await main();
}
