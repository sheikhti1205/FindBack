/**
 * WS6 benchmark harness skeleton.
 *
 * Loads a golden corpus (see tools/bench/goldenCorpus.schema.json), ranks each
 * text-match case under two injected comparison configs, and writes a
 * benchmark-record JSON carrying model-rev, runtime-rev, app-sha,
 * corpus-version, Recall@1/3, MRR, nDCG@3, latency, and a memory note.
 *
 * Comparison configs (deterministic, no models, no network):
 *   - "stub":  ranks candidates by token overlap between the query text and
 *              each candidate text (USE-vs-stub stand-in for the embedding
 *              path: swap `rankStub` for real USE scores when available).
 *   - "fake":  same overlap plus a same-category boost, standing in for the
 *              injected FakeAiProvider-assisted path. Real provider injection
 *              (FakeAiProvider / on-device runtime) plugs in at `runConfig`
 *              without changing the record shape.
 *
 * Photo cases are schema-validated and counted, but NOT executed: the
 * skeleton has no model runtime. They record as `status: "skipped"`.
 *
 * Metrics come from ./score.mjs (the file-level mirror of the TS contract in
 * apps/mobile/src/services/similarity.ts).
 *
 * Usage:
 *   node tools/bench/runBench.mjs --corpus <corpus.json> --out <record.json>
 *     [--model-rev <rev>] [--runtime-rev <rev>] [--app-sha <sha>]
 *
 * No dependencies. No network. No model downloads.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scoreCases } from "./score.mjs";

const CONFIGS = ["stub", "fake"];

/** Lowercase alphanumeric tokens of a text. */
function tokens(text) {
  return (text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Token-overlap score between query text and candidate text. */
function overlapScore(queryText, candidateText) {
  const query = new Set(tokens(queryText));
  if (query.size === 0) return 0;
  let hits = 0;
  for (const t of new Set(tokens(candidateText))) {
    if (query.has(t)) hits++;
  }
  return hits / query.size;
}

function candidateText(c) {
  return `${c.title ?? ""} ${c.description ?? ""}`;
}

/**
 * Stub ranker: pure token overlap, id-ascending tie-break. Deterministic.
 */
function rankStub(query, candidates) {
  const q = `${query.title ?? ""} ${query.description ?? ""}`;
  return [...candidates]
    .map((c) => ({ id: c.id, s: overlapScore(q, candidateText(c)) }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.id.localeCompare(b.id)))
    .map((r) => r.id);
}

/**
 * Fake-assisted ranker: token overlap plus a same-category boost, standing in
 * for the injected FakeAiProvider-assisted path. Deterministic.
 */
function rankFake(query, candidates) {
  const q = `${query.title ?? ""} ${query.description ?? ""}`;
  return [...candidates]
    .map((c) => ({
      id: c.id,
      s: overlapScore(q, candidateText(c)) + (c.category === query.category ? 1 : 0),
    }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.id.localeCompare(b.id)))
    .map((r) => r.id);
}

/** Minimal structural validation; strict shape lives in the JSON schema. */
function validateCorpus(doc) {
  const errors = [];
  if (typeof doc !== "object" || doc === null) return ["corpus root must be an object"];
  if (typeof doc.corpusVersion !== "string" || doc.corpusVersion.length === 0) {
    errors.push("corpusVersion must be a non-empty string");
  }
  for (const key of ["textMatchPairs", "photoCases"]) {
    if (!Array.isArray(doc[key])) errors.push(`${key} must be an array`);
  }
  for (const pair of doc.textMatchPairs ?? []) {
    const ids = new Set((pair.candidates ?? []).map((c) => c.id));
    for (const rel of pair.relevantIds ?? []) {
      if (!ids.has(rel)) errors.push(`pair ${pair.id}: relevantId ${rel} matches no candidate`);
    }
  }
  return errors;
}

function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function resolveAppSha(explicit) {
  if (explicit) return explicit;
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** Run one config over all text-match pairs; returns score.mjs-shaped cases. */
function runConfig(name, pairs) {
  const rank = name === "fake" ? rankFake : rankStub;
  return pairs.map((pair) => {
    const start = Date.now();
    const rankedIds = rank(pair.query ?? {}, pair.candidates ?? []);
    const latencyMs = Date.now() - start;
    return { id: pair.id ?? "", rankedIds, relevantIds: pair.relevantIds ?? [], latencyMs };
  });
}

function main() {
  const argv = globalThis.process.argv.slice(2);
  const log = globalThis.console;
  const corpusPath = flagValue(argv, "--corpus");
  const outPath = flagValue(argv, "--out");
  if (!corpusPath || !outPath) {
    log.error("usage: runBench.mjs --corpus <corpus.json> --out <record.json> [--model-rev <rev>] [--runtime-rev <rev>] [--app-sha <sha>]");
    globalThis.process.exitCode = 1;
    return;
  }

  const doc = JSON.parse(readFileSync(corpusPath, "utf8"));
  const errors = validateCorpus(doc);
  if (errors.length > 0) {
    for (const e of errors) log.error(`corpus error: ${e}`);
    globalThis.process.exitCode = 1;
    return;
  }

  const pairs = doc.textMatchPairs;
  const photoCases = doc.photoCases;
  const configs = {};
  for (const name of CONFIGS) {
    const cases = runConfig(name, pairs);
    const summary = scoreCases(cases);
    const { perCase, ...aggregate } = summary;
    configs[name] = { ...aggregate, cases };
    void perCase;
  }

  const mem = typeof globalThis.process.memoryUsage === "function" ? globalThis.process.memoryUsage() : null;
  const record = {
    benchmark: "ws6-golden-corpus",
    corpusVersion: doc.corpusVersion,
    modelRev: flagValue(argv, "--model-rev") ?? "skeleton-fake",
    runtimeRev: flagValue(argv, "--runtime-rev") ?? "skeleton-stub",
    appSha: resolveAppSha(flagValue(argv, "--app-sha")),
    createdAt: new Date().toISOString(),
    configs,
    photoCases: {
      total: photoCases.length,
      executed: 0,
      status: "skipped",
      reason: "skeleton harness has no model runtime; photo cases are schema-validated and counted only",
    },
    memoryNote:
      "Skeleton-harness note, not a device measurement: RSS/heap sampled from the Node bench process at end of run. " +
      "On-device RAM budgets are owned by ModelProfile + evaluation measurements.",
    memory: mem ? { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed } : null,
  };

  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(record, null, 2) + "\n", "utf8");
  for (const name of CONFIGS) {
    const s = configs[name];
    log.log(
      `[bench] ${name}: n=${s.count} recall@1=${s.recallAt1.toFixed(3)} recall@3=${s.recallAt3.toFixed(3)} ` +
        `mrr=${s.mrr.toFixed(3)} ndcg@3=${s.ndcgAt3.toFixed(3)}`,
    );
  }
  log.log(`[bench] record written: ${resolved}`);
}

main();
