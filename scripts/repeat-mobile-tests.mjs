#!/usr/bin/env node
// Repeat the full mobile suite to capture the next intermittent failure with
// its full identity (file, test name, config, worker setup, stderr, duration,
// environment). Single attempt per run: no retries, no sleeps, no timeout flags.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}
const MAX_RUNS = Math.max(1, parseInt(flagValue("--runs", "20"), 10) || 20);
const outDir = path.resolve(flagValue("--out", "test-evidence/mobile-repeat"));
fs.mkdirSync(outDir, { recursive: true });

function gitFact(cmd) {
  try {
    return execFileSync("git", cmd, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const environment = {
  node: process.version,
  platform: `${os.platform()}/${os.arch()}`,
  cpus: os.cpus().length,
  ci: process.env.CI ?? "unset",
  nodeEnv: process.env.NODE_ENV ?? "unset",
  gitSha: gitFact(["rev-parse", "HEAD"]),
  gitBranch: gitFact(["rev-parse", "--abbrev-ref", "HEAD"]),
  vitest: (() => {
    try {
      return execFileSync("node_modules/.bin/vitest", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })(),
};

function runOnce(index) {
  const jsonReport = path.join(outDir, `run-${String(index).padStart(2, "0")}.vitest.json`);
  const command = ["npm", "test", "-w", "@findback/mobile", "--",
    "--reporter=verbose", "--reporter=json", `--outputFile.json=${jsonReport}`];
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const child = spawnSync(command[0], command.slice(1), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Date.now() - start;
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const logPath = path.join(outDir, `run-${String(index).padStart(2, "0")}.log`);
  fs.writeFileSync(logPath, `$ ${command.join(" ")}\nexit=${child.status}\n${output}`);
  return { index, command: command.join(" "), startedAt, durationMs, exitCode: child.status ?? -1, logPath, jsonReport, output };
}

function failuresFromJson(jsonReport) {
  if (!fs.existsSync(jsonReport)) return null;
  const report = JSON.parse(fs.readFileSync(jsonReport, "utf8"));
  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failures.push({
          file: file.name,
          test: assertion.title,
          fullName: assertion.fullName,
          durationMs: assertion.duration,
          failureExcerpt: (assertion.failureMessages ?? []).join("\n").slice(0, 4000),
        });
      }
    }
    if ((file.assertionResults ?? []).length === 0 && file.status === "failed") {
      failures.push({ file: file.name, test: "(file-level failure)", fullName: file.name, durationMs: 0, failureExcerpt: (file.message ?? "").slice(0, 4000) });
    }
  }
  return failures;
}

function failuresFromLog(output) {
  const failures = [];
  for (const line of output.split("\n")) {
    const match = line.match(/FAIL\s+(\S+)(?:\s*>\s*(.*))?/);
    if (match) failures.push({ file: match[1], test: (match[2] ?? "").trim(), fullName: line.trim(), durationMs: 0, failureExcerpt: "" });
  }
  return failures;
}

execFileSync("npm", ["run", "build", "-w", "@findback/shared"], { stdio: "inherit" });
const runs = [];
for (let index = 1; index <= MAX_RUNS; index += 1) {
  const run = runOnce(index);
  let failures = failuresFromJson(run.jsonReport) ?? failuresFromLog(run.output);
  if (run.exitCode !== 0 && failures.length === 0) {
    failures = [{ file: "unknown", test: "unknown", fullName: "nonzero exit without parsed identity", durationMs: run.durationMs, failureExcerpt: run.output.slice(-4000) }];
  }
  const record = {
    index: run.index, command: run.command, startedAt: run.startedAt,
    durationMs: run.durationMs, exitCode: run.exitCode, failures,
    artifacts: { log: path.basename(run.logPath), jsonReport: path.basename(run.jsonReport) },
  };
  runs.push(record);
  fs.writeFileSync(path.join(outDir, `run-${String(index).padStart(2, "0")}.json`), JSON.stringify({ environment, ...record }, null, 2));
  console.log(`run ${index}/${MAX_RUNS}: exit=${run.exitCode} failures=${failures.length} durationMs=${run.durationMs}`);
  if (failures.length > 0) {
    const identity = {
      runIndex: index, command: run.command, startedAt: run.startedAt,
      durationMs: run.durationMs, exitCode: run.exitCode, environment,
      workerSetup: { pool: "vitest default (forks)", maxWorkers: "vitest default", isolate: "default (per-file workers)" },
      seedConfig: "vitest default sequence (no --seed passed; rerun reads the same defaults)",
      failures,
      stderrTail: run.output.slice(-8000),
      artifacts: { log: path.basename(run.logPath), runReport: `run-${String(index).padStart(2, "0")}.json`, jsonReport: path.basename(run.jsonReport) },
    };
    fs.writeFileSync(path.join(outDir, "failure-identity.json"), JSON.stringify(identity, null, 2));
    console.log(`failure identity preserved: ${path.join(outDir, "failure-identity.json")}`);
    process.exit(1);
  }
}
fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ environment, runs, conclusion: `all ${MAX_RUNS} runs passed; intermittent did not reproduce in this set` }, null, 2));
console.log(`all ${MAX_RUNS} runs passed; summary: ${path.join(outDir, "summary.json")}`);
