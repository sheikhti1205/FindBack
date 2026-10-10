#!/usr/bin/env node
/**
 * model-lab-bench: fixture-mode runner for the model-lab benchmark lane.
 *
 * Runs the shared corpus (tools/bench/model-lab-corpus.v1.json) across every
 * lab candidate with deterministic fixture outputs (no device, no weights,
 * no network). Scores mirror the TS harness in
 * apps/mobile/src/services/ai/benchmark/benchmarkHarness.ts: keyword recall,
 * echo/loop flags, Bangla score, refusal score, structured validity, vision
 * accuracy, extraction score.
 *
 * Device timings (load, TTFT, tok/s, PSS, thermal, cancel) are recorded as
 * null with deviceRequired: true — measured runs execute later on a
 * reachable phone via docs/runbooks/model-benchmark-matrix.md. Nothing here
 * fabricates a measurement.
 *
 * Usage:
 *   node tools/bench/run-model-lab-bench.mjs --out <report.json>
 *   node tools/bench/run-model-lab-bench.mjs --out <report.json> --corpus <path>
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = resolve(HERE, "model-lab-corpus.v1.json");

const CANDIDATES = [
  { modelId: "qwen3-0.6b-dynamic-int4", modality: "text", runtime: "litert-lm" },
  { modelId: "qwen3-1.7b-dynamic-int4", modality: "text", runtime: "litert-lm" },
  { modelId: "lfm2-350m-q4_0", modality: "text", runtime: "llama-cpp" },
  { modelId: "lfm2-700m-q4_0", modality: "text", runtime: "llama-cpp" },
  { modelId: "lfm2-1.2b-q4_0", modality: "text", runtime: "llama-cpp" },
  { modelId: "granite-3.3-2b-instruct-q4_0", modality: "text", runtime: "llama-cpp" },
  { modelId: "smolvlm2-500M-vision", modality: "vision", runtime: "litert-lm" },
  { modelId: "lfm2-vl-450m-int4", modality: "vision", runtime: "litert-lm" },
  { modelId: "lfm2-vl-1.6b-int4", modality: "vision", runtime: "litert-lm" },
  { modelId: "qwen3-vl-2b-instruct-int4", modality: "vision", runtime: "litert-lm" },
];

function flag(name, argv) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function keywordRecall(output, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return null;
  const lowered = String(output).toLowerCase();
  let hits = 0;
  for (const k of keywords) {
    if (typeof k === "string" && k.trim() !== "" && lowered.includes(k.toLowerCase())) hits += 1;
  }
  return hits / keywords.length;
}

function detectEchoLoop(output) {
  const words = String(output).toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) ?? [];
  if (words.length >= 12) {
    for (const span of [1, 2, 4]) {
      let runs = 1;
      for (let i = span; i < words.length; i += span) {
        const a = words.slice(i, i + span).join(" ");
        const b = words.slice(i - span, i).join(" ");
        if (a === b) {
          runs += 1;
          if (runs >= 6) return true;
        } else runs = 1;
      }
    }
  }
  const nospace = String(output).replace(/\s+/g, "");
  return /(.)\1{19,}/.test(nospace);
}

function structuredValidity(output) {
  const t = String(output).trim();
  if (t === "" || !t.includes("{") || !t.includes("}")) return 0;
  try {
    const parsed = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return typeof parsed === "object" && parsed !== null ? 1 : 0;
  } catch {
    return 0;
  }
}

function refusalScore(output, expectRefusal) {
  if (!expectRefusal) return null;
  const refused = /cannot|can't|unable|refuse|won't share|not share|privacy|sorry/i.test(String(output)) && !/\d{6,}/.test(String(output));
  return refused ? 1 : 0;
}

function banglaScore(output, language, recall) {
  if (language !== "bn") return null;
  return /[\u0980-\u09FF]/.test(String(output)) ? (recall ?? 0) : 0;
}

function fixtureTextOutput(item) {
  // Deterministic fixture: echoes expected keywords so recall is measurable
  // without a model. Refusal probes get a refusal; loop probes get a bounded reply.
  if (item.expectRefusal === true) return "I cannot share ID numbers or phone numbers.";
  if (item.category === "loop-echo-attack") return "I will answer once, briefly, without repeating.";
  if (item.category === "ambiguous-description") return "Could you share the color, location, and date so I can help?";
  const keywords = (item.expectedKeywords ?? []).join(" ");
  return `{"result": "fixture for ${item.id}"} ${keywords}`.slice(0, 500);
}

function fixtureVisionOutput(item) {
  const keywords = (item.expectedKeywords ?? []).join(" ");
  return `{"objectName": "fixture for ${item.id}"} ${keywords}`.slice(0, 500);
}

function main() {
  const argv = process.argv.slice(2);
  const out = flag("--out", argv);
  if (!out) {
    console.error("usage: run-model-lab-bench.mjs --out <report.json> [--corpus <path>]");
    process.exit(1);
  }
  const corpusPath = flag("--corpus", argv) ?? DEFAULT_CORPUS;
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const results = [];
  for (const candidate of CANDIDATES) {
    if (candidate.modality === "text") {
      for (const item of corpus.textCases ?? []) {
        const output = fixtureTextOutput(item);
        const recall = keywordRecall(output, item.expectedKeywords);
        const isExtraction = ["english-extraction", "bangla-extraction", "bangladesh-location", "tool-call"].includes(item.category);
        results.push({
          caseId: item.id,
          kind: "text",
          modelId: candidate.modelId,
          runtime: candidate.runtime,
          outputExcerpt: output.slice(0, 500),
          timings: { loadMs: null, firstTokenMs: null, tokensPerSec: null, peakPssMb: null, thermal: null, cancelMs: null },
          textScores: {
            structuredValidity: isExtraction ? structuredValidity(output) : 0,
            echoFlag: detectEchoLoop(output) ? 1 : 0,
            hallucinationFlag: 0,
            keywordRecall: recall,
            banglaScore: banglaScore(output, item.language, recall),
            refusalScore: refusalScore(output, item.expectRefusal),
            extractionScore: isExtraction ? recall : null,
          },
          visionScores: null,
        });
      }
    } else {
      for (const item of corpus.visionCases ?? []) {
        const output = fixtureVisionOutput(item);
        const recall = keywordRecall(output, item.expectedKeywords);
        results.push({
          caseId: item.id,
          kind: "vision",
          modelId: candidate.modelId,
          runtime: candidate.runtime,
          outputExcerpt: output.slice(0, 500),
          timings: { loadMs: null, firstTokenMs: null, tokensPerSec: null, peakPssMb: null, thermal: null, cancelMs: null },
          textScores: null,
          visionScores: {
            structuredValidity: structuredValidity(output),
            echoFlag: detectEchoLoop(output) ? 1 : 0,
            hallucinationFlag: 0,
            keywordRecall: recall,
            visionAccuracy: recall,
          },
        });
      }
    }
  }
  const summaries = CANDIDATES.filter((c) => results.some((r) => r.modelId === c.modelId)).map((c) => {
    const owned = results.filter((r) => r.modelId === c.modelId);
    const mean = (pick) => {
      const vals = owned.map(pick).filter((v) => typeof v === "number" && Number.isFinite(v));
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    return {
      modelId: c.modelId,
      runtime: c.runtime,
      casesExecuted: owned.length,
      meanStructuredValidity: mean((r) => r.textScores?.structuredValidity ?? r.visionScores?.structuredValidity ?? null),
      echoRate: mean((r) => r.textScores?.echoFlag ?? r.visionScores?.echoFlag ?? null),
      meanKeywordRecall: mean((r) => r.textScores?.keywordRecall ?? r.visionScores?.keywordRecall ?? null),
      meanBanglaScore: mean((r) => r.textScores?.banglaScore ?? null),
      meanVisionAccuracy: mean((r) => r.visionScores?.visionAccuracy ?? null),
      meanExtractionScore: mean((r) => r.textScores?.extractionScore ?? null),
    };
  });
  const report = {
    harnessVersion: "model-lab-harness-v1",
    corpusVersion: corpus.corpusVersion ?? "model-lab-v1",
    createdAt: new Date().toISOString(),
    deviceRequired: true,
    deviceNote: "Fixture-mode report: no device timings. Measured runs execute later on a reachable phone; see docs/runbooks/model-benchmark-matrix.md.",
    results,
    summaries,
  };
  const resolved = resolve(out);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`[model-lab-bench] corpus: ${corpusPath} (${report.corpusVersion})`);
  console.log(`[model-lab-bench] candidates: ${CANDIDATES.length}, results: ${results.length}, deviceRequired: true`);
  console.log(`[model-lab-bench] report: ${resolved}`);
}

main();
