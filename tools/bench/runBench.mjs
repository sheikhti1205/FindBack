/**
 * Golden-corpus benchmark harness.
 *
 * Text-match pairs rank under two deterministic comparison configs
 * (token-overlap stub + category-boosted fake); real Needle vectors plug
 * in at `runConfig` without changing the record shape.
 *
 * Photo cases execute through the real vision bench
 * (tools/bench/run-vision-bench.py over generated fixture plates):
 * this harness aggregates the latest vision report when present —
 * executed counts plates actually run, never a skeleton zero. Without a
 * report the cases record `device-required` with the real fixture files
 * queued (not placeholder URIs).
 *
 * Metrics come from ./score.mjs (the file-level mirror of the TS contract in
 * apps/mobile/src/services/similarity.ts).
 *
 * Usage:
 *   node tools/bench/runBench.mjs --corpus <corpus.json> --out <record.json>
 *     [--model-rev <rev>] [--runtime-rev <rev>] [--app-sha <sha>]
 *   node tools/bench/runBench.mjs --out <record.json>
 *     (uses the bundled synthetic corpus tools/bench/corpus.v1.json)
 *
 * No dependencies. No network. No model downloads.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreCases } from "./score.mjs";

const CONFIGS = ["stub", "fake"];

/** Bundled synthetic corpus: used when --corpus is omitted. */
const DEFAULT_CORPUS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "corpus.v1.json");

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

/**
 * Photo-case summary: aggregate the latest real vision-bench report when
 * one exists (executed = plates actually run with real modelRev). Without
 * a report the real fixture files stay queued as `device-required` — the
 * inputs are concrete PNGs, never placeholder URIs.
 */
function summarizePhotoCases(photoCases, hereDir) {
  const reportsDir = resolve(hereDir, "reports");
  let latest = null;
  try {
    const names = readdirSync(reportsDir).filter((n) => n.startsWith("vision-bench-") && n.endsWith(".json")).sort();
    if (names.length > 0) latest = JSON.parse(readFileSync(join(reportsDir, names[names.length - 1]), "utf8"));
  } catch {
    latest = null;
  }
  if (latest !== null && typeof latest.photoCases?.executed === "number" && latest.photoCases.executed > 0) {
    const plates = latest.photoCases.plates ?? [];
    const recalls = plates.map((p) => p.ocrRecallTranscribe).filter((r) => typeof r === "number");
    return {
      total: photoCases.length,
      executed: latest.photoCases.executed,
      status: "executed",
      report: {
        modelRev: latest.modelRev ?? null,
        runtimeRev: latest.runtimeRev ?? null,
        meanOcrRecallTranscribe: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
        loops: plates.reduce((n, p) => n + Object.values(p.prompts ?? {}).filter((v) => v.loop === true).length, 0),
        forbiddenHits: plates.reduce((n, p) => n + (p.forbiddenHits ?? []).length, 0),
      },
    };
  }
  return {
    total: photoCases.length,
    executed: 0,
    status: "device-required",
    reason: "no vision-bench report present: run tools/bench/run-vision-bench.py with provisioned weights, or execute on-device",
    fixtureFiles: photoCases.map((c) => c.imageRef).filter((r) => typeof r === "string"),
  };
}

function main() {
  const argv = globalThis.process.argv.slice(2);
  const log = globalThis.console;
  const corpusPath = flagValue(argv, "--corpus") ?? DEFAULT_CORPUS_PATH;
  const outPath = flagValue(argv, "--out");
  if (!outPath) {
    log.error("usage: runBench.mjs [--corpus <corpus.json>] --out <record.json> [--model-rev <rev>] [--runtime-rev <rev>] [--app-sha <sha>]");
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
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const record = {
    benchmark: "ws6-golden-corpus",
    corpusVersion: doc.corpusVersion,
    modelRev: flagValue(argv, "--model-rev") ?? "skeleton-fake",
    runtimeRev: flagValue(argv, "--runtime-rev") ?? "skeleton-stub",
    appSha: resolveAppSha(flagValue(argv, "--app-sha")),
    createdAt: new Date().toISOString(),
    configs,
    photoCases: summarizePhotoCases(photoCases, hereDir),
    memoryNote:
      "Harness note, not a device measurement: RSS/heap sampled from the Node bench process at end of run. " +
      "On-device RAM budgets are owned by ModelProfile + evaluation measurements.",
    memory: mem ? { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed } : null,
  };

  const resolved = resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(record, null, 2) + "\n", "utf8");
  log.log(`[bench] corpus: ${corpusPath} (version ${doc.corpusVersion})`);
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
