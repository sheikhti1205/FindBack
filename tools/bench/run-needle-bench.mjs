#!/usr/bin/env node
/**
 * Real Needle text bench (F3): extraction cases through the pinned needle3
 * CLI with a single-record tool schema. Records per-case function calls,
 * suppressed calls, confidence, validation flags, and perf counters into
 * tools/bench/reports/needle-bench-<stamp>.json.
 *
 * Requires: build/needle/needle3.cact + build/needle/needle-cli
 * (fetch-needle-model.mjs --bench-only, NEEDLE_MODEL_ENABLED=1).
 * Telemetry is disabled in the CLI environment (vendor off-switch).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI = join(REPO_ROOT, "build", "needle", "needle-cli");
const WEIGHTS = join(REPO_ROOT, "build", "needle", "needle3.cact");
const REPORTS = join(REPO_ROOT, "tools", "bench", "reports");

const TOOL_SCHEMA = [
  {
    name: "record_item",
    description: "Record a lost-and-found item report",
    parameters: {
      type: "object",
      properties: {
        object: { type: "string", description: "the lost object" },
        color: { type: "string", description: "its color" },
        location: { type: "string", description: "where it was lost" },
      },
      required: ["object", "color"],
    },
  },
];

const CASES = [
  { id: "lost-umbrella", prompt: "I lost my red umbrella near the park gate", expect: { object: "red umbrella", color: "red" } },
  { id: "lost-keys", prompt: "Missing blue keys with a lanyard from yesterday", expect: { object: "blue keys", color: "blue" } },
  { id: "lost-passport", prompt: "My black passport is gone, last seen at the airport cafe", expect: { object: "passport", color: "black" } },
  { id: "lost-wallet", prompt: "Brown leather wallet fell out of my pocket on bus 12", expect: { object: "wallet", color: "brown" } },
];

function runCase(prompt, toolsPath) {
  const raw = execFileSync(
    CLI,
    ["--model", WEIGHTS, "--tools", toolsPath, "--prompt", prompt, "--max", "64"],
    {
      encoding: "utf8",
      timeout: 300_000,
      env: { ...process.env, NEEDLE_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    },
  );
  return JSON.parse(raw);
}

function scoreOutcome(outcome, expected) {
  const calls = [...(outcome.function_calls ?? []), ...(outcome.suppressed_calls ?? [])];
  const args = calls.find((call) => call.name === "record_item")?.arguments ?? {};
  const fields = Object.keys(expected);
  const hits = fields.filter(
    (field) =>
      typeof args[field] === "string" &&
      args[field].toLowerCase().includes(String(expected[field]).toLowerCase()),
  );
  const routed = (outcome.function_calls ?? []).length > 0 ? "dispatched" : "suppressed";
  return { fieldRecall: fields.length ? hits.length / fields.length : 0, routed, confidence: outcome.confidence ?? null };
}

function main() {
  const toolsPath = join(tmpdir(), `needle-bench-tools-${Date.now()}.json`);
  writeFileSync(toolsPath, JSON.stringify(TOOL_SCHEMA));
  const report = {
    modelId: "needle3-cact-l20",
    modelRev: "c7c415a3d1b3d929014bc6e866d51ebb971f7089",
    runtimeRev: "needle-cli-linux-x86_64",
    cases: [],
  };
  for (const kase of CASES) {
    const outcome = runCase(kase.prompt, toolsPath);
    const score = scoreOutcome(outcome, kase.expect);
    report.cases.push({
      id: kase.id,
      prompt: kase.prompt,
      expected: kase.expect,
      ...score,
      prefillTps: outcome.prefill_tps ?? null,
      decodeTps: outcome.decode_tps ?? null,
      peakRamMb: outcome.peak_ram_mb ?? null,
      validation: outcome.validation ?? null,
    });
    console.log(
      `${kase.id}: recall=${score.fieldRecall.toFixed(2)} routed=${score.routed} conf=${score.confidence}`,
    );
  }
  mkdirSync(REPORTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const path = join(REPORTS, `needle-bench-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  const mean = report.cases.reduce((sum, c) => sum + c.fieldRecall, 0) / report.cases.length;
  console.log(`executed=${report.cases.length} meanFieldRecall=${mean.toFixed(2)}`);
  console.log(`report: ${path}`);
}

main();
